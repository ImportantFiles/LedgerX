/**
 * Archive.gs
 * "Prepare Next Month" workflow: snapshot the current period's report
 * sheets into archive tabs inside the SAME workbook (never a separate
 * spreadsheet file), then clear only the data rows of the live report
 * sheets so headers, formulas, pivot tables, charts, hidden columns,
 * protections, and data validation are preserved untouched.
 */

var ARCHIVE_PREFIX = 'Archive - ';

/**
 * Archives the current Generated Summary + all Generated Report - *
 * sheets by duplicating them in place (Sheet.copyTo preserves formulas,
 * pivot tables, charts, conditional formatting, and data validation),
 * then clears the live sheets' data rows for the next reporting period.
 */
function prepareNextMonth_(payload) {
  if (!payload || isBlank_(payload.monthLabel)) {
    throw new Error('monthLabel is required to archive the current period.');
  }
  var monthLabel = payload.monthLabel;
  var spreadsheet = getSpreadsheet_();

  var summarySheet = requireSheet_(spreadsheet, SUMMARY_SHEET_NAME);
  var reportSheets = spreadsheet.getSheets().filter(function (sheet) {
    return sheet.getName().indexOf(REPORT_SHEET_PREFIX) === 0;
  });

  var summaryArchiveName = ARCHIVE_PREFIX + monthLabel + ' - Summary';
  if (spreadsheet.getSheetByName(summaryArchiveName)) {
    throw new Error('"' + monthLabel + '" has already been archived. ' +
      'Remove or rename the existing "' + summaryArchiveName + '" tab before archiving again.');
  }

  var archivedSheetNames = [];

  var summaryArchive = summarySheet.copyTo(spreadsheet);
  summaryArchive.setName(summaryArchiveName);
  archivedSheetNames.push(summaryArchiveName);

  reportSheets.forEach(function (sheet) {
    var amLabel = sheet.getName().substring(REPORT_SHEET_PREFIX.length);
    var archiveName = ARCHIVE_PREFIX + monthLabel + ' - ' + amLabel;
    var archived = sheet.copyTo(spreadsheet);
    archived.setName(archiveName);
    archivedSheetNames.push(archiveName);
  });

  // Clear only the data rows of the live report sheets - headers,
  // formulas, pivot tables, charts, hidden columns, and protections stay.
  reportSheets.forEach(function (sheet) {
    clearDataRows_(sheet);
  });

  var errorsSheet = spreadsheet.getSheetByName(ERRORS_SHEET_NAME);
  if (errorsSheet) {
    clearDataRows_(errorsSheet);
  }

  refreshCalculations_(spreadsheet);

  return {
    archivedMonth: monthLabel,
    archivedSheets: archivedSheetNames
  };
}
