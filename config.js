/**
 * config.js
 * Site-wide configuration for LedgerX. This file is public (served from
 * GitHub Pages) - it must never contain the shared secret key. The key
 * is entered once by the administrator through the UI and kept only in
 * this browser's localStorage.
 */
window.LEDGERX_CONFIG = {
  // Paste the /exec URL from your Apps Script deployment here.
  // See SETUP.md, step "Deploy the Web App".
APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyc4GMN0txG6FLMIFW31brApIfBpR97GhzbcuzYTv_GTJC-MlgjbKcKDxt4RQErrctYuw/exec',
  // The workbook opened by the "Open Updated Spreadsheet" button.
  SPREADSHEET_URL: 'https://docs.google.com/spreadsheets/d/1C2NX5ImumLfOxyopBHr_xOvwSOQod7bf8yzRTJHX_Yo/edit',

  // localStorage keys. ACCESS_KEY is kept identical across versions so
  // an already-configured browser stays connected after UI updates.
  STORAGE_KEYS: {
    ACCESS_KEY: 'ledgerx_access_key',
    ACTIVITY: 'ledgerx_activity'
  },

  // Header aliases used to auto-detect columns in the uploaded or pasted
  // Monthly Performance table. Matching is case-insensitive and ignores
  // surrounding whitespace. The first alias that matches a header wins.
  STT_COLUMN_ALIASES: {
    sttId: ['stt id', 'account', 'account id', 'account number', 'stt', 'login'],
    deposit: ['total deposit', 'deposit', 'deposits'],
    withdrawal: ['total withdrawal', 'withdrawal', 'withdrawals'],
    closedProfit: ['closed profit', 'closed p/l', 'closed pl'],
    balance: ['balance'],
    equity: ['equity']
  },

  MONTH_NAMES: ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'],

  // How many years back/forward the Reporting Year selector offers.
  YEAR_RANGE: { back: 2, forward: 1 }
};
