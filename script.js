/**
 * script.js
 * LedgerX v2.0 — premium enterprise frontend.
 *
 * Flow: boot beam -> access key (once) -> onboarding modal (first visit
 * only) -> month selection -> automatic processing with a live stage
 * tracker -> Report Generated with stats, error preview, and Open
 * Report / Open Output Folder / Generate Another Report.
 *
 * Business logic is untouched: same Apps Script endpoints, same payload
 * shapes, same auth. The backend reads the template's Raw Data sheet,
 * matches the Client Database, and writes "{Month} {Year} Performance
 * Summary" into the designated Drive folder. The year is always the
 * current system year. No uploads, no confirmations.
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
  // Persistence (localStorage): access key, activity log, onboarding flag,
  // recent reports. Activity log has no on-page display; render is no-op
  // safe so the recording behavior is preserved.
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
    },
    isOnboarded: function () { return localStorage.getItem(CFG.STORAGE_KEYS.ONBOARDED) === '1'; },
    setOnboarded: function () { localStorage.setItem(CFG.STORAGE_KEYS.ONBOARDED, '1'); }
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
  // Modal manager: fade+scale panels over a frosted overlay. Closes on X,
  // outside click, or Escape. Focus moves into the dialog and returns to
  // the opener on close.
  // =======================================================================
  var Modal = {
    opener: null,

    open: function (id) {
      var overlay = $('modalOverlay');
      var modals = overlay.querySelectorAll('.modal');
      for (var i = 0; i < modals.length; i++) modals[i].classList.add('hidden');
      this.opener = document.activeElement;
      overlay.classList.remove('hidden');
      var modal = $(id);
      modal.classList.remove('hidden');
      try { modal.focus({ preventScroll: true }); } catch (e) { modal.focus(); }
    },

    current: function () {
      var overlay = $('modalOverlay');
      if (overlay.classList.contains('hidden')) return null;
      var open = overlay.querySelector('.modal:not(.hidden)');
      return open ? open.id : null;
    },

    close: function () {
      var openId = this.current();
      if (!openId) return;
      if (openId === 'onboardModal') Store.setOnboarded();
      $('modalOverlay').classList.add('hidden');
      var modals = $('modalOverlay').querySelectorAll('.modal');
      for (var i = 0; i < modals.length; i++) modals[i].classList.add('hidden');
      if (this.opener && this.opener.focus) {
        try { this.opener.focus({ preventScroll: true }); } catch (e) { /* noop */ }
      }
      this.opener = null;
    }
  };

  function initModals() {
    $('modalOverlay').addEventListener('click', function (e) {
      if (e.target === this) Modal.close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') Modal.close();
    });
    var closers = document.querySelectorAll('[data-close]');
    for (var i = 0; i < closers.length; i++) {
      closers[i].addEventListener('click', function () { Modal.close(); });
    }

    // Onboarding
    $('btnGetStarted').addEventListener('click', function () {
      Store.setOnboarded();
      Modal.close();
    });
    $('btnViewGuide').addEventListener('click', function () {
      Store.setOnboarded();
      Modal.open('guideModal');
    });
  }

  // =======================================================================
  // Header: Guide opens the in-app guide; Refresh Data flushes pending
  // workbook recalculations (same backend action as always).
  // =======================================================================
  function initHeader() {
    $('btnGuide').addEventListener('click', function () { Modal.open('guideModal'); });

    var btn = $('btnRefreshData');
    btn.addEventListener('click', function () {
      if (btn.disabled || generating) return;
      var original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Refreshing…';
      Api.post('refreshWorkbook', {})
        .then(function () { btn.textContent = 'Refreshed ✓'; })
        .catch(function () { btn.textContent = 'Refresh failed'; })
        .then(function () {
          return delay(2000);
        })
        .then(function () {
          btn.textContent = original;
          btn.disabled = false;
        });
    });
  }

  // =======================================================================
  // Scene manager: exactly one scene on screen with fade transitions.
  // =======================================================================
  var Scenes = {
    current: null,

    show: function (id) {
      var next = $(id);
      var cur = this.current && this.current !== id ? $(this.current) : null;
      this.current = id;

      var out = Promise.resolve();
      if (cur) {
        cur.classList.add('leaving');
        out = delay(REDUCED_MOTION ? 0 : 280).then(function () {
          cur.classList.remove('visible', 'leaving');
        });
      }

      return out.then(function () {
        next.classList.add('visible');
        var focusTarget = next.querySelector('[data-autofocus]') || next.querySelector('.q');
        if (focusTarget && focusTarget.focus) {
          try { focusTarget.focus({ preventScroll: true }); } catch (e) { focusTarget.focus(); }
        }
      });
    }
  };

  function showHome() {
    resetMonthGrid();
    Recent.render();
    return Scenes.show('step-home').then(function () {
      if (!Store.isOnboarded()) Modal.open('onboardModal');
    });
  }

  // =======================================================================
  // Stage tracker: each processing stage animates from pending to active
  // to "✓ Completed". The final stage holds until the real backend call
  // settles; if the call finishes early the remaining stages fast-forward.
  // =======================================================================
  var Stages = {
    play: function (names, work) {
      var list = $('stageList');
      list.innerHTML = names.map(function (n) {
        return '<li class="stage-item"><span class="stage-name">' + escapeHtml(n) +
          '</span><span class="stage-state"></span></li>';
      }).join('');
      var items = list.children;

      function setState(i, cls, text) {
        items[i].className = 'stage-item ' + cls;
        items[i].lastElementChild.textContent = text;
      }

      var settled = false, value, failure;
      var tracked = (work || Promise.resolve()).then(
        function (v) { settled = true; value = v; },
        function (e) { settled = true; failure = e; }
      );

      var chain = Promise.resolve();
      names.forEach(function (_, i) {
        chain = chain.then(function () {
          if (failure) return null;
          setState(i, 'active', 'Processing…');
          var isLast = i === names.length - 1;
          var wait = isLast ? tracked : delay(settled || REDUCED_MOTION ? 150 : 620);
          return wait.then(function () {
            if (failure) { setState(i, 'failed', '✕ Failed'); return; }
            setState(i, 'done', '✓ Completed');
          });
        });
      });

      return chain
        .then(function () { return tracked; })
        .then(function () {
          if (failure) return delay(REDUCED_MOTION ? 100 : 600).then(function () { throw failure; });
          return delay(REDUCED_MOTION ? 150 : 550).then(function () { return value; });
        });
    }
  };

  // =======================================================================
  // Recent reports (localStorage only).
  // =======================================================================
  var Recent = {
    load: function () {
      try { return JSON.parse(localStorage.getItem(CFG.STORAGE_KEYS.RECENT_REPORTS)) || []; }
      catch (e) { return []; }
    },

    add: function (entry) {
      var list = this.load().filter(function (r) { return r.label !== entry.label; });
      list.unshift(entry);
      if (list.length > 6) list = list.slice(0, 6);
      localStorage.setItem(CFG.STORAGE_KEYS.RECENT_REPORTS, JSON.stringify(list));
    },

    relativeTime: function (iso) {
      var then = new Date(iso);
      if (isNaN(then.getTime())) return '';
      var startOfDay = function (d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      };
      var days = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86400000);
      if (days <= 0) return 'Today';
      if (days === 1) return 'Yesterday';
      if (days < 7) return days + ' days ago';
      if (days < 14) return 'Last Week';
      return then.toLocaleDateString();
    },

    render: function () {
      var section = $('recentSection');
      var list = this.load();
      if (!list.length) { section.classList.add('hidden'); return; }
      section.classList.remove('hidden');
      var self = this;
      var ul = $('recentList');
      ul.innerHTML = '';
      list.forEach(function (r) {
        var li = document.createElement('li');
        li.className = 'recent-item';
        li.tabIndex = 0;
        li.setAttribute('role', 'link');
        li.setAttribute('aria-label', 'Open ' + r.label + ' Performance Summary');
        li.innerHTML =
          '<span class="recent-month">' + escapeHtml(r.label) + '</span>' +
          '<span class="recent-status">Completed</span>' +
          '<span class="recent-when">' + escapeHtml(self.relativeTime(r.when)) + '</span>';
        function openIt() { if (r.url) window.open(r.url, '_blank', 'noopener'); }
        li.addEventListener('click', openIt);
        li.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openIt(); }
        });
        ul.appendChild(li);
      });
    }
  };

  // =======================================================================
  // App state + error recovery.
  // =======================================================================
  var state = {
    monthKey: '',
    monthName: '',
    monthLabel: '',
    result: null
  };

  var retryFn = null;
  var resumeAfterKey = null;
  var generating = false;

  var NO_DATA_RE = /has no data|no data rows|was not found/i;

  function fail(err, retry) {
    var msg = err && err.message ? err.message : String(err);
    if (NO_DATA_RE.test(msg)) {
      retryFn = retry || null;
      Scenes.show('step-empty');
      return;
    }
    retryFn = retry || null;
    $('errorMessage').textContent = msg;
    $('btnRetry').classList.toggle('hidden', !retryFn);
    Scenes.show('step-error');
  }

  function initError() {
    $('btnRetry').addEventListener('click', function () {
      var fn = retryFn;
      retryFn = null;
      if (fn) fn();
    });
    $('btnBackHome').addEventListener('click', function () {
      retryFn = null;
      showHome();
    });
    $('connectionLink').addEventListener('click', function () {
      resumeAfterKey = retryFn;
      $('accessKeyInput').value = Store.getKey();
      $('keyStatus').textContent = '';
      Scenes.show('step-key');
    });

    // Empty state
    $('btnOpenGuideEmpty').addEventListener('click', function () { Modal.open('guideModal'); });
    $('btnEmptyBack').addEventListener('click', function () {
      retryFn = null;
      showHome();
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
        else showHome();
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
  // Month selection. The year is detected from the system clock; selecting
  // a month starts processing immediately - no extra clicks.
  // =======================================================================
  function initMonths() {
    var grid = $('monthGrid');
    var year = new Date().getFullYear();

    $('yearHint').textContent = 'Reports generate for ' + year + '. The year is detected automatically.';

    CFG.MONTH_NAMES.forEach(function (name, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'month-btn';
      btn.textContent = name;
      btn.addEventListener('click', function () {
        if (generating) return;
        state.monthName = name;
        state.monthLabel = name + ' ' + year;
        state.monthKey = year + '-' + String(i + 1).padStart(2, '0');
        btn.classList.add('selected');
        setMonthGridEnabled(false);
        startGenerate();
      });
      grid.appendChild(btn);
    });
  }

  function setMonthGridEnabled(enabled) {
    var buttons = $('monthGrid').querySelectorAll('.month-btn');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = !enabled;
  }

  function resetMonthGrid() {
    var buttons = $('monthGrid').querySelectorAll('.month-btn');
    for (var i = 0; i < buttons.length; i++) buttons[i].classList.remove('selected');
    setMonthGridEnabled(true);
  }

  // =======================================================================
  // Generation: one backend call; the stage tracker narrates it live.
  // =======================================================================
  function startGenerate() {
    if (generating) return;
    generating = true;
    Store.patchActivity({ status: 'Generating report' });
    $('processingTitle').textContent = 'Generating ' + state.monthLabel + ' Performance Summary';

    var startedAt = Date.now();

    Scenes.show('step-processing').then(function () {
      Stages.play([
        'Reading Client Database',
        'Reading Trade History',
        'Validating Records',
        'Calculating Growth',
        'Generating Summary',
        'Creating Spreadsheet',
        'Uploading to Google Drive'
      ], Api.post('generateReports', {
        monthKey: state.monthKey,
        monthLabel: state.monthLabel
      }))
        .then(function (data) {
          state.result = data;
          var seconds = (Date.now() - startedAt) / 1000;
          populateSuccess(data, seconds);
          Recent.add({
            label: state.monthLabel,
            url: data.outputFile && data.outputFile.url,
            when: new Date().toISOString()
          });
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

  function populateSuccess(data, seconds) {
    var counts = data.counts || {};
    var stats = data.stats || null;
    var total = counts.totalAccounts || 0;
    var matched = counts.matchedAccounts || 0;

    $('reportName').textContent = (data.outputFile && data.outputFile.name) ||
      (state.monthLabel + ' Performance Summary');

    $('statClients').textContent = String(total);
    $('figSuccess').textContent = String(matched);
    $('figErrors').textContent = String(counts.errorCount || 0);
    $('statRate').textContent = total > 0 ? Math.round((matched / total) * 100) + '%' : '—';
    $('statAvg').textContent = stats ? stats.averageGrowth.toFixed(2) + '%' : '—';
    $('statHigh').textContent = stats ? stats.highestGrowth.toFixed(2) + '%' : '—';
    $('statLow').textContent = stats ? stats.lowestGrowth.toFixed(2) + '%' : '—';
    $('statTime').textContent = seconds.toFixed(1) + 's';

    renderErrors(data.errors || []);
    renderErrorPreview(data.errors || []);
  }

  // Full errors table (inside the errors modal).
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

  // Short preview on the success screen: client name + reason only.
  function renderErrorPreview(errors) {
    var section = $('errorPreview');
    if (!errors.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    var list = $('errorPreviewList');
    list.innerHTML = errors.slice(0, 5).map(function (e) {
      var name = e.clientName && e.clientName !== 'Unknown'
        ? e.clientName
        : (e.sttId || 'Unknown');
      return '<li class="preview-item">' +
        '<span class="preview-name">' + escapeHtml(name) + '</span>' +
        '<span class="preview-reason">' + escapeHtml(e.issue) + '</span>' +
        '</li>';
    }).join('');
    $('btnViewFullErrors').textContent = errors.length > 5
      ? 'View Full Errors (' + errors.length + ')'
      : 'View Full Errors';
  }

  // =======================================================================
  // Success screen actions.
  // =======================================================================
  function initComplete() {
    $('btnOpenSheet').addEventListener('click', function () {
      var url = (state.result && state.result.outputFile && state.result.outputFile.url) ||
        CFG.SPREADSHEET_URL;
      window.open(url, '_blank', 'noopener');
    });

    $('btnOpenFolder').addEventListener('click', function () {
      var url = (state.result && state.result.folderUrl) || CFG.OUTPUT_FOLDER_URL;
      window.open(url, '_blank', 'noopener');
    });

    $('btnViewFullErrors').addEventListener('click', function () { Modal.open('errorsModal'); });

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

    $('btnAnotherMonth').addEventListener('click', function () { showHome(); });
  }

  function flashLabel(button, message) {
    var original = button.textContent;
    button.textContent = message;
    setTimeout(function () { button.textContent = original; }, 2200);
  }

  // =======================================================================
  // Init: hold the boot beam briefly, then land on the first scene.
  // =======================================================================
  document.addEventListener('DOMContentLoaded', function () {
    initModals();
    initHeader();
    initKey();
    initMonths();
    initComplete();
    initError();

    delay(REDUCED_MOTION ? 250 : 1600).then(function () {
      $('loader').classList.add('done');
      return delay(REDUCED_MOTION ? 0 : 350);
    }).then(function () {
      if (Store.getKey()) showHome();
      else Scenes.show('step-key');
    });
  });
})();
