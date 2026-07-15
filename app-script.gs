/**
 * WHO SHOT ME — backend script for the Google Sheet.
 *
 * Does three jobs:
 *   1. Auto-stamps a permanent Shoot ID onto any row a photographer edits
 *      directly in the sheet (same as before).
 *   2. Runs as a Web App so add-shoot.html can create/edit/delete shoots,
 *      add galleries, and read/update click stats — all without anyone
 *      needing to open the spreadsheet.
 *   3. Keeps a simple daily page-view count (SiteVisits tab) so you can
 *      see roughly how much the public map gets used, without any
 *      third-party analytics tool. Check numbers by opening that tab.
 *
 * SETUP (one-time):
 * 1. Open the Google Sheet, then Extensions > Apps Script.
 * 2. Delete any starter code and paste this whole file in. Save.
 * 3. Click the clock icon (Triggers) > Add Trigger.
 *      Function to run: stampShootId
 *      Event source: From spreadsheet
 *      Event type: On edit
 *    Save, and grant the permissions it asks for.
 * 4. Click Deploy > New deployment > gear icon > Web app.
 *      Execute as: Me
 *      Who has access: Anyone
 *    Deploy, grant permissions again if asked, and copy the URL it gives
 *    you (ends in /exec). That's your APPS_SCRIPT_URL for both HTML files.
 * 5. Every photographer needs a "Secret Key" — see the Photographers tab,
 *    column F. Generate a random one for each (anything unguessable — a
 *    password generator's fine) and share it with them privately, along
 *    with their "Shoot Tab Name" (column E). Their personal link is:
 *      add-shoot.html?p=SHOOT_TAB_NAME&key=THEIR_SECRET_KEY
 * 6. If you've moved the Photographers tab to its own separate spreadsheet
 *    (see the migration guide), set PHOTOGRAPHERS_SPREADSHEET_ID below to
 *    that spreadsheet's ID. Leave it blank if Photographers still lives in
 *    this same spreadsheet.
 *
 * IMPORTANT: if you ever change the code below, you must Deploy > Manage
 * deployments > edit (pencil) > New version > Deploy again for the change
 * to actually take effect — saving the file alone only updates what you
 * see in the editor, not what the live /exec URL runs.
 */

const PHOTOGRAPHERS_SHEET = 'Photographers';
const STATS_SHEET = 'Stats';
const SITE_VISITS_SHEET = 'SiteVisits';
const STATS_COLUMNS = { popup_open: 2, gallery_click: 3, page_link_click: 4 };

// If the Photographers tab (with everyone's Secret Key) has been moved out
// to its own separate, tightly-restricted spreadsheet — see the migration
// guide — paste that spreadsheet's ID here (the long string in its URL:
// docs.google.com/spreadsheets/d/THIS_PART/edit). Leave blank to keep
// reading Photographers from this same spreadsheet, as before.
const PHOTOGRAPHERS_SPREADSHEET_ID = '';

function getPhotographersSheet() {
  if (PHOTOGRAPHERS_SPREADSHEET_ID) {
    return SpreadsheetApp.openById(PHOTOGRAPHERS_SPREADSHEET_ID).getSheetByName(PHOTOGRAPHERS_SHEET);
  }
  return SpreadsheetApp.getActive().getSheetByName(PHOTOGRAPHERS_SHEET);
}

// Google Sheets treats a cell value starting with =, +, -, or @ as a
// formula regardless of whether it was typed by hand or set via
// Range.setValue() from a script — including values submitted through
// this Web App. A photographer submitting a Location Name like
// "=IMPORTXML(...)" would otherwise turn their own cell into a live,
// potentially data-exfiltrating formula. A leading apostrophe forces
// Sheets to treat it as plain text, same as it would if typed manually.
function sanitizeForCell(value){
  var s = String(value == null ? '' : value);
  if (/^[=+\-@]/.test(s)) return "'" + s;
  return s;
}

// =========================================================================
// PART 1 — auto-stamping Shoot IDs on manual sheet edits (unchanged from
// before; still useful as a safety net if you ever edit a tab by hand).
// =========================================================================
function stampShootId(e) {
  var sheet = e.range.getSheet();
  if (!isShootTab(sheet)) return;

  var startRow = e.range.getRow();
  var numRows = e.range.getNumRows();

  for (var i = 0; i < numRows; i++) {
    maybeStamp(sheet, startRow + i);
  }
}

function isShootTab(sheet) {
  return sheet.getRange('A1').getValue() === 'Photographer Name:';
}

function maybeStamp(sheet, row) {
  if (row < 4) return;

  var idCell = sheet.getRange(row, 1);
  var locationCell = sheet.getRange(row, 2);

  if (idCell.getValue() !== '') return;
  if (locationCell.getValue() === '') return;

  idCell.setValue(makeShootId(sheet));
}

function makeShootId(sheet) {
  var nameParts = String(sheet.getRange('B1').getValue()).trim().split(/\s+/);
  var prefix = nameParts.map(function (w) { return w.charAt(0); }).join('').toUpperCase();
  if (!prefix) prefix = sheet.getName().substring(0, 2).toUpperCase();
  return prefix + '-' + Utilities.getUuid().substring(0, 6);
}

// =========================================================================
// PART 2 — the Web App itself.
//
// Reads (list shoots, read stats) come in as GET requests with query
// params. Writes (create/update/delete/add gallery/track a click) come in
// as POST requests with a JSON body.
//
// Why POST bodies are sent as plain text rather than application/json:
// browsers send a CORS "preflight" check before certain cross-origin
// requests, and Apps Script Web Apps can't respond to that preflight.
// Sending the JSON as a text/plain body (and JSON.parse-ing it here on
// the server) counts as a "simple request" and skips the preflight
// entirely — this only works if the client fetch() call does NOT set a
// custom Content-Type or any other custom header. Both HTML files already
// do this correctly; if you ever add a new fetch() call to either site,
// keep that in mind or it'll silently fail with a CORS error.
// =========================================================================

function doGet(e) {
  try {
    var action = e.parameter.action;
    var p = e.parameter.p;
    var key = e.parameter.key;

    if (action === 'myShoots') return jsonOut(getMyShoots(p, key));
    if (action === 'stats') return jsonOut(getStats(p, key));

    return jsonOut({ error: 'Unknown action' });
  } catch (err) {
    return jsonOut({ error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;

    // Click tracking and the page-view counter are intentionally public —
    // any visitor's browser can send these, no secret key needed, since
    // they're just counters, not writes to a photographer's actual data.
    if (action === 'trackEvent') {
      return jsonOut(trackEvent(body.p, body.type));
    }
    if (action === 'trackPageView') {
      return jsonOut(trackPageView());
    }

    if (!authenticate(body.p, body.key)) {
      return jsonOut({ error: 'Not authorized' });
    }

    if (action === 'createShoot') return jsonOut(createShoot(body.p, body.shoot));
    if (action === 'updateShoot') return jsonOut(updateShoot(body.p, body.shootId, body.shoot));
    if (action === 'deleteShoot') return jsonOut(deleteShoot(body.p, body.shootId));
    if (action === 'addGallery') return jsonOut(addGallery(body.p, body.shootId, body.label, body.url));
    if (action === 'updateGallery') return jsonOut(updateGallery(body.p, body.shootId, body.row, body.label, body.url));
    if (action === 'deleteGallery') return jsonOut(deleteGallery(body.p, body.shootId, body.row));

    return jsonOut({ error: 'Unknown action' });
  } catch (err) {
    return jsonOut({ error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---- auth ---------------------------------------------------------------

function findPhotographerRow(tabName) {
  var sheet = getPhotographersSheet();
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var tabCol = headers.indexOf('Shoot Tab Name');
  var keyCol = headers.indexOf('Secret Key');
  for (var i = 1; i < data.length; i++) {
    if (data[i][tabCol] === tabName) {
      return { row: data[i], keyCol: keyCol };
    }
  }
  return null;
}

function authenticate(tabName, key) {
  var found = findPhotographerRow(tabName);
  if (!found || !key) return false;
  return String(found.row[found.keyCol]) === String(key);
}

// ---- shoots ---------------------------------------------------------------

// Some Start/End cells may already have been corrupted into real Date
// values by the bug this file's other fixes address (Sheets silently
// auto-converts a "YYYY-MM-DD HH:MM" string into a Date on write, unless
// the cell is explicitly formatted as plain text first — see
// createShoot/updateShoot). Any row written before that fix — or edited
// directly in the sheet by hand — can still be a Date object here.
// Normalize it back to the plain string the front-end expects, rather
// than depending solely on manually re-typing affected cells.
function formatDateCell(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, 'Europe/London', 'yyyy-MM-dd HH:mm');
  }
  return value;
}

function getMyShoots(p, key) {
  if (!authenticate(p, key)) return { error: 'Not authorized' };
  var sheet = SpreadsheetApp.getActive().getSheetByName(p);
  if (!sheet) return { error: 'Unknown photographer tab' };

  var galleries = getGalleriesForTab(p);
  var data = sheet.getRange('A4:G').getValues();
  var shoots = [];
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var shootId = row[0], location = row[1];
    if (!location) continue;
    shoots.push({
      shootId: shootId,
      location: location,
      description: row[2] || '',
      lat: row[3],
      lng: row[4],
      start: formatDateCell(row[5]),
      end: formatDateCell(row[6]),
      galleries: galleries[shootId] || []
    });
  }
  return { shoots: shoots };
}

function validateShoot(shoot) {
  if (!shoot || !String(shoot.location || '').trim()) return 'Location is required';
  if (typeof shoot.lat !== 'number' || isNaN(shoot.lat)) return 'Lat must be a number';
  if (typeof shoot.lng !== 'number' || isNaN(shoot.lng)) return 'Lng must be a number';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(shoot.start || '')) return 'Start must look like "2026-06-30 08:00"';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(shoot.end || '')) return 'End must look like "2026-06-30 11:00"';
  if (String(shoot.end) <= String(shoot.start)) return 'End time must be after the start time';
  return null;
}

function createShoot(p, shoot) {
  var problem = validateShoot(shoot);
  if (problem) return { error: problem };

  var sheet = SpreadsheetApp.getActive().getSheetByName(p);
  if (!sheet) return { error: 'Unknown photographer tab' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var newRow = findLastDataRow(sheet) + 1;
    var shootId = makeShootId(sheet);
    // Force Start/End (columns F, G) to plain text BEFORE writing. Without
    // this, Sheets auto-detects the "YYYY-MM-DD HH:MM" string as a
    // date/time and silently converts the cell into a real Date value —
    // exactly as if someone had typed it in by hand. Reading that cell
    // back later then returns a JS Date object instead of the original
    // string, which breaks the front-end's date parser (see parseUKDateTime
    // in index.html / add-shoot.html for the read-side half of this fix).
    sheet.getRange(newRow, 6, 1, 2).setNumberFormat('@');
    sheet.getRange(newRow, 1, 1, 7).setValues([[
      shootId, sanitizeForCell(shoot.location), sanitizeForCell(shoot.description || ''), shoot.lat, shoot.lng, shoot.start, shoot.end
    ]]);
    return { shootId: shootId };
  } finally {
    lock.releaseLock();
  }
}

function updateShoot(p, shootId, shoot) {
  var problem = validateShoot(shoot);
  if (problem) return { error: problem };

  var sheet = SpreadsheetApp.getActive().getSheetByName(p);
  if (!sheet) return { error: 'Unknown photographer tab' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var rowIndex = findRowByShootId(sheet, shootId);
    if (!rowIndex) return { error: 'Shoot not found' };

    // Same fix as createShoot — force plain text before writing, so an
    // edit can't re-trigger the same auto-conversion on an existing row.
    sheet.getRange(rowIndex, 6, 1, 2).setNumberFormat('@');
    sheet.getRange(rowIndex, 2, 1, 6).setValues([[
      sanitizeForCell(shoot.location), sanitizeForCell(shoot.description || ''), shoot.lat, shoot.lng, shoot.start, shoot.end
    ]]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// A real delete, not just clearing the row — see the conversation this
// script came out of for why that's safe here: Shoot IDs are random and
// never reused, and Combined reads by row position, not by ID lookup, so
// nothing downstream can end up pointing at the wrong shoot afterwards.
function deleteShoot(p, shootId) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(p);
  if (!sheet) return { error: 'Unknown photographer tab' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var rowIndex = findRowByShootId(sheet, shootId);
    if (rowIndex) sheet.deleteRow(rowIndex);

    var gSheet = SpreadsheetApp.getActive().getSheetByName(p + 'Galleries');
    // Guard: getLastRow() is 1 when a galleries tab has only its header
    // row (true for every brand-new photographer). 'A2:A1' is an invalid
    // range and throws, so skip the scan entirely when there's nothing
    // to scan rather than trying to build that range.
    if (gSheet && gSheet.getLastRow() >= 2) {
      var data = gSheet.getRange('A2:A' + gSheet.getLastRow()).getValues();
      for (var i = data.length - 1; i >= 0; i--) {
        if (data[i][0] === shootId) gSheet.deleteRow(i + 2);
      }
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function findLastDataRow(sheet) {
  var data = sheet.getRange('B4:B').getValues();
  var last = 3;
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] !== '') last = i + 4;
  }
  return last;
}

function findRowByShootId(sheet, shootId) {
  var data = sheet.getRange('A4:A').getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === shootId) return i + 4;
  }
  return null;
}

// ---- galleries ------------------------------------------------------------

function getGalleriesForTab(p) {
  var gSheet = SpreadsheetApp.getActive().getSheetByName(p + 'Galleries');
  if (!gSheet || gSheet.getLastRow() < 2) return {};
  var data = gSheet.getRange('A2:C' + gSheet.getLastRow()).getValues();
  var map = {};
  for (var i = 0; i < data.length; i++) {
    var id = data[i][0];
    if (!id) continue;
    if (!map[id]) map[id] = [];
    // row is the gallery's actual sheet row (1-based) — the dashboard
    // sends this back on edit/delete so we know exactly which row to
    // touch, since galleries have no ID column of their own.
    map[id].push({ label: data[i][1], url: data[i][2], row: i + 2 });
  }
  return map;
}

// Photographers commonly paste a URL copied straight from a browser's
// address bar, which omits the scheme (e.g. "www.instagram.com/theirpage")
// far more often than not. Rather than rejecting that, default it to
// http:// — browsers themselves upgrade to https automatically if the
// site supports it (and if it doesn't, http:// is at least still a
// working link, unlike bouncing the photographer's submission entirely).
// A URL that already starts with http:// or https:// passes through
// untouched.
function normalizeGalleryUrl(url) {
  var cleanUrl = String(url || '').trim();
  if (!cleanUrl) return '';
  if (!/^https?:\/\//i.test(cleanUrl)) cleanUrl = 'http://' + cleanUrl;
  return cleanUrl;
}

function addGallery(p, shootId, label, url) {
  var cleanUrl = normalizeGalleryUrl(url);
  if (!cleanUrl) return { error: 'Gallery URL is required' };

  var sheet = SpreadsheetApp.getActive().getSheetByName(p);
  if (!sheet || !findRowByShootId(sheet, shootId)) {
    return { error: "That shoot wasn't found for this photographer" };
  }

  var gSheet = SpreadsheetApp.getActive().getSheetByName(p + 'Galleries');
  if (!gSheet) return { error: 'Galleries tab not found' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var row = gSheet.getLastRow() + 1;
    gSheet.getRange(row, 1, 1, 3).setValues([[shootId, sanitizeForCell(label || 'Gallery'), cleanUrl]]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// row is the gallery's own sheet row, as returned by getMyShoots (via
// getGalleriesForTab). We re-check that row's Shoot ID still matches the
// shootId the client thinks it's editing, both as a sanity check against
// a stale row number (e.g. another gallery was deleted in between,
// shifting rows) and so a photographer can never touch a row outside
// their own galleries tab even if a row number were tampered with.
function updateGallery(p, shootId, row, label, url) {
  var cleanUrl = normalizeGalleryUrl(url);
  if (!cleanUrl) return { error: 'Gallery URL is required' };

  var gSheet = SpreadsheetApp.getActive().getSheetByName(p + 'Galleries');
  if (!gSheet) return { error: 'Galleries tab not found' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var rowNum = Number(row);
    if (!rowNum || rowNum < 2 || rowNum > gSheet.getLastRow()) return { error: 'Gallery not found' };
    if (gSheet.getRange(rowNum, 1).getValue() !== shootId) return { error: 'Gallery not found' };
    gSheet.getRange(rowNum, 2, 1, 2).setValues([[sanitizeForCell(label || 'Gallery'), cleanUrl]]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function deleteGallery(p, shootId, row) {
  var gSheet = SpreadsheetApp.getActive().getSheetByName(p + 'Galleries');
  if (!gSheet) return { error: 'Galleries tab not found' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var rowNum = Number(row);
    if (!rowNum || rowNum < 2 || rowNum > gSheet.getLastRow()) return { error: 'Gallery not found' };
    if (gSheet.getRange(rowNum, 1).getValue() !== shootId) return { error: 'Gallery not found' };
    gSheet.deleteRow(rowNum);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---- stats ------------------------------------------------------------

function trackEvent(p, type) {
  var col = STATS_COLUMNS[type];
  if (!col || !p) return { ok: false };

  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var sheet = SpreadsheetApp.getActive().getSheetByName(STATS_SHEET);
    var rowIndex = null;
    if (sheet.getLastRow() >= 2) {
      var data = sheet.getRange('A2:A' + sheet.getLastRow()).getValues();
      for (var i = 0; i < data.length; i++) {
        if (data[i][0] === p) { rowIndex = i + 2; break; }
      }
    }
    if (!rowIndex) {
      rowIndex = sheet.getLastRow() + 1;
      sheet.getRange(rowIndex, 1).setValue(p);
      sheet.getRange(rowIndex, 2, 1, 3).setValues([[0, 0, 0]]);
    }
    var cell = sheet.getRange(rowIndex, col);
    cell.setValue((Number(cell.getValue()) || 0) + 1);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---- site-wide visitor count ------------------------------------------

// One row per calendar day (Europe/London), incremented once per page
// load. No visitor identifier of any kind is stored — this is a plain
// counter, not attempting to deduplicate repeat visits into "uniques".
function trackPageView() {
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var sheet = SpreadsheetApp.getActive().getSheetByName(SITE_VISITS_SHEET);
    if (!sheet) return { ok: false };

    var today = Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd');
    var rowIndex = null;
    if (sheet.getLastRow() >= 2) {
      var data = sheet.getRange('A2:A' + sheet.getLastRow()).getValues();
      for (var i = 0; i < data.length; i++) {
        if (data[i][0] === today) { rowIndex = i + 2; break; }
      }
    }
    if (!rowIndex) {
      rowIndex = sheet.getLastRow() + 1;
      sheet.getRange(rowIndex, 1).setValue(today);
      sheet.getRange(rowIndex, 2).setValue(0);
    }
    var cell = sheet.getRange(rowIndex, 2);
    cell.setValue((Number(cell.getValue()) || 0) + 1);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function getStats(p, key) {
  if (!authenticate(p, key)) return { error: 'Not authorized' };
  var sheet = SpreadsheetApp.getActive().getSheetByName(STATS_SHEET);
  if (sheet.getLastRow() >= 2) {
    var data = sheet.getRange('A2:D' + sheet.getLastRow()).getValues();
    for (var i = 0; i < data.length; i++) {
      if (data[i][0] === p) {
        return { popupOpens: data[i][1] || 0, galleryClicks: data[i][2] || 0, pageLinkClicks: data[i][3] || 0 };
      }
    }
  }
  return { popupOpens: 0, galleryClicks: 0, pageLinkClicks: 0 };
}
