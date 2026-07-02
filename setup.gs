// iN Starter Kit — Apps Script Pipeline
// Deploy in Google Apps Script, bound to your Google Sheet.
//
// SETUP (Claude Code will walk you through this):
// 1. Fill in the CONFIG block below
// 2. Add ANTHROPIC_API_KEY in Project Settings → Script Properties
// 3. Create a time-based trigger: runPipeline, every 15 minutes
// 4. Connect your Google Form to the Sheet
//
// ── CONFIGURE THIS ────────────────────────────────────────────────────────────

const CONFIG = {
  // The ID from your Google Sheet URL:
  // docs.google.com/spreadsheets/d/[PUT THIS HERE]/edit
  sheetId: 'YOUR_SHEET_ID_HERE',

  // The name of your top-level Google Drive folder
  driveFolderName: 'IN',

  // The name of the captures subfolder inside your Drive folder
  capturesFolderName: 'captures',

  // Your tag / category list — must match your form dropdown exactly
  categories: ['To Do', 'Goal', 'Idea', 'Reminder', 'Resource'],

  // Your form field names — must match your form exactly
  formFields: {
    mainCapture: 'What?',
    tag:         'Tag?',
  },

  // Claude model for enrichment. Haiku is fast and cheap (~$0.002/capture).
  model: 'claude-haiku-4-5-20251001',
};

// ── COLUMN SCHEMAS ─────────────────────────────────────────────────────────────

const CAPTURE_COLUMNS = [
  'id', 'created_at', 'entry_date', 'source', 'tag',
  'capture', 'type', 'horizon', 'size', 'autonomy',
  'context', 'resources', 'next_steps', 'search_query',
];

const RESOURCE_COLUMNS = [
  'id', 'created_at', 'entry_date', 'url', 'title', 'summary', 'source_capture',
];

const TASK_COLUMNS = [
  'id', 'created_at', 'entry_date', 'capture', 'next_steps', 'horizon', 'size', 'status',
];

const LOG_COLUMNS = [
  'timestamp', 'source', 'items_processed', 'status', 'error',
];

const PROCESSED_COLUMNS = ['filename', 'processed_at'];

// ── PROMPTS ────────────────────────────────────────────────────────────────────

function buildEnrichPrompt(capture, tag) {
  return `You are enriching a personal capture with structured metadata.

The person capturing this uses these categories: ${CONFIG.categories.join(', ')}.

Capture: ${capture}
Tag: ${tag || '(none)'}

Extract the following. Return valid JSON only, no markdown, no explanation:
{
  "type": "task | thought | gem | question | resource",
  "horizon": "today | this_week | this_month | someday | ongoing | null",
  "size": "S | M | L | null",
  "autonomy": "self | delegate | automate | null",
  "resources": ["any URLs, names, or references mentioned"],
  "next_steps": ["the single most atomic first action, or empty"],
  "search_query": "ideal web search string if useful, or null"
}

type: task = clear next action; thought = reflection, not actionable; gem = insight worth keeping; question = seeking an answer; resource = link or reference to save.
horizon: null if type is not task.
size: S under 30 min, M half day, L multi-day. null if type is not task.
autonomy: self = requires the person personally; delegate = a capable helper could do it; automate = fully automatable. null if type is not task.`;
}

const LINK_PROMPT = `Extract the key information from this webpage content.
Return valid JSON only, no markdown:
{"title": "page title", "summary": "2-3 sentence summary of what this page is and why it matters"}`;

// ── ENTRY POINT ────────────────────────────────────────────────────────────────

function runPipeline() {
  const ss = SpreadsheetApp.openById(CONFIG.sheetId);
  processFormResponses(ss);
  processCapturesFolder(ss);
}

// ── FORM PROCESSING ─────────────────────────────────────────────────────────────

function processFormResponses(ss) {
  const formWs = ss.getSheetByName('Form Responses 1');
  if (!formWs) return;

  const all = formWs.getDataRange().getValues();
  if (all.length <= 1) return;

  const header = all[0];
  if (!header.includes('Processed')) {
    formWs.getRange(1, header.length + 1).setValue('Processed');
    header.push('Processed');
  }

  const processedCol = header.indexOf('Processed');
  const captureWs   = getOrCreateSheet(ss, 'Captures', CAPTURE_COLUMNS);
  const resourceWs  = getOrCreateSheet(ss, 'Resources', RESOURCE_COLUMNS);
  const taskWs      = getOrCreateSheet(ss, 'Tasks', TASK_COLUMNS);
  const now = new Date().toISOString();

  for (let i = 1; i < all.length; i++) {
    const row = all[i];
    if (row[processedCol] && row[processedCol].toString().trim()) continue;

    const capture = (row[header.indexOf(CONFIG.formFields.mainCapture)] || '').trim();
    if (!capture) continue;

    const tag       = row[header.indexOf(CONFIG.formFields.tag)] || '';
    const timestamp = row[header.indexOf('Timestamp')];
    const entryDate = timestamp
      ? Utilities.formatDate(new Date(timestamp), 'UTC', 'yyyy-MM-dd')
      : '';

    try {
      const enriched = callClaudeText(buildEnrichPrompt(capture, tag));
      const id = nextId(captureWs);

      captureWs.appendRow([
        id, now, entryDate, 'form', tag,
        capture,
        enriched.type     || 'thought',
        enriched.horizon  || '',
        enriched.size     || '',
        enriched.autonomy || '',
        '',
        toArray(enriched.resources).join('\n'),
        toArray(enriched.next_steps).join('\n'),
        enriched.search_query || '',
      ]);

      // Pull tasks into the Tasks tab
      if (enriched.type === 'task') {
        taskWs.appendRow([
          id, now, entryDate, capture,
          toArray(enriched.next_steps).join('\n'),
          enriched.horizon || 'someday',
          enriched.size    || '',
          'open',
        ]);
      }

      // Fetch metadata for any URLs found in the capture
      const urls = extractUrls(capture);
      urls.forEach(url => fetchAndWriteLink(url, capture, entryDate, now, resourceWs));

      formWs.getRange(i + 1, processedCol + 1).setValue(now);
      Logger.log('Processed form entry: ' + capture.substring(0, 60));
    } catch (e) {
      Logger.log('Form entry error: ' + e.message);
      writeLog(ss, 'form', 0, 'error', e.message);
    }
  }
}

// ── DRIVE CAPTURES PROCESSING ──────────────────────────────────────────────────
// Picks up .txt files dropped in IN/captures/ (voice transcripts, exported notes)
// Images and PDFs are not processed in v1 — drop them in captures/ for your records.

function processCapturesFolder(ss) {
  const capturesFolder = getCapturesFolder();
  if (!capturesFolder) return;

  const processedWs = getOrCreateSheet(ss, 'Processed Files', PROCESSED_COLUMNS);
  const processed   = new Set(
    processedWs.getDataRange().getValues().slice(1).map(r => r[0]).filter(Boolean)
  );

  const captureWs  = getOrCreateSheet(ss, 'Captures', CAPTURE_COLUMNS);
  const resourceWs = getOrCreateSheet(ss, 'Resources', RESOURCE_COLUMNS);
  const taskWs     = getOrCreateSheet(ss, 'Tasks', TASK_COLUMNS);
  const now = new Date().toISOString();

  const files = capturesFolder.getFilesByType(MimeType.PLAIN_TEXT);
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    if (processed.has(name)) continue;

    try {
      const text = file.getBlob().getDataAsString();
      if (!text.trim()) continue;

      const enriched = callClaudeText(buildEnrichPrompt(text, '', ''));
      const id = nextId(captureWs);
      const entryDate = Utilities.formatDate(new Date(file.getDateCreated()), 'UTC', 'yyyy-MM-dd');

      captureWs.appendRow([
        id, now, entryDate, 'drive:' + name, '',
        text.substring(0, 500),
        enriched.type     || 'thought',
        enriched.horizon  || '',
        enriched.size     || '',
        enriched.autonomy || '',
        '',
        toArray(enriched.resources).join('\n'),
        toArray(enriched.next_steps).join('\n'),
        enriched.search_query || '',
      ]);

      if (enriched.type === 'task') {
        taskWs.appendRow([
          id, now, entryDate, text.substring(0, 200),
          toArray(enriched.next_steps).join('\n'),
          enriched.horizon || 'someday',
          enriched.size    || '',
          'open',
        ]);
      }

      const urls = extractUrls(text);
      urls.forEach(url => fetchAndWriteLink(url, name, entryDate, now, resourceWs));

      processedWs.appendRow([name, now]);
      Logger.log('Processed file: ' + name);
    } catch (e) {
      Logger.log('File error (' + name + '): ' + e.message);
      writeLog(ss, name, 0, 'error', e.message);
    }
  }
}

// ── LINK FETCHING ──────────────────────────────────────────────────────────────

function fetchAndWriteLink(url, sourceCapture, entryDate, now, resourceWs) {
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (response.getResponseCode() !== 200) return;

    const html = response.getContentText().substring(0, 8000);
    const meta = callClaudeText(LINK_PROMPT + '\n\nContent:\n' + html);
    const id   = nextId(resourceWs);

    resourceWs.appendRow([
      id, now, entryDate, url,
      meta.title   || url,
      meta.summary || '',
      sourceCapture.substring(0, 100),
    ]);
    Logger.log('Fetched link: ' + url);
  } catch (e) {
    Logger.log('Link fetch error (' + url + '): ' + e.message);
  }
}

function extractUrls(text) {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s"'<>]+/g);
  return matches ? [...new Set(matches)] : [];
}

// ── CLAUDE API ─────────────────────────────────────────────────────────────────

function callClaudeText(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in Script Properties');

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    payload: JSON.stringify({
      model: CONFIG.model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) throw new Error('Anthropic API ' + code + ': ' + body);

  let text = JSON.parse(body).content[0].text.trim();
  if (text.startsWith('```')) text = text.split('\n').slice(1).join('\n').replace(/```$/, '').trim();
  return JSON.parse(text);
}

// ── SHEET HELPERS ──────────────────────────────────────────────────────────────

function getOrCreateSheet(ss, title, columns) {
  let ws = ss.getSheetByName(title);
  if (!ws) {
    ws = ss.insertSheet(title);
    ws.getRange(1, 1, 1, columns.length).setValues([columns]).setFontWeight('bold');
  }
  return ws;
}

function nextId(ws) {
  const vals = ws.getRange(2, 1, Math.max(ws.getLastRow() - 1, 1), 1).getValues();
  const nums  = vals.map(r => parseInt(r[0])).filter(n => !isNaN(n));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

function writeLog(ss, source, count, status, error) {
  const ws = getOrCreateSheet(ss, 'Pipeline Log', LOG_COLUMNS);
  ws.appendRow([new Date().toISOString(), source, count, status, error || '']);
}

function toArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [String(val)];
}

// ── DRIVE HELPERS ──────────────────────────────────────────────────────────────

function getCapturesFolder() {
  const parents = DriveApp.getFoldersByName(CONFIG.driveFolderName);
  if (!parents.hasNext()) return null;
  const parent = parents.next();
  const children = parent.getFoldersByName(CONFIG.capturesFolderName);
  if (children.hasNext()) return children.next();
  // Create it if it doesn't exist
  return parent.createFolder(CONFIG.capturesFolderName);
}

// ── OPTIONAL EXTENSION: Journal OCR ───────────────────────────────────────────
// Amy uses this to process handwritten journal scans (PDF → Claude vision → tasks + gems).
// Not included in v1. Ask Amy or see pkm-system/scripts/journal_trigger.gs for the full
// implementation if you want to add this capability.
