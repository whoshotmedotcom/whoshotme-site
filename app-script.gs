/**
 * WHO SHOT ME — backend script for the Google Sheet.
 *
 * Does three jobs:
 *   1. Auto-stamps a permanent Shoot ID onto any row a photographer edits
 *      directly in the sheet (same as before).
 *   2. Runs as a Web App so add-shoot.html can create/edit/delete shoots,
 *      add galleries, and read/update click stats — all without anyone
 *      needing to open the spreadsheet.
 *   3. Keeps a simple daily page-view count (SiteVisits tab) and daily
 *      counts of specific interactions - basemap switches, search usage,
 *      "My location" usage (SiteEvents tab, one row per day+event type) -
 *      so you can see roughly how the public map actually gets used,
 *      without any third-party analytics tool. Check numbers by opening
 *      those tabs directly. SiteEvents needs three columns: Date,
 *      EventType, Count.
 *
 * ARCHITECTURE (v3 — shared Shoots/Galleries tabs):
 * All photographers' shoots live in ONE "Shoots" tab, all galleries in ONE
 * "Galleries" tab, distinguished by a Shoot Tab Name column on each row -
 * not one pair of tabs per photographer like earlier versions of this
 * script. This means adding a new photographer is just one row in the
 * Photographers workbook - no tabs to create, no formulas to edit. See
 * "ADDING A NEW PHOTOGRAPHER" below.
 *
 * Because everyone's data now shares one sheet instead of being isolated
 * by tab, every write (update/delete a shoot, add/edit/delete a gallery)
 * explicitly re-checks that the row being touched actually belongs to the
 * authenticated photographer (p) before allowing it - see the comments on
 * updateShoot/deleteShoot/addGallery/updateGallery/deleteGallery. This
 * used to be implicit (a photographer's Apps Script calls only ever
 * looked at their own tab, so there was nothing else to touch); it isn't
 * implicit anymore, so don't remove those checks when editing this file.
 *
 * SHEET LAYOUTS:
 *   Shoots:    A=Shoot ID, B=Location Name, C=Description, D=Lat, E=Lng,
 *              F=Start, G=End, H=Shoot Tab Name. Header row 1, data from
 *              row 2 (no more 3-row per-tab header block).
 *   Galleries: A=Shoot ID, B=Gallery Label, C=Gallery URL,
 *              D=Shoot Tab Name. Header row 1, data from row 2.
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
 * ADDING A NEW PHOTOGRAPHER (this is now the entire process):
 * 1. Add a row for them in the Photographers workbook: name, logo,
 *    website, contact email, a new unique Shoot Tab Name (any short
 *    identifier with no spaces, e.g. "NewPhotographer" - it's just a
 *    value in a column now, not an actual sheet tab), and a freshly
 *    generated Secret Key.
 * 2. Send them their personal add-shoot.html link (see step 5 above).
 * That's it - no tabs to create, no formulas to touch. Their shoots will
 * appear in Combined/Combined Galleries automatically the moment they
 * save their first one, because those formulas read the shared Shoots/
 * Galleries tabs directly rather than naming tabs individually.
 *
 * IMPORTANT: if you ever change the code below, you must Deploy > Manage
 * deployments > edit (pencil) > New version > Deploy again for the change
 * to actually take effect — saving the file alone only updates what you
 * see in the editor, not what the live /exec URL runs.
 */

const PHOTOGRAPHERS_SHEET = 'Photographers';
const SHOOTS_SHEET = 'Shoots';
const GALLERIES_SHEET = 'Galleries';
const STATS_SHEET = 'Stats';
const SITE_VISITS_SHEET = 'SiteVisits';
const SITE_EVENTS_SHEET = 'SiteEvents';
const STATS_COLUMNS = { popup_open: 2, gallery_click: 3, page_link_click: 4 };
// Any lowercase_with_underscores identifier up to 40 chars — deliberately
// not a fixed allow-list of exact event names (unlike STATS_COLUMNS above)
// so a new basemap added to the layer switcher in index.html doesn't also
// need a matching update here. Still narrow enough to keep this a plain
// counter, not a place to smuggle arbitrary text into the sheet.
const SITE_EVENT_TYPE_RE = /^[a-z0-9_]{1,40}$/;

// If the Photographers tab (with everyone's Secret Key) has been moved out
// to its own separate, tightly-restricted spreadsheet — see the migration
// guide — paste that spreadsheet's ID here (the long string in its URL:
// docs.google.com/spreadsheets/d/THIS_PART/edit). Leave blank to keep
// reading Photographers from this same spreadsheet, as before.
//
// Deliberately left blank in this public repo — the real ID is set
// directly in the live Apps Script deployment instead, not committed
// here, since this repo is public and that spreadsheet holds every
// photographer's Secret Key.
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
// PART 1 — auto-stamping Shoot IDs on manual sheet edits (a fallback for
// hand-editing the Shoots tab directly; most shoots are stamped by the Web
// App itself instead, see createShoot below).
// =========================================================================
function stampShootId(e) {
  var sheet = e.range.getSheet();
  if (sheet.getName() !== SHOOTS_SHEET) return;

  var startRow = e.range.getRow();
  var numRows = e.range.getNumRows();

  for (var i = 0; i < numRows; i++) {
    maybeStamp(sheet, startRow + i);
  }
}

function maybeStamp(sheet, row) {
  if (row < 2) return; // header row

  var idCell = sheet.getRange(row, 1);
  var locationCell = sheet.getRange(row, 2);
  var tabNameCell = sheet.getRange(row, 8);

  if (idCell.getValue() !== '') return;
  if (locationCell.getValue() === '') return;
  if (tabNameCell.getValue() === '') return; // don't stamp until we know whose shoot this is

  idCell.setValue(makeShootId(sheet, tabNameCell.getValue()));
}

// Prefix is derived from the Shoot Tab Name itself now (e.g. "DavesShots"
// -> "DS"), splitting on capital letters — there's no longer a per-tab B1
// header cell with a separate display name to read, since Shoot Tab Name
// is just a column value shared across everyone's rows in one sheet.
//
// The random suffix makes a collision unlikely but not impossible
// (two photographers with similar names share a prefix, e.g. "PeakPursuit"
// and "PhilPhotography" both -> "PP"), so this checks the generated ID
// against existing rows and retries rather than trusting the odds.
function makeShootId(sheet, shootTabName) {
  var prefix = shootTabNamePrefix(shootTabName);
  for (var attempt = 0; attempt < 10; attempt++) {
    var candidate = prefix + '-' + Utilities.getUuid().substring(0, 6);
    if (findRowByShootId(sheet, candidate) === null) return candidate;
  }
  // 10 straight collisions on a 16.7M-value space would mean something is
  // very wrong, but fail safe with a longer suffix rather than looping forever.
  return prefix + '-' + Utilities.getUuid().replace(/-/g, '').substring(0, 12);
}

function shootTabNamePrefix(shootTabName) {
  var name = String(shootTabName || '');
  // Two alternatives so a trailing acronym stays one "word" instead of
  // splitting into separate letters - "TrailShotsUK" -> Trail/Shots/UK
  // (initials TSU), not Trail/Shots/U/K (TSUK). A run of capitals only
  // matches as its own word when NOT followed by a lowercase letter;
  // otherwise the normal "one capital + following lowercase" word wins.
  var words = name.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*/g);
  if (words && words.length) {
    var initials = words.map(function (w) { return w.charAt(0); }).join('').toUpperCase();
    if (initials) return initials;
  }
  return (name.substring(0, 2) || 'XX').toUpperCase();
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
    if (action === 'trackSiteEvent') {
      return jsonOut(trackSiteEvent(body.type));
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
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHOOTS_SHEET);
  if (!sheet) return { error: 'Shoots tab not found' };

  var galleries = getGalleriesForTab(p);
  var data = sheet.getDataRange().getValues();
  var shoots = [];
  for (var i = 1; i < data.length; i++) { // start at 1 to skip the header row
    var row = data[i];
    var shootId = row[0], location = row[1], tabName = row[7];
    if (!location) continue;
    if (tabName !== p) continue; // only this photographer's own shoots
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
  // Same box as UK_BOUNDS in add-shoot.html — keep these in sync.
  if (shoot.lat < 49.5 || shoot.lat > 61.2 || shoot.lng < -10.9 || shoot.lng > 2.1) return 'Coordinates must be within the UK';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(shoot.start || '')) return 'Start must look like "2026-06-30 08:00"';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(shoot.end || '')) return 'End must look like "2026-06-30 11:00"';
  if (String(shoot.end) <= String(shoot.start)) return 'End time must be after the start time';
  return null;
}

function createShoot(p, shoot) {
  var problem = validateShoot(shoot);
  if (problem) return { error: problem };

  var sheet = SpreadsheetApp.getActive().getSheetByName(SHOOTS_SHEET);
  if (!sheet) return { error: 'Shoots tab not found' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var newRow = findLastDataRow(sheet) + 1;
    var shootId = makeShootId(sheet, p);
    // Force Start/End (columns F, G) to plain text BEFORE writing. Without
    // this, Sheets auto-detects the "YYYY-MM-DD HH:MM" string as a
    // date/time and silently converts the cell into a real Date value —
    // exactly as if someone had typed it in by hand. Reading that cell
    // back later then returns a JS Date object instead of the original
    // string, which breaks the front-end's date parser (see parseUKDateTime
    // in index.html / add-shoot.html for the read-side half of this fix).
    sheet.getRange(newRow, 6, 1, 2).setNumberFormat('@');
    sheet.getRange(newRow, 1, 1, 8).setValues([[
      shootId, sanitizeForCell(shoot.location), sanitizeForCell(shoot.description || ''), shoot.lat, shoot.lng, shoot.start, shoot.end, p
    ]]);
    return { shootId: shootId };
  } finally {
    lock.releaseLock();
  }
}

function updateShoot(p, shootId, shoot) {
  var problem = validateShoot(shoot);
  if (problem) return { error: problem };

  var sheet = SpreadsheetApp.getActive().getSheetByName(SHOOTS_SHEET);
  if (!sheet) return { error: 'Shoots tab not found' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var rowIndex = findRowByShootId(sheet, shootId);
    // Same generic "Shoot not found" whether the ID doesn't exist at all
    // or it exists but belongs to a different photographer — deliberately
    // not a different error message for the second case, so a photographer
    // poking at someone else's Shoot ID can't use the error text to
    // confirm whether that ID is real. This ownership check is the whole
    // reason writes are safe now that everyone's shoots share one sheet —
    // don't remove it.
    if (!rowIndex || sheet.getRange(rowIndex, 8).getValue() !== p) return { error: 'Shoot not found' };

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

// A real delete, not just clearing the row — Shoot IDs are random and
// never reused, and Combined reads by row position, not by ID lookup, so
// nothing downstream can end up pointing at the wrong shoot afterwards.
function deleteShoot(p, shootId) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHOOTS_SHEET);
  if (!sheet) return { error: 'Shoots tab not found' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var rowIndex = findRowByShootId(sheet, shootId);
    // Capture the ownership check BEFORE deleting — can't re-read the row
    // to check it afterwards. A shoot that isn't found or isn't p's own is
    // silently a no-op (same "not found = fine" tolerance as before),
    // never an error, and — same reasoning as updateShoot above — never
    // touches anything belonging to someone else.
    var owned = rowIndex && sheet.getRange(rowIndex, 8).getValue() === p;
    if (owned) sheet.deleteRow(rowIndex);

    var gSheet = SpreadsheetApp.getActive().getSheetByName(GALLERIES_SHEET);
    if (owned && gSheet && gSheet.getLastRow() >= 2) {
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
  var data = sheet.getRange('B2:B').getValues();
  var last = 1; // header is row 1 — 1 means "no data rows yet"
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] !== '') last = i + 2;
  }
  return last;
}

function findRowByShootId(sheet, shootId) {
  if (sheet.getLastRow() < 2) return null;
  var data = sheet.getRange('A2:A' + sheet.getLastRow()).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === shootId) return i + 2;
  }
  return null;
}

// ---- galleries ------------------------------------------------------------

function getGalleriesForTab(p) {
  var gSheet = SpreadsheetApp.getActive().getSheetByName(GALLERIES_SHEET);
  if (!gSheet || gSheet.getLastRow() < 2) return {};
  var data = gSheet.getRange('A2:D' + gSheet.getLastRow()).getValues();
  var map = {};
  for (var i = 0; i < data.length; i++) {
    var id = data[i][0], tabName = data[i][3];
    if (!id || tabName !== p) continue;
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
  if (!String(label || '').trim()) return { error: 'Gallery label is required' };
  var cleanUrl = normalizeGalleryUrl(url);
  if (!cleanUrl) return { error: 'Gallery URL is required' };

  var sheet = SpreadsheetApp.getActive().getSheetByName(SHOOTS_SHEET);
  var shootRow = sheet ? findRowByShootId(sheet, shootId) : null;
  // Same ownership check as updateShoot — the shoot this gallery is being
  // attached to has to actually belong to p, not just exist.
  if (!shootRow || sheet.getRange(shootRow, 8).getValue() !== p) {
    return { error: "That shoot wasn't found for this photographer" };
  }

  var gSheet = SpreadsheetApp.getActive().getSheetByName(GALLERIES_SHEET);
  if (!gSheet) return { error: 'Galleries tab not found' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var row = gSheet.getLastRow() + 1;
    gSheet.getRange(row, 1, 1, 4).setValues([[shootId, sanitizeForCell(label || 'Gallery'), cleanUrl, p]]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// row is the gallery's own sheet row, as returned by getMyShoots (via
// getGalleriesForTab). Re-checks that row's Shoot ID still matches the
// shootId the client thinks it's editing (sanity check against a stale
// row number, e.g. another gallery was deleted in between, shifting rows)
// AND that its Shoot Tab Name column matches p — that second check is
// what actually stops a photographer touching a row outside their own
// galleries now that everyone's galleries share one sheet.
function updateGallery(p, shootId, row, label, url) {
  if (!String(label || '').trim()) return { error: 'Gallery label is required' };
  var cleanUrl = normalizeGalleryUrl(url);
  if (!cleanUrl) return { error: 'Gallery URL is required' };

  var gSheet = SpreadsheetApp.getActive().getSheetByName(GALLERIES_SHEET);
  if (!gSheet) return { error: 'Galleries tab not found' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var rowNum = Number(row);
    if (!rowNum || rowNum < 2 || rowNum > gSheet.getLastRow()) return { error: 'Gallery not found' };
    var rowValues = gSheet.getRange(rowNum, 1, 1, 4).getValues()[0];
    if (rowValues[0] !== shootId || rowValues[3] !== p) return { error: 'Gallery not found' };
    gSheet.getRange(rowNum, 2, 1, 2).setValues([[sanitizeForCell(label || 'Gallery'), cleanUrl]]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function deleteGallery(p, shootId, row) {
  var gSheet = SpreadsheetApp.getActive().getSheetByName(GALLERIES_SHEET);
  if (!gSheet) return { error: 'Galleries tab not found' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var rowNum = Number(row);
    if (!rowNum || rowNum < 2 || rowNum > gSheet.getLastRow()) return { error: 'Gallery not found' };
    var rowValues = gSheet.getRange(rowNum, 1, 1, 4).getValues()[0];
    if (rowValues[0] !== shootId || rowValues[3] !== p) return { error: 'Gallery not found' };
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
      // Force column A to plain text BEFORE writing — same fix as
      // Shoots' Start/End columns (see createShoot): without this, Sheets
      // auto-detects the "yyyy-MM-dd" string as a date and silently
      // converts the cell into a real Date object. Reading it back next
      // time then fails the `=== today` string comparison below, so a
      // new row gets created on every call instead of the same day's row
      // being found and incremented.
      sheet.getRange(rowIndex, 1).setNumberFormat('@');
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

// ---- site-wide interaction events --------------------------------------

// One row per (day, event type) in the "SiteEvents" tab — same shape and
// same privacy stance as trackPageView above (no visitor identifier, just
// an aggregate daily count), extended with a type column so index.html
// can report on basemap choice, search usage, and "My location" usage
// (the gaps noted in the project's suggested-improvements list) without
// adding a third-party analytics tool. Check numbers by opening that tab
// directly, same as SiteVisits.
function trackSiteEvent(type) {
  if (!SITE_EVENT_TYPE_RE.test(String(type || ''))) return { ok: false };

  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var sheet = SpreadsheetApp.getActive().getSheetByName(SITE_EVENTS_SHEET);
    if (!sheet) return { ok: false };

    var today = Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd');
    var rowIndex = null;
    if (sheet.getLastRow() >= 2) {
      var data = sheet.getRange('A2:B' + sheet.getLastRow()).getValues();
      for (var i = 0; i < data.length; i++) {
        if (data[i][0] === today && data[i][1] === type) { rowIndex = i + 2; break; }
      }
    }
    if (!rowIndex) {
      rowIndex = sheet.getLastRow() + 1;
      // Same date-auto-conversion fix as trackPageView above.
      sheet.getRange(rowIndex, 1).setNumberFormat('@');
      sheet.getRange(rowIndex, 1).setValue(today);
      sheet.getRange(rowIndex, 2).setValue(sanitizeForCell(type));
      sheet.getRange(rowIndex, 3).setValue(0);
    }
    var cell = sheet.getRange(rowIndex, 3);
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
