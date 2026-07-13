/**
 * Code.gs
 * Web app entry points. Deploy this project as a Web App (Execute as:
 * Me, Access: Anyone) and paste the resulting /exec URL into config.js
 * as APPS_SCRIPT_URL. See SETUP.md for full deployment steps.
 *
 * Requests are authenticated with a shared secret (Script Properties
 * key API_SECRET_KEY) rather than Google OAuth, so the single
 * administrator only has to paste the key once into the web UI.
 *
 * POST bodies are sent as text/plain (containing JSON) instead of
 * application/json specifically to stay inside the CORS "simple
 * request" rules - Apps Script web apps cannot answer CORS preflight
 * (OPTIONS) requests, so avoiding the preflight entirely is required
 * for the GitHub Pages frontend to call this endpoint successfully.
 */

/** Handles GET requests: read-only lookups. */
function doGet(e) {
  var params = (e && e.parameter) || {};
  return safeHandle_(function () {
    assertAuthorized_(params.key);
    switch (params.action) {
      case 'ping':
        return { message: 'pong' };
      case 'getClients':
        return getClientDatabase_();
      default:
        throw new Error('Unknown action: ' + params.action);
    }
  });
}

/** Handles POST requests: report generation and archiving. */
function doPost(e) {
  return safeHandle_(function () {
    var body = parseRequestBody_(e);
    assertAuthorized_(body.key);

    switch (body.action) {
      case 'generateReports':
        return generateReports_(body);
      case 'prepareNextMonth':
        return prepareNextMonth_(body);
      default:
        throw new Error('Unknown action: ' + body.action);
    }
  });
}

/** Parses the JSON payload sent as a text/plain POST body. */
function parseRequestBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Missing request body.');
  }
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    throw new Error('Request body is not valid JSON.');
  }
}
