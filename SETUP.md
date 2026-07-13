# LedgerX Setup Guide

One-time setup, done in four parts: prepare the spreadsheet, deploy the Apps Script
backend, configure the frontend, then publish to GitHub Pages.

## Part 1 - Prepare the spreadsheet

You're using the existing sheet at:
`https://docs.google.com/spreadsheets/d/1C2NX5ImumLfOxyopBHr_xOvwSOQod7bf8yzRTJHX_Yo/edit`

1. **Client Database tab.** Confirm the tab is named exactly `Client Database` (or
   update `CLIENT_SHEET_NAME` in `apps-script/Sheets.gs` to match your tab name), with
   columns A-E as: STT ID, Name, System, AM, Note. Row 1 = headers, data from row 2.

2. **Generated Summary tab.** Create a tab named exactly `Generated Summary`. Build
   your pivot tables and charts on this tab, sourced from the `Generated Report - *`
   sheets (LedgerX creates one such sheet per AM automatically the first time you
   generate reports - run one generation first, then come back and build your pivots
   against those ranges). LedgerX never creates or edits pivot tables/charts itself;
   it only refreshes the underlying data and lets Sheets' own reference-driven
   recalculation update your pivots automatically.

3. **Reserve columns A:F on Generated Summary** for whatever raw pivot source /
   helper data you want protected from accidental edits - LedgerX will hide and
   lock these columns after every successful generation. Put anything meant to stay
   editable (your live charts, summary labels, etc.) in column G onward.

4. **Named ranges for the Last Updated stamp.** On the Generated Summary tab, pick
   three cells (e.g. `H1`, `H2`, `H3`) and create named ranges pointing at them via
   **Data > Named ranges**:
   - `LastUpdatedMonth`
   - `LastUpdatedDate`
   - `LastUpdatedTime`

   LedgerX writes to these named ranges after every successful generation. If you
   skip this step, generation still succeeds - you'll just see a warning toast that
   the stamp couldn't be written.

   `Report Errors` and each `Generated Report - {AM}` sheet are created automatically
   on first use; you don't need to pre-create them.

## Part 2 - Deploy the Apps Script backend

1. Open the spreadsheet, then **Extensions > Apps Script**.
2. Delete the default empty `Code.gs`. Create these five script files and one
   manifest, copying the contents from this project's `apps-script/` folder:
   `Utils.gs`, `Sheets.gs`, `Reports.gs`, `Archive.gs`, `Code.gs`.
3. Open **Project Settings** (gear icon) and make sure *Show "appsscript.json"
   manifest file in editor* is checked, then replace its contents with
   `apps-script/appsscript.json` from this project.
4. In `Sheets.gs`, confirm `SPREADSHEET_ID` matches your sheet's ID (already set to
   `1C2NX5ImumLfOxyopBHr_xOvwSOQod7bf8yzRTJHX_Yo`).
5. **Set the shared secret key**: Project Settings > Script Properties > Add script
   property, key `API_SECRET_KEY`, value = a long random string you generate
   yourself (e.g. from a password manager). This is the key LedgerX's frontend will
   use to authenticate - it is never committed to GitHub.
6. **Deploy > New deployment > type: Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click Deploy, authorize the requested permissions (this project only touches
     the one spreadsheet it's bound to), and copy the `/exec` URL shown.
7. Whenever you edit the `.gs` files afterward, use **Deploy > Manage deployments >
   Edit > New version** so the live `/exec` URL picks up your changes.

## Part 3 - Configure the frontend

1. Open `config.js` in this project and set:
   ```js
   APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycb.../exec'
   ```
   (the URL you copied in Part 2, step 6).
2. If your Client Database uses different header aliases for the STT columns than
   the defaults, adjust `STT_COLUMN_ALIASES` in `config.js`.

## Part 4 - Publish to GitHub Pages

1. Create a GitHub repository (or use an existing one) and push the contents of
   `TradingReportGenerator/` to it. GitHub Pages serves either the repo root or a
   `/docs` folder on a branch, so either:
   - put these files directly at the repo root, or
   - place them in a `docs/` folder and select that as the Pages source.
2. In the repo, go to **Settings > Pages**, choose the branch/folder from step 1,
   and save. GitHub will give you a `https://<user>.github.io/<repo>/` URL.
3. Open that URL, click the gear icon (top right), paste the `API_SECRET_KEY` value
   you generated in Part 2, click **Test Connection**, then **Save**.

## First run

1. Select the **Reporting Month**.
2. Click **Paste Data**, paste the full STT table (with its header row) copied from
   your source, click **Parse Data**.
3. Click **Generate Reports**. The dashboard cards, report table, and Report Errors
   update automatically; the Client Database Note column, Generated Report - {AM}
   sheets, and Generated Summary protections/stamp are all updated in the same run.

## Troubleshooting

- **"Unauthorized: invalid or missing access key."** The key in the browser's
  Settings dialog doesn't match `API_SECRET_KEY` in Script Properties. Re-check both.
- **Requests fail with a network/CORS-looking error.** Double-check the deployment's
  access is set to "Anyone" and that you're using the `/exec` URL (not `/dev`).
- **"Required sheet ... was not found in the workbook."** Create the missing tab
  (`Client Database` or `Generated Summary`) with the exact name expected, or update
  the corresponding constant in `apps-script/Sheets.gs`.
- **Pivot tables/charts don't seem to update.** Confirm they're built from ranges on
  the `Generated Report - {AM}` sheets (not a static copy) - Sheets recalculates
  pivots automatically whenever their source range changes.
