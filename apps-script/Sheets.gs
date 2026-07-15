/**
 * Sheets.gs
 * Low-level access to the single existing spreadsheet. Every read/write
 * to Google Sheets goes through this file so batching and layout
 * assumptions stay in one place.
 *
 * IMPORTANT: This project never creates a new spreadsheet file. All
 * sheets referenced below are tabs inside the one existing workbook
 * identified by SPREADSHEET_ID.
 */

// ---- Workbook configuration -------------------------------------------
var SPREADSHEET_ID = '1C2NX5ImumLfOxyopBHr_xOvwSOQod7bf8yzRTJHX_Yo';
var CLIENT_SHEET_NAME = 'Client Database';
var SUMMARY_SHEET_NAME = 'Generated Summary';
var ERRORS_SHEET_NAME = 'Errors';
var REPORT_SHEET_PREFIX = 'Generated Report - ';
var UNKNOWN_GROUP_LABEL = 'Unknown';
var PROTECTION_DESCRIPTION = 'LedgerX: locked report columns (auto-managed)';
var SUMMARY_PROTECTED_COLUMNS = { start: 1, end: 6 }; // A:F

var REPORT_HEADERS_ = ['STT ID', 'Name', 'System', 'AM', 'Note'];
var ERROR_HEADERS_ = ['Client Name', 'Account Number', 'Software', 'Error Type', 'Detailed Error Message', 'Timestamp'];

/** Returns the single existing spreadsheet. Never call SpreadsheetApp.create(). */
function getSpreadsheet_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/** Gets an existing sheet by name, throwing a clear error if it is missing. */
function requireSheet_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    throw new Error('Required sheet "' + name + '" was not found in the workbook. ' +
      'See SETUP.md to create it.');
  }
  return sheet;
}

/**
 * Reads the Client Database (columns A:E) into memory.
 * Returns { bySttId: Map<string, record>, rows: [record], allRows: [record], sheet }
 * where record = { rowIndex, sttId, name, system, am, note }.
 * `allRows` is contiguous (rows 2..lastRow, including blank-STT-ID rows) so
 * it can be written back in a single range write without misaligning rows;
 * `rows`/`bySttId` only include rows with a usable STT ID, for lookups.
 */
function readClientDatabase_(spreadsheet) {
  var sheet = requireSheet_(spreadsheet, CLIENT_SHEET_NAME);
  var lastRow = sheet.getLastRow();
  var bySttId = {};
  var rows = [];
  var allRows = [];

  if (lastRow < 2) return { bySttId: bySttId, rows: rows, allRows: allRows, sheet: sheet, lastRow: lastRow };

  var values = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    // Column A normally holds a bare STT ID, but extractSttId_ also
    // accepts "Label (ID)" cells so both sides key the map identically.
    var sttId = extractSttId_(row[0]);

    var record = {
      rowIndex: i + 2,
      sttId: sttId,
      name: row[1],
      system: row[2],
      am: row[3],
      note: row[4]
    };
    allRows.push(record);

    if (isBlank_(sttId)) continue;
    rows.push(record);
    bySttId[sttId] = record;
  }

  return { bySttId: bySttId, rows: rows, allRows: allRows, sheet: sheet, lastRow: lastRow };
}

/**
 * Writes the Note column (E) for the Client Database in a single batch
 * call over the full contiguous row range. `noteBySttId` maps normalized
 * STT ID -> new note string. Rows whose STT ID has no entry in the map
 * (including blank-STT-ID rows) keep their existing note.
 */
function writeClientNotes_(clientDb, noteBySttId) {
  if (clientDb.allRows.length === 0) return;

  var notes = clientDb.allRows.map(function (record) {
    var newNote = isBlank_(record.sttId) ? undefined : noteBySttId[record.sttId];
    return [newNote !== undefined ? newNote : (record.note || '')];
  });

  var firstRow = clientDb.allRows[0].rowIndex;
  clientDb.sheet.getRange(firstRow, 5, notes.length, 1).setValues(notes);
}

/**
 * Returns the report sheet for a given AM group, creating it (with
 * header row only) if it does not already exist. Existing sheets keep
 * their formatting, formulas, and name untouched.
 */
function getOrCreateReportSheet_(spreadsheet, amLabel) {
  var name = REPORT_SHEET_PREFIX + amLabel;
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.getRange(1, 1, 1, REPORT_HEADERS_.length).setValues([REPORT_HEADERS_]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Clears only the data rows (row 2 downward) of a sheet, preserving the
 * header row, column formatting, widths, and any formulas that live
 * outside the cleared range.
 */
function clearDataRows_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
  }
}

/** Batch-writes report rows starting at row 2. rows = [[sttId,name,system,am,note], ...] */
function writeReportRows_(sheet, rows) {
  if (rows.length === 0) return;
  sheet.getRange(2, 1, rows.length, REPORT_HEADERS_.length).setValues(rows);
}

/** Returns (creating if needed) the Errors sheet with its header. */
function getOrCreateErrorsSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(ERRORS_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(ERRORS_SHEET_NAME);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Clears the Errors sheet, rewrites its header row (idempotent, so a
 * pre-existing sheet with stale headers is corrected), then batch-writes
 * the new error rows. rows = [[clientName, account, software, errorType,
 * message, timestamp], ...]
 */
function writeErrorRows_(sheet, rows) {
  sheet.getRange(1, 1, 1, ERROR_HEADERS_.length).setValues([ERROR_HEADERS_]);
  clearDataRows_(sheet);
  if (rows.length === 0) return;
  sheet.getRange(2, 1, rows.length, ERROR_HEADERS_.length).setValues(rows);
}

/**
 * Hides and protects columns A:F on the Generated Summary sheet. If a
 * matching protection already exists (identified by description), it is
 * updated in place rather than duplicated.
 */
function protectSummaryColumns_(spreadsheet) {
  var sheet = requireSheet_(spreadsheet, SUMMARY_SHEET_NAME);
  var start = SUMMARY_PROTECTED_COLUMNS.start;
  var count = SUMMARY_PROTECTED_COLUMNS.end - SUMMARY_PROTECTED_COLUMNS.start + 1;

  sheet.hideColumns(start, count);

  var protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  var existing = null;
  for (var i = 0; i < protections.length; i++) {
    if (protections[i].getDescription() === PROTECTION_DESCRIPTION) {
      existing = protections[i];
      break;
    }
  }

  var range = sheet.getRange(1, start, Math.max(sheet.getMaxRows(), 1), count);
  var protection = existing || range.protect();
  protection.setDescription(PROTECTION_DESCRIPTION);
  protection.setRange(range);
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
}

/**
 * Forces pending spreadsheet writes to apply immediately so that any
 * pivot tables and charts referencing the report ranges recalculate.
 * Google Sheets pivot tables/charts are reference-driven and update
 * automatically once their source data changes and is flushed - there
 * is no separate "refresh" API to call.
 */
function refreshCalculations_(spreadsheet) {
  SpreadsheetApp.flush();
}

/**
 * Standalone refresh action for the UI's "Refresh Monthly Performance
 * File" step: applies all pending writes so pivot tables, formulas, and
 * chart references recalculate against the latest data, and returns the
 * refresh timestamp in the spreadsheet's time zone.
 */
function refreshWorkbook_() {
  var spreadsheet = getSpreadsheet_();
  refreshCalculations_(spreadsheet);
  var tz = spreadsheet.getSpreadsheetTimeZone();
  var now = new Date();
  return {
    refreshedDate: Utilities.formatDate(now, tz, 'yyyy-MM-dd'),
    refreshedTime: Utilities.formatDate(now, tz, 'HH:mm:ss')
  };
}

/**
 * Writes the Last Updated stamp using named ranges so the exact cell
 * layout stays under the admin's control (see SETUP.md). Missing named
 * ranges are skipped rather than failing the whole generation run.
 */
function updateLastUpdated_(spreadsheet, monthLabel) {
  var now = new Date();
  var tz = spreadsheet.getSpreadsheetTimeZone();
  var writes = {
    LastUpdatedMonth: monthLabel,
    LastUpdatedDate: Utilities.formatDate(now, tz, 'yyyy-MM-dd'),
    LastUpdatedTime: Utilities.formatDate(now, tz, 'HH:mm:ss')
  };

  var skipped = [];
  Object.keys(writes).forEach(function (name) {
    var range = spreadsheet.getRangeByName(name);
    if (range) {
      range.setValue(writes[name]);
    } else {
      skipped.push(name);
    }
  });
  return skipped;
}
