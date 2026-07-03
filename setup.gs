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

// ── WEB APP — Stats dashboard ────────────────────────────────────────────────
// A single page: when you capture, broken down by type, with a tap-to-reveal
// on each hour so you can see exactly what landed then. Deploy this file as
// a Web App (Deploy > New deployment > Web app, execute as yourself, who has
// access: Anyone — see README for why "Anyone" and not "Anyone with Google
// account") and the deployment URL is your dashboard link.
//
// Ported from Amy's own pkm-system/scripts/in_heartbeat.gs Pulse view,
// adapted to this kit's simpler schema (no journal-batch source to filter
// out — every row here already carries an accurate per-capture timestamp,
// see the createdAt fix above) and validated with the dataviz skill's
// categorical color formula against this page's dark surface (#09080F).

const IN_ICON_DATA_URI = 'https://i.imgur.com/4mCGlZg.png';

// Fixed order — same categorical-color assignment method as Amy's own Pulse
// view, just mapped onto this kit's task/thought/gem/question/resource types
// instead of her category taxonomy.
const CAPTURE_TYPES = ['task', 'thought', 'gem', 'question', 'resource'];
const TYPE_COLORS = {
  task: '#3987e5', thought: '#199e70', gem: '#c98500', question: '#008300', resource: '#9085e9',
};

function getStatsData() {
  const ss = SpreadsheetApp.openById(CONFIG.sheetId);
  const ws = ss.getSheetByName('Captures');
  if (!ws || ws.getLastRow() <= 1) {
    return {
      byHour: new Array(24).fill(0),
      byHourByType: new Array(24).fill(null).map(() => ({})),
      entriesByHour: new Array(24).fill(null).map(() => []),
      byType: {}, total: 0, withLinks: 0, peakHour: 0,
    };
  }

  const lastRow = ws.getLastRow();
  const data = ws.getRange(2, 1, lastRow - 1, CAPTURE_COLUMNS.length).getValues();
  const byHour = new Array(24).fill(0);
  const byHourByType = new Array(24).fill(null).map(() => ({}));
  const entriesByHour = new Array(24).fill(null).map(() => []);
  const byType = {};
  let total = 0;
  let withLinks = 0;

  data.forEach(r => {
    if (!r[0] || !r[5]) return; // id, capture
    total++;
    const type = r[6] || 'thought';
    if (r[1]) {
      const d = new Date(r[1]); // created_at
      if (!isNaN(d)) {
        const hr = d.getHours();
        byHour[hr]++;
        byHourByType[hr][type] = (byHourByType[hr][type] || 0) + 1;
        entriesByHour[hr].push({ capture: String(r[5]).substring(0, 200), type, created_at: r[1] });
      }
    }
    byType[type] = (byType[type] || 0) + 1;
    if (String(r[10] || '').match(/https?:\/\//)) withLinks++; // resources
  });

  entriesByHour.forEach(list => list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));

  const peakHour = byHour.indexOf(Math.max(...byHour));
  return { byHour, byHourByType, entriesByHour, byType, total, withLinks, peakHour };
}

function buildStatsHtml(stats) {
  function hourLabel(h) {
    if (h === 0) return 'midnight';
    if (h === 12) return 'noon';
    return h < 12 ? h + 'am' : (h - 12) + 'pm';
  }

  const maxCount = Math.max(...stats.byHour, 1);
  const barW = 12;
  const gap = 3;
  const chartH = 100;
  const totalW = 24 * (barW + gap) - gap;

  let bars = '';
  let hitRects = '';
  stats.byHour.forEach((count, i) => {
    if (!count) return;
    const h = Math.max(Math.round((count / maxCount) * chartH), 3);
    const x = i * (barW + gap);
    const typeCounts = stats.byHourByType[i] || {};
    let yCursor = chartH - h;
    CAPTURE_TYPES.forEach(type => {
      const segCount = typeCounts[type];
      if (!segCount) return;
      const segH = Math.max(Math.round((segCount / count) * h), 1);
      bars += `<rect x="${x}" y="${yCursor}" width="${barW}" height="${segH}" fill="${TYPE_COLORS[type] || '#9B8EC4'}" rx="1"/>`;
      yCursor += segH;
    });
    hitRects += `<rect class="hour-hit" x="${x - gap / 2}" y="0" width="${barW + gap}" height="${chartH}" fill="transparent" onclick="toggleHour(${i})"/>`;
  });

  let labelsSvg = '';
  [[0,'12a'],[6,'6a'],[12,'12p'],[18,'6p']].forEach(([h, label]) => {
    const x = h * (barW + gap) + barW / 2;
    labelsSvg += `<text x="${x}" y="${chartH + 18}" text-anchor="middle" fill="rgba(212,255,89,0.35)" font-size="9" font-family="-apple-system,sans-serif">${label}</text>`;
  });

  const hourChartSvg = `<svg viewBox="0 0 ${totalW} ${chartH + 24}" xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block">${bars}${hitRects}${labelsSvg}</svg>`;

  const hourLabels = new Array(24).fill(0).map((_, h) => hourLabel(h));
  const entriesByHourJson = JSON.stringify(stats.entriesByHour || []).replace(/<\/script>/g, '<\\/script>');
  const typeColorsJson = JSON.stringify(TYPE_COLORS);
  const hourLabelsJson = JSON.stringify(hourLabels);

  const legendHtml = CAPTURE_TYPES
    .filter(type => stats.byType[type])
    .map(type => `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px"><span style="width:9px;height:9px;border-radius:2px;background:${TYPE_COLORS[type]};display:inline-block"></span><span style="font-size:11px;color:rgba(155,142,196,0.6);letter-spacing:0.04em;text-transform:uppercase">${type}</span></span>`)
    .join('');

  const total = stats.total || 1;
  let typeBarsHtml = '';
  CAPTURE_TYPES.forEach(type => {
    const count = stats.byType[type] || 0;
    if (!count) return;
    const pct = Math.round(count / total * 100);
    const color = TYPE_COLORS[type] || '#9B8EC4';
    typeBarsHtml +=
      `<div style="margin-bottom:14px">` +
        `<div style="display:flex;justify-content:space-between;margin-bottom:5px">` +
          `<span style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:${color}">${type}</span>` +
          `<span style="font-size:13px;color:rgba(155,142,196,0.55)">${count}</span>` +
        `</div>` +
        `<div style="background:rgba(255,255,255,0.05);border-radius:3px;height:5px">` +
          `<div style="background:${color};width:${pct}%;height:5px;border-radius:3px;opacity:0.8"></div>` +
        `</div>` +
      `</div>`;
  });

  const linkPct = stats.total ? Math.round(stats.withLinks / stats.total * 100) : 0;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="apple-touch-icon" href="${IN_ICON_DATA_URI}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="iN">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="theme-color" content="#0b1810">
<title>iN — Stats</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#09080F;color:#E8E0F0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}
.header{padding:20px 16px 12px;border-bottom:1px solid rgba(255,255,255,0.07);display:flex;justify-content:space-between;align-items:baseline}
.wordmark{font-size:26px;font-weight:300;letter-spacing:0.06em;color:#FFE9A8}
.total-count{font-size:16px;color:#9B8EC4;letter-spacing:0.06em}
.section{padding:20px 16px;border-bottom:1px solid rgba(255,255,255,0.06)}
.section-label{font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(212,255,89,0.45);margin-bottom:14px}
.peak-note{margin-top:10px;font-size:16px;color:#d4ff59;letter-spacing:0.02em}
.stat-grid{display:flex;gap:24px}
.stat-box{flex:1}
.stat-n{font-size:36px;font-weight:300;color:#d4ff59;line-height:1;margin-bottom:4px}
.stat-label{font-size:11px;color:rgba(155,142,196,0.55);letter-spacing:0.08em;text-transform:uppercase}
.hour-hit{cursor:pointer}
.hour-hit:hover{fill:rgba(255,255,255,0.06)}
.hour-hint{margin-top:8px;font-size:11px;color:rgba(155,142,196,0.4)}
.hour-panel{margin-top:14px;border-top:1px solid rgba(255,255,255,0.08);padding-top:12px}
.hour-panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.hour-panel-title{font-size:13px;color:#d4ff59;letter-spacing:0.03em}
.hour-panel-close{cursor:pointer;color:rgba(155,142,196,0.6);font-size:18px;padding:0 4px;line-height:1}
.hour-entry{padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:14px;line-height:1.4}
.hour-entry:last-child{border-bottom:none}
.hour-entry-cat{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:7px;vertical-align:middle}
.hour-entry-time{color:rgba(155,142,196,0.5);font-size:11px;margin-left:6px;white-space:nowrap}
</style>
</head><body>
<div class="header">
  <span class="wordmark">iN Stats</span>
  <span class="total-count">${stats.total} captures</span>
</div>
<div class="section">
  <div class="section-label">Activity by hour</div>
  ${hourChartSvg}
  <div style="margin-top:10px">${legendHtml}</div>
  ${stats.byHour[stats.peakHour] > 0 ? `<div class="peak-note">peak: ${hourLabel(stats.peakHour)} · ${stats.byHour[stats.peakHour]} captures</div>` : ''}
  <div class="hour-hint">tap a bar to see what you captured then</div>
  <div id="hourPanel" class="hour-panel" style="display:none">
    <div class="hour-panel-head">
      <span class="hour-panel-title" id="hourPanelTitle"></span>
      <span class="hour-panel-close" onclick="closeHourPanel()">&times;</span>
    </div>
    <div id="hourPanelList"></div>
  </div>
</div>
<div class="section">
  <div class="section-label">Capture types</div>
  ${typeBarsHtml}
</div>
<div class="section">
  <div class="section-label">Quick stats</div>
  <div class="stat-grid">
    <div class="stat-box">
      <div class="stat-n">${stats.total}</div>
      <div class="stat-label">total captures</div>
    </div>
    <div class="stat-box">
      <div class="stat-n">${linkPct}%</div>
      <div class="stat-label">include a link</div>
    </div>
  </div>
</div>
<script>
var ENTRIES_BY_HOUR = ${entriesByHourJson};
var TYPE_COLORS_JS = ${typeColorsJson};
var HOUR_LABELS = ${hourLabelsJson};
var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
var openHour = null;
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function fmtDateTime(s){var d=new Date(s);if(isNaN(d))return"";var h=d.getHours();var m=d.getMinutes();var ap=h<12?"am":"pm";var h12=h%12||12;return MONTHS[d.getMonth()]+" "+d.getDate()+" · "+h12+":"+(m<10?"0":"")+m+ap;}
function closeHourPanel(){document.getElementById("hourPanel").style.display="none";openHour=null;}
function toggleHour(h){
  var list=ENTRIES_BY_HOUR[h]||[]; // already sorted newest-first in getStatsData()
  if(!list.length)return;
  if(openHour===h){closeHourPanel();return;}
  openHour=h;
  document.getElementById("hourPanelTitle").textContent=HOUR_LABELS[h]+" · "+list.length+" "+(list.length===1?"capture":"captures");
  document.getElementById("hourPanelList").innerHTML=list.map(function(e){
    return '<div class="hour-entry"><span class="hour-entry-cat" style="background:'+(TYPE_COLORS_JS[e.type]||"#9B8EC4")+'"></span>'+esc(e.capture)+'<span class="hour-entry-time">'+fmtDateTime(e.created_at)+'</span></div>';
  }).join("");
  document.getElementById("hourPanel").style.display="block";
}
</script>
</body></html>`;
}

function doGet(e) {
  try {
    const stats = getStatsData();
    const html = buildStatsHtml(stats);
    return HtmlService.createHtmlOutput(html)
      .setTitle('iN — Stats')
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
