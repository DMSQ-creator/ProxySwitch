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
  const AUTO_UI_KEY = 'diagnosticAutoUiState';
  const UI_TTL = 30 * 60 * 1000;
  let sourceTabId = null;
  let sourceHostname = '';
  let sourceUrl = '';
  let sourceRevision = 0;
  let obsoleteSessionId = null;
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
  let busy = false;
  let reading = false;
  let pendingMutation = null;
  let recoveringMutation = false;
  let mutationSequence = 0;
  let messageKey = '';
  let messageError = false;
  let pollTimer = null;
  let persistTimer = null;
  let lastSessionId = null;
  let savedUi = null;
  let savedAutomaticUi = null;
  let pendingUiWrite = null;
  let uiTouched = false;
  let destroyed = false;
  let lastRenderSignature = '';
  let automaticUiSeen = false;
  let permissionRevoked = false;

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
    rule_undo_not_found: 'diagErrorUndoNotFound', rule_undo_conflict: 'diagErrorUndoConflict',
    rule_application_pending: 'diagOtherRulesPending', invalid_action: 'diagErrorInternalError', invalid_rules: 'diagErrorInvalidRules',
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

  function hasAutomatic() { return !!(state && state.autoCapture); }
  function automaticEnabled() { return !!(hasAutomatic() && state.autoCapture.enabled && state.autoCapture.permission && !state.autoCapture.error && !state.autoCapture.recovering); }
  function localSession() { return state && state.session && state.session.tabId === sourceTabId && state.session.id !== obsoleteSessionId ? state.session : null; }
  function localRows() { return localSession() && Array.isArray(state.rows) ? state.rows : []; }
  function localRuleUndo() {
    const receipt = state && state.ruleUndo;
    const session = localSession();
    const clearedAutomatic = receipt && receipt.context === 'auto' && hasAutomatic() && !state.autoCapture.enabled && !state.session;
    return receipt && receipt.tabId === sourceTabId && receipt.expiresAt > Date.now() && (session && receipt.sessionId === session.id || clearedAutomatic) ? receipt : null;
  }
  function rulesPending() { return !!(state && state.ruleUndo && state.ruleUndo.pendingApply); }
  function ruleWritesBlocked() { return trialBlocksChange() || rulesPending(); }
  function activeTrial() { return state && state.trial && state.trial.expiresAt > Date.now() ? state.trial : null; }
  function trialBlocksChange() { return !!(state && state.trial); }
  function isCollecting() { const session = localSession(); return !!(session && !session.closed && session.captureUntil > Date.now()); }
  function conflict(row) {
    const field = direction === 'proxy' ? 'conflictProxy' : 'conflictDirect';
    return row[field] === undefined ? !!row.conflict && row.route !== direction : !!row[field];
  }
  function selectedRows() { return localRows().filter(row => selected.has(row.host) && !conflict(row) && row.route !== direction); }
  function different(row) { return !!(state && state.main && state.main.route !== 'unknown' && row.route !== 'unknown' && row.route !== state.main.route); }
  function httpErrors(row) {
    // Older records retained only the latest status. Do not classify HTTP 4xx/5xx
    // as a transport failure, or infer whether any human-verification passed.
    return typeof row.httpErrors === 'number' ? Math.max(0, row.httpErrors) : Number(row.lastStatus) >= 400 ? 1 : 0;
  }
  function networkErrors(row) {
    // An aborted request is not evidence of a network failure. Unknown terminal
    // events have their own unconfirmed count and must not enter this filter.
    return row.error === 'net::ERR_ABORTED' ? 0 : Math.max(0, Number(row.failed) || 0);
  }

  function matchesFilter(row) {
    if (filter === 'different') return different(row);
    if (filter === 'failed') return networkErrors(row) > 0;
    if (filter === 'http') return httpErrors(row) > 0;
    return true;
  }

  function message(key, error = false) { messageKey = key; messageError = error; }

  function actionId() {
    if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `rules-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  function mutationSettled(mutation) {
    const session = localSession();
    const trial = activeTrial();
    const receipt = localRuleUndo();
    if (mutation.type === 'PS_DIAG_AUTO_ENABLE') return automaticEnabled();
    if (mutation.type === 'PS_DIAG_AUTO_DISABLE') return hasAutomatic() && !state.autoCapture.enabled &&
      !state.autoCapture.recovering && !state.autoCapture.error;
    if (mutation.type === 'PS_DIAG_ADD_RULES') return !!(receipt && receipt.actionId === mutation.actionId);
    if (mutation.type === 'PS_DIAG_UNDO_RULES') return !!(receipt && receipt.id === mutation.undoId && receipt.undone);
    if (mutation.type === 'PS_DIAG_RETRY_RULES') return !!(receipt && receipt.id === mutation.undoId && !receipt.pendingApply);
    if (mutation.type === 'PS_DIAG_APPLY') return !!(trial && trial.sessionId === mutation.sessionId && trial.direction === mutation.direction);
    if (mutation.type === 'PS_DIAG_START') return !!(session && session.id !== mutation.previousSessionId);
    if (mutation.type === 'PS_DIAG_STOP') return !!(session && !isCollecting());
    if (mutation.type === 'PS_DIAG_CLEAR') return !session || !!(session.auto && !localRows().length);
    return !trial || trial.id !== mutation.trialId;
  }

  function request(type, payload = {}, timeout = 2200, operationToken = 0) {
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
              if ((!operationToken || operationToken === mutationSequence) && pendingMutation && pendingMutation.type === type && (!payload.actionId || pendingMutation.actionId === payload.actionId) && (!payload.undoId || pendingMutation.undoId === payload.undoId)) {
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
    if (automaticEnabled() && next.autoCapture && !next.autoCapture.permission) permissionRevoked = true;
    if (next.autoCapture && next.autoCapture.enabled && next.autoCapture.permission) permissionRevoked = false;
    state = next;
    if (automaticEnabled() && !automaticUiSeen) {
      automaticUiSeen = true;
      if (!uiTouched) filter = 'all';
    }
    const session = localSession();
    if (session && session.hostname && !session.auto) sourceHostname = session.hostname;
    if (session && session.closed) sourceValid = false;
    if ((session && session.id) !== lastSessionId) {
      lastSessionId = session ? session.id : null;
      selected.clear();
      expanded.clear();
      if (session) restoreUi();
      if (view === 'review') view = 'requests';
    }
    const allowed = new Set(localRows().filter(row => !conflict(row) && row.route !== direction).map(row => row.host));
    selected = new Set([...selected].filter(host => allowed.has(host)));
    if (pendingMutation && mutationSettled(pendingMutation)) {
      pendingMutation = null; recoveringMutation = false; busy = false; view = 'requests'; message(''); remember();
    }
    readError = false;
  }

  async function readState() {
    if (reading || destroyed || !sourceReady) return;
    reading = true;
    const revision = sourceRevision;
    const reply = await request('PS_DIAG_GET', { tabId: sourceTabId });
    reading = false;
    if (destroyed) return;
    if (revision !== sourceRevision) { readState(); return; }
    if (reply && reply.success && reply.state) {
      applyState(reply.state);
      // Automatic recording recovery exists only in this open UI. GET is the
      // queue barrier: inspect the enabled flag and never replay consent.
      if (pendingMutation && pendingMutation.awaitingConfirmation && ['PS_DIAG_AUTO_ENABLE', 'PS_DIAG_AUTO_DISABLE'].includes(pendingMutation.type)) {
        pendingMutation = null; busy = false;
        message('diagOperationFailed', true);
      }
      // GET is a worker-queue barrier. A reopened operation with no receipt is
      // unconfirmed, not permission to resend the old request or remain locked.
      if (recoveringMutation && pendingMutation) {
        pendingMutation = null; recoveringMutation = false; busy = false;
        message('diagRulesUnconfirmed', true); remember();
      }
    }
    else readError = true;
    render();
  }

  async function mutate(type, payload, successKey) {
    if (busy) return;
    const operationToken = ++mutationSequence;
    recoveringMutation = false;
    busy = true;
    message('');
    render();
    const previousSessionId = localSession() && localSession().id;
    pendingMutation = { type, ...payload, previousSessionId };
    remember();
    const reply = await request(type, payload, 15000, operationToken);
    if (destroyed) return;
    if (operationToken !== mutationSequence) { readState(); return; }
    if (reply.state) applyState(reply.state);
    if (reply.success) {
      busy = false;
      pendingMutation = null;
      selected.clear();
      view = 'requests';
      message(successKey || '');
      if (!reply.state) await readState();
    } else if (reply.error === 'timeout') {
      // Keep writes disabled until an authoritative state or late reply resolves them.
      pendingMutation = { type, ...payload, previousSessionId, awaitingConfirmation: true };
      message('diagMutationPending', true);
      await readState();
    } else {
      busy = false;
      pendingMutation = null;
      message(errors[reply.error] || 'diagOperationFailed', true);
      await readState();
    }
    remember();
    render();
  }

  function remember() {
    const session = localSession();
    if (!session) return;
    // Recovery stores only an operation identity, never a second executable request.
    const pending = pendingMutation && ['PS_DIAG_ADD_RULES', 'PS_DIAG_UNDO_RULES', 'PS_DIAG_RETRY_RULES'].includes(pendingMutation.type)
      ? { type: pendingMutation.type, sessionId: session.id, ...(pendingMutation.actionId ? { actionId: pendingMutation.actionId } : { undoId: pendingMutation.undoId }) } : null;
    const snapshot = { sessionId: session.id, filter, direction, selected: [...selected].slice(0, 200), ...(pending ? { pendingMutation: pending } : {}), expiresAt: Math.min(Date.now() + UI_TTL, (session.auto ? session.updatedAt || Date.now() : session.startedAt) + UI_TTL) };
    if (session.auto) savedAutomaticUi = snapshot;
    else savedUi = snapshot;
    pendingUiWrite = { automatic: !!session.auto, snapshot };
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      writeUiSnapshot();
    }, 80);
  }

  function writeUiSnapshot() {
    const write = pendingUiWrite;
    pendingUiWrite = null;
    const session = localSession();
    if (!write || !session || !!session.auto !== write.automatic || session.id !== write.snapshot.sessionId || write.snapshot.expiresAt <= Date.now()) return;
    // Automatic selections contain observed domains. Never fall back to local
    // storage when session storage is absent or unavailable (Chrome 95).
    try {
      const area = write.automatic ? chrome.storage.session : chrome.storage.local;
      if (area && typeof area.set === 'function') area.set({ [write.automatic ? AUTO_UI_KEY : UI_KEY]: write.snapshot }, () => { void chrome.runtime.lastError; });
    } catch (_) {}
  }

  function restoreUi() {
    const session = localSession();
    const snapshot = session && session.auto ? savedAutomaticUi : savedUi;
    if (!session || !snapshot || snapshot.sessionId !== session.id || snapshot.expiresAt <= Date.now()) return;
    if (!uiTouched) {
      if (['different', 'failed', 'http', 'all'].includes(snapshot.filter)) filter = snapshot.filter;
      if (['proxy', 'direct'].includes(snapshot.direction)) direction = snapshot.direction;
      const hosts = new Set(localRows().filter(row => !conflict(row) && row.route !== direction).map(row => row.host));
      selected = new Set((Array.isArray(snapshot.selected) ? snapshot.selected.slice(0, 200) : []).filter(host => hosts.has(host)));
    }
    const pending = snapshot.pendingMutation;
    if (pendingMutation && !recoveringMutation) return;
    if (pending && pending.sessionId === session.id && ['PS_DIAG_ADD_RULES', 'PS_DIAG_UNDO_RULES', 'PS_DIAG_RETRY_RULES'].includes(pending.type)) {
      if (mutationSettled(pending)) {
        pendingMutation = null; recoveringMutation = false; busy = false; remember();
      } else {
        pendingMutation = pending; busy = true; message('diagMutationPending', true);
        recoveringMutation = true;
      }
    }
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (!open || document.hidden || destroyed) return;
    pollTimer = setTimeout(async () => { if (hasAutomatic()) refreshSource(); await readState(); schedulePoll(); }, 1000);
  }

  function navigate(next) {
    view = next;
    if (!pendingMutation && !(next === 'requests' && messageKey === 'diagRulesUnconfirmed')) message('');
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
    if (ruleWritesBlocked()) { message(rulesPending() ? 'diagRulesPending' : state.trial.pendingCleanup ? 'diagRecovery' : 'diagOtherTrial', true); render(); return; }
    if (replace && !window.confirm(t('diagReplaceConfirm'))) return;
    const start = () => mutate('PS_DIAG_START', { tabId: sourceTabId, ...(replace ? { replace: true } : {}) });
    if (state && (state.permission || automaticEnabled())) { start(); return; }
    // Invoke directly in the button gesture, before any asynchronous work (Chrome 95).
    try {
      chrome.permissions.request({ permissions: ['webRequest'] }, granted => {
        const error = chrome.runtime.lastError;
        if (error || !granted) { message('diagPermissionDenied', true); render(); return; }
        start();
      });
    } catch (_) { message('diagPermissionDenied', true); render(); }
  }

  function requestPermissionAndEnable() {
    if (busy || !sourceValid || !hasAutomatic()) return;
    const enable = () => mutate('PS_DIAG_AUTO_ENABLE', { consent: true, tabId: sourceTabId });
    // A granted Chrome permission is not consent to automatic recording.
    if (state.autoCapture.permission) { enable(); return; }
    busy = true; message(''); render();
    try {
      chrome.permissions.request({ permissions: ['webRequest'] }, granted => {
        const error = chrome.runtime.lastError;
        if (destroyed) return;
        busy = false;
        if (error || !granted) { message('diagAutoPermissionDenied', true); render(); return; }
        enable();
      });
    } catch (_) { busy = false; message('diagAutoPermissionDenied', true); render(); }
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
    const websocket = Array.isArray(row.types) && row.types.includes('websocket');
    // Domain rows aggregate resource types. A mixed row must not present its
    // HTTP counts or latest status as the outcome of a WebSocket handshake.
    const mixed = websocket && row.types.some(type => type !== 'websocket');
    if (networkErrors(row) > 0) parts.push(t('diagFailed', { count: networkErrors(row) }));
    if (httpErrors(row) > 0) parts.push(t('diagHttpErrors', { count: httpErrors(row) }));
    if (row.pending > 0) parts.push(t(websocket ? mixed ? 'diagMixedPending' : 'diagWebSocketPending' : 'diagPending', { count: row.pending }));
    if (row.completed > 0) parts.push(t(websocket ? mixed ? 'diagMixedCompleted' : 'diagWebSocketCompleted' : 'diagCompleted', { count: row.completed }));
    if (row.unconfirmed > 0) parts.push(t('diagUnconfirmed', { count: row.unconfirmed }));
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
    const failures = rows.filter(row => !row.stale && (networkErrors(row) || httpErrors(row))).length;
    const hint = automaticEnabled()
      ? t(failures ? 'diagEntryFailures' : 'diagEntryDomains', { count: failures || rows.length })
      : rows.length ? `${t('diagFilterDifferent')} ${rows.filter(different).length} · ${t('diagFilterFailed')} ${rows.filter(row => networkErrors(row) > 0).length}` : t('diagEntryHint');
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
    input.disabled = busy || ruleWritesBlocked() || conflict(row) || row.route === direction || state.mode !== 'pac_script';
    const copy = el('span', 'ps-diag-domain-copy');
    const hostLine = el('span', 'ps-diag-host-line');
    hostLine.appendChild(el('span', 'ps-diag-host', row.host));
    const websocket = Array.isArray(row.types) && row.types.includes('websocket');
    if (websocket) hostLine.appendChild(el('span', 'ps-diag-type', t('diagWebSocket')));
    copy.appendChild(hostLine);
    const meta = el('span', 'ps-diag-meta');
    meta.append(el('span', '', t('diagRoute')), routeBadge(row.route), el('span', (networkErrors(row) || httpErrors(row)) && !row.stale ? 'ps-diag-problem' : '', row.stale ? t('diagStale') : requestSummary(row)));
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
      add('diagTypes', Array.isArray(row.types) ? row.types.map(type => type === 'websocket' ? t('diagWebSocket') : type).join(', ') : '—');
      add('diagRequest', requestSummary(row));
      if (row.lastStatus) add('diagLastStatus', 'HTTP ' + row.lastStatus);
      if (row.error) add('diagLastError', row.error);
      details.append(dl, el('p', '', t('diagPrediction')));
      if (websocket) details.appendChild(el('p', 'ps-diag-websocket-hint', t('diagWebSocketHint')));
      wrap.appendChild(details);
    }
    return wrap;
  }

  function emptyState(content) {
    const empty = el('div', 'ps-diag-empty');
    const logo = el('div', 'ps-diag-logo'); logo.appendChild(icon('list'));
    empty.append(logo, el('h2', '', t('diagCaptureTitle')), el('p', '', t('diagCaptureHint')));
    const start = button(state && state.permission ? 'diagCapture' : 'diagCapturePermission', 'capture', 'ps-diag-primary', 'refresh');
    start.disabled = busy || !sourceValid || ruleWritesBlocked();
    empty.appendChild(start);
    content.appendChild(empty);
  }

  function automaticOptIn(content) {
    const card = el('section', 'ps-diag-auto-optin');
    card.append(el('h2', '', t('diagAutoTitle')), el('p', '', t('diagAutoScope')), el('p', 'ps-diag-muted', t('diagAutoPrivacy')));
    const enable = button('diagAutoEnable', 'auto-enable', 'ps-diag-primary ps-diag-wide-btn');
    enable.disabled = busy || !sourceValid;
    card.appendChild(enable);
    content.appendChild(card);
  }

  function automaticEmpty(content) {
    const empty = el('div', 'ps-diag-empty ps-diag-auto-empty');
    empty.append(el('h2', '', t('diagAutoNoRecords')), el('p', '', t('diagAutoEarlier')));
    const reload = button('diagReload', 'capture', 'ps-diag-link', 'refresh');
    reload.disabled = busy || !sourceValid || ruleWritesBlocked();
    empty.appendChild(reload); content.appendChild(empty);
  }

  function renderRequests(content) {
    const rows = localRows();
    const session = localSession();
    const trial = activeTrial();
    const other = state && state.session && !session && (!hasAutomatic() || !state.autoCapture.enabled && !state.session.auto);
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
    if (rulesPending() && !localRuleUndo()) content.appendChild(el('p', 'ps-diag-notice ps-diag-warning', t('diagOtherRulesPending')));
    if (hasAutomatic() && (state.autoCapture.error || state.autoCapture.recovering) && !readError) content.appendChild(el('p', 'ps-diag-notice ps-diag-warning', t('diagReadFailed')));
    if (hasAutomatic() && !automaticEnabled()) {
      if (!state.autoCapture.permission && (permissionRevoked || state.autoCapture.enabled || session && session.stopReason === 'permission_revoked')) content.appendChild(el('p', 'ps-diag-notice ps-diag-warning', t('diagPermissionRevoked')));
      automaticOptIn(content);
    }
    if (other) {
      const notice = el('div', 'ps-diag-notice');
      notice.appendChild(el('p', '', t('diagOtherSession', { host: state.session.hostname })));
      if (ruleWritesBlocked()) notice.appendChild(el('p', 'ps-diag-hint', t(rulesPending() ? 'diagRulesPending' : 'diagOtherTrial')));
      else {
        const replace = button('diagReplace', 'replace', 'ps-diag-link'); replace.disabled = busy || !sourceValid;
        notice.appendChild(replace);
      }
      content.appendChild(notice);
    }
    if (trial) content.appendChild(trialCard(trial));
    if (!session && !hasAutomatic()) { if (!other && sourceValid) emptyState(content); return; }
    if (hasAutomatic() && !automaticEnabled() && (!session || session.auto)) return;
    if (state.mode !== 'pac_script') content.appendChild(el('p', 'ps-diag-notice', t('diagModeRequired')));
    if (session && session.rulesChanged && !session.auto) content.appendChild(el('p', 'ps-diag-notice', t('diagRulesChanged')));
    const stopKeys = { navigation: 'diagNavigation', permission_revoked: 'diagPermissionRevoked' };
    if (session && stopKeys[session.stopReason] && !session.auto) content.appendChild(el('p', 'ps-diag-notice', t(stopKeys[session.stopReason])));
    const capture = el('div', 'ps-diag-capture');
    capture.appendChild(el('span', automaticEnabled() ? 'ps-diag-auto-status' : '', t(automaticEnabled() ? 'diagAutoActive' : isCollecting() ? 'diagCaptureActive' : 'diagCaptureStopped', { count: rows.length })));
    const controls = el('div', 'ps-diag-controls');
    if (automaticEnabled()) controls.appendChild(button('diagAutoDisable', 'auto-disable', 'ps-diag-link ps-diag-auto-disable'));
    else if (isCollecting()) controls.appendChild(button('diagStop', 'stop', 'ps-diag-link'));
    else if (!trial) {
      const collect = button(state.permission ? 'diagCapture' : 'diagCapturePermission', 'capture', 'ps-diag-link', 'refresh');
      collect.disabled = busy || !sourceValid || ruleWritesBlocked(); controls.appendChild(collect);
    }
    if (session) {
      const clear = button('diagClear', 'clear', 'ps-diag-link'); clear.disabled = busy || ruleWritesBlocked();
      controls.appendChild(clear);
    }
    capture.appendChild(controls); content.appendChild(capture);
    if (automaticEnabled() && state.autoCapture.storage === 'memory') content.appendChild(el('p', 'ps-diag-memory-note', t('diagAutoMemory')));
    if (automaticEnabled() && !rows.length) { automaticEmpty(content); return; }
    const filters = el('div', 'ps-diag-filters');
    const counts = { different: rows.filter(different).length, failed: rows.filter(row => networkErrors(row) > 0).length, http: rows.filter(row => httpErrors(row) > 0).length, all: rows.length };
    for (const [name, key] of [['different', 'diagFilterDifferent'], ['failed', 'diagFilterFailed'], ['http', 'diagFilterHttp'], ['all', 'diagFilterAll']]) {
      const tab = button(key, 'filter'); tab.className = ''; tab.dataset.filter = name; tab.dataset.focus = 'filter:' + name;
      tab.setAttribute('aria-pressed', String(filter === name)); tab.disabled = false;
      tab.appendChild(el('span', 'ps-diag-count', counts[name])); filters.appendChild(tab);
    }
    content.appendChild(filters);
    const list = el('div', 'ps-diag-list');
    list.setAttribute('aria-label', t('diagTitle'));
    // Selected rows remain visible when live routing changes; no hidden selection surprise.
    const visible = rows.filter(row => selected.has(row.host) || matchesFilter(row));
    if (automaticEnabled()) visible.sort((a, b) => Number(!b.stale && !!networkErrors(b)) - Number(!a.stale && !!networkErrors(a)) || Number(!b.stale && !!httpErrors(b)) - Number(!a.stale && !!httpErrors(a)));
    for (const row of visible) list.appendChild(renderDomain(row));
    if (!visible.length) list.appendChild(el('div', 'ps-diag-empty', t(rows.length ? 'diagNoMatches' : 'diagNoRecords')));
    content.append(list, el('p', 'ps-diag-hint', t('diagCaveat')));
    if (session && session.dropped) content.appendChild(el('p', 'ps-diag-hint', t('diagDropped', { count: session.dropped })));
    if (fullPage) content.appendChild(el('p', 'ps-diag-hint', t('diagPrediction')));
  }

  function renderReview(content) {
    const hosts = selectedRows().map(row => row.host);
    const h1 = el('h1', '', t('diagReviewTitle')); h1.tabIndex = -1;
    content.append(h1, el('p', 'ps-diag-hint', t('diagReviewHint')));
    const list = el('div', 'ps-diag-confirm-list');
    for (const host of hosts) { const line = el('div', 'ps-diag-row'); line.append(el('span', 'ps-diag-host', host), routeBadge(direction)); list.appendChild(line); }
    content.appendChild(list);
    content.appendChild(el('p', 'ps-diag-muted', t('diagLifetime')));
    const scope = el('div', 'ps-diag-scope'); scope.append(icon('info'), el('span', '', t('diagScope'))); content.appendChild(scope);
    const confirm = button('diagApply', 'apply', 'ps-diag-primary ps-diag-wide-btn');
    confirm.disabled = busy || !hosts.length || !state || state.mode !== 'pac_script' || ruleWritesBlocked();
    content.appendChild(confirm);
  }

  function renderSelection() {
    if (view !== 'requests' || !localRows().length || trialBlocksChange() || !sourceValid || hasAutomatic() && !automaticEnabled() && localSession().auto) return null;
    const section = el('div', 'ps-diag-selection');
    const summary = el('div', 'ps-diag-selection-summary');
    summary.appendChild(el('div', 'ps-diag-muted', t(selected.size ? 'diagSelected' : 'diagSelectHint', { count: selected.size })));
    const review = button('diagReview', 'review', 'ps-diag-link'); review.disabled = busy || rulesPending() || !selectedRows().length || state.mode !== 'pac_script';
    summary.appendChild(review); section.appendChild(summary);
    const actions = el('div', 'ps-diag-selection-actions');
    const select = el('select'); select.dataset.direction = 'true'; select.dataset.focus = 'direction'; select.setAttribute('aria-label', t('diagDirection')); select.disabled = busy || rulesPending() || state.mode !== 'pac_script';
    for (const [value, key] of [['proxy', 'diagToProxy'], ['direct', 'diagToDirect']]) { const option = el('option', '', t(key)); option.value = value; option.selected = direction === value; select.appendChild(option); }
    const add = button(direction === 'direct' ? 'diagAddDirect' : 'diagAddProxy', 'add-rules', 'ps-diag-primary');
    add.setAttribute('title', t('diagScope'));
    add.setAttribute('aria-description', t('diagScope'));
    add.disabled = busy || rulesPending() || !selectedRows().length || state.mode !== 'pac_script';
    actions.append(select, add); section.appendChild(actions); return section;
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
      open, view, filter, direction, selected: [...selected], expanded: [...expanded], busy,
      pendingMutation, messageKey, messageError, readError, sourceReady, sourceLookupFailed, sourceValid,
      sourceTabId, sourceHostname, sourceRevision, obsoleteSessionId, state: observedState, collecting: isCollecting(),
      permissionRevoked,
      trialMinutes: trial ? Math.ceil((trial.expiresAt - Date.now()) / 60000) : null,
      ruleUndoVisible: !!localRuleUndo(),
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
    const brand = el('div', 'ps-diag-brand');
    const logo = el('img', 'ps-diag-brand-logo');
    logo.setAttribute('src', chrome.runtime.getURL('assets/icon.png'));
    logo.setAttribute('alt', '');
    logo.setAttribute('aria-hidden', 'true');
    brand.append(logo, el('span', '', 'ProxySwitch'));
    header.appendChild(brand);
    if (!fullPage || view !== 'requests') { const back = button('diagBack', 'back', 'ps-diag-link ps-diag-back', 'back'); back.disabled = false; header.appendChild(back); }
    root.appendChild(header);
    const content = el('div', 'ps-diag-content');
    if (view === 'review') renderReview(content); else renderRequests(content);
    root.appendChild(content);
    const selection = renderSelection(); if (selection) root.appendChild(selection);
    const receipt = localRuleUndo();
    const receiptKey = receipt ? receipt.pendingApply ? receipt.undone ? 'diagRulesUndoPending' : 'diagRulesPending' : receipt.undone ? 'diagRulesUndone' : 'diagRulesAdded' : '';
    const statusKey = receipt && receipt.pendingApply ? receiptKey : messageKey || receiptKey;
    const statusError = messageError || !!(receipt && receipt.pendingApply);
    const status = el('div', 'ps-diag-message', statusKey ? t(statusKey) : '');
    status.setAttribute('role', statusError ? 'alert' : 'status'); status.setAttribute('aria-live', 'polite');
    status.dataset.error = String(statusError); status.hidden = !statusKey;
    if (pendingMutation) { const retry = button('diagRetry', 'retry', 'ps-diag-link'); retry.disabled = false; status.appendChild(retry); }
    if (receipt && !pendingMutation) {
      const receiptAction = (key, action) => {
        const control = button(key, action, 'ps-diag-link');
        if (trialBlocksChange()) { control.disabled = true; control.setAttribute('title', t('diagErrorTrialConflict')); }
        status.appendChild(control);
      };
      if (receipt.pendingApply) receiptAction('diagRetryApply', 'retry-rules');
      if (!receipt.undone && receipt.canUndo) receiptAction('diagUndoRules', 'undo-rules');
      if (!receipt.undone && !receipt.canUndo) status.appendChild(el('span', 'ps-diag-undo-unavailable', t('diagUndoUnavailable')));
    }
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
    else if (action === 'auto-enable') requestPermissionAndEnable();
    else if (action === 'auto-disable') mutate('PS_DIAG_AUTO_DISABLE', { tabId: sourceTabId });
    else if (action === 'capture') requestPermissionAndStart(false);
    else if (action === 'replace') requestPermissionAndStart(true);
    else if (action === 'retry') { if (sourceLookupFailed) resolveSource(); else readState(); }
    else if (action === 'filter') { uiTouched = true; filter = node.dataset.filter; remember(); render(); }
    else if (action === 'expand') { expanded.has(node.dataset.host) ? expanded.delete(node.dataset.host) : expanded.add(node.dataset.host); render(); }
    else if (action === 'review') { if (selectedRows().length) navigate('review'); }
    else if (action === 'add-rules') {
      const session = localSession();
      if (session && state.mode === 'pac_script' && !ruleWritesBlocked() && selectedRows().length) {
        mutate('PS_DIAG_ADD_RULES', { sessionId: session.id, hosts: selectedRows().map(row => row.host), direction, actionId: actionId() });
      }
    }
    else if (action === 'apply') {
      const session = localSession();
      if (session) mutate('PS_DIAG_APPLY', { sessionId: session.id, hosts: selectedRows().map(row => row.host), direction }, 'diagTrialApplied');
    } else if (action === 'stop') {
      const session = localSession(); if (session) mutate('PS_DIAG_STOP', { sessionId: session.id });
    } else if (action === 'clear') {
      const session = localSession(); if (session && window.confirm(t('diagClearConfirm'))) mutate('PS_DIAG_CLEAR', { sessionId: session.id, ...(session.auto ? { tabId: sourceTabId } : {}) });
    } else if (action === 'undo') {
      const trial = activeTrial(); if (trial) { if (!open) navigate('requests'); mutate('PS_DIAG_UNDO', { trialId: trial.id }, 'diagTrialUndone'); }
    } else if (action === 'save') {
      const trial = activeTrial(); if (trial) mutate('PS_DIAG_SAVE', { trialId: trial.id }, 'diagTrialSaved');
    } else if (action === 'undo-rules' || action === 'retry-rules') {
      const receipt = localRuleUndo();
      if (receipt && (action === 'undo-rules' ? receipt.canUndo && !receipt.undone : receipt.pendingApply)) {
        mutate(action === 'undo-rules' ? 'PS_DIAG_UNDO_RULES' : 'PS_DIAG_RETRY_RULES', { undoId: receipt.id });
      }
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
    }
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
      writeUiSnapshot();
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
      if (recoveringMutation && state) readState();
      if (fullPage) applyTheme(items && items.theme);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (fullPage && changes.theme) applyTheme(changes.theme.newValue);
      if (changes.diagnosticTrial) readState();
    });
  } catch (_) {}

  try {
    if (chrome.storage.session && typeof chrome.storage.session.get === 'function') chrome.storage.session.get([AUTO_UI_KEY], items => {
      if (chrome.runtime.lastError) return;
      if (items && items[AUTO_UI_KEY] && items[AUTO_UI_KEY].expiresAt > Date.now()) savedAutomaticUi = items[AUTO_UI_KEY];
      else if (items && items[AUTO_UI_KEY]) chrome.storage.session.remove(AUTO_UI_KEY, () => { void chrome.runtime.lastError; });
      restoreUi();
      if (state) render();
      if (recoveringMutation && state) readState();
    });
  } catch (_) {}

  function applyTheme(theme) {
    if (globalThis.ProxySwitchUI) ProxySwitchUI.applyTheme(theme);
    else if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
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
      url.hash = '';
      const nextUrl = sourceValid ? url.href : '';
      if (sourceUrl && nextUrl !== sourceUrl) {
        sourceRevision += 1;
        if (state && state.session && state.session.auto) obsoleteSessionId = state.session.id;
        selected.clear(); expanded.clear(); view = 'requests';
      }
      sourceUrl = nextUrl;
    } catch (_) {
      sourceValid = false; sourceHostname = '';
      if (sourceUrl) {
        sourceRevision += 1;
        if (state && state.session && state.session.auto) obsoleteSessionId = state.session.id;
        selected.clear(); expanded.clear(); view = 'requests';
      }
      sourceUrl = '';
    }
    sourceReady = true;
    render();
    // Never make the established homepage wait for this read.
    readState();
    schedulePoll();
  }

  function refreshSource() {
    if (!Number.isInteger(sourceTabId) || destroyed) return;
    try { chrome.tabs.get(sourceTabId, tab => { void chrome.runtime.lastError; acceptSource(tab); }); } catch (_) { acceptSource(null); }
  }

  // An open popup can outlive a foreground navigation. Invalidate the old page
  // immediately; only the worker's fresh document session may repopulate it.
  try {
    chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
      if (tabId !== sourceTabId || !hasAutomatic() || !changes.url) return;
      acceptSource({ ...tab, id: tabId, url: changes.url });
    });
  } catch (_) {}

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
