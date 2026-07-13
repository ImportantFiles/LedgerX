/**
 * Archive.gs
 * "Prepare Next Month" workflow: save a full copy of the workbook into
 * the same Google Drive folder (named "Monthly Performance - {Month}
 * {Year}"), then clear only the data rows of the live report sheets so
 * headers, formulas, pivot tables, charts, conditional formatting,
 * hidden columns, protections, and data validation are preserved
 * untouched and the workbook is immediately ready for the next month.
 */

var ARCHIVE_NAME_PREFIX = 'Monthly Performance - ';

/**
 * Archives the current reporting period. A Drive file copy captures
 * everything - formulas, pivot tables, charts, formatting - exactly as
 * generated, and archived copies are never modified afterwards.
 */
function prepareNextMonth_(payload) {
  if (!payload || isBlank_(payload.monthLabel)) {
    throw new Error('monthLabel is required to archive the current period.');
  }
  var monthLabel = payload.monthLabel; // e.g. "July 2026"
  var spreadsheet = getSpreadsheet_();
  var archiveName = ARCHIVE_NAME_PREFIX + monthLabel;

  var file = DriveApp.getFileById(spreadsheet.getId());
  var parents = file.getParents();
  var folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();

  var existing = folder.getFilesByName(archiveName);
  if (existing.hasNext()) {
    throw new Error('"' + archiveName + '" already exists in this Drive folder. ' +
      monthLabel + ' appears to be archived already - rename or remove that copy first.');
  }

  // Make sure every pending write is applied before the snapshot is taken.
  SpreadsheetApp.flush();
  var copy = file.makeCopy(archiveName, folder);

  // Clear only the live report data rows - headers, formulas, pivot
  // tables, charts, hidden columns, protections, and validation stay.
  spreadsheet.getSheets().forEach(function (sheet) {
    if (sheet.getName().indexOf(REPORT_SHEET_PREFIX) === 0) {
      clearDataRows_(sheet);
    }
  });

  var errorsSheet = spreadsheet.getSheetByName(ERRORS_SHEET_NAME);
  if (errorsSheet) {
    clearDataRows_(errorsSheet);
  }

  refreshCalculations_(spreadsheet);

  return {
    archivedMonth: monthLabel,
    archiveFileName: archiveName,
    archiveUrl: copy.getUrl()
  };
}
