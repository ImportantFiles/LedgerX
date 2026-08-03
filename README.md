# LedgerX

LedgerX turns a Monthly Performance (STT) export into per-account-manager client
reports, written directly into your existing Google Spreadsheet. It runs as a static
site on GitHub Pages, backed by a Google Apps Script Web App.

The interface is a guided, one-step-at-a-time flow - like talking to an operator
that performs one task at a time - rather than a dashboard. Pure black theme,
silver accents, minimal typography, subtle fade/typing animations.

## The flow

```
Upload File  ->  Refresh Workbook  ->  Select Reporting Month  ->  Generate Report
                                                                        |
        Prepare Next Month  <-  View Results (Successful / Errors)  <---+
```

Only the current step is visible; each completed step transitions into the next
automatically. An activity log at the bottom of the page tracks the last upload,
refresh, generation, and archive.

## How it works

```
GitHub Pages (static)              Google Apps Script (Web App)         Google Drive
------------------------           ---------------------------          ------------------
index.html / styles.css / -- fetch(JSON, text/plain) -->  Code.gs (doGet/doPost)  ---> The workbook:
script.js                                                  Reports.gs, Sheets.gs,        Client Database
                                                            Archive.gs, Utils.gs          Generated Report - {AM}
                        <-- JSON response ------------------                              Errors
                                                                                           Generated Summary
                                                                                          Archive copies:
                                                                                           Monthly Performance - {Month} {Year}
```

- **Workbook.** All live sheets - Client Database, Generated Report - *, Errors,
  Generated Summary - are tabs in the one existing spreadsheet. Archives are full
  workbook copies saved into the same Drive folder, one per month, never modified
  after creation.
- **Authentication.** The frontend is public (GitHub Pages), so requests are
  authenticated with a shared secret key. The key lives in Apps Script Script
  Properties (`API_SECRET_KEY`) and is entered once into the browser (stored in
  `localStorage`).
- **Backend is the source of truth.** The browser only parses the uploaded table
  into rows; the Apps Script backend re-reads the Client Database fresh and performs
  every match, calculation, and write.

## Project structure

```
TradingReportGenerator/
  index.html            Guided step-by-step UI
  styles.css             Pure black / silver minimal theme
  script.js               Step flow, file parsing, typing-effect status, API client
  config.js               Public config: Apps Script URL, spreadsheet URL, column aliases
  assets/                  Favicon
  apps-script/
    Code.gs                Web app entry points (doGet/doPost), routing, auth
    Reports.gs              Validation, calculations, grouping, report + error writing
    Sheets.gs                All Sheets read/write access, refresh, column protection
    Archive.gs               "Prepare Next Month": Drive workbook copy + data clear
    Utils.gs                 Formatting/parsing helpers shared by the above
    appsscript.json           Apps Script manifest (web app config, OAuth scopes)
  README.md
  SETUP.md                 Full one-time setup guide
```

## Quick start

1. Follow **[SETUP.md](SETUP.md)** to prepare the spreadsheet, deploy the Apps
   Script Web App, and set the shared secret key.
2. Put the exec URL from your deployment into `config.js` (`APPS_SCRIPT_URL`).
3. Push this folder to a GitHub repo and enable GitHub Pages on it.
4. Open the site and enter the access key when prompted.

## Data rules (for reference)

- **Net Deposit** = Total Deposit − Total Withdrawal
- **Growth %** = ((Balance − Net Deposit) / Net Deposit) × 100, rounded to 2 decimals
- **Floating P/L** = Equity − Balance
- The source's own "Growth" column is always ignored - growth is recalculated from
  Balance and Net Deposit every time.
- Negative numbers always render as `-$1,250.55`, never `($1,250.55)`.
- **Notes** are always one single sentence, ready to paste into GHL:
  `July: 6.42% growth, $1,842.55 closed profit, $325.20 floating P/L, $18,560.55 current balance.`
- An account is routed to **Generated Report - Unknown** and logged in the
  **Errors** sheet whenever its STT ID is blank/unmatched/duplicated, or its
  Balance, Deposit, or Equity is blank, non-numeric, or (for Balance) zero.
- The **Errors** sheet stores every error from the latest generation:
  Client Name, Account Number, Software, Error Type, Detailed Error Message, Timestamp.
- The Google Sheet's own pivot tables are the official summary - LedgerX refreshes
  them (by flushing the new report data they reference) but never generates a
  separate summary.
- Disclaimer shown in the app: *Performance shown is Month-to-Date and should not
  be interpreted as Month-on-Month performance.*

## Prepare Next Month

Archiving saves a complete copy of the workbook - formulas, pivot tables, charts,
formatting - as `Monthly Performance - {Month} {Year}` in the same Drive folder,
then clears only the report data rows. Headers, formulas, pivot tables, conditional
formatting, protected ranges, data validation, and sheet structure are preserved, so
the workbook is immediately ready for the next month.

## License

Internal tool - no license file included by default.
