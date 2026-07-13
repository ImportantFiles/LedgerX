/**
 * Utils.gs
 * Shared formatting, parsing, and validation helpers used across the backend.
 * No function here talks to Sheets directly - pure data transforms only.
 */

/**
 * Parses a raw value (number or string) into a finite number.
 * Handles currency symbols, thousands separators, accounting-style
 * parentheses for negatives (e.g. "(100.50)" -> -100.5), and percent signs.
 * Returns NaN when the value cannot be interpreted as a number.
 */
function parseNumber_(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return isFinite(value) ? value : NaN;

  var str = String(value).trim();
  if (str === '') return NaN;

  var isParenNegative = /^\(.*\)$/.test(str);
  if (isParenNegative) str = str.slice(1, -1);

  str = str.replace(/[$,%\s]/g, '');

  if (str === '' || str === '-' || str === '+') return NaN;
  if (!/^[+-]?\d*\.?\d+$/.test(str)) return NaN;

  var num = parseFloat(str);
  if (!isFinite(num)) return NaN;

  return isParenNegative ? -Math.abs(num) : num;
}

/**
 * Rounds a number to 2 decimal places using string-based rounding to
 * avoid classic floating point artifacts (e.g. 1.005 -> 1.01).
 */
function roundTo2_(num) {
  if (!isFinite(num)) return NaN;
  var sign = num < 0 ? -1 : 1;
  var rounded = Math.round((Math.abs(num) + Number.EPSILON) * 100) / 100;
  return sign * rounded;
}

/**
 * Formats a number as US currency, always preserving the negative sign
 * before the dollar sign (never accounting-style parentheses).
 * Examples: 15250.25 -> "$15,250.25", -320.5 -> "-$320.50"
 */
function formatCurrency_(num) {
  if (!isFinite(num)) return '$0.00';
  var rounded = roundTo2_(num);
  var negative = rounded < 0;
  var abs = Math.abs(rounded);
  var parts = abs.toFixed(2).split('.');
  var intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  var formatted = '$' + intPart + '.' + parts[1];
  return negative ? '-' + formatted : formatted;
}

/**
 * Builds the single-sentence Note for a client's report row.
 * Format: {Month}: {Growth}% growth, ${Closed Profit} closed profit,
 *         ${Floating P/L} floating P/L, ${Current Balance} current balance.
 * All monetary figures already carry their own sign, so the literal "$"
 * prefix is only used for readability; formatCurrency_ supplies the sign.
 */
function buildNote_(monthLabel, growthPct, closedProfit, floatingPL, balance) {
  var growthStr = roundTo2_(growthPct).toFixed(2);
  var closedStr = formatCurrency_(closedProfit);
  var floatingStr = formatCurrency_(floatingPL);
  var balanceStr = formatCurrency_(balance);

  return monthLabel + ': ' + growthStr + '% growth, ' + closedStr +
    ' closed profit, ' + floatingStr + ' floating P/L, ' + balanceStr +
    ' current balance.';
}

/**
 * Normalizes an STT ID for lookup/comparison: trims whitespace and
 * strips a trailing ".0" that Sheets sometimes appends to numeric IDs.
 */
function normalizeSttId_(value) {
  if (value === null || value === undefined) return '';
  var str = String(value).trim();
  str = str.replace(/\.0+$/, '');
  return str;
}

/**
 * Returns true when a string is null/undefined/blank after trimming.
 */
function isBlank_(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/**
 * Validates the shared-secret key sent by the frontend against the key
 * stored in Script Properties. Throws if not configured or mismatched.
 */
function assertAuthorized_(providedKey) {
  var expected = PropertiesService.getScriptProperties().getProperty('API_SECRET_KEY');
  if (!expected) {
    throw new Error('Server misconfiguration: API_SECRET_KEY is not set in Script Properties.');
  }
  if (!providedKey || providedKey !== expected) {
    throw new Error('Unauthorized: invalid or missing access key.');
  }
}

/**
 * Builds a JSON ContentService response. Using text/plain-compatible
 * JSON output keeps the response CORS-safe for cross-origin fetch()
 * calls from the GitHub Pages frontend without triggering a preflight.
 */
function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Wraps a handler function so any thrown error becomes a structured
 * { success:false, error } JSON response instead of an Apps Script HTML
 * error page (which the frontend cannot parse as JSON).
 */
function safeHandle_(fn) {
  try {
    var result = fn();
    return jsonResponse_(Object.assign({ success: true }, result));
  } catch (err) {
    return jsonResponse_({ success: false, error: err && err.message ? err.message : String(err) });
  }
}

/** Canonical month labels used throughout the UI and Note text. */
var MONTH_NAMES_ = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Converts a "YYYY-MM" reporting-period string into a display label,
 * e.g. "2026-07" -> "July 2026".
 */
function monthKeyToLabel_(monthKey) {
  var parts = String(monthKey).split('-');
  var year = parts[0];
  var monthIndex = parseInt(parts[1], 10) - 1;
  return MONTH_NAMES_[monthIndex] + ' ' + year;
}

/**
 * Extracts just the month name from a "YYYY-MM" key, e.g. "2026-07" ->
 * "July". Returns '' when the key is missing or malformed, so callers
 * can fall back to another label.
 */
function monthNameFromKey_(monthKey) {
  if (isBlank_(monthKey)) return '';
  var parts = String(monthKey).split('-');
  var idx = parseInt(parts[1], 10) - 1;
  return (idx >= 0 && idx < 12) ? MONTH_NAMES_[idx] : '';
}
