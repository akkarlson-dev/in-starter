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

  // Your tag / category list — must match your form checkboxes exactly.
  // These are life-area tags (what it's about), separate from type (task/
  // thought/gem/question/resource) and autonomy (self/delegate/automate)
  // below — don't mix the three axes. Replace with your own during setup.
  categories: ['Work', 'Home', 'Ideas', 'Health', 'Finance', 'Personal'],

  // Your form field names — must match your form exactly
  formFields: {
    mainCapture: 'What?',
    tag:         'Tag?',
  },

  // Claude model for classification. Haiku is fast and cheap (~$0.002/capture).
  model: 'claude-haiku-4-5-20251001',
};

// ── COLUMN SCHEMAS ─────────────────────────────────────────────────────────────

const CAPTURE_COLUMNS = [
  'id', 'created_at', 'entry_date', 'source', 'tag',
  'capture', 'type', 'horizon', 'size', 'autonomy',
  'resources', 'next_steps', 'search_query', 'keywords',
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
  "search_query": "ideal web search string if useful, or null",
  "keywords": ["3-8 concrete, memory-triggering words or short phrases"]
}

type: task = clear next action; thought = reflection, not actionable; gem = insight worth keeping; question = seeking an answer; resource = link or reference to save.
horizon: null if type is not task.
size: S under 30 min, M half day, L multi-day. null if type is not task.
autonomy: self = requires the person personally; delegate = a capable helper could do it; automate = fully automatable. null if type is not task.
next_steps: the single most atomic first action that removes the main blocker. Empty if type is not task.
keywords: people's names, proper nouns, places, link domains, specific objects or topics — whatever would help you recall this specific entry later. Skip generic/abstract words (way, thing, day, time, etc.); this isn't a summary.`;
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
    // created_at uses the Form's own per-row Timestamp, not the batch-level
    // `now` above — `now` is computed once for the whole trigger run, so any
    // time multiple unprocessed rows get caught in one run (the 15-min
    // trigger fell behind, or several captures queued up) they'd otherwise
    // all get stamped with the exact same clock time, faking a burst that
    // never happened.
    const createdAt = timestamp ? new Date(timestamp).toISOString() : now;

    try {
      const enriched = callClaudeText(buildEnrichPrompt(capture, tag));
      const id = nextId(captureWs);

      captureWs.appendRow([
        id, createdAt, entryDate, 'form', tag,
        capture,
        enriched.type     || 'thought',
        enriched.horizon  || '',
        enriched.size     || '',
        enriched.autonomy || '',
        toArray(enriched.resources).join('\n'),
        toArray(enriched.next_steps).join('\n'),
        enriched.search_query || '',
        joinKeywords(enriched.keywords),
      ]);

      // Pull tasks into the Tasks tab
      if (enriched.type === 'task') {
        taskWs.appendRow([
          id, createdAt, entryDate, capture,
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

      const enriched = callClaudeText(buildEnrichPrompt(text, ''));
      const id = nextId(captureWs);
      // Real file creation time, not `now` (when the pipeline happened to
      // process it) — same reasoning as the form path above: a file that
      // sat for a bit before the trigger caught it shouldn't get stamped
      // with the processing moment instead of when it was actually dropped.
      const createdAt = file.getDateCreated().toISOString();
      const entryDate = Utilities.formatDate(file.getDateCreated(), 'UTC', 'yyyy-MM-dd');

      captureWs.appendRow([
        id, createdAt, entryDate, 'drive:' + name, '',
        text.substring(0, 500),
        enriched.type     || 'thought',
        enriched.horizon  || '',
        enriched.size     || '',
        enriched.autonomy || '',
        toArray(enriched.resources).join('\n'),
        toArray(enriched.next_steps).join('\n'),
        enriched.search_query || '',
        joinKeywords(enriched.keywords),
      ]);

      if (enriched.type === 'task') {
        taskWs.appendRow([
          id, createdAt, entryDate, text.substring(0, 200),
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

// Keywords keep their original casing — proper nouns are the point, so
// lowercasing "Greg" or "TLC" would defeat the purpose.
function joinKeywords(val) {
  return toArray(val)
    .map(k => String(k).trim())
    .filter(Boolean)
    .join(', ');
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

// ── WEB APP — Calendar dashboard ─────────────────────────────────────────────
// A real 5-week (35-day) grid of actual dates, not an hour-of-day aggregate —
// an aggregate is interesting once and then static forever, where a rolling
// window of real days keeps changing. Cell color is volume only (one hue,
// opacity-scaled — a sequential heat ramp), not dominant type: a single cell
// can only show one color, which would throw away information the
// click-to-reveal panel below preserves instead (each entry keeps its own
// type color). Deploy this file as a Web App (Deploy > New deployment > Web
// app, execute as yourself, who has access: Anyone — see README for why
// "Anyone" and not "Anyone with Google account") and the deployment URL is
// your dashboard link.
//
// Ported from Amy's own pkm-system/scripts/in_heartbeat.gs Calendar view,
// adapted to this kit's simpler schema (task/thought/gem/question/resource
// instead of her category taxonomy; no notes field or jump-link heuristics —
// kept lean) and validated with the dataviz skill's categorical color
// formula against this page's dark surface (#09080F).
//
// NOTE for whoever adapts this: linkify()'s regexes below use DOUBLE
// backslashes (\\/\\/, \\s) — this whole page is one big JS template
// literal, and inside a template literal (same rule as any plain string)
// \/ and \s aren't recognized escapes, so a single backslash gets silently
// dropped, producing a broken regex and a SyntaxError that kills the entire
// inline <script> before anything can run. Learned this the hard way in
// Amy's own Calendar view — don't reintroduce it here.

const IN_ICON_DATA_URI = 'https://i.imgur.com/4mCGlZg.png';

// Fixed order — same categorical-color assignment method as Amy's own
// system, just mapped onto this kit's task/thought/gem/question/resource
// types instead of her category taxonomy.
const CAPTURE_TYPES = ['task', 'thought', 'gem', 'question', 'resource'];
const TYPE_COLORS = {
  task: '#3987e5', thought: '#199e70', gem: '#c98500', question: '#008300', resource: '#9085e9',
};

function getCalendarData() {
  const ss = SpreadsheetApp.openById(CONFIG.sheetId);
  const ws = ss.getSheetByName('Captures');
  const tz = Session.getScriptTimeZone();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(today);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()); // this week's Sunday
  const gridStart = new Date(startOfWeek);
  gridStart.setDate(gridStart.getDate() - 28); // 4 weeks earlier -> 5 weeks (35 days) total

  const byDate = {}; // 'yyyy-MM-dd' -> { count, entries: [{ capture, type, autonomy, created_at }] }

  if (ws && ws.getLastRow() > 1) {
    const data = ws.getRange(2, 1, ws.getLastRow() - 1, CAPTURE_COLUMNS.length).getValues();
    data.forEach(r => {
      if (!r[0] || !r[5] || !r[1]) return; // id, capture, created_at
      const d = new Date(r[1]);
      if (isNaN(d)) return;
      const key = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
      if (!byDate[key]) byDate[key] = { count: 0, entries: [] };
      byDate[key].count++;
      byDate[key].entries.push({
        capture: r[5] || '',
        type: r[6] || 'thought',
        autonomy: r[9] || '',
        created_at: r[1],
      });
    });
  }

  const cells = [];
  for (let i = 0; i < 35; i++) {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    const key = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
    const isFuture = d.getTime() > today.getTime();
    const info = byDate[key] || { count: 0, entries: [] };
    info.entries.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    cells.push({
      date: key,
      dayNum: d.getDate(),
      isToday: d.getTime() === today.getTime(),
      isFuture,
      count: isFuture ? 0 : info.count,
      entries: info.entries,
    });
  }

  const maxCount = Math.max.apply(null, cells.map(c => c.count).concat(1));
  return { cells, maxCount };
}

function buildCalendarHtml(data) {
  const DAY_HEADS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const headHtml = DAY_HEADS.map(d => `<div class="cal-head">${d}</div>`).join('');

  function heatStyle(cell) {
    if (cell.isFuture) return 'background:transparent;border:1px dashed rgba(255,255,255,0.08)';
    if (!cell.count) return 'background:rgba(255,255,255,0.04)';
    const t = Math.min(cell.count / data.maxCount, 1);
    const alpha = 0.18 + t * 0.72;
    return `background:rgba(239,147,0,${alpha.toFixed(2)})`;
  }

  const cellsHtml = data.cells.map((cell, i) => {
    const classes = ['cal-cell'];
    if (cell.isToday) classes.push('today');
    if (cell.isFuture) classes.push('future');
    if (!cell.isFuture && cell.count) classes.push('has-entries');
    const clickAttr = (!cell.isFuture && cell.count) ? ` onclick="toggleDay(${i})"` : '';
    return `<div class="${classes.join(' ')}" style="${heatStyle(cell)}"${clickAttr}><span class="cal-daynum">${cell.dayNum}</span></div>`;
  }).join('');

  const entriesByDayJson = JSON.stringify(data.cells.map(c => ({ date: c.date, entries: c.entries }))).replace(/<\/script>/g, '<\\/script>');
  const typeColorsJson = JSON.stringify(TYPE_COLORS);

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="apple-touch-icon" href="${IN_ICON_DATA_URI}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="iN">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="theme-color" content="#0b1810">
<title>iN — Calendar</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#09080F;color:#E8E0F0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}
.header{padding:20px 16px 12px;border-bottom:1px solid rgba(255,255,255,0.07)}
.wordmark{font-size:26px;font-weight:300;letter-spacing:0.06em;color:#FFE9A8}
.section{padding:20px 16px}
.section-label{font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(212,255,89,0.45);margin-bottom:14px}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
.cal-head{text-align:center;font-size:24px;font-weight:700;letter-spacing:0.01em;text-transform:uppercase;color:rgba(155,142,196,0.75);padding-bottom:8px}
.cal-cell{aspect-ratio:1;border-radius:6px;position:relative}
.cal-cell.has-entries{cursor:pointer}
.cal-cell.has-entries:hover{outline:1px solid rgba(255,255,255,0.25)}
.cal-cell.today{outline:2px solid #d4ff59;outline-offset:1px}
.cal-daynum{position:absolute;top:3px;right:4px;font-size:16px;font-weight:600;color:rgba(255,255,255,0.75);text-shadow:0 1px 3px rgba(0,0,0,0.7)}
.cal-cell.future .cal-daynum{color:rgba(255,255,255,0.3);text-shadow:none}
.cal-hint{margin-top:10px;font-size:11px;color:rgba(155,142,196,0.4)}
.day-panel{margin-top:14px;border-top:1px solid rgba(255,255,255,0.08);padding-top:12px;display:none}
.day-panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.day-panel-title{font-size:20px;color:#d4ff59;letter-spacing:0.03em}
.day-panel-close{cursor:pointer;color:rgba(155,142,196,0.6);font-size:26px;padding:0 4px;line-height:1}
.day-entry{padding:20px 0;border-bottom:1px solid rgba(255,255,255,0.06)}
.day-entry:last-child{border-bottom:none}
.day-entry-cat-dot{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:9px;vertical-align:middle}
.day-entry-text{font-size:40px;line-height:1.4;color:#E8E0F0;word-break:break-word}
.day-inline-link{color:#d4ff59;word-break:break-all;text-decoration:underline;text-underline-offset:2px}
.day-meta-row{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}
.day-age{font-size:20px;color:rgba(155,142,196,0.55);letter-spacing:0.02em}
.day-cat-tag{font-size:20px;letter-spacing:0.02em;color:rgba(155,142,196,0.75)}
.day-badge{font-size:16px;letter-spacing:0.04em;padding:4px 12px;border-radius:20px;font-weight:600}
.day-badge-self{background:rgba(160,123,255,0.15);color:#A07BFF}
.day-badge-delegate{background:rgba(201,133,0,0.18);color:#e0a636}
.day-badge-automate{background:rgba(82,200,122,0.15);color:#52C87A}
</style>
</head><body>
<div class="header"><span class="wordmark">iN Calendar</span></div>
<div class="section">
  <div class="section-label">Last 5 weeks</div>
  <div class="cal-grid">${headHtml}${cellsHtml}</div>
  <div class="cal-hint">darker = more captures that day · tap a day to see what landed</div>
  <div id="dayPanel" class="day-panel">
    <div class="day-panel-head">
      <span class="day-panel-title" id="dayPanelTitle"></span>
      <span class="day-panel-close" onclick="closeDayPanel()">&times;</span>
    </div>
    <div id="dayPanelList"></div>
  </div>
</div>
<script>
window.onerror = function(msg, url, line, col, err) {
  var list = document.getElementById("dayPanelList");
  var panel = document.getElementById("dayPanel");
  var title = document.getElementById("dayPanelTitle");
  if (list && panel && title) {
    title.textContent = "Script error";
    list.innerHTML = '<div style="color:#ff6b6b;font-size:24px;padding:12px 0;line-height:1.4">' + msg + ' (line ' + line + ')</div>';
    panel.style.display = "block";
  }
  return false;
};
var ENTRIES_BY_DAY = ${entriesByDayJson};
var TYPE_COLORS_JS = ${typeColorsJson};
var AUTONOMY_BADGES = {
  self:     { label: 'self',     cls: 'day-badge-self' },
  delegate: { label: 'delegate', cls: 'day-badge-delegate' },
  automate: { label: 'automate', cls: 'day-badge-automate' },
};
var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
var openIdx = null;
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function linkify(s){return String(s).split(/(https?:\\/\\/[^\\s<>"]+)/g).map(function(part,i){if(i%2===1){var e=esc(part);var label=part.replace(/^https?:\\/\\/(?:www\\.)?/,"").split(/[/?#]/)[0];if(label.length>40)label=label.substring(0,40)+"…";return '<a href="'+e+'" target="_blank" class="day-inline-link">'+esc(label)+'</a>';}return esc(part);}).join("");}
function fmtTime(s){var d=new Date(s);if(isNaN(d))return"";var h=d.getHours();var m=d.getMinutes();var ap=h<12?"am":"pm";var h12=h%12||12;return h12+":"+(m<10?"0":"")+m+ap;}
function fmtDayHeading(key){var p=key.split("-");var d=new Date(parseInt(p[0]),parseInt(p[1])-1,parseInt(p[2]));return MONTHS[d.getMonth()]+" "+d.getDate();}
function closeDayPanel(){document.getElementById("dayPanel").style.display="none";openIdx=null;}
function toggleDay(i){
 try {
  var day=ENTRIES_BY_DAY[i];
  if(!day||!day.entries.length)return;
  if(openIdx===i){closeDayPanel();return;}
  openIdx=i;
  document.getElementById("dayPanelTitle").textContent=fmtDayHeading(day.date)+" · "+day.entries.length+" "+(day.entries.length===1?"entry":"entries");
  document.getElementById("dayPanelList").innerHTML=day.entries.map(function(e){
    var badge=AUTONOMY_BADGES[e.autonomy];
    return '<div class="day-entry">'+
      '<span class="day-entry-cat-dot" style="background:'+(TYPE_COLORS_JS[e.type]||"#9B8EC4")+'"></span>'+
      '<span class="day-entry-text">'+linkify(e.capture)+'</span>'+
      '<div class="day-meta-row">'+
        '<span class="day-age">'+fmtTime(e.created_at)+'</span>'+
        '<span class="day-cat-tag">'+esc(e.type)+'</span>'+
        (badge?'<span class="day-badge '+badge.cls+'">'+badge.label+'</span>':'')+
      '</div>'+
    '</div>';
  }).join("");
  document.getElementById("dayPanel").style.display="block";
 } catch (err) {
  var list=document.getElementById("dayPanelList");
  document.getElementById("dayPanelTitle").textContent="Script error in toggleDay";
  list.innerHTML='<div style="color:#ff6b6b;font-size:24px;padding:12px 0;line-height:1.4">'+err.message+'</div>';
  document.getElementById("dayPanel").style.display="block";
 }
}
</script>
</body></html>`;
}

function doGet(e) {
  try {
    const calData = getCalendarData();
    const html = buildCalendarHtml(calData);
    return HtmlService.createHtmlOutput(html)
      .setTitle('iN — Calendar')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return HtmlService.createHtmlOutput(
      '<body style="background:#09080F;color:#ff6b6b;font-family:monospace;padding:20px">' +
      '<b>Error in doGet:</b><br><pre>' + err.toString() + '\n' + (err.stack || '') + '</pre>' +
      '</body>'
    ).setTitle('iN — Error');
  }
}

// ── OPTIONAL EXTENSIONS ───────────────────────────────────────────────────────
// None of this is included in v1. Each is a real, working pattern from Amy's
// own pipeline — ask Claude to build it in when you're ready, pointing it at
// pkm-system/scripts/in_heartbeat.gs for the reference implementation to adapt.
//
// Journal OCR — handwritten journal pages (PDF) → Claude vision → tasks + gems.
// See in_heartbeat.gs's processFile/callClaude and the PROMPT constant for the
// extraction prompt and the Drive-folder polling pattern.
//
// Email-forward capture — forward a newsletter or email to a Gmail plus-alias
// of your own account (e.g. you+in@gmail.com), a Gmail filter labels it on
// arrival, and Apps Script's built-in GmailApp service reads that label on
// the same 15-minute trigger this pipeline already uses. No new account and
// no third-party service — the destination just has to be Gmail. This is a
// new function alongside processFormResponses, not a rewrite of anything here.
//
// Long-form voice — the Drive-drop path above already handles short voice
// transcripts as .txt files fine. For long, rambling dictation, consider
// having Claude chunk the transcript into multiple captures instead of one
// giant blob, so each idea lands as its own row instead of one entry with
// everything blended together.
