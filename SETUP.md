# LedgerX Setup Guide (v2.0)

One-time setup in four parts: prepare the spreadsheets, deploy the Apps Script
backend, configure the frontend, then publish to GitHub Pages.

## Part 1 - Prepare the main template

The LedgerX Template is the sheet at:
`https://docs.google.com/spreadsheets/d/1C2NX5ImumLfOxyopBHr_xOvwSOQod7bf8yzRTJHX_Yo/edit`

It must contain **exactly two permanent tabs**. Nothing is ever generated into it.

1. **Client Database tab.** Named exactly `Client Database` (or update
   `CLIENT_SHEET_NAME` in `apps-script/Sheets.gs`). Columns A-E: STT ID, Name,
   System, AM, Note. Row 1 = headers, data from row 2. Column A holds the bare
   STT ID (e.g. `1335619`). Populate it from the Account Tracker sheet (copy
   columns A-C, paste as values only, replace "N/A" with blanks) - see the
   in-app Guide.

2. **Raw Data tab.** Named exactly `Raw Data` (the legacy `STT Import` name is
   still accepted). Each month, paste the Monthly Performance export from the
   STT Dashboard (Trades) into it - header row included, values only, every
   page. Recognized headers (case-insensitive):
   - `Account` / `STT ID` / `Login` - the account label, e.g.
     `_RS15 500K Max Tradiso (1335619)`; the STT ID in parentheses is extracted
     automatically
   - `Balance`, `Equity` (required)
   - `Deposits` / `Total Deposit` (required)
   - `Withdrawals` / `Total Withdrawal` - negative amounts and positive totals
     are both handled
   - `Profit` / `Closed Profit`

   Extra columns (Growth %, Trades, Won, Lost, Lots, Com, Swap, ...) are
   ignored. LedgerX always recalculates growth itself.

3. **Delete everything else.** `Errors`, `Generated Summary`, and any
   `Generated Report - *` tabs are obsolete - reports and error logs now live
   only in the generated output file.

## Part 2 - Output folder

Every generation creates (or rewrites) `{Month} {Year} Performance Summary` in
this Drive folder:

`https://drive.google.com/drive/folders/1tkZxSgzWrjv2Ot-zV7J6pAZ4pIEJ3oRi`

The file contains two sheets: **Performance Summary** and **Errors**.
The Google account that deploys the Apps Script must have **edit access** to
this folder. To change the destination, update `OUTPUT_FOLDER_ID` in
`apps-script/Sheets.gs` and `OUTPUT_FOLDER_URL` in `config.js`.

## Part 3 - Deploy the Apps Script backend

1. Open the main template, then **Extensions > Apps Script**.
2. Create these five script files, copying from this project's `apps-script/`
   folder: `Utils.gs`, `Sheets.gs`, `Reports.gs`, `Archive.gs`, `Code.gs`.
3. In Project Settings, enable *Show "appsscript.json"* and replace its
   contents with `apps-script/appsscript.json` (Sheets + Drive scopes; Drive is
   required to create the output file in the folder).
4. Confirm `SPREADSHEET_ID` in `Sheets.gs` matches your template's ID.
5. **Set the shared secret**: Project Settings > Script Properties > add
   `API_SECRET_KEY` = a long random string.
6. **Deploy > New deployment > Web app**: Execute as **Me**, access **Anyone**.
   Authorize Sheets + Drive, copy the `/exec` URL.
7. After any later `.gs` edit: **Deploy > Manage deployments > Edit > New
   version** (keeps the same `/exec` URL).

## Part 4 - Configure and publish the frontend

1. In `config.js`, set `APPS_SCRIPT_URL` to your `/exec` URL. `OUTPUT_FOLDER_URL`
   is already set to the output folder.
2. Push `TradingReportGenerator/` to a GitHub repo and enable GitHub Pages.
3. Open the site, enter the `API_SECRET_KEY` value when asked. The key is
   stored only in that browser; "Connection settings" on the error screen
   changes it later.
4. If your export uses different column headers, adjust `STT_IMPORT_ALIASES_`
   in `apps-script/Utils.gs` (column matching happens in the backend).

## Monthly run

1. Update the template: refresh `Client Database` if needed, paste the latest
   export into `Raw Data` (see the in-app **Guide**).
2. Open LedgerX and click the reporting month - the year is automatic, and
   processing starts immediately.
3. LedgerX reads the template, validates, calculates, and writes
   `{Month} {Year} Performance Summary` (Performance Summary + Errors) into the
   output folder. Re-running a month rewrites the same file.
4. From the success screen: **Open Report**, **Copy Notes** (paste into GHL),
   **Open Output Folder**, or **Generate Another Report**.

## Troubleshooting

- **"Unauthorized: invalid or missing access key."** The key in the browser
  doesn't match `API_SECRET_KEY`. Re-enter it via Connection settings.
- **Network/CORS-looking failures.** Ensure deployment access is "Anyone" and
  the URL is `/exec` (not `/dev`).
- **"No Data Available" screen.** `Raw Data` is empty or missing - paste the
  Monthly Performance table (with its header row) into it.
- **'"Raw Data" is missing required column(s)'.** The paste lacks Balance,
  Equity, or Deposits headers. Paste the full export table.
- **Every account shows "Missing Balance; Missing Deposit; Missing Equity".**
  What's in `Raw Data` isn't the Monthly Performance table. Paste the export
  itself.
- **Output file creation fails.** The deploying account lacks access to the
  output Drive folder - share the folder with it (edit rights).
- **Growth stat cards show "—".** The deployed backend is older than the
  frontend - publish a new deployment version with the latest `.gs` files.
