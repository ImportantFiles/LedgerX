# LedgerX v2.0

LedgerX turns a Monthly Performance (STT) export into a ready-to-send client
report. It reads the LedgerX Template (Google Sheets), validates and calculates
everything server-side, and creates a new "{Month} {Year} Performance Summary"
spreadsheet in a designated Google Drive folder. It runs as a static site on
GitHub Pages, backed by a Google Apps Script Web App.

The interface is a premium, minimal, one-screen-at-a-time experience: boot beam,
month cards, a live stage tracker, and a stats-rich success screen. No uploads,
no confirmations, no year picker.

## The flow

```
Update the LedgerX Template (paste Client Database + Raw Data)
        |
Open LedgerX -> pick a month card -> automatic processing
        |
"{Month} {Year} Performance Summary" created in the output Drive folder
   (Sheet 1: Performance Summary, Sheet 2: Errors)
        |
Success screen: stats, error preview, Open Report / Open Output Folder,
Copy Notes (for GHL), Generate Another Report
```

The year is always the current system year. The backend reads the template
server-side during generation - the browser never parses or uploads files.

## How it works

```
GitHub Pages (static)              Google Apps Script (Web App)         Google Drive
------------------------           ---------------------------          ------------------
index.html / styles.css / -- fetch(JSON, text/plain) -->  Code.gs (doGet/doPost)  ---> MAIN TEMPLATE (never generated into):
script.js                                                  Reports.gs, Sheets.gs,        Client Database
                                                            Archive.gs, Utils.gs          Raw Data
                        <-- JSON response ------------------
                                                                                          OUTPUT FOLDER (one file per month):
                                                                                           {Month} {Year} Performance Summary
                                                                                             - Performance Summary
                                                                                             - Errors
```

- **Main template.** Exactly two permanent tabs: `Client Database` (who owns each
  STT ID: ID, Name, System, AM, Note) and `Raw Data` (the pasted Monthly
  Performance export; the legacy `STT Import` tab name is still accepted).
  Nothing is ever generated into the main template.
- **Output.** Every generation writes `{Month} {Year} Performance Summary` into
  the designated Drive folder (`OUTPUT_FOLDER_ID` in `Sheets.gs`). Re-running the
  same month rewrites the same file instead of creating copies. Errors live only
  in this output file.
- **Authentication.** Requests are authenticated with a shared secret key stored
  in Apps Script Script Properties (`API_SECRET_KEY`), entered once into the
  browser (localStorage).
- **Backend is the source of truth.** The browser sends only the reporting
  month; Apps Script reads Raw Data and the Client Database fresh and performs
  every match, calculation, and write.

## Frontend

- Boot loading: single full-width light beam (sweep, bloom, pulse).
- First visit: onboarding modal (localStorage flag) with View Guide / Get Started.
- Header: LedgerX brand, Guide (in-app glass modal with the full how-to),
  Refresh Data (flushes workbook recalculations).
- Home: 12 glass month cards (click = generate immediately), Important Note
  card, Recent Reports (localStorage, last 6, click to reopen).
- Processing: live stage tracker - each stage animates to "✓ Completed"; the
  last stage holds on the real backend call.
- Success: filename + "Saved to Google Drive", stat cards (Clients Processed,
  Successful, Errors, Success Rate, Average/Highest/Lowest Growth, Processing
  Time), error preview (first 5 + View Full Errors modal), Open Report /
  Copy Notes / Open Output Folder / Generate Another Report.
- Empty state: backend "no data" errors show "No Data Available" + Open Guide.
- Fonts: Satoshi (Fontshare) + Inter. All animations are 200-300ms
  transform/opacity. Fully responsive; keyboard and screen-reader friendly.

## Project structure

```
TradingReportGenerator/
  index.html            v2.0 UI: scenes, modals (onboarding/guide/errors)
  styles.css             Black glass theme, beam, stage tracker, stat cards
  script.js               Scene flow, modals, stage player, recent reports, API client
  config.js               Public config: Apps Script URL, output folder URL, storage keys
  assets/                  Favicon
  apps-script/
    Code.gs                Web app entry points (doGet/doPost), routing, auth
    Reports.gs              Validation, calculations, growth stats, output routing
    Sheets.gs                Raw Data reader, output file writer, workbook access
    Archive.gs               prepareNextMonth endpoint (Drive copy + Raw Data clear)
    Utils.gs                 Parsing helpers, STT ID extraction, column aliases
    appsscript.json           Apps Script manifest (web app config, OAuth scopes)
  README.md
  SETUP.md                 Full one-time setup guide
```

## Data rules (for reference)

- The STT ID is extracted from the Account label's parentheses:
  `_RS15 500K Max Tradiso (1335619)` -> `1335619`; bare IDs pass through unchanged.
- **Net Deposit** = Deposits − |Withdrawals| (the STT export reports withdrawals
  as negative amounts; positive-total exports work identically).
- **Growth %** = ((Balance − Net Deposit) / Net Deposit) × 100, rounded to 2 decimals.
- **Floating P/L** = Equity − Balance.
- The source's own "Growth %" column is always ignored - growth is recalculated.
- Negative numbers always render as `-$1,250.55`, never `($1,250.55)`.
- **Notes** are one single sentence, ready to paste into GHL:
  `July: 6.42% growth, $1,842.55 closed profit, $325.20 floating P/L, $18,560.55 current balance.`
- **Performance Summary** (in the output file) lists STT ID, Name, System, AM,
  Note - grouped by AM alphabetically, Unknown group last, clients A-Z.
- An account lands in the **Unknown** group and in the output file's **Errors**
  sheet whenever its STT ID is blank/unmatched/duplicated, or its Balance,
  Deposit, or Equity is blank, non-numeric, or (for Balance) zero.
- The generation response also returns aggregate stats (average / highest /
  lowest growth) for the success screen.
- Important note shown in the app: performance is calculated from each client's
  Start Date up to the selected month's end date - it is NOT a month-over-month
  (MoM) growth calculation.

## License

Internal tool - © Ridge Capital Solutions.
