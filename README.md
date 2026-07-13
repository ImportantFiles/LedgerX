# LedgerX

LedgerX turns a manually copied STT (trading account) table into per-account-manager
client reports, written directly into your existing Google Spreadsheet. It runs as a
static site on GitHub Pages, backed by a Google Apps Script Web App.

Built for one administrator to run once per reporting period. Paste the STT table,
pick the reporting month, click **Generate Reports** - matching against the Client
Database, growth/P&L calculations, report grouping, error logging, sheet protection,
and the Last Updated stamp all happen automatically.

## How it works

```
GitHub Pages (static)              Google Apps Script (Web App)         Google Sheet
------------------------           ---------------------------          ------------------
index.html / styles.css / -- fetch(JSON, text/plain) -->  Code.gs (doGet/doPost)  ---> Client Database
script.js                                                  Reports.gs, Sheets.gs,       Generated Report - {AM}
                                                            Archive.gs, Utils.gs         Report Errors
                        <-- JSON response ------------------                             Generated Summary
                                                                                          Archive - {Month} - *
```

- **One spreadsheet only.** Every sheet the app reads or writes - Client Database,
  Generated Report - *, Report Errors, Generated Summary, and Archive - * tabs - lives
  inside the single existing workbook. Nothing here ever calls
  `SpreadsheetApp.create()`.
- **Authentication.** The frontend is public (GitHub Pages), so requests are
  authenticated with a shared secret key rather than Google login. The key lives in
  Apps Script Script Properties (`API_SECRET_KEY`) and is entered once into the
  browser's Settings dialog, where it's kept in `localStorage`.
- **Backend is the source of truth.** The browser mirrors the calculation rules for
  instant preview, but every "Generate Reports" click also sends the raw pasted rows
  to Apps Script, which re-reads the Client Database fresh and recalculates
  everything before writing - so a stale browser cache can never corrupt the sheet.

## Project structure

```
TradingReportGenerator/
  index.html            Dashboard UI
  styles.css             Dark glassmorphism theme
  script.js               Frontend logic (API client, calc engine, rendering)
  config.js               Public config: Apps Script URL, column aliases, etc.
  assets/                  Favicon / logo
  apps-script/
    Code.gs                Web app entry points (doGet/doPost), routing, auth
    Reports.gs              Validation, calculations, grouping, report writing
    Sheets.gs                All Sheets read/write access + protection
    Archive.gs               "Prepare Next Month" archiving
    Utils.gs                 Formatting/parsing helpers shared by the above
    appsscript.json           Apps Script manifest (web app config)
  README.md
  SETUP.md                 Full one-time setup guide
```

## Quick start

1. Follow **[SETUP.md](SETUP.md)** to prepare the spreadsheet, deploy the Apps
   Script Web App, and set the shared secret key.
2. Put the exec URL from your deployment into `config.js` (`APPS_SCRIPT_URL`).
3. Push this folder to a GitHub repo and enable GitHub Pages on it.
4. Open the site, click the gear icon, paste in the access key, and you're ready to
   generate reports.

## Data rules (for reference)

- **Net Deposit** = Total Deposit − Total Withdrawal
- **Growth %** = ((Balance − Net Deposit) / Net Deposit) × 100, rounded to 2 decimals
- **Floating P/L** = Equity − Balance
- STT's own "Growth" column is always ignored - growth is recalculated from Balance
  and Net Deposit every time.
- Negative numbers always render as `-$1,250.55`, never `($1,250.55)`.
- An account is routed to **Generated Report - Unknown** and logged in
  **Report Errors** whenever its STT ID is blank/unmatched, or its Balance, Deposit,
  or Equity is blank, non-numeric, or (for Balance) zero.

## License

Internal tool - no license file included by default.
