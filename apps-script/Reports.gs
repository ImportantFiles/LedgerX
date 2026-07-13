/**
 * Reports.gs
 * Core business logic: validating pasted STT rows against the Client
 * Database, calculating growth/floating P/L, grouping by AM, and
 * persisting the results. This file is the single source of truth for
 * "what counts as Unknown" - the frontend mirrors these rules only for
 * instant preview, never as the final authority.
 */

var ISSUES_ = {
  BLANK_STT_ID: 'Blank STT ID',
  UNKNOWN_CLIENT: 'Unknown Client',
  ZERO_BALANCE: 'Zero Balance',
  MISSING_DEPOSIT: 'Missing Deposit',
  MISSING_EQUITY: 'Missing Equity',
  MISSING_BALANCE: 'Missing Balance',
  DUPLICATE_STT_ID: 'Duplicate STT ID',
  INVALID_NUMBER: 'Invalid Number',
  GROWTH_FAILED: 'Growth Calculation Failed',
  FLOATING_PL_FAILED: 'Floating P/L Calculation Failed'
};

/**
 * Evaluates a single pasted STT row against the Client Database and
 * business rules. Returns a classification record; never throws for
 * bad data - bad data is reported via `issues`, not exceptions.
 */
function evaluateSttRow_(row, clientDb, seenIds, monthLabel) {
  var sttId = normalizeSttId_(row.sttId);
  var issues = []; // [{ issue, details }]

  if (isBlank_(sttId)) {
    issues.push({ issue: ISSUES_.BLANK_STT_ID, details: 'STT ID is missing from the pasted row.' });
    return {
      sttId: '', name: 'Unknown', system: 'Unknown', am: UNKNOWN_GROUP_LABEL,
      isUnknown: true, isDuplicate: false, issues: issues, note: buildUnknownNote_(monthLabel, issues)
    };
  }

  if (seenIds[sttId]) {
    issues.push({ issue: ISSUES_.DUPLICATE_STT_ID, details: 'STT ID "' + sttId + '" appears more than once in the imported data.' });
    var dupClient = clientDb.bySttId[sttId];
    return {
      sttId: sttId,
      name: dupClient ? dupClient.name : 'Unknown',
      system: dupClient ? dupClient.system : 'Unknown',
      isDuplicate: true, issues: issues
    };
  }
  seenIds[sttId] = true;

  var client = clientDb.bySttId[sttId];
  if (!client) {
    issues.push({ issue: ISSUES_.UNKNOWN_CLIENT, details: 'STT ID "' + sttId + '" was not found in the Client Database.' });
  }

  var depositBlank = isBlank_(row.deposit);
  var balanceBlank = isBlank_(row.balance);
  var equityBlank = isBlank_(row.equity);

  var depositNum = depositBlank ? NaN : parseNumber_(row.deposit);
  var withdrawalNum = isBlank_(row.withdrawal) ? 0 : parseNumber_(row.withdrawal);
  var closedProfitNum = isBlank_(row.closedProfit) ? 0 : parseNumber_(row.closedProfit);
  var balanceNum = balanceBlank ? NaN : parseNumber_(row.balance);
  var equityNum = equityBlank ? NaN : parseNumber_(row.equity);

  if (balanceBlank) {
    issues.push({ issue: ISSUES_.MISSING_BALANCE, details: 'Balance value is blank.' });
  } else if (isNaN(balanceNum)) {
    issues.push({ issue: ISSUES_.INVALID_NUMBER, details: 'Balance "' + row.balance + '" is not a valid number.' });
  } else if (balanceNum === 0) {
    issues.push({ issue: ISSUES_.ZERO_BALANCE, details: 'Balance equals zero.' });
  }

  if (depositBlank) {
    issues.push({ issue: ISSUES_.MISSING_DEPOSIT, details: 'Total Deposit value is blank.' });
  } else if (isNaN(depositNum)) {
    issues.push({ issue: ISSUES_.INVALID_NUMBER, details: 'Total Deposit "' + row.deposit + '" is not a valid number.' });
  }

  if (equityBlank) {
    issues.push({ issue: ISSUES_.MISSING_EQUITY, details: 'Equity value is blank.' });
  } else if (isNaN(equityNum)) {
    issues.push({ issue: ISSUES_.INVALID_NUMBER, details: 'Equity "' + row.equity + '" is not a valid number.' });
  }

  if (!isBlank_(row.withdrawal) && isNaN(withdrawalNum)) {
    issues.push({ issue: ISSUES_.INVALID_NUMBER, details: 'Total Withdrawal "' + row.withdrawal + '" is not a valid number.' });
  }
  if (!isBlank_(row.closedProfit) && isNaN(closedProfitNum)) {
    issues.push({ issue: ISSUES_.INVALID_NUMBER, details: 'Closed Profit "' + row.closedProfit + '" is not a valid number.' });
  }

  var name = client ? client.name : 'Unknown';
  var system = client ? client.system : 'Unknown';
  var am = client && !isBlank_(client.am) ? client.am : UNKNOWN_GROUP_LABEL;

  if (issues.length > 0) {
    return {
      sttId: sttId, name: name, system: system, am: am,
      isUnknown: true, isDuplicate: false, issues: issues,
      note: buildUnknownNote_(monthLabel, issues)
    };
  }

  var netDeposit = roundTo2_(depositNum - withdrawalNum);
  var growthPct;
  if (netDeposit === 0) {
    issues.push({ issue: ISSUES_.GROWTH_FAILED, details: 'Net Deposit is zero, growth percentage is undefined (division by zero).' });
  } else {
    growthPct = roundTo2_(((balanceNum - netDeposit) / netDeposit) * 100);
    if (!isFinite(growthPct)) {
      issues.push({ issue: ISSUES_.GROWTH_FAILED, details: 'Growth percentage could not be calculated.' });
    }
  }

  var floatingPL = roundTo2_(equityNum - balanceNum);
  if (!isFinite(floatingPL)) {
    issues.push({ issue: ISSUES_.FLOATING_PL_FAILED, details: 'Floating P/L could not be calculated.' });
  }

  if (issues.length > 0) {
    return {
      sttId: sttId, name: name, system: system, am: am,
      isUnknown: true, isDuplicate: false, issues: issues,
      note: buildUnknownNote_(monthLabel, issues)
    };
  }

  return {
    sttId: sttId, name: name, system: system, am: am,
    isUnknown: false, isDuplicate: false, issues: [],
    netDeposit: netDeposit, growthPct: growthPct, closedProfit: roundTo2_(closedProfitNum),
    floatingPL: floatingPL, balance: roundTo2_(balanceNum),
    note: buildNote_(monthLabel, growthPct, closedProfitNum, floatingPL, balanceNum)
  };
}

/** Builds the single-sentence note used for Unknown/invalid accounts. */
function buildUnknownNote_(monthLabel, issues) {
  var reasons = issues.map(function (i) { return i.issue; }).join('; ');
  return monthLabel + ': Unable to calculate - ' + reasons + '.';
}

/**
 * Main entry point for report generation. Reads the Client Database
 * fresh (never trusts client-cached data), classifies every imported STT
 * row, writes report sheets grouped by AM, writes the Errors sheet,
 * updates Client Database notes, refreshes calculations, protects the
 * Generated Summary sheet, and stamps Last Updated. Notes use the month
 * name alone (e.g. "July: ...") while the Last Updated stamp uses the
 * full "{Month} {Year}" label.
 */
function generateReports_(payload) {
  if (!payload || !Array.isArray(payload.rows) || payload.rows.length === 0) {
    throw new Error('No STT rows were provided.');
  }
  var monthLabel = payload.monthLabel || monthKeyToLabel_(payload.monthKey);
  var noteMonth = monthNameFromKey_(payload.monthKey) || monthLabel;
  var spreadsheet = getSpreadsheet_();
  var clientDb = readClientDatabase_(spreadsheet);
  var timestamp = Utilities.formatDate(new Date(), spreadsheet.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm:ss');

  var seenIds = {};
  var groups = {}; // amLabel -> [ [sttId,name,system,am,note], ... ]
  var errorRows = []; // [ [clientName, account, software, errorType, message, timestamp], ... ]
  var noteUpdates = {};

  var counts = { total: 0, matched: 0, unknown: 0, zeroBalance: 0, errors: 0 };

  payload.rows.forEach(function (row) {
    counts.total++;
    var result = evaluateSttRow_(row, clientDb, seenIds, noteMonth);

    if (result.isDuplicate) {
      counts.errors += result.issues.length;
      result.issues.forEach(function (i) {
        errorRows.push([result.name, result.sttId, result.system, i.issue, i.details, timestamp]);
      });
      return;
    }

    if (result.issues && result.issues.length > 0) {
      counts.errors += result.issues.length;
      result.issues.forEach(function (i) {
        errorRows.push([result.name || 'Unknown', result.sttId || '(blank)', result.system || 'Unknown', i.issue, i.details, timestamp]);
        if (i.issue === ISSUES_.ZERO_BALANCE) counts.zeroBalance++;
      });
    }

    var groupLabel = result.isUnknown ? UNKNOWN_GROUP_LABEL : result.am;
    if (!groups[groupLabel]) groups[groupLabel] = [];
    groups[groupLabel].push([result.sttId, result.name, result.system, result.am, result.note]);

    if (result.isUnknown) {
      counts.unknown++;
    } else {
      counts.matched++;
      noteUpdates[result.sttId] = result.note;
    }
  });

  // Clear every existing report sheet's data rows before rewriting, so an
  // AM group that has no accounts this run doesn't retain stale rows.
  var allSheets = spreadsheet.getSheets();
  allSheets.forEach(function (sheet) {
    if (sheet.getName().indexOf(REPORT_SHEET_PREFIX) === 0) {
      clearDataRows_(sheet);
    }
  });

  var reportsWritten = 0;
  Object.keys(groups).forEach(function (amLabel) {
    var sheet = getOrCreateReportSheet_(spreadsheet, amLabel);
    writeReportRows_(sheet, groups[amLabel]);
    reportsWritten++;
  });

  var errorsSheet = getOrCreateErrorsSheet_(spreadsheet);
  writeErrorRows_(errorsSheet, errorRows);

  writeClientNotes_(clientDb, noteUpdates);

  refreshCalculations_(spreadsheet);
  protectSummaryColumns_(spreadsheet);
  var skippedNamedRanges = updateLastUpdated_(spreadsheet, monthLabel);

  return {
    monthLabel: monthLabel,
    counts: {
      totalAccounts: counts.total,
      matchedAccounts: counts.matched,
      unknownAccounts: counts.unknown,
      zeroBalanceAccounts: counts.zeroBalance,
      generatedReports: reportsWritten,
      errorCount: errorRows.length
    },
    groups: Object.keys(groups),
    errors: errorRows.map(function (r) {
      return { clientName: r[0], sttId: r[1], software: r[2], issue: r[3], details: r[4], timestamp: r[5] };
    }),
    notes: Object.keys(noteUpdates).map(function (id) { return { sttId: id, note: noteUpdates[id] }; }),
    warnings: skippedNamedRanges.length
      ? ['Named range(s) not found, Last Updated not fully stamped: ' + skippedNamedRanges.join(', ')]
      : []
  };
}

/** Returns the Client Database contents for the frontend's local preview/search. */
function getClientDatabase_() {
  var spreadsheet = getSpreadsheet_();
  var clientDb = readClientDatabase_(spreadsheet);
  return {
    clients: clientDb.rows.map(function (r) {
      return { sttId: r.sttId, name: r.name, system: r.system, am: r.am };
    })
  };
}
