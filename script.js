/**
 * script.js
 * LedgerX frontend. Organized as small namespaces instead of one big
 * blob of functions - each namespace owns one concern (API access,
 * calculation, parsing, rendering, app state).
 */
(function () {
  'use strict';

  var CFG = window.LEDGERX_CONFIG;

  // =======================================================================
  // Storage
  // =======================================================================
  var Storage = {
    getAccessKey: function () { return localStorage.getItem(CFG.STORAGE_KEYS.ACCESS_KEY) || ''; },
    setAccessKey: function (key) { localStorage.setItem(CFG.STORAGE_KEYS.ACCESS_KEY, key); },
    getLastMonth: function () { return localStorage.getItem(CFG.STORAGE_KEYS.LAST_MONTH) || ''; },
    setLastMonth: function (monthKey) { localStorage.setItem(CFG.STORAGE_KEYS.LAST_MONTH, monthKey); }
  };

  // =======================================================================
  // API client - talks to the Apps Script Web App.
  // POST bodies are sent as text/plain (containing JSON) to stay inside
  // the CORS "simple request" rules, since Apps Script cannot answer a
  // CORS preflight (OPTIONS) request.
  // =======================================================================
  var Api = {
    get: function (action, extraParams) {
      var url = new URL(CFG.APPS_SCRIPT_URL);
      url.searchParams.set('action', action);
      url.searchParams.set('key', Storage.getAccessKey());
      Object.keys(extraParams || {}).forEach(function (k) { url.searchParams.set(k, extraParams[k]); });
      return fetch(url.toString(), { method: 'GET' }).then(Api._handle);
    },
    post: function (action, body) {
      var payload = Object.assign({ action: action, key: Storage.getAccessKey() }, body);
      return fetch(CFG.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      }).then(Api._handle);
    },
    _handle: function (response) {
      return response.json().then(function (data) {
        if (!data.success) throw new Error(data.error || 'Request failed.');
        return data;
      });
    }
  };

  // =======================================================================
  // Engine - business rules mirrored from the Apps Script backend so the
  // UI can render instant, correct previews. The backend independently
  // recomputes everything from a fresh read of the Client Database before
  // writing to Sheets, so this copy is never the final authority.
  // =======================================================================
  var Engine = (function () {
    var ISSUES = {
      BLANK_STT_ID: 'Blank STT ID',
      UNKNOWN_CLIENT: 'Unknown Client',
      ZERO_BALANCE: 'Zero Balance',
      MISSING_DEPOSIT: 'Missing Deposit',
      MISSING_EQUITY: 'Missing Equity',
      MISSING_BALANCE: 'Missing Balance',
      DUPLICATE_STT_ID: 'Duplicate STT ID',
      INVALID_NUMBER: 'Invalid Number',
      GROWTH_FAILED: 'Growth Calculation Failed',
      FLOATING_PL_FAILED: 'Floating P/L Calculation Failed'
    };
    var UNKNOWN_LABEL = 'Unknown';

    function isBlank(v) { return v === null || v === undefined || String(v).trim() === ''; }

    function normalizeSttId(v) {
      if (isBlank(v)) return '';
      return String(v).trim().replace(/\.0+$/, '');
    }

    function parseNumber(value) {
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

    function roundTo2(num) {
      if (!isFinite(num)) return NaN;
      var sign = num < 0 ? -1 : 1;
      return sign * (Math.round((Math.abs(num) + Number.EPSILON) * 100) / 100);
    }

    function formatCurrency(num) {
      if (!isFinite(num)) return '$0.00';
      var rounded = roundTo2(num);
      var negative = rounded < 0;
      var abs = Math.abs(rounded);
      var parts = abs.toFixed(2).split('.');
      var intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      var formatted = '$' + intPart + '.' + parts[1];
      return negative ? '-' + formatted : formatted;
    }

    function buildNote(monthLabel, growthPct, closedProfit, floatingPL, balance) {
      var growthStr = roundTo2(growthPct).toFixed(2);
      return monthLabel + ': ' + growthStr + '% growth, ' + formatCurrency(closedProfit) +
        ' closed profit, ' + formatCurrency(floatingPL) + ' floating P/L, ' +
        formatCurrency(balance) + ' current balance.';
    }

    function buildUnknownNote(monthLabel, issues) {
      return monthLabel + ': Unable to calculate - ' + issues.map(function (i) { return i.issue; }).join('; ') + '.';
    }

    /** Evaluates every pasted row against the client list. Returns { groups, errors, counts, rows }. */
    function evaluateAll(sttRows, clientBySttId, monthLabel) {
      var seenIds = {};
      var groups = {}; // amLabel -> array of row objects {sttId,name,system,am,note,isUnknown}
      var errors = [];
      var counts = { total: 0, matched: 0, unknown: 0, zeroBalance: 0, errors: 0 };

      sttRows.forEach(function (row) {
        counts.total++;
        var sttId = normalizeSttId(row.sttId);
        var issues = [];

        if (isBlank(sttId)) {
          issues.push({ issue: ISSUES.BLANK_STT_ID, details: 'STT ID is missing from the pasted row.' });
          pushError('(blank)', issues);
          addToGroup(UNKNOWN_LABEL, { sttId: '', name: 'Unknown', system: 'Unknown', am: UNKNOWN_LABEL,
            note: buildUnknownNote(monthLabel, issues), isUnknown: true });
          counts.unknown++;
          return;
        }

        if (seenIds[sttId]) {
          issues.push({ issue: ISSUES.DUPLICATE_STT_ID, details: 'STT ID "' + sttId + '" appears more than once in the pasted data.' });
          pushError(sttId, issues);
          return;
        }
        seenIds[sttId] = true;

        var client = clientBySttId[sttId];
        if (!client) issues.push({ issue: ISSUES.UNKNOWN_CLIENT, details: 'STT ID "' + sttId + '" was not found in the Client Database.' });

        var depositBlank = isBlank(row.deposit), balanceBlank = isBlank(row.balance), equityBlank = isBlank(row.equity);
        var depositNum = depositBlank ? NaN : parseNumber(row.deposit);
        var withdrawalNum = isBlank(row.withdrawal) ? 0 : parseNumber(row.withdrawal);
        var closedProfitNum = isBlank(row.closedProfit) ? 0 : parseNumber(row.closedProfit);
        var balanceNum = balanceBlank ? NaN : parseNumber(row.balance);
        var equityNum = equityBlank ? NaN : parseNumber(row.equity);

        if (balanceBlank) issues.push({ issue: ISSUES.MISSING_BALANCE, details: 'Balance value is blank.' });
        else if (isNaN(balanceNum)) issues.push({ issue: ISSUES.INVALID_NUMBER, details: 'Balance "' + row.balance + '" is not a valid number.' });
        else if (balanceNum === 0) { issues.push({ issue: ISSUES.ZERO_BALANCE, details: 'Balance equals zero.' }); counts.zeroBalance++; }

        if (depositBlank) issues.push({ issue: ISSUES.MISSING_DEPOSIT, details: 'Total Deposit value is blank.' });
        else if (isNaN(depositNum)) issues.push({ issue: ISSUES.INVALID_NUMBER, details: 'Total Deposit "' + row.deposit + '" is not a valid number.' });

        if (equityBlank) issues.push({ issue: ISSUES.MISSING_EQUITY, details: 'Equity value is blank.' });
        else if (isNaN(equityNum)) issues.push({ issue: ISSUES.INVALID_NUMBER, details: 'Equity "' + row.equity + '" is not a valid number.' });

        if (!isBlank(row.withdrawal) && isNaN(withdrawalNum)) issues.push({ issue: ISSUES.INVALID_NUMBER, details: 'Total Withdrawal "' + row.withdrawal + '" is not a valid number.' });
        if (!isBlank(row.closedProfit) && isNaN(closedProfitNum)) issues.push({ issue: ISSUES.INVALID_NUMBER, details: 'Closed Profit "' + row.closedProfit + '" is not a valid number.' });

        var name = client ? client.name : 'Unknown';
        var system = client ? client.system : 'Unknown';
        var am = client && !isBlank(client.am) ? client.am : UNKNOWN_LABEL;

        if (issues.length === 0) {
          var netDeposit = roundTo2(depositNum - withdrawalNum);
          var growthPct;
          if (netDeposit === 0) {
            issues.push({ issue: ISSUES.GROWTH_FAILED, details: 'Net Deposit is zero, growth percentage is undefined (division by zero).' });
          } else {
            growthPct = roundTo2(((balanceNum - netDeposit) / netDeposit) * 100);
            if (!isFinite(growthPct)) issues.push({ issue: ISSUES.GROWTH_FAILED, details: 'Growth percentage could not be calculated.' });
          }
          var floatingPL = roundTo2(equityNum - balanceNum);
          if (!isFinite(floatingPL)) issues.push({ issue: ISSUES.FLOATING_PL_FAILED, details: 'Floating P/L could not be calculated.' });

          if (issues.length === 0) {
            var note = buildNote(monthLabel, growthPct, closedProfitNum, floatingPL, balanceNum);
            addToGroup(am, { sttId: sttId, name: name, system: system, am: am, note: note, isUnknown: false });
            counts.matched++;
            return;
          }
        }

        pushError(sttId, issues);
        addToGroup(UNKNOWN_LABEL, { sttId: sttId, name: name, system: system, am: am,
          note: buildUnknownNote(monthLabel, issues), isUnknown: true });
        counts.unknown++;

        function pushError(id, list) {
          list.forEach(function (i) { errors.push({ sttId: id, issue: i.issue, details: i.details }); counts.errors++; });
        }
      });

      function addToGroup(label, rowObj) {
        if (!groups[label]) groups[label] = [];
        groups[label].push(rowObj);
      }

      return { groups: groups, errors: errors, counts: counts };
    }

    return {
      normalizeSttId: normalizeSttId, parseNumber: parseNumber, roundTo2: roundTo2,
      formatCurrency: formatCurrency, buildNote: buildNote, evaluateAll: evaluateAll
    };
  })();

  // =======================================================================
  // Parser - turns pasted spreadsheet text into structured STT rows.
  // =======================================================================
  var Parser = {
    parse: function (text) {
      var lines = text.split(/\r\n|\r|\n/).filter(function (l) { return l.trim() !== ''; });
      if (lines.length < 2) return { rows: [], error: 'Paste must include a header row and at least one data row.' };

      var delimiter = lines[0].indexOf('\t') !== -1 ? '\t' : ',';
      var header = lines[0].split(delimiter).map(function (h) { return h.trim().toLowerCase(); });

      var colIndex = {};
      Object.keys(CFG.STT_COLUMN_ALIASES).forEach(function (field) {
        var aliases = CFG.STT_COLUMN_ALIASES[field];
        for (var i = 0; i < header.length; i++) {
          if (aliases.indexOf(header[i]) !== -1) { colIndex[field] = i; break; }
        }
      });
      if (colIndex.sttId === undefined) {
        return { rows: [], error: 'Could not find an STT ID / Account column in the pasted header row.' };
      }

      var rows = [];
      for (var r = 1; r < lines.length; r++) {
        var cells = lines[r].split(delimiter);
        rows.push({
          sttId: cells[colIndex.sttId],
          deposit: colIndex.deposit !== undefined ? cells[colIndex.deposit] : undefined,
          withdrawal: colIndex.withdrawal !== undefined ? cells[colIndex.withdrawal] : undefined,
          closedProfit: colIndex.closedProfit !== undefined ? cells[colIndex.closedProfit] : undefined,
          balance: colIndex.balance !== undefined ? cells[colIndex.balance] : undefined,
          equity: colIndex.equity !== undefined ? cells[colIndex.equity] : undefined
        });
      }
      return { rows: rows, error: null };
    }
  };

  // =======================================================================
  // Toast + Loading overlay
  // =======================================================================
  var Toast = {
    show: function (message, type) {
      var el = document.createElement('div');
      el.className = 'toast toast-' + (type || 'info');
      el.textContent = message;
      document.getElementById('toastContainer').appendChild(el);
      setTimeout(function () { el.remove(); }, 5000);
    },
    success: function (m) { this.show(m, 'success'); },
    error: function (m) { this.show(m, 'error'); },
    info: function (m) { this.show(m, 'info'); }
  };

  var Loading = {
    show: function (label) {
      document.getElementById('loadingLabel').textContent = label || 'Working...';
      this.progress(8);
      document.getElementById('loadingOverlay').classList.remove('hidden');
    },
    progress: function (pct) { document.getElementById('progressFill').style.width = Math.min(pct, 100) + '%'; },
    hide: function () { document.getElementById('loadingOverlay').classList.add('hidden'); }
  };

  // =======================================================================
  // App state + UI wiring
  // =======================================================================
  var state = {
    clientBySttId: {},
    clientsLoaded: false,
    sttRows: [],
    lastResult: null, // { groups, errors, counts }
    activeAmFilter: 'All',
    searchTerm: '',
    selectedMonthKey: '',
    selectedMonthLabel: ''
  };

  function buildMonthOptions() {
    var select = document.getElementById('monthSelect');
    var now = new Date();
    var options = [];
    for (var y = now.getFullYear() - CFG.MONTH_RANGE.yearsBack; y <= now.getFullYear() + CFG.MONTH_RANGE.yearsForward; y++) {
      for (var m = 0; m < 12; m++) {
        var key = y + '-' + String(m + 1).padStart(2, '0');
        options.push({ key: key, label: CFG.MONTH_NAMES[m] + ' ' + y });
      }
    }
    select.innerHTML = options.map(function (o) {
      return '<option value="' + o.key + '">' + o.label + '</option>';
    }).join('');

    var stored = Storage.getLastMonth();
    var currentKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    select.value = stored && options.some(function (o) { return o.key === stored; }) ? stored : currentKey;
    onMonthChange();
  }

  function onMonthChange() {
    var select = document.getElementById('monthSelect');
    state.selectedMonthKey = select.value;
    var opt = select.options[select.selectedIndex];
    state.selectedMonthLabel = opt.textContent;
    Storage.setLastMonth(state.selectedMonthKey);
    updateGenerateButtonState();
  }

  function updateGenerateButtonState() {
    var btn = document.getElementById('btnGenerate');
    btn.disabled = !(state.clientsLoaded && state.sttRows.length > 0 && state.selectedMonthKey);
  }

  function loadClientDatabase() {
    if (!Storage.getAccessKey()) return Promise.resolve();
    return Api.get('getClients').then(function (data) {
      state.clientBySttId = {};
      data.clients.forEach(function (c) { state.clientBySttId[Engine.normalizeSttId(c.sttId)] = c; });
      state.clientsLoaded = true;
      updateGenerateButtonState();
    }).catch(function (err) {
      state.clientsLoaded = false;
      Toast.error('Could not load Client Database: ' + err.message);
    });
  }

  // ---- Rendering ----
  function renderStats(counts) {
    document.getElementById('statTotal').textContent = counts.totalAccounts != null ? counts.totalAccounts : counts.total;
    document.getElementById('statMatched').textContent = counts.matchedAccounts != null ? counts.matchedAccounts : counts.matched;
    document.getElementById('statUnknown').textContent = counts.unknownAccounts != null ? counts.unknownAccounts : counts.unknown;
    document.getElementById('statZeroBalance').textContent = counts.zeroBalanceAccounts != null ? counts.zeroBalanceAccounts : counts.zeroBalance;
    document.getElementById('statReports').textContent = counts.generatedReports != null ? counts.generatedReports : Object.keys(state.lastResult ? state.lastResult.groups : {}).length;
    document.getElementById('statErrors').textContent = counts.errorCount != null ? counts.errorCount : counts.errors;

    var badge = document.getElementById('errorBadge');
    var errCount = counts.errorCount != null ? counts.errorCount : counts.errors;
    badge.textContent = errCount;
    badge.classList.toggle('hidden', !errCount);
  }

  function renderAmTabs() {
    var tabs = document.getElementById('amTabs');
    var labels = Object.keys(state.lastResult.groups).sort(function (a, b) {
      if (a === 'Unknown') return 1;
      if (b === 'Unknown') return -1;
      return a.localeCompare(b);
    });
    var all = ['All'].concat(labels);
    tabs.innerHTML = all.map(function (label) {
      var active = label === state.activeAmFilter ? ' active' : '';
      return '<button type="button" class="am-tab' + active + '" data-am="' + escapeHtml(label) + '">' + escapeHtml(label) + '</button>';
    }).join('');
    tabs.querySelectorAll('.am-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.activeAmFilter = btn.getAttribute('data-am');
        renderAmTabs();
        renderTable();
      });
    });
  }

  function getAllRows() {
    var rows = [];
    Object.keys(state.lastResult.groups).forEach(function (label) {
      rows = rows.concat(state.lastResult.groups[label]);
    });
    return rows;
  }

  function renderTable() {
    var body = document.getElementById('reportTableBody');
    if (!state.lastResult) {
      body.innerHTML = '<tr class="empty-row"><td colspan="5">No reports generated yet. Paste STT data and click Generate Reports.</td></tr>';
      return;
    }

    var rows = state.activeAmFilter === 'All' ? getAllRows() : (state.lastResult.groups[state.activeAmFilter] || []);
    var term = state.searchTerm.trim().toLowerCase();
    if (term) {
      rows = rows.filter(function (r) {
        return (r.sttId + ' ' + r.name + ' ' + r.system + ' ' + r.am).toLowerCase().indexOf(term) !== -1;
      });
    }

    if (rows.length === 0) {
      body.innerHTML = '<tr class="empty-row"><td colspan="5">No matching rows.</td></tr>';
      return;
    }

    body.innerHTML = rows.map(function (r) {
      return '<tr class="' + (r.isUnknown ? 'row-unknown' : '') + '">' +
        '<td>' + escapeHtml(r.sttId || '(blank)') + '</td>' +
        '<td>' + escapeHtml(r.name) + '</td>' +
        '<td>' + escapeHtml(r.system) + '</td>' +
        '<td>' + escapeHtml(r.am) + '</td>' +
        '<td>' + escapeHtml(r.note) + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderErrors(errors) {
    var body = document.getElementById('errorsTableBody');
    if (!errors || errors.length === 0) {
      body.innerHTML = '<tr class="empty-row"><td colspan="3">No errors.</td></tr>';
      return;
    }
    body.innerHTML = errors.map(function (e) {
      return '<tr><td>' + escapeHtml(e.sttId) + '</td><td>' + escapeHtml(e.issue) + '</td><td>' + escapeHtml(e.details) + '</td></tr>';
    }).join('');
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderAll() {
    renderStats(state.lastResult.counts);
    renderAmTabs();
    renderTable();
    renderErrors(state.lastResult.errors);
  }

  // ---- Actions ----
  function handleParse() {
    var text = document.getElementById('sttInput').value;
    var result = Parser.parse(text);
    if (result.error) {
      Toast.error(result.error);
      return;
    }
    state.sttRows = result.rows;
    document.getElementById('pasteRowCount').textContent = result.rows.length + ' rows detected';
    updateGenerateButtonState();
    Toast.success('Parsed ' + result.rows.length + ' rows. Click Generate Reports to continue.');
  }

  function handleGenerate() {
    if (!state.selectedMonthKey || state.sttRows.length === 0) return;
    Loading.show('Calculating report preview...');
    Loading.progress(30);

    setTimeout(function () {
      var localResult = Engine.evaluateAll(state.sttRows, state.clientBySttId, state.selectedMonthLabel);
      state.lastResult = localResult;
      renderAll();
      Loading.progress(60);

      Api.post('generateReports', {
        monthKey: state.selectedMonthKey,
        monthLabel: state.selectedMonthLabel,
        rows: state.sttRows
      }).then(function (data) {
        state.lastResult.counts = data.counts;
        state.lastResult.errors = data.errors;
        renderAll();
        document.getElementById('lastGeneratedLabel').textContent = data.monthLabel + ' - ' + new Date().toLocaleString();
        Loading.progress(100);
        Toast.success('Reports generated and saved to Google Sheets (' + data.counts.generatedReports + ' sheets).');
        (data.warnings || []).forEach(function (w) { Toast.info(w); });
      }).catch(function (err) {
        Toast.error('Generation failed: ' + err.message);
      }).finally(function () {
        Loading.hide();
      });
    }, 30);
  }

  function handleSync() {
    if (!state.sttRows.length || !state.selectedMonthKey) {
      Toast.error('Nothing to sync yet - parse data and generate a report first.');
      return;
    }
    Loading.show('Syncing to Google Sheets...');
    Loading.progress(40);
    Api.post('generateReports', {
      monthKey: state.selectedMonthKey,
      monthLabel: state.selectedMonthLabel,
      rows: state.sttRows
    }).then(function (data) {
      if (state.lastResult) {
        state.lastResult.counts = data.counts;
        state.lastResult.errors = data.errors;
        renderAll();
      }
      Loading.progress(100);
      Toast.success('Synced to Google Sheets.');
    }).catch(function (err) {
      Toast.error('Sync failed: ' + err.message);
    }).finally(function () {
      Loading.hide();
    });
  }

  function handleExport() {
    if (!state.lastResult) { Toast.error('Nothing to export yet.'); return; }
    var rows = getAllRows();
    var csv = ['STT ID,Name,System,AM,Note'].concat(rows.map(function (r) {
      return [r.sttId, r.name, r.system, r.am, r.note].map(csvEscape).join(',');
    })).join('\r\n');
    downloadFile('LedgerX-Reports-' + state.selectedMonthKey + '.csv', csv, 'text/csv');
    Toast.success('Exported ' + rows.length + ' rows.');
  }

  function csvEscape(value) {
    var str = String(value == null ? '' : value);
    return /[",\r\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  }

  function downloadFile(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleCopyNotes() {
    if (!state.lastResult) { Toast.error('Nothing to copy yet.'); return; }
    var rows = getAllRows().filter(function (r) { return !r.isUnknown; });
    var text = rows.map(function (r) { return r.sttId + ' - ' + r.note; }).join('\n');
    navigator.clipboard.writeText(text).then(function () {
      Toast.success('Copied ' + rows.length + ' notes to clipboard.');
    }).catch(function () {
      Toast.error('Clipboard access was denied by the browser.');
    });
  }

  function handlePrepareNext() {
    if (!state.selectedMonthLabel) return;
    Loading.show('Archiving ' + state.selectedMonthLabel + '...');
    Loading.progress(35);
    Api.post('prepareNextMonth', { monthLabel: state.selectedMonthLabel }).then(function (data) {
      Loading.progress(100);
      Toast.success('Archived ' + data.archivedMonth + ' (' + data.archivedSheets.length + ' sheets). Ready for the next period.');
      state.sttRows = [];
      state.lastResult = null;
      document.getElementById('sttInput').value = '';
      document.getElementById('pasteRowCount').textContent = '0 rows detected';
      renderTable();
      renderStats({ total: 0, matched: 0, unknown: 0, zeroBalance: 0, errors: 0 });
      advanceMonthSelect();
      updateGenerateButtonState();
    }).catch(function (err) {
      Toast.error('Archiving failed: ' + err.message);
    }).finally(function () {
      Loading.hide();
      closeModal('confirmArchiveModal');
    });
  }

  function advanceMonthSelect() {
    var select = document.getElementById('monthSelect');
    var idx = select.selectedIndex;
    if (idx < select.options.length - 1) {
      select.selectedIndex = idx + 1;
      onMonthChange();
    }
  }

  // ---- Modals ----
  function openModal(id) { document.getElementById(id).showModal(); }
  function closeModal(id) { document.getElementById(id).close(); }

  function handleTestConnection() {
    var key = document.getElementById('accessKeyInput').value.trim();
    var statusEl = document.getElementById('settingsStatus');
    if (!key) { statusEl.textContent = 'Enter a key first.'; return; }
    var previous = Storage.getAccessKey();
    Storage.setAccessKey(key);
    statusEl.textContent = 'Testing...';
    Api.get('ping').then(function () {
      statusEl.textContent = 'Connection successful.';
    }).catch(function (err) {
      Storage.setAccessKey(previous);
      statusEl.textContent = 'Failed: ' + err.message;
    });
  }

  function handleSaveSettings() {
    var key = document.getElementById('accessKeyInput').value.trim();
    if (!key) { Toast.error('Access key cannot be empty.'); return; }
    Storage.setAccessKey(key);
    closeModal('settingsModal');
    Toast.info('Loading Client Database...');
    loadClientDatabase().then(function () {
      if (state.clientsLoaded) Toast.success('Connected. Client Database loaded.');
    });
  }

  // =======================================================================
  // Init
  // =======================================================================
  document.addEventListener('DOMContentLoaded', function () {
    buildMonthOptions();
    document.getElementById('monthSelect').addEventListener('change', onMonthChange);

    document.getElementById('btnPasteData').addEventListener('click', function () {
      document.getElementById('pastePanel').classList.remove('hidden');
    });
    document.getElementById('btnClosePaste').addEventListener('click', function () {
      document.getElementById('pastePanel').classList.add('hidden');
    });
    document.getElementById('btnParse').addEventListener('click', handleParse);
    document.getElementById('btnGenerate').addEventListener('click', handleGenerate);
    document.getElementById('btnSync').addEventListener('click', handleSync);
    document.getElementById('btnExport').addEventListener('click', handleExport);
    document.getElementById('btnCopyNotes').addEventListener('click', handleCopyNotes);

    document.getElementById('btnViewErrors').addEventListener('click', function () { openModal('errorsModal'); });
    document.getElementById('btnSettings').addEventListener('click', function () {
      document.getElementById('accessKeyInput').value = Storage.getAccessKey();
      document.getElementById('settingsStatus').textContent = '';
      openModal('settingsModal');
    });
    document.getElementById('btnPrepareNext').addEventListener('click', function () { openModal('confirmArchiveModal'); });
    document.getElementById('btnConfirmArchive').addEventListener('click', handlePrepareNext);
    document.getElementById('btnTestConnection').addEventListener('click', handleTestConnection);
    document.getElementById('btnSaveSettings').addEventListener('click', handleSaveSettings);

    document.querySelectorAll('[data-close-modal]').forEach(function (btn) {
      btn.addEventListener('click', function () { closeModal(btn.getAttribute('data-close-modal')); });
    });

    document.getElementById('searchInput').addEventListener('input', function (e) {
      state.searchTerm = e.target.value;
      if (state.lastResult) renderTable();
    });

    if (!Storage.getAccessKey()) {
      Toast.info('Set your Apps Script access key to get started.');
      openModal('settingsModal');
    } else {
      loadClientDatabase();
    }
  });
})();
