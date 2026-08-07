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
APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwCQ5tPz1Zlw7u-52Hpg40WrwwlbrZxuj4A9BsTmA7phO2UDtWmFn61SUdQl4N1yw8X/exec',
  // The main workbook (Client Database / Raw Data / Errors).
  SPREADSHEET_URL: 'https://docs.google.com/spreadsheets/d/1C2NX5ImumLfOxyopBHr_xOvwSOQod7bf8yzRTJHX_Yo/edit',
  // Fallback folder used by the "Open Output Folder" button when the
  // template workbook's parent folder cannot be determined.
  OUTPUT_FOLDER_URL: 'https://drive.google.com/drive/folders/1tkZxSgzWrjv2Ot-zV7J6pAZ4pIEJ3oRi',

  // localStorage keys. ACCESS_KEY is kept identical across versions so
  // an already-configured browser stays connected after UI updates.
  STORAGE_KEYS: {
    ACCESS_KEY: 'ledgerx_access_key',
    ACTIVITY: 'ledgerx_activity',
    ONBOARDED: 'ledgerx_onboarded',
    RECENT_REPORTS: 'ledgerx_recent_reports'
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
