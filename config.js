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
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/REPLACE_WITH_YOUR_DEPLOYMENT_ID/exec',

  // localStorage keys.
  STORAGE_KEYS: {
    ACCESS_KEY: 'ledgerx_access_key',
    LAST_MONTH: 'ledgerx_last_month'
  },

  // Header aliases used to auto-detect columns in the pasted STT table.
  // Matching is case-insensitive and ignores surrounding whitespace.
  // The first alias that matches a pasted header wins.
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

  // How many years back/forward the Reporting Month selector offers.
  MONTH_RANGE: { yearsBack: 2, yearsForward: 1 }
};
