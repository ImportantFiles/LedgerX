/**
 * Sheets.gs
 * Low-level access to Google Sheets. Every read/write goes through this
 * file so batching and layout assumptions stay in one place.
 *
 * Two spreadsheets are involved:
 *  - The MAIN workbook (SPREADSHEET_ID): exactly two permanent tabs -
 *    Client Database and Raw Data. Nothing is generated into it.
 *  - The OUTPUT file: "{Month} {Year} Performance Summary", created (or
 *    rewritten) by each generation inside the designated Drive folder
 *    (OUTPUT_FOLDER_ID), containing the Performance Summary sheet and
 *    the Errors sheet.
 */

// ---- Workbook configuration -------------------------------------------
var SPREADSHEET_ID = '1C2NX5ImumLfOxyopBHr_xOvwSOQod7bf8yzRTJHX_Yo';
var CLIENT_SHEET_NAME = 'Client Database';
var RAW_DATA_SHEET_NAME = 'Raw Data';
var LEGACY_RAW_DATA_SHEET_NAME = 'STT Import'; // accepted until the tab is renamed
var ERRORS_SHEET_NAME = 'Errors';
var REPORT_SHEET_PREFIX = 'Generated Report - ';
var UNKNOWN_GROUP_LABEL = 'Unknown';

// ---- Output configuration ----------------------------------------------
// Every generated Performance Summary spreadsheet is saved to this Drive
// folder and nowhere else.
var OUTPUT_FOLDER_ID = '1tkZxSgzWrjv2Ot-zV7J6pAZ4pIEJ3oRi';
var OUTPUT_SUMMARY_SHEET_NAME = 'Performance Summary';

var REPORT_HEADERS_ = ['STT ID', 'Name', 'System', 'AM', 'Note'];
var ERROR_HEADERS_ = ['Client Name', 'Account Number', 'Software', 'Error Type', 'Detailed Error Message', 'Timestamp'];

/** Returns the main workbook (Client Database / Raw Data). */
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
 * Reads the Monthly Performance table from the "Raw Data" sheet (the
 * legacy "STT Import" tab name is accepted until it is renamed).
 * The header row is located automatically within the first 10 rows (so a
 * paste that starts a row or two down still works), columns are matched
 * by alias (STT_IMPORT_ALIASES_ in Utils.gs), extra columns (Trades, Won,
 * Lots, ...) are ignored, and fully blank rows are skipped.
 * Returns rows in the exact shape evaluateSttRow_ expects.
 */
function readRawData_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(RAW_DATA_SHEET_NAME) ||
    spreadsheet.getSheetByName(LEGACY_RAW_DATA_SHEET_NAME);
  if (!sheet) {
    throw new Error('Required sheet "' + RAW_DATA_SHEET_NAME + '" was not found in the ' +
      'workbook. Create it and paste the Monthly Performance table into it.');
  }
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) {
    throw new Error('"' + RAW_DATA_SHEET_NAME + '" has no data. Paste the Monthly ' +
      'Performance table (including its header row) into it, then try again.');
  }

  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  var colIndex = null;
  var headerRow = -1;
  for (var r = 0; r < Math.min(values.length, 10); r++) {
    colIndex = detectSttColumns_(values[r]);
    if (colIndex) { headerRow = r; break; }
  }
  if (!colIndex) {
    throw new Error('Could not find an Account / STT ID header row in "' +
      RAW_DATA_SHEET_NAME + '". Paste the table with its header row included.');
  }

  var missing = ['balance', 'equity', 'deposit'].filter(function (f) {
    return colIndex[f] === undefined;
  });
  if (missing.length) {
    throw new Error('"' + RAW_DATA_SHEET_NAME + '" is missing required column(s): ' +
      missing.join(', ') + '. Expected headers like Balance, Equity and Deposits.');
  }

  function pick(cells, idx) { return idx === undefined ? undefined : cells[idx]; }

  var rows = [];
  for (var i = headerRow + 1; i < values.length; i++) {
    var cells = values[i];
    var allBlank = cells.every(function (c) {
      return String(c === null || c === undefined ? '' : c).trim() === '';
    });
    if (allBlank) continue;
    rows.push({
      sttId: pick(cells, colIndex.sttId),
      deposit: pick(cells, colIndex.deposit),
      withdrawal: pick(cells, colIndex.withdrawal),
      closedProfit: pick(cells, colIndex.closedProfit),
      balance: pick(cells, colIndex.balance),
      equity: pick(cells, colIndex.equity)
    });
  }
  if (rows.length === 0) {
    throw new Error('"' + RAW_DATA_SHEET_NAME + '" has a header row but no data rows.');
  }
  return rows;
}

/**
 * Writes the generated report into its own output spreadsheet named
 * "{Month} {Year} Performance Summary", saved in the designated Drive
 * folder (OUTPUT_FOLDER_ID) - never anywhere else, and never inside the
 * main workbook. If a file with that name already exists in the folder,
 * it is rewritten in place (re-running a month updates the same file
 * instead of piling up copies). The file contains two sheets:
 * "Performance Summary" and "Errors".
 * Returns { name, url, folderUrl } for the frontend's buttons.
 */
function writeOutputFile_(monthLabel, summaryRows, errorRows) {
  var folder = DriveApp.getFolderById(OUTPUT_FOLDER_ID);
  var name = monthLabel + ' Performance Summary';

  var existing = folder.getFilesByName(name);
  var output;
  if (existing.hasNext()) {
    output = SpreadsheetApp.openById(existing.next().getId());
  } else {
    output = SpreadsheetApp.create(name);
    DriveApp.getFileById(output.getId()).moveTo(folder);
  }

  // Sheet 1: Performance Summary. On a fresh file, rename the default
  // first sheet instead of leaving an empty "Sheet1" behind.
  var summarySheet = output.getSheetByName(OUTPUT_SUMMARY_SHEET_NAME);
  if (!summarySheet) {
    var sheets = output.getSheets();
    if (sheets.length === 1 && sheets[0].getLastRow() === 0) {
      summarySheet = sheets[0].setName(OUTPUT_SUMMARY_SHEET_NAME);
    } else {
      summarySheet = output.insertSheet(OUTPUT_SUMMARY_SHEET_NAME, 0);
    }
  }
  summarySheet.getRange(1, 1, 1, REPORT_HEADERS_.length).setValues([REPORT_HEADERS_]);
  summarySheet.setFrozenRows(1);
  clearDataRows_(summarySheet);
  writeReportRows_(summarySheet, summaryRows);

  // Sheet 2: Errors.
  var errorsSheet = output.getSheetByName(ERRORS_SHEET_NAME);
  if (!errorsSheet) {
    errorsSheet = output.insertSheet(ERRORS_SHEET_NAME);
    errorsSheet.setFrozenRows(1);
  }
  writeErrorRows_(errorsSheet, errorRows);

  SpreadsheetApp.flush();
  return { name: name, url: output.getUrl(), folderUrl: folder.getUrl() };
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

/**
 * Clears an Errors sheet, rewrites its header row (idempotent, so a
 * pre-existing sheet with stale headers is corrected), then batch-writes
 * the new error rows. Used only on the output spreadsheet's Errors
 * sheet. rows = [[clientName, account, software, errorType, message,
 * timestamp], ...]
 */
function writeErrorRows_(sheet, rows) {
  sheet.getRange(1, 1, 1, ERROR_HEADERS_.length).setValues([ERROR_HEADERS_]);
  clearDataRows_(sheet);
  if (rows.length === 0) return;
  sheet.getRange(2, 1, rows.length, ERROR_HEADERS_.length).setValues(rows);
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
