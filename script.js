/**
 * script.js
 * LedgerX frontend — a conversational, one-question-at-a-time interface.
 *
 * PRESENTATION LAYER ONLY. The business layer is byte-for-byte the same
 * as before: Api (endpoints, payload shapes, text/plain CORS posts),
 * TableData (file/paste parsing), Store (localStorage), and the backend
 * workflow order — parse upload -> refreshWorkbook -> generateReports ->
 * prepareNextMonth. Only how steps are presented and advanced changed:
 * questions replace forms, and steps that used to need a button click
 * (refresh, generate) run automatically inside the processing scene.
 */
(function () {
  'use strict';

  var CFG = window.LEDGERX_CONFIG;

  function $(id) { return document.getElementById(id); }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function now() { return new Date().toLocaleString(); }

  var REDUCED_MOTION = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // =======================================================================
  // Persistence: access key + activity log (localStorage only). Unchanged.
  // The activity log is still recorded; it just has no on-page display in
  // the conversational UI, so render() is null-safe.
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

  var ActivityLog = {
    render: function () {
      var a = Store.getActivity();
      var fields = {
        actUpload: a.lastUpload || '—',
        actRefresh: a.lastRefresh || '—',
        actGenerate: a.lastGenerate || '—',
        actArchive: a.lastArchive || '—',
        actStatus: a.status || 'Idle',
        actErrors: a.lastErrors != null ? String(a.lastErrors) : '—'
      };
      Object.keys(fields).forEach(function (id) {
        var el = $(id);
        if (el) el.textContent = fields[id];
      });
    }
  };

  // =======================================================================
  // API client. POST bodies are sent as text/plain (containing JSON) to
  // stay inside the CORS "simple request" rules - Apps Script web apps
  // cannot answer a CORS preflight (OPTIONS) request. Unchanged.
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
  // Unchanged.
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
  // Liquidity waveform. Thin layered lines (blue / purple / teal / white)
  // drifting slowly through a center envelope — market flow, not Siri.
  // Rendered only while visible; a single static frame under reduced motion.
  // =======================================================================
  var TAU = Math.PI * 2;

  var Wave = {
    el: null,
    canvas: null,
    ctx: null,
    raf: 0,
    hideTimer: 0,
    running: false,
    t: 0,
    LINES: [
      { rgb: '96,165,250',  amp: 30, freq: 2.0, speed: 0.020, phase: 0.0, alpha: 0.50 },
      { rgb: '167,139,250', amp: 22, freq: 2.9, speed: 0.014, phase: 2.2, alpha: 0.42 },
      { rgb: '94,234,212',  amp: 15, freq: 3.7, speed: 0.026, phase: 4.1, alpha: 0.36 },
      { rgb: '255,255,255', amp: 9,  freq: 5.1, speed: 0.010, phase: 1.1, alpha: 0.22 }
    ],

    init: function () {
      this.el = $('wave');
      this.canvas = $('waveCanvas');
      this.ctx = this.canvas.getContext('2d');
      var self = this;
      window.addEventListener('resize', function () { self.resize(); });
      this.resize();
    },

    resize: function () {
      var dpr = window.devicePixelRatio || 1;
      var w = this.el.clientWidth;
      var h = this.el.clientHeight;
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!this.running) this.draw();
    },

    show: function () {
      clearTimeout(this.hideTimer);
      this.el.classList.add('on');
      if (REDUCED_MOTION) { this.draw(); return; }
      if (!this.running) {
        this.running = true;
        this.loop();
      }
    },

    hide: function () {
      var self = this;
      this.el.classList.remove('on');
      clearTimeout(this.hideTimer);
      // Keep animating through the CSS opacity fade, then stop.
      this.hideTimer = setTimeout(function () {
        self.running = false;
        cancelAnimationFrame(self.raf);
      }, 700);
    },

    loop: function () {
      var self = this;
      this.raf = requestAnimationFrame(function () {
        if (!self.running) return;
        self.t += 1;
        self.draw();
        self.loop();
      });
    },

    draw: function () {
      var ctx = this.ctx;
      var w = this.el.clientWidth;
      var h = this.el.clientHeight;
      var mid = h / 2;
      var t = REDUCED_MOTION ? 24 : this.t;

      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 1.2;
      ctx.lineJoin = 'round';

      for (var i = 0; i < this.LINES.length; i++) {
        var L = this.LINES[i];
        ctx.beginPath();
        for (var x = 0; x <= w; x += 3) {
          var u = x / w;
          // Gaussian envelope: full motion mid-stream, still at the edges.
          var env = Math.exp(-Math.pow((u - 0.5) / 0.27, 2));
          var y = mid + env * L.amp * (
            0.66 * Math.sin(u * L.freq * TAU + t * L.speed + L.phase) +
            0.34 * Math.sin(u * L.freq * 2.17 * TAU - t * L.speed * 0.7 + L.phase * 1.7)
          );
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(' + L.rgb + ',' + L.alpha + ')';
        ctx.stroke();
      }
    }
  };

  // =======================================================================
  // Scene manager: exactly one question on screen. Transitions fade the
  // outgoing scene up and out, bridge on the waveform, then fade the next
  // scene in. The waveform stays up for the processing scene.
  // =======================================================================
  var Scenes = {
    current: null,

    show: function (id) {
      var next = $(id);
      var cur = this.current && this.current !== id ? $(this.current) : null;
      this.current = id;
      var keepWave = id === 'step-processing';

      if (!REDUCED_MOTION || keepWave) Wave.show();

      var out = Promise.resolve();
      if (cur) {
        cur.classList.add('leaving');
        out = delay(REDUCED_MOTION ? 0 : 360).then(function () {
          cur.classList.remove('visible', 'leaving');
        });
      }

      return out
        .then(function () { return delay(REDUCED_MOTION ? 0 : 220); })
        .then(function () {
          if (!keepWave) Wave.hide();
          next.classList.add('visible');
          var focusTarget = next.querySelector('[data-autofocus]') || next.querySelector('.q');
          if (focusTarget && focusTarget.focus) {
            try { focusTarget.focus({ preventScroll: true }); } catch (e) { focusTarget.focus(); }
          }
        });
    }
  };

  // =======================================================================
  // Status player: one intelligent status line at a time. Each message
  // crossfades in, dwells, then yields to the next. If the real work is
  // still pending after the last message, the line breathes until it
  // settles. No percentages, no progress bars.
  // =======================================================================
  function swapText(el, text) {
    if (REDUCED_MOTION) { el.textContent = text; return Promise.resolve(); }
    el.classList.add('swap-out');
    return delay(230).then(function () {
      el.textContent = text;
      el.classList.remove('swap-out');
      return delay(240);
    });
  }

  var Status = {
    play: function (messages, work, finalLine) {
      var el = $('statusLine');
      el.classList.remove('holding');
      el.textContent = '';

      var settled = false, value, failure;
      var tracked = (work || Promise.resolve()).then(
        function (v) { settled = true; value = v; },
        function (e) { settled = true; failure = e; }
      );

      var chain = Promise.resolve();
      messages.forEach(function (msg) {
        chain = chain.then(function () {
          if (settled && failure) return null; // stop narrating a failed run
          return swapText(el, msg).then(function () {
            return delay(REDUCED_MOTION ? 120 : 900);
          });
        });
      });

      return chain
        .then(function () {
          if (!settled) el.classList.add('holding');
          return tracked;
        })
        .then(function () {
          el.classList.remove('holding');
          if (failure) throw failure;
          if (finalLine) {
            return swapText(el, finalLine)
              .then(function () { return delay(REDUCED_MOTION ? 150 : 750); })
              .then(function () { return value; });
          }
          return value;
        });
    }
  };

  // =======================================================================
  // App state (same fields as before) + error recovery.
  // =======================================================================
  var state = {
    rows: [],
    monthKey: '',
    monthName: '',
    monthLabel: '',
    result: null
  };

  var retryFn = null;
  var resumeAfterKey = null;

  function fail(err, retry) {
    retryFn = retry || null;
    $('errorMessage').textContent = err && err.message ? err.message : String(err);
    $('btnRetry').classList.toggle('hidden', !retryFn);
    Scenes.show('step-error');
  }

  function initError() {
    $('btnRetry').addEventListener('click', function () {
      var fn = retryFn;
      retryFn = null;
      if (fn) fn();
    });
    $('connectionLink').addEventListener('click', function () {
      resumeAfterKey = retryFn;
      $('accessKeyInput').value = Store.getKey();
      $('keyStatus').textContent = '';
      Scenes.show('step-key');
    });
  }

  // =======================================================================
  // Access key (verification logic unchanged: ping, rollback on failure)
  // =======================================================================
  function initKey() {
    var input = $('accessKeyInput');

    function submit() {
      var key = input.value.trim();
      var status = $('keyStatus');
      if (!key) { status.textContent = 'Enter the access key to continue.'; return; }
      var previous = Store.getKey();
      Store.setKey(key);
      status.textContent = 'Verifying…';
      Api.get('ping').then(function () {
        status.textContent = '';
        var resume = resumeAfterKey;
        resumeAfterKey = null;
        if (resume) { retryFn = null; resume(); }
        else Scenes.show('step-confirm');
      }).catch(function (err) {
        Store.setKey(previous);
        status.textContent = 'Connection failed: ' + err.message;
      });
    }

    $('btnSaveKey').addEventListener('click', submit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  }

  // =======================================================================
  // Question 1: "Done updating the file?"
  // =======================================================================
  function initConfirm() {
    var note = $('confirmNote');

    $('btnConfirmYes').addEventListener('click', function () {
      note.textContent = '';
      Scenes.show('step-upload');
    });

    $('btnConfirmNo').addEventListener('click', function () {
      // Re-trigger the fade even if the message is already showing.
      note.textContent = '';
      void note.offsetWidth;
      note.textContent = 'Please update your file first before continuing.';
    });
  }

  // =======================================================================
  // Question 2: the file. Parsing is unchanged; on success the workbook
  // refresh (same backend call as the old Refresh button) runs
  // automatically inside the processing scene.
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
    Store.patchActivity({ status: 'Validating upload' });
    Scenes.show('step-processing');

    Status.play([
      'Reading your file…',
      'Checking worksheet structure…',
      'Validating data…'
    ], parsePromise)
      .then(function (rows) {
        state.rows = rows;
        Store.patchActivity({ lastUpload: sourceName + ' · ' + now(), status: 'Idle' });
        return refreshWorkbook();
      })
      .catch(function (err) {
        Store.patchActivity({ status: 'Upload failed' });
        fail(err, function () { Scenes.show('step-upload'); });
      });
  }

  function refreshWorkbook() {
    Store.patchActivity({ status: 'Refreshing workbook' });
    return Status.play([
      'Syncing your workbook…',
      'Refreshing pivot tables…',
      'Updating references…'
    ], Api.post('refreshWorkbook', {}))
      .then(function (data) {
        Store.patchActivity({
          lastRefresh: data.refreshedDate + ' ' + data.refreshedTime,
          status: 'Idle'
        });
        return Scenes.show('step-month');
      })
      .catch(function (err) {
        Store.patchActivity({ status: 'Refresh failed' });
        fail(err, function () {
          Scenes.show('step-processing').then(refreshWorkbook);
        });
      });
  }

  // =======================================================================
  // Question 3: the month. Year is fixed to the current year by design;
  // selecting a month continues automatically — no submit button.
  // =======================================================================
  function initMonth() {
    var monthSelect = $('monthSelect');
    var caption = $('generatePeriod');
    var year = new Date().getFullYear();
    var pending = null;

    monthSelect.innerHTML =
      '<option value="" disabled selected>Select a month</option>' +
      CFG.MONTH_NAMES.map(function (name, i) {
        return '<option value="' + i + '">' + name + '</option>';
      }).join('');

    function commit() {
      if (pending) { clearTimeout(pending); pending = null; }
      monthSelect.disabled = true;
      startGenerate();
    }

    monthSelect.addEventListener('change', function () {
      if (monthSelect.value === '') return;
      var monthIndex = parseInt(monthSelect.value, 10);
      state.monthName = CFG.MONTH_NAMES[monthIndex];
      state.monthLabel = state.monthName + ' ' + year;
      state.monthKey = year + '-' + String(monthIndex + 1).padStart(2, '0');
      caption.textContent = 'Generating for ' + state.monthLabel;
      // Debounced so keyboard browsing through options doesn't fire early.
      if (pending) clearTimeout(pending);
      pending = setTimeout(commit, 1200);
    });

    monthSelect.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && monthSelect.value !== '' && !monthSelect.disabled) {
        e.preventDefault();
        commit();
      }
    });
  }

  // =======================================================================
  // Generation: same payload, same endpoint, same result handling.
  // =======================================================================
  var generating = false;

  function startGenerate() {
    if (generating) return;
    generating = true;
    Store.patchActivity({ status: 'Generating report' });

    Scenes.show('step-processing').then(function () {
      Status.play([
        'Checking STT IDs…',
        'Matching client database…',
        'Gathering trading data…',
        'Calculating performance…',
        'Updating template…',
        'Writing spreadsheet…',
        'Finalizing…'
      ], Api.post('generateReports', {
        monthKey: state.monthKey,
        monthLabel: state.monthLabel,
        rows: state.rows
      }), 'Done.')
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
          generating = false;
          return Scenes.show('step-complete');
        })
        .catch(function (err) {
          generating = false;
          Store.patchActivity({ status: 'Generation failed' });
          fail(err, startGenerate);
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
  // Completion screen. The Open Updated File button uses the same URL as
  // before (CFG.SPREADSHEET_URL) — how it is produced has not changed.
  // =======================================================================
  function initComplete() {
    $('btnOpenSheet').addEventListener('click', function () {
      window.open(CFG.SPREADSHEET_URL, '_blank', 'noopener');
    });

    $('btnViewErrors').addEventListener('click', function () {
      var panel = $('errorsPanel');
      panel.classList.toggle('hidden');
      this.setAttribute('aria-expanded', panel.classList.contains('hidden') ? 'false' : 'true');
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

    $('btnToNext').addEventListener('click', function () {
      $('archiveMonth').textContent = state.monthLabel;
      Scenes.show('step-next');
    });
  }

  function flashLabel(button, message) {
    var original = button.textContent;
    button.textContent = message;
    setTimeout(function () { button.textContent = original; }, 2200);
  }

  // =======================================================================
  // Archive question ("Prepare next month"). Same backend call.
  // =======================================================================
  function initNext() {
    $('btnPrepareNext').addEventListener('click', function () {
      Store.patchActivity({ status: 'Archiving' });

      Scenes.show('step-processing').then(function () {
        Status.play([
          'Creating archive…',
          'Saving Monthly Performance – ' + state.monthLabel + '…',
          'Clearing report data…',
          'Preparing the new month…'
        ], Api.post('prepareNextMonth', { monthLabel: state.monthLabel }), 'All set.')
          .then(function (data) {
            Store.patchActivity({
              lastArchive: data.archiveFileName + ' · ' + now(),
              status: 'Idle'
            });
            $('doneMessage').textContent = 'The workbook has been archived as "' + data.archiveFileName +
              '" and is ready for the next reporting month.';
            return Scenes.show('step-done');
          })
          .catch(function (err) {
            Store.patchActivity({ status: 'Archive failed' });
            // Return to the question rather than blind-retrying: the backend
            // refuses to overwrite an archive that already exists.
            fail(err, function () { Scenes.show('step-next'); });
          });
      });
    });

    $('btnSkipArchive').addEventListener('click', function () {
      Scenes.show('step-complete');
    });

    $('btnStartOver').addEventListener('click', function () { window.location.reload(); });
  }

  // =======================================================================
  // Init
  // =======================================================================
  document.addEventListener('DOMContentLoaded', function () {
    Wave.init();
    initKey();
    initConfirm();
    initUpload();
    initMonth();
    initComplete();
    initNext();
    initError();
    ActivityLog.render();
    Scenes.show(Store.getKey() ? 'step-confirm' : 'step-key');
  });
})();
