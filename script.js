/**
 * script.js
 * LedgerX frontend - a guided, one-step-at-a-time flow:
 *
 *   Upload File -> Refresh Workbook -> Select Period -> Generate -> Results -> Prepare Next Month
 *
 * All business logic (matching, calculations, note text, error rules)
 * lives in the Apps Script backend; this file only parses the uploaded
 * table into rows, drives the step transitions, and renders results.
 */
(function () {
  'use strict';

  var CFG = window.LEDGERX_CONFIG;

  function $(id) { return document.getElementById(id); }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function now() { return new Date().toLocaleString(); }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // =======================================================================
  // Persistence: access key + activity log (localStorage only)
  // =======================================================================
  var Store = {
    getKey: function () { return localStorage.getItem(CFG.STORAGE_KEYS.ACCESS_KEY) || ''; },
    setKey: function (k) { localStorage.setItem(CFG.STORAGE_KEYS.ACCESS_KEY, k); },
    getActivity: function () {
      try { return JSON.parse(localStorage.getItem(CFG.STORAGE_KEYS.ACTIVITY)) || {}; }
      catch (e) { return {}; }
    },
    patchActivity: function (patch) {
      var merged = Object.assign(this.getActivity(), patch);
      localStorage.setItem(CFG.STORAGE_KEYS.ACTIVITY, JSON.stringify(merged));
      ActivityLog.render();
    }
  };

  // =======================================================================
  // API client. POST bodies are sent as text/plain (containing JSON) to
  // stay inside the CORS "simple request" rules - Apps Script web apps
  // cannot answer a CORS preflight (OPTIONS) request.
  // =======================================================================
  var Api = {
    get: function (action) {
      var url = new URL(CFG.APPS_SCRIPT_URL);
      url.searchParams.set('action', action);
      url.searchParams.set('key', Store.getKey());
      return fetch(url.toString(), { method: 'GET' }).then(Api._handle);
    },
    post: function (action, body) {
      var payload = Object.assign({ action: action, key: Store.getKey() }, body);
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
  // Table parsing: uploaded file or pasted text -> structured STT rows.
  // Extra columns in the source are ignored; only aliased columns are read.
  // =======================================================================
  var TableData = {
    detectColumns: function (headerCells) {
      var header = headerCells.map(function (h) {
        return String(h == null ? '' : h).trim().toLowerCase();
      });
      var colIndex = {};
      Object.keys(CFG.STT_COLUMN_ALIASES).forEach(function (field) {
        var aliases = CFG.STT_COLUMN_ALIASES[field];
        for (var i = 0; i < header.length; i++) {
          if (aliases.indexOf(header[i]) !== -1) { colIndex[field] = i; break; }
        }
      });
      return colIndex.sttId === undefined ? null : colIndex;
    },

    fromGrid: function (grid) {
      if (!grid || grid.length < 2) {
        throw new Error('The file must include a header row and at least one data row.');
      }
      var colIndex = this.detectColumns(grid[0]);
      if (!colIndex) {
        throw new Error('Could not find an STT ID / Account column in the header row.');
      }
      function pick(cells, idx) { return idx === undefined ? undefined : cells[idx]; }

      var rows = [];
      for (var r = 1; r < grid.length; r++) {
        var cells = grid[r];
        if (!cells || cells.every(function (c) { return String(c == null ? '' : c).trim() === ''; })) continue;
        rows.push({
          sttId: pick(cells, colIndex.sttId),
          deposit: pick(cells, colIndex.deposit),
          withdrawal: pick(cells, colIndex.withdrawal),
          closedProfit: pick(cells, colIndex.closedProfit),
          balance: pick(cells, colIndex.balance),
          equity: pick(cells, colIndex.equity)
        });
      }
      if (rows.length === 0) throw new Error('No data rows found below the header.');
      return rows;
    },

    fromText: function (text) {
      var lines = text.split(/\r\n|\r|\n/).filter(function (l) { return l.trim() !== ''; });
      var delimiter = lines.length && lines[0].indexOf('\t') !== -1 ? '\t' : ',';
      return this.fromGrid(lines.map(function (l) { return l.split(delimiter); }));
    },

    fromFile: function (file) {
      var self = this;
      var name = file.name.toLowerCase();
      if (/\.(xlsx|xls)$/.test(name)) {
        if (typeof XLSX === 'undefined') {
          return Promise.reject(new Error(
            'The Excel reader could not be loaded. Export the file as CSV and upload that instead.'));
        }
        return file.arrayBuffer().then(function (buf) {
          var workbook = XLSX.read(buf, { type: 'array' });
          var sheet = workbook.Sheets[workbook.SheetNames[0]];
          var grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
          return self.fromGrid(grid);
        });
      }
      return file.text().then(function (text) { return self.fromText(text); });
    }
  };

  // =======================================================================
  // Status player: types each message line, holds with a pulsing ellipsis
  // on the last line until the real work settles, then types the final
  // line ("Done." by default) - or the error message if the work failed.
  // =======================================================================
  var TYPE_SPEED = 14;
  var LINE_PAUSE = 240;

  function typeLine(container, text, className) {
    return new Promise(function (resolve) {
      var line = document.createElement('div');
      line.className = 'status-line' + (className ? ' ' + className : '');
      container.appendChild(line);
      var i = 0;
      (function tick() {
        i++;
        line.textContent = text.slice(0, i);
        if (i < text.length) {
          setTimeout(tick, TYPE_SPEED);
        } else {
          line.classList.add('done');
          setTimeout(resolve, LINE_PAUSE);
        }
      })();
    });
  }

  function playStatus(container, lines, work, finalLine) {
    container.innerHTML = '';
    var settled = false, value, failure;
    var tracked = (work || Promise.resolve()).then(
      function (v) { settled = true; value = v; },
      function (e) { settled = true; failure = e; }
    );

    var chain = Promise.resolve();
    lines.forEach(function (l) {
      chain = chain.then(function () { return typeLine(container, l); });
    });

    return chain
      .then(function () {
        if (settled) return null;
        var last = container.lastElementChild;
        var base = last ? last.textContent.replace(/\.+$/, '') : '';
        var dots = 3;
        var pulse = setInterval(function () {
          if (!last) return;
          dots = (dots % 3) + 1;
          last.textContent = base + '...'.slice(0, dots);
        }, 380);
        return tracked.then(function () {
          clearInterval(pulse);
          if (last) last.textContent = base + '...';
        });
      })
      .then(function () {
        if (failure) {
          return typeLine(container, failure.message || String(failure), 'error')
            .then(function () { throw failure; });
        }
        return typeLine(container, finalLine || 'Done.').then(function () { return value; });
      });
  }

  // =======================================================================
  // Step controller: exactly one step visible at a time.
  // =======================================================================
  var Steps = {
    ids: ['step-key', 'step-upload', 'step-upload-progress', 'step-refresh', 'step-month',
      'step-generate', 'step-complete', 'step-next', 'step-done'],
    show: function (id) {
      this.ids.forEach(function (stepId) {
        $(stepId).classList.toggle('visible', stepId === id);
      });
    }
  };

  // =======================================================================
  // Activity log (footer)
  // =======================================================================
  var ActivityLog = {
    render: function () {
      var a = Store.getActivity();
      $('actUpload').textContent = a.lastUpload || '—';
      $('actRefresh').textContent = a.lastRefresh || '—';
      $('actGenerate').textContent = a.lastGenerate || '—';
      $('actArchive').textContent = a.lastArchive || '—';
      $('actStatus').textContent = a.status || 'Idle';
      $('actErrors').textContent = a.lastErrors != null ? String(a.lastErrors) : '—';
    }
  };

  // =======================================================================
  // App state
  // =======================================================================
  var state = {
    rows: [],
    monthKey: '',
    monthName: '',
    monthLabel: '',
    result: null
  };

  // =======================================================================
  // Access key step
  // =======================================================================
  function initKey() {
    $('btnSaveKey').addEventListener('click', function () {
      var key = $('accessKeyInput').value.trim();
      var status = $('keyStatus');
      if (!key) { status.textContent = 'Enter the access key to continue.'; return; }
      var previous = Store.getKey();
      Store.setKey(key);
      status.textContent = 'Verifying...';
      Api.get('ping').then(function () {
        status.textContent = '';
        Steps.show('step-upload');
      }).catch(function (err) {
        Store.setKey(previous);
        status.textContent = 'Connection failed: ' + err.message;
      });
    });

    $('connectionLink').addEventListener('click', function () {
      $('accessKeyInput').value = Store.getKey();
      $('keyStatus').textContent = '';
      Steps.show('step-key');
    });
  }

  // =======================================================================
  // Step 1: Upload
  // =======================================================================
  function initUpload() {
    var dropzone = $('dropzone');
    var input = $('fileInput');

    dropzone.addEventListener('click', function () { input.click(); });
    dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', function () {
      if (input.files.length) {
        beginUpload(TableData.fromFile(input.files[0]), input.files[0].name);
        input.value = '';
      }
    });

    ['dragover', 'dragenter'].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove('drag'); });
    });
    dropzone.addEventListener('drop', function (e) {
      var file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) beginUpload(TableData.fromFile(file), file.name);
    });

    document.addEventListener('paste', function (e) {
      if (!$('step-upload').classList.contains('visible')) return;
      var text = e.clipboardData && e.clipboardData.getData('text');
      if (text && text.trim()) {
        beginUpload(
          Promise.resolve().then(function () { return TableData.fromText(text); }),
          'Pasted table'
        );
      }
    });
  }

  function beginUpload(parsePromise, sourceName) {
    Steps.show('step-upload-progress');
    Store.patchActivity({ status: 'Validating upload' });

    playStatus($('uploadStatus'), [
      '✓ File uploaded successfully.',
      'Analyzing workbook...',
      'Checking worksheet structure...',
      'Validating sheets...'
    ], parsePromise, 'Workbook verified.')
      .then(function (rows) {
        state.rows = rows;
        Store.patchActivity({ lastUpload: sourceName + ' · ' + now(), status: 'Idle' });
        return delay(900);
      })
      .then(function () { Steps.show('step-refresh'); })
      .catch(function () {
        Store.patchActivity({ status: 'Upload failed' });
        return delay(2400).then(function () { Steps.show('step-upload'); });
      });
  }

  // =======================================================================
  // Step 2: Refresh workbook
  // =======================================================================
  function initRefresh() {
    $('btnRefresh').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      Store.patchActivity({ status: 'Refreshing workbook' });

      playStatus($('refreshStatus'), [
        'Refreshing Pivot Tables...',
        'Refreshing formulas...',
        'Updating references...',
        'Checking calculations...',
        'Finalizing...'
      ], Api.post('refreshWorkbook', {}))
        .then(function (data) {
          var line = $('lastRefreshLine');
          line.textContent = 'Last Refresh · ' + data.refreshedDate + ' · ' + data.refreshedTime;
          line.classList.remove('hidden');
          Store.patchActivity({
            lastRefresh: data.refreshedDate + ' ' + data.refreshedTime,
            status: 'Idle'
          });
          return delay(1100);
        })
        .then(function () { Steps.show('step-month'); })
        .catch(function () {
          Store.patchActivity({ status: 'Refresh failed' });
          btn.disabled = false;
        });
    });
  }

  // =======================================================================
  // Step 3: Reporting period
  // =======================================================================
  function initMonth() {
    var monthSelect = $('monthSelect');
    var yearSelect = $('yearSelect');
    var today = new Date();

    monthSelect.innerHTML = CFG.MONTH_NAMES.map(function (name, i) {
      return '<option value="' + i + '">' + name + '</option>';
    }).join('');
    monthSelect.value = String(today.getMonth());

    var years = [];
    for (var y = today.getFullYear() - CFG.YEAR_RANGE.back; y <= today.getFullYear() + CFG.YEAR_RANGE.forward; y++) {
      years.push(y);
    }
    yearSelect.innerHTML = years.map(function (yr) {
      return '<option value="' + yr + '">' + yr + '</option>';
    }).join('');
    yearSelect.value = String(today.getFullYear());

    $('btnContinueMonth').addEventListener('click', function () {
      var monthIndex = parseInt(monthSelect.value, 10);
      var year = parseInt(yearSelect.value, 10);
      state.monthName = CFG.MONTH_NAMES[monthIndex];
      state.monthLabel = state.monthName + ' ' + year;
      state.monthKey = year + '-' + String(monthIndex + 1).padStart(2, '0');
      $('generatePeriod').textContent = state.monthLabel;
      Steps.show('step-generate');
    });
  }

  // =======================================================================
  // Step 4: Generate report
  // =======================================================================
  function initGenerate() {
    $('btnGenerateReport').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      Store.patchActivity({ status: 'Generating report' });

      playStatus($('generateStatus'), [
        'Reading spreadsheet...',
        'Loading client data...',
        'Calculating Monthly Performance...',
        'Generating Notes...',
        'Refreshing Pivot Tables...',
        'Applying formatting...',
        'Hiding internal columns...',
        'Saving workbook...'
      ], Api.post('generateReports', {
        monthKey: state.monthKey,
        monthLabel: state.monthLabel,
        rows: state.rows
      }))
        .then(function (data) {
          state.result = data;
          $('figSuccess').textContent = data.counts.matchedAccounts;
          $('figErrors').textContent = data.counts.errorCount;
          renderErrors(data.errors || []);
          Store.patchActivity({
            lastGenerate: state.monthLabel + ' · ' + now(),
            lastErrors: data.counts.errorCount,
            status: 'Idle'
          });
          return delay(900);
        })
        .then(function () { Steps.show('step-complete'); })
        .catch(function () {
          Store.patchActivity({ status: 'Generation failed' });
          btn.disabled = false;
        });
    });
  }

  function renderErrors(errors) {
    var body = $('errorsTableBody');
    if (!errors.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty">No errors recorded for this generation.</td></tr>';
      return;
    }
    body.innerHTML = errors.map(function (e) {
      return '<tr>' +
        '<td>' + escapeHtml(e.clientName) + '</td>' +
        '<td>' + escapeHtml(e.sttId) + '</td>' +
        '<td>' + escapeHtml(e.software) + '</td>' +
        '<td>' + escapeHtml(e.issue) + '</td>' +
        '<td>' + escapeHtml(e.details) + '</td>' +
        '</tr>';
    }).join('');
  }

  // =======================================================================
  // Completion screen
  // =======================================================================
  function initComplete() {
    $('btnOpenSheet').addEventListener('click', function () {
      window.open(CFG.SPREADSHEET_URL, '_blank', 'noopener');
    });

    $('btnViewErrors').addEventListener('click', function () {
      $('errorsPanel').classList.toggle('hidden');
    });

    $('btnCopyNotes').addEventListener('click', function () {
      var btn = this;
      var notes = (state.result && state.result.notes) || [];
      if (!notes.length) { flashLabel(btn, 'No notes to copy'); return; }
      var text = notes.map(function (n) { return n.sttId + ' - ' + n.note; }).join('\n');
      navigator.clipboard.writeText(text).then(
        function () { flashLabel(btn, 'Copied ' + notes.length + ' notes'); },
        function () { flashLabel(btn, 'Clipboard blocked by browser'); }
      );
    });

    $('btnToNext').addEventListener('click', function () { Steps.show('step-next'); });
  }

  function flashLabel(button, message) {
    var original = button.textContent;
    button.textContent = message;
    setTimeout(function () { button.textContent = original; }, 2200);
  }

  // =======================================================================
  // Step 5: Prepare next month
  // =======================================================================
  function initNext() {
    $('btnPrepareNext').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      Store.patchActivity({ status: 'Archiving' });

      playStatus($('archiveStatus'), [
        'Creating archive...',
        'Saving Monthly Performance - ' + state.monthLabel,
        'Uploading archive...',
        'Clearing report data...',
        'Keeping formulas...',
        'Keeping Pivot Tables...',
        'Keeping formatting...',
        'Preparing template...'
      ], Api.post('prepareNextMonth', { monthLabel: state.monthLabel }))
        .then(function (data) {
          Store.patchActivity({
            lastArchive: data.archiveFileName + ' · ' + now(),
            status: 'Idle'
          });
          $('doneMessage').textContent = 'The workbook has been archived as "' + data.archiveFileName +
            '" and is ready for the next reporting month.';
          return delay(900);
        })
        .then(function () { Steps.show('step-done'); })
        .catch(function () {
          Store.patchActivity({ status: 'Archive failed' });
          btn.disabled = false;
        });
    });

    $('btnStartOver').addEventListener('click', function () { window.location.reload(); });
  }

  // =======================================================================
  // Init
  // =======================================================================
  document.addEventListener('DOMContentLoaded', function () {
    initKey();
    initUpload();
    initRefresh();
    initMonth();
    initGenerate();
    initComplete();
    initNext();
    ActivityLog.render();
    Steps.show(Store.getKey() ? 'step-upload' : 'step-key');
  });
})();
