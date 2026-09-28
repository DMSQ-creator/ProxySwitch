// Page request inspector. Observations never determine the user's verification outcome.
(() => {
  'use strict';
  const root = document.getElementById('diagnosticsRoot');
  if (!root) return;
  const fullPage = document.body.classList.contains('ps-diag-page');
  const entry = document.getElementById('diagnosticsEntry');
  const homeTrial = document.getElementById('diagnosticsHomeTrial');
  const i18n = globalThis.ProxySwitchDiagnosticsI18n;
  const t = (key, values) => i18n ? i18n.t(key, values) : key;
  const UI_KEY = 'diagnosticUiState';
  const UI_TTL = 30 * 60 * 1000;
  let sourceTabId = null;
  let sourceHostname = '';
  let sourceValid = false;
  let sourceReady = false;
  let sourceLookupFailed = false;
  let sourceTimer = null;
  let state = null;
  let readError = false;
  let open = fullPage;
  let view = 'requests';
  let filter = fullPage ? 'all' : 'different';
  let direction = 'proxy';
  let selected = new Set();
  let expanded = new Set();
  let verified = false;
  let busy = false;
  let reading = false;
  let pendingMutation = null;
  let messageKey = '';
  let messageError = false;
  let pollTimer = null;
  let persistTimer = null;
  let lastSessionId = null;
  let savedUi = null;
  let uiTouched = false;
  let destroyed = false;
  let lastRenderSignature = '';

  const sources = {
    user: 'diagSourceUser', whitelist: 'diagSourceWhitelist', subscription: 'diagSourceSubscription',
    temporary: 'diagSourceTemporary', trial: 'diagSourceTrial', default: 'diagSourceDefault',
    local: 'diagSourceLocal', mode: 'diagSourceMode',
  };
  const routes = { proxy: 'diagRouteProxy', direct: 'diagRouteDirect', system: 'diagRouteSystem', unknown: 'diagRouteUnknown' };
  const modes = { pac_script: 'diagModeAuto', fixed_servers: 'diagModeGlobal', direct: 'diagModeDirect', system: 'diagModeSystem' };
  const errors = {
    permission_required: 'diagErrorPermissionRequired', invalid_tab: 'diagErrorInvalidTab', tab_closed: 'diagErrorTabClosed',
    restricted_tab: 'diagErrorRestrictedTab', session_conflict: 'diagErrorSessionConflict', session_not_found: 'diagErrorSessionNotFound',
    trial_conflict: 'diagErrorTrialConflict', trial_not_found: 'diagErrorTrialNotFound', invalid_hosts: 'diagErrorInvalidHosts',
    invalid_direction: 'diagErrorInvalidDirection', rule_conflict: 'diagErrorRuleConflict', mode_required: 'diagErrorModeRequired',
    proxy_uncontrolled: 'diagErrorProxyUncontrolled', no_server: 'diagErrorNoServer', reload_failed: 'diagErrorReloadFailed',
    storage_failed: 'diagErrorStorageFailed', proxy_failed: 'diagErrorProxyFailed', internal_error: 'diagErrorInternalError',
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function icon(name) {
    const paths = {
      list: 'M4 6h16M4 12h11M4 18h7', back: 'm14 6-6 6 6 6M8 12h12',
      refresh: 'M20 6v5h-5M4 18v-5h5M5 8a7 7 0 0 1 12-3l3 6M4 13l3 6a7 7 0 0 0 12-3',
      down: 'm6 9 6 6 6-6', up: 'm6 15 6-6 6 6', out: 'M14 4h6v6M20 4 10 14M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5',
      info: 'M12 11v6M12 7v1M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0',
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ps-diag-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[name] || paths.list);
    svg.appendChild(path);
    return svg;
  }

  function button(key, action, style = '', iconName = '') {
    const node = el('button', 'ps-diag-btn ' + style);
    node.type = 'button';
    node.dataset.action = action;
    node.dataset.focus = action;
    if (iconName) node.appendChild(icon(iconName));
    node.appendChild(el('span', '', t(key)));
    node.disabled = busy;
    return node;
  }

  function routeBadge(route) {
    const badge = el('span', 'ps-diag-route', t(routes[route] || routes.unknown));
    badge.dataset.route = route || 'unknown';
    return badge;
  }

  function localSession() { return state && state.session && state.session.tabId === sourceTabId ? state.session : null; }
  function localRows() { return localSession() && Array.isArray(state.rows) ? state.rows : []; }
  function activeTrial() { return state && state.trial && state.trial.expiresAt > Date.now() ? state.trial : null; }
  function trialBlocksChange() { return !!(state && state.trial); }
  function isCollecting() { const session = localSession(); return !!(session && !session.closed && session.captureUntil > Date.now()); }
  function conflict(row) {
    const field = direction === 'proxy' ? 'conflictProxy' : 'conflictDirect';
    return row[field] === undefined ? !!row.conflict && row.route !== direction : !!row[field];
  }
  function selectedRows() { return localRows().filter(row => selected.has(row.host) && !conflict(row) && row.route !== direction); }
  function different(row) { return !!(state && state.main && state.main.route !== 'unknown' && row.route !== 'unknown' && row.route !== state.main.route); }

  function message(key, error = false) { messageKey = key; messageError = error; }

  function request(type, payload = {}, timeout = 2200) {
    return new Promise(resolve => {
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        resolve({ success: false, error: 'timeout' });
      }, timeout);
      try {
        chrome.runtime.sendMessage({ type, ...payload }, reply => {
          const lastError = chrome.runtime.lastError;
          if (finished) {
            // A timed-out mutation can still finish; reconcile, never apply it again here.
            if (type !== 'PS_DIAG_GET' && !destroyed) {
              if (pendingMutation && pendingMutation.type === type) {
                pendingMutation = null;
                busy = false;
                if (!lastError && reply && reply.state) applyState(reply.state);
                message(!lastError && reply && reply.success ? '' : errors[reply && reply.error] || 'diagOperationFailed', !!(lastError || !reply || !reply.success));
              }
              readState();
            }
            return;
          }
          finished = true;
          clearTimeout(timer);
          resolve(lastError ? { success: false, error: 'runtime_unavailable' } : reply || { success: false, error: 'empty_reply' });
        });
      } catch (_) {
        finished = true;
        clearTimeout(timer);
        resolve({ success: false, error: 'runtime_unavailable' });
      }
    });
  }

  function applyState(next) {
    if (!next || typeof next !== 'object') return;
    state = next;
    const session = localSession();
    if (session && session.hostname) sourceHostname = session.hostname;
    if (session && session.closed) sourceValid = false;
    if ((session && session.id) !== lastSessionId) {
      lastSessionId = session ? session.id : null;
      selected.clear();
      expanded.clear();
      if (session && savedUi && savedUi.sessionId === session.id && savedUi.expiresAt > Date.now()) {
        restoreUi();
      }
      if (view === 'review') view = 'requests';
    }
    const allowed = new Set(localRows().filter(row => !conflict(row) && row.route !== direction).map(row => row.host));
    selected = new Set([...selected].filter(host => allowed.has(host)));
    if (view === 'save' && !activeTrial()) { view = 'requests'; verified = false; }
    if (pendingMutation) {
      const trial = activeTrial();
      const changed = pendingMutation.type === 'PS_DIAG_APPLY'
        ? trial && trial.sessionId === pendingMutation.sessionId && trial.direction === pendingMutation.direction
        : pendingMutation.type === 'PS_DIAG_START' ? session && session.id !== pendingMutation.previousSessionId
          : pendingMutation.type === 'PS_DIAG_STOP' ? session && !isCollecting()
            : pendingMutation.type === 'PS_DIAG_CLEAR' ? !session
              : !trial || trial.id !== pendingMutation.trialId;
      if (changed) { pendingMutation = null; busy = false; view = 'requests'; }
    }
    readError = false;
  }

  async function readState() {
    if (reading || destroyed || !sourceReady) return;
    reading = true;
    const reply = await request('PS_DIAG_GET', { tabId: sourceTabId });
    reading = false;
    if (destroyed) return;
    if (reply && reply.success && reply.state) applyState(reply.state);
    else readError = true;
    render();
  }

  async function mutate(type, payload, successKey) {
    if (busy) return;
    busy = true;
    message('');
    render();
    const previousSessionId = localSession() && localSession().id;
    const reply = await request(type, payload, 15000);
    if (destroyed) return;
    if (reply.state) applyState(reply.state);
    if (reply.success) {
      busy = false;
      pendingMutation = null;
      selected.clear();
      verified = false;
      view = 'requests';
      message(successKey || '');
      if (!reply.state) await readState();
    } else if (reply.error === 'timeout') {
      // Keep writes disabled until an authoritative state or late reply resolves them.
      pendingMutation = { type, ...payload, previousSessionId };
      message('diagMutationPending', true);
      await readState();
    } else {
      busy = false;
      message(errors[reply.error] || 'diagOperationFailed', true);
      await readState();
    }
    remember();
    render();
  }

  function remember() {
    const session = localSession();
    if (!session) return;
    savedUi = { sessionId: session.id, filter, direction, selected: [...selected].slice(0, 200), expiresAt: Math.min(Date.now() + UI_TTL, session.startedAt + UI_TTL) };
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (!savedUi || savedUi.expiresAt <= Date.now() || !localSession() || localSession().id !== savedUi.sessionId) return;
      try { chrome.storage.local.set({ [UI_KEY]: savedUi }, () => { void chrome.runtime.lastError; }); } catch (_) {}
    }, 80);
  }

  function restoreUi() {
    const session = localSession();
    if (!session || !savedUi || savedUi.sessionId !== session.id || savedUi.expiresAt <= Date.now() || uiTouched) return;
    if (['different', 'failed', 'all'].includes(savedUi.filter)) filter = savedUi.filter;
    if (['proxy', 'direct'].includes(savedUi.direction)) direction = savedUi.direction;
    const hosts = new Set(localRows().filter(row => !conflict(row) && row.route !== direction).map(row => row.host));
    selected = new Set((Array.isArray(savedUi.selected) ? savedUi.selected.slice(0, 200) : []).filter(host => hosts.has(host)));
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (!open || document.hidden || destroyed) return;
    pollTimer = setTimeout(async () => { await readState(); schedulePoll(); }, 1000);
  }

  function navigate(next) {
    view = next;
    verified = false;
    message('');
    if (!open) {
      open = true;
      root.hidden = false;
      document.body.classList.add('ps-diag-open');
      readState();
      schedulePoll();
    }
    render();
    const heading = root.querySelector('h1');
    if (heading) heading.focus({ preventScroll: true });
  }

  function closeInspector() {
    if (fullPage) return;
    open = false;
    root.hidden = true;
    document.body.classList.remove('ps-diag-open');
    schedulePoll();
    if (entry) entry.focus();
  }

  function requestPermissionAndStart(replace) {
    if (busy || !sourceValid) return;
    if (trialBlocksChange()) { message(state.trial.pendingCleanup ? 'diagRecovery' : 'diagOtherTrial', true); render(); return; }
    if (replace && !window.confirm(t('diagReplaceConfirm'))) return;
    const start = () => mutate('PS_DIAG_START', { tabId: sourceTabId, ...(replace ? { replace: true } : {}) });
    if (state && state.permission) { start(); return; }
    // Invoke directly in the button gesture, before any asynchronous work (Chrome 95).
    try {
      chrome.permissions.request({ permissions: ['webRequest'] }, granted => {
        const error = chrome.runtime.lastError;
        if (error || !granted) { message('diagPermissionDenied', true); render(); return; }
        start();
      });
    } catch (_) { message('diagPermissionDenied', true); render(); }
  }

  function returnToSource() {
    const trial = activeTrial();
    const tabId = trial ? trial.tabId : sourceTabId;
    if (!Number.isInteger(tabId)) return;
    chrome.tabs.update(tabId, { active: true }, tab => {
      if (chrome.runtime.lastError || !tab) { message('diagTabClosed', true); render(); return; }
      if (chrome.windows && Number.isInteger(tab.windowId)) {
        chrome.windows.update(tab.windowId, { focused: true }, () => { void chrome.runtime.lastError; if (!fullPage) window.close(); });
      } else if (!fullPage) window.close();
    });
  }

  function openPage(path) {
    chrome.tabs.create({ url: chrome.runtime.getURL(path) }, () => {
      if (chrome.runtime.lastError) { message('diagOperationFailed', true); render(); }
    });
  }

  function requestSummary(row) {
    const parts = [];
    if (row.failed > 0) parts.push(t('diagFailed', { count: row.failed }));
    if (row.pending > 0) parts.push(t('diagPending', { count: row.pending }));
    if (row.completed > 0) parts.push(t('diagCompleted', { count: row.completed }));
    return parts.join(' · ') || t('diagCount', { count: row.count || 0 });
  }

  function trialCard(trial, compact = false) {
    const card = el('section', 'ps-diag-trial');
    const header = el('div', 'ps-diag-row');
    header.append(el('h3', '', t('diagTrialTitle', { count: trial.hosts.length })), routeBadge(trial.direction));
    card.appendChild(header);
    card.appendChild(el('p', 'ps-diag-trial-summary', t('diagTrialRemaining', { count: Math.max(1, Math.ceil((trial.expiresAt - Date.now()) / 60000)) })));
    if (!compact) card.appendChild(el('p', 'ps-diag-trial-summary', trial.hosts.join(', ')));
    const actions = el('div', 'ps-diag-trial-actions');
    actions.append(button('diagVerify', 'verify', 'ps-diag-primary'), button('diagUndo', 'undo'));
    card.appendChild(actions);
    card.appendChild(button('diagSave', 'save', 'ps-diag-link'));
    return card;
  }

  function renderHome() {
    if (!entry) return;
    document.getElementById('diagnosticsEntryTitle').textContent = t('diagEntry');
    const rows = localRows();
    const hint = rows.length
      ? `${t('diagFilterDifferent')} ${rows.filter(different).length} · ${t('diagFilterFailed')} ${rows.filter(row => row.failed > 0).length}`
      : t('diagEntryHint');
    document.getElementById('diagnosticsEntryHint').textContent = hint;
    const trial = activeTrial();
    homeTrial.replaceChildren();
    if (trial) homeTrial.appendChild(trialCard(trial, true));
  }

  function renderDomain(row) {
    const wrap = el('div', 'ps-diag-domain');
    const line = el('div', 'ps-diag-domain-line');
    const label = el('label', 'ps-diag-label');
    const input = el('input');
    input.type = 'checkbox';
    input.dataset.host = row.host;
    input.dataset.focus = 'host:' + row.host;
    input.setAttribute('aria-label', t('diagSelect', { host: row.host }));
    input.checked = selected.has(row.host);
    input.disabled = busy || trialBlocksChange() || conflict(row) || row.route === direction || state.mode !== 'pac_script';
    const copy = el('span', 'ps-diag-domain-copy');
    copy.appendChild(el('span', 'ps-diag-host', row.host));
    const meta = el('span', 'ps-diag-meta');
    meta.append(el('span', '', t('diagRoute')), routeBadge(row.route), el('span', row.failed && !row.stale ? 'ps-diag-problem' : '', row.stale ? t('diagStale') : requestSummary(row)));
    copy.appendChild(meta);
    label.append(input, copy);
    const toggle = button('diagDetails', 'expand', 'ps-diag-expand');
    toggle.replaceChildren(icon(expanded.has(row.host) ? 'up' : 'down'));
    toggle.dataset.host = row.host;
    toggle.dataset.focus = 'expand:' + row.host;
    toggle.setAttribute('aria-label', t('diagDetails', { host: row.host }));
    toggle.setAttribute('aria-expanded', String(expanded.has(row.host)));
    toggle.disabled = false;
    line.append(label, toggle);
    wrap.appendChild(line);
    if (conflict(row)) wrap.appendChild(el('p', 'ps-diag-conflict', t('diagManualConflict')));
    if (expanded.has(row.host)) {
      const details = el('div', 'ps-diag-detail');
      const dl = el('dl');
      const add = (key, value) => { dl.append(el('dt', '', t(key)), el('dd', '', value)); };
      add('diagMatched', `${t(sources[row.source] || 'diagSourceDefault')}${row.rule ? ' · ' + String(row.rule) : ''}`);
      add('diagTypes', Array.isArray(row.types) ? row.types.join(', ') : '—');
      add('diagRequest', requestSummary(row));
      if (row.lastStatus) add('diagLastStatus', 'HTTP ' + row.lastStatus);
      if (row.error) add('diagLastError', row.error);
      details.append(dl, el('p', '', t('diagPrediction')));
      wrap.appendChild(details);
    }
    return wrap;
  }

  function emptyState(content) {
    const empty = el('div', 'ps-diag-empty');
    const logo = el('div', 'ps-diag-logo'); logo.appendChild(icon('list'));
    empty.append(logo, el('h2', '', t('diagCaptureTitle')), el('p', '', t('diagCaptureHint')));
    const start = button(state && state.permission ? 'diagCapture' : 'diagCapturePermission', 'capture', 'ps-diag-primary', 'refresh');
    start.disabled = busy || !sourceValid || trialBlocksChange();
    empty.appendChild(start);
    content.appendChild(empty);
  }

  function renderRequests(content) {
    const rows = localRows();
    const session = localSession();
    const trial = activeTrial();
    const other = state && state.session && !session;
    const heading = el('div', 'ps-diag-row ps-diag-heading');
    const h1 = el('h1', '', t(fullPage ? 'diagFullTitle' : 'diagTitle')); h1.tabIndex = -1;
    heading.append(h1, el('span', 'ps-diag-mode', t(modes[state && state.mode] || 'diagModeUnknown')));
    content.append(heading, el('p', 'ps-diag-source', sourceHostname ? `${sourceHostname} · ${t('diagSource')}` : t('diagSource')));
    if (!sourceReady) { content.appendChild(el('div', 'ps-diag-empty', t('diagLoading'))); return; }
    if (sourceLookupFailed) {
      const unavailable = el('div', 'ps-diag-notice ps-diag-warning');
      unavailable.append(el('p', '', t('diagReadFailed')), button('diagRetry', 'retry', 'ps-diag-link'));
      content.appendChild(unavailable);
      return;
    }
    if (!sourceValid) content.appendChild(el('p', 'ps-diag-notice ps-diag-warning', t(session && session.closed ? 'diagTabClosed' : 'diagInvalidTab')));
    if (readError) {
      const notice = el('div', 'ps-diag-notice ps-diag-warning');
      notice.append(el('p', '', t('diagReadFailed')), button('diagRetry', 'retry', 'ps-diag-link'));
      content.appendChild(notice);
    }
    if (!state) {
      if (!readError) content.appendChild(el('div', 'ps-diag-empty', t('diagLoading')));
      return;
    }
    if (state.trial && state.trial.pendingCleanup) {
      const recovery = el('div', 'ps-diag-notice ps-diag-warning');
      recovery.append(el('p', '', t('diagRecovery')), button('diagRetry', 'retry', 'ps-diag-link'));
      content.appendChild(recovery);
    }
    if (other) {
      const notice = el('div', 'ps-diag-notice');
      notice.appendChild(el('p', '', t('diagOtherSession', { host: state.session.hostname })));
      if (trialBlocksChange()) notice.appendChild(el('p', 'ps-diag-hint', t('diagOtherTrial')));
      else {
        const replace = button('diagReplace', 'replace', 'ps-diag-link'); replace.disabled = busy || !sourceValid;
        notice.appendChild(replace);
      }
      content.appendChild(notice);
    }
    if (trial) content.appendChild(trialCard(trial));
    if (!session) { if (!other && sourceValid) emptyState(content); return; }
    if (state.mode !== 'pac_script') content.appendChild(el('p', 'ps-diag-notice', t('diagModeRequired')));
    if (session.rulesChanged) content.appendChild(el('p', 'ps-diag-notice', t('diagRulesChanged')));
    const stopKeys = { navigation: 'diagNavigation', permission_revoked: 'diagPermissionRevoked' };
    if (stopKeys[session.stopReason]) content.appendChild(el('p', 'ps-diag-notice', t(stopKeys[session.stopReason])));
    const capture = el('div', 'ps-diag-capture');
    capture.appendChild(el('span', '', t(isCollecting() ? 'diagCaptureActive' : 'diagCaptureStopped', { count: rows.length })));
    const controls = el('div', 'ps-diag-controls');
    if (isCollecting()) controls.appendChild(button('diagStop', 'stop', 'ps-diag-link'));
    else if (!trial) {
      const collect = button(state.permission ? 'diagCapture' : 'diagCapturePermission', 'capture', 'ps-diag-link', 'refresh');
      collect.disabled = busy || !sourceValid || trialBlocksChange(); controls.appendChild(collect);
    }
    const clear = button('diagClear', 'clear', 'ps-diag-link'); clear.disabled = busy || trialBlocksChange();
    controls.appendChild(clear);
    capture.appendChild(controls); content.appendChild(capture);
    const filters = el('div', 'ps-diag-filters');
    const counts = { different: rows.filter(different).length, failed: rows.filter(row => row.failed > 0).length, all: rows.length };
    for (const [name, key] of [['different', 'diagFilterDifferent'], ['failed', 'diagFilterFailed'], ['all', 'diagFilterAll']]) {
      const tab = button(key, 'filter'); tab.className = ''; tab.dataset.filter = name; tab.dataset.focus = 'filter:' + name;
      tab.setAttribute('aria-pressed', String(filter === name)); tab.disabled = false;
      tab.appendChild(el('span', 'ps-diag-count', counts[name])); filters.appendChild(tab);
    }
    content.appendChild(filters);
    const list = el('div', 'ps-diag-list');
    list.setAttribute('aria-label', t('diagTitle'));
    // Selected rows remain visible when live routing changes; no hidden selection surprise.
    const visible = rows.filter(row => selected.has(row.host) || filter === 'all' || (filter === 'different' ? different(row) : row.failed > 0));
    for (const row of visible) list.appendChild(renderDomain(row));
    if (!visible.length) list.appendChild(el('div', 'ps-diag-empty', t(rows.length ? 'diagNoMatches' : 'diagNoRecords')));
    content.append(list, el('p', 'ps-diag-hint', t('diagCaveat')));
    if (session.dropped) content.appendChild(el('p', 'ps-diag-hint', t('diagDropped', { count: session.dropped })));
    if (fullPage) content.appendChild(el('p', 'ps-diag-hint', t('diagPrediction')));
  }

  function renderReview(content, saving) {
    const trial = activeTrial();
    const hosts = saving && trial ? trial.hosts : selectedRows().map(row => row.host);
    const targetDirection = saving && trial ? trial.direction : direction;
    const h1 = el('h1', '', t(saving ? 'diagSaveTitle' : 'diagReviewTitle')); h1.tabIndex = -1;
    content.append(h1, el('p', 'ps-diag-hint', t(saving ? 'diagSaveHint' : 'diagReviewHint')));
    const list = el('div', 'ps-diag-confirm-list');
    for (const host of hosts) { const line = el('div', 'ps-diag-row'); line.append(el('span', 'ps-diag-host', host), routeBadge(targetDirection)); list.appendChild(line); }
    content.appendChild(list);
    if (!saving) content.appendChild(el('p', 'ps-diag-muted', t('diagLifetime')));
    const scope = el('div', 'ps-diag-scope'); scope.append(icon('info'), el('span', '', t('diagScope'))); content.appendChild(scope);
    if (saving) {
      const label = el('label', 'ps-diag-verified');
      const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.dataset.verified = 'true'; checkbox.dataset.focus = 'verified'; checkbox.checked = verified; checkbox.disabled = busy;
      label.append(checkbox, el('span', '', t('diagVerified'))); content.appendChild(label);
    }
    const confirm = button(saving ? 'diagSaveConfirm' : 'diagApply', saving ? 'confirm-save' : 'apply', 'ps-diag-primary ps-diag-wide-btn');
    confirm.disabled = busy || !hosts.length || (saving && !verified) || (!saving && (!state || state.mode !== 'pac_script' || trialBlocksChange()));
    content.appendChild(confirm);
  }

  function renderSelection() {
    if (view !== 'requests' || !localRows().length || trialBlocksChange() || !sourceValid) return null;
    const section = el('div', 'ps-diag-selection');
    section.appendChild(el('div', 'ps-diag-muted', t(selected.size ? 'diagSelected' : 'diagSelectHint', { count: selected.size })));
    const actions = el('div', 'ps-diag-selection-actions');
    const select = el('select'); select.dataset.direction = 'true'; select.dataset.focus = 'direction'; select.setAttribute('aria-label', t('diagDirection')); select.disabled = busy;
    for (const [value, key] of [['proxy', 'diagToProxy'], ['direct', 'diagToDirect']]) { const option = el('option', '', t(key)); option.value = value; option.selected = direction === value; select.appendChild(option); }
    const review = button('diagReview', 'review', 'ps-diag-primary'); review.disabled = busy || !selectedRows().length || state.mode !== 'pac_script';
    actions.append(select, review); section.appendChild(actions); return section;
  }

  function render() {
    // GET polling must not destroy focused controls or keep their animation-frame
    // stability checks perpetually restarting. Repaint only observable changes;
    // backend bookkeeping timestamps are deliberately not part of this signature.
    const observedState = state ? {
      ...state,
      session: state.session ? { ...state.session, updatedAt: undefined } : null,
    } : null;
    const trial = activeTrial();
    const signature = JSON.stringify({
      open, view, filter, direction, selected: [...selected], expanded: [...expanded], verified, busy,
      pendingMutation, messageKey, messageError, readError, sourceReady, sourceLookupFailed, sourceValid,
      sourceTabId, sourceHostname, state: observedState, collecting: isCollecting(),
      trialMinutes: trial ? Math.ceil((trial.expiresAt - Date.now()) / 60000) : null,
      language: i18n && i18n.getLanguage ? i18n.getLanguage() : '',
    });
    if (signature === lastRenderSignature) return;
    lastRenderSignature = signature;
    renderHome();
    if (!open) return;
    const oldContent = root.querySelector('.ps-diag-content');
    const scrollTop = oldContent ? oldContent.scrollTop : 0;
    const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    root.replaceChildren();
    root.setAttribute('aria-label', t('diagFullTitle'));
    document.title = fullPage ? `${t('diagFullTitle')} · ProxySwitch` : 'ProxySwitch';
    const header = el('header', 'ps-diag-top');
    const brand = el('div', 'ps-diag-brand'); const logo = el('span', 'ps-diag-logo'); logo.appendChild(icon('list')); brand.append(logo, el('span', '', 'ProxySwitch'));
    header.appendChild(brand);
    if (!fullPage || view !== 'requests') { const back = button('diagBack', 'back', 'ps-diag-link ps-diag-back', 'back'); back.disabled = false; header.appendChild(back); }
    root.appendChild(header);
    const content = el('div', 'ps-diag-content');
    if (view === 'review' || view === 'save') renderReview(content, view === 'save'); else renderRequests(content);
    root.appendChild(content);
    const selection = renderSelection(); if (selection) root.appendChild(selection);
    const status = el('div', 'ps-diag-message', messageKey ? t(messageKey) : '');
    status.setAttribute('role', messageError ? 'alert' : 'status'); status.setAttribute('aria-live', 'polite');
    status.dataset.error = String(messageError); status.hidden = !messageKey;
    if (pendingMutation) { const retry = button('diagRetry', 'retry', 'ps-diag-link'); retry.disabled = false; status.appendChild(retry); }
    root.appendChild(status);
    const footer = el('footer', 'ps-diag-footer');
    footer.appendChild(el('span', '', t('diagLocalOnly')));
    footer.appendChild(button('diagSettings', 'settings', 'ps-diag-link'));
    if (!fullPage) footer.appendChild(button('diagFull', 'full', 'ps-diag-link', 'out'));
    root.appendChild(footer);
    content.scrollTop = scrollTop;
    if (focused) {
      // Attribute values are compared rather than interpolated into a selector.
      const replacement = [...root.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === focused);
      if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
    }
  }

  function onClick(event) {
    const node = event.target.closest('button');
    if (!node || node.disabled) return;
    const action = node.dataset.action;
    if (action === 'back') { if (view === 'requests') closeInspector(); else navigate('requests'); }
    else if (action === 'capture') requestPermissionAndStart(false);
    else if (action === 'replace') requestPermissionAndStart(true);
    else if (action === 'retry') { if (sourceLookupFailed) resolveSource(); else readState(); }
    else if (action === 'filter') { uiTouched = true; filter = node.dataset.filter; remember(); render(); }
    else if (action === 'expand') { expanded.has(node.dataset.host) ? expanded.delete(node.dataset.host) : expanded.add(node.dataset.host); render(); }
    else if (action === 'review') { if (selectedRows().length) navigate('review'); }
    else if (action === 'apply') {
      const session = localSession();
      if (session) mutate('PS_DIAG_APPLY', { sessionId: session.id, hosts: selectedRows().map(row => row.host), direction }, 'diagTrialApplied');
    } else if (action === 'stop') {
      const session = localSession(); if (session) mutate('PS_DIAG_STOP', { sessionId: session.id });
    } else if (action === 'clear') {
      const session = localSession(); if (session && window.confirm(t('diagClearConfirm'))) mutate('PS_DIAG_CLEAR', { sessionId: session.id });
    } else if (action === 'undo') {
      const trial = activeTrial(); if (trial) { if (!open) navigate('requests'); mutate('PS_DIAG_UNDO', { trialId: trial.id }, 'diagTrialUndone'); }
    } else if (action === 'save') { if (activeTrial()) navigate('save'); }
    else if (action === 'confirm-save') {
      const trial = activeTrial(); if (trial && verified) mutate('PS_DIAG_SAVE', { trialId: trial.id }, 'diagTrialSaved');
    } else if (action === 'verify') returnToSource();
    else if (action === 'settings') openPage('html/options.html#rules');
    else if (action === 'full') openPage(`html/diagnostics.html?tabId=${Number.isInteger(sourceTabId) ? sourceTabId : ''}`);
  }

  root.addEventListener('click', onClick);
  if (homeTrial) homeTrial.addEventListener('click', onClick);
  root.addEventListener('change', event => {
    uiTouched = true;
    const node = event.target;
    if (node.dataset.host && node.type === 'checkbox') {
      if (node.checked) selected.add(node.dataset.host); else selected.delete(node.dataset.host);
    } else if (node.dataset.direction) {
      direction = node.value;
      selected = new Set(selectedRows().map(row => row.host));
    } else if (node.dataset.verified) verified = node.checked;
    remember(); render();
  });
  if (entry) entry.addEventListener('click', () => navigate('requests'));
  document.addEventListener('visibilitychange', schedulePoll);
  window.addEventListener('pagehide', () => {
    destroyed = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (sourceTimer) clearTimeout(sourceTimer);
    if (persistTimer) {
      clearTimeout(persistTimer);
      if (savedUi && savedUi.expiresAt > Date.now() && localSession() && localSession().id === savedUi.sessionId) {
        try { chrome.storage.local.set({ [UI_KEY]: savedUi }, () => { void chrome.runtime.lastError; }); } catch (_) {}
      }
    }
  });
  if (i18n) i18n.subscribe(render);

  // Small UI state is separate from proxy configuration, never sent to the worker.
  try {
    chrome.storage.local.get([UI_KEY, 'theme'], items => {
      if (chrome.runtime.lastError) return;
      if (items && items[UI_KEY] && items[UI_KEY].expiresAt > Date.now()) savedUi = items[UI_KEY];
      else if (items && items[UI_KEY]) chrome.storage.local.remove(UI_KEY, () => { void chrome.runtime.lastError; });
      restoreUi();
      if (state) render();
      if (fullPage) applyTheme(items && items.theme);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (fullPage && changes.theme) applyTheme(changes.theme.newValue);
      if (changes.diagnosticTrial) readState();
    });
  } catch (_) {}

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }

  function acceptSource(tab) {
    if (destroyed) return;
    if (sourceTimer) clearTimeout(sourceTimer);
    sourceTimer = null;
    sourceLookupFailed = false;
    sourceTabId = tab && Number.isInteger(tab.id) ? tab.id : sourceTabId;
    try {
      const candidate = tab && (/^https?:/.test(tab.url || '') ? tab.url : tab.pendingUrl);
      const url = new URL(candidate);
      sourceValid = !tab.incognito && ['http:', 'https:'].includes(url.protocol);
      sourceHostname = sourceValid ? url.hostname : '';
    } catch (_) { sourceValid = false; }
    sourceReady = true;
    render();
    // Never make the established homepage wait for this read.
    readState();
    schedulePoll();
  }

  function resolveSource() {
    if (sourceTimer) clearTimeout(sourceTimer);
    sourceReady = false;
    sourceLookupFailed = false;
    render();
    sourceTimer = setTimeout(() => { sourceReady = true; sourceLookupFailed = true; render(); }, 2200);
    if (fullPage) {
      const parameter = new URLSearchParams(location.search).get('tabId');
      const id = parameter !== null && parameter !== '' ? Number(parameter) : NaN;
      if (Number.isInteger(id) && id >= 0) {
        sourceTabId = id;
        try { chrome.tabs.get(id, tab => { void chrome.runtime.lastError; acceptSource(tab); }); } catch (_) { acceptSource(null); }
      } else acceptSource(null);
    } else {
      // Independent from popup.js initialization and background readiness.
      try { chrome.tabs.query({ active: true, currentWindow: true }, tabs => { void chrome.runtime.lastError; acceptSource(tabs && tabs[0]); }); } catch (_) { acceptSource(null); }
    }
  }
  render();
  resolveSource();
})();
