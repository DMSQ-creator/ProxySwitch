// Optional, bounded request diagnostics. Never stores URLs, headers, bodies or socket messages.
(function (root) {
  'use strict';
  const SESSION_KEY = 'diagnosticSession';
  const TRIAL_KEY = 'diagnosticTrial';
  const UI_KEY = 'diagnosticUiState';
  const RULE_UNDO_KEY = 'diagnosticRuleUndo';
  const AUTO_UI_KEY = 'diagnosticAutoUiState';
  const CONFIG_KEYS = ['userRules', 'userWhitelist', 'gfwDomains', 'tempRules', 'serverList', 'activeServerId'];
  const ALARM = 'proxyswitch-diagnostics';
  const CAPTURE_MS = 60000;
  const RETENTION_MS = 30 * 60000;
  const TRIAL_MS = 10 * 60000;
  const RULE_UNDO_MS = 10 * 60000;
  const MAX_DOMAINS = 200;
  const MAX_REQUESTS = 1000;
  function create({ chrome, routing, refresh, mutateConfiguration = fn => fn(), now = Date.now, uuid = () => crypto.randomUUID() }) {
    const automatic = root.ProxySwitchRequestRecorder ? root.ProxySwitchRequestRecorder.create({ chrome, routing, now, uuid }) : null;
    let session = null;
    let trial = null;
    let ruleUndo = null;
    let resetPending = false;
    let digestInput = null;
    let digestResult = null;
    let rows = new Map();
    const active = new Map();
    const httpErrorRequests = new Set();
    let granted = false;
    let attached = false;
    let attachedTabId = null;
    const requestListeners = [];
    let flushTimer = null;
    let configSignature = '';
    let prepared = routing.prepare({});
    let mutation = Promise.resolve();
    let hydrated = false;
    const earlyEvents = [];
    const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
    function call(object, name, args, code) {
      return new Promise((resolve, reject) => {
        let completed = false;
        let timer = null;
        const finish = (error, value) => {
          if (completed) return;
          completed = true;
          if (timer) clearTimeout(timer);
          error ? reject(error) : resolve(value);
        };
        // Time out reads. Writes must await their callback because a timed-out
        // write can still commit later and must not race a subsequent mutation.
        if (name === 'get' || name === 'contains') {
          timer = setTimeout(() => finish(Object.assign(new Error(code), { code })), 8000);
        }
        try {
          object[name](...args, (value) => {
            if (chrome.runtime.lastError) finish(Object.assign(new Error(code), { code }));
            else finish(null, value);
          });
        } catch (_) { finish(Object.assign(new Error(code), { code })); }
      });
    }
    const read = (keys) => call(chrome.storage.local, 'get', [keys], 'storage_failed');
    const write = (items) => call(chrome.storage.local, 'set', [items], 'storage_failed');
    const remove = (keys) => call(chrome.storage.local, 'remove', [keys], 'storage_failed');
    const removeAutomaticUi = () => chrome.storage.session
      ? call(chrome.storage.session, 'remove', [[AUTO_UI_KEY]], 'storage_failed') : Promise.resolve();
    const serialize = (fn) => {
      const result = mutation.then(fn);
      mutation = result.catch(() => {});
      return result;
    };
    function automaticEnabled() { return !!(automatic && automatic.status().enabled); }
    function adoptAutomatic(tabId, sessionId) {
      if (!automatic || (!automaticEnabled() && !(session && session.auto))) return;
      const record = sessionId ? automatic.find(sessionId) : automatic.snapshot(tabId);
      session = record ? record.session : null;
      rows = new Map(record ? record.rows.map(row => [row.host, row]) : []);
      active.clear(); httpErrorRequests.clear(); detach();
    }
    async function bindAutomatic(message) {
      if (!automatic) return;
      if (message.type === 'PS_DIAG_AUTO_ENABLE' || message.type === 'PS_DIAG_AUTO_DISABLE') return;
      try { await automatic.ready; } catch (_) { return; }
      if (!automaticEnabled() && !(session && session.auto)) return;
      if (message.sessionId) adoptAutomatic(message.tabId, message.sessionId);
      else if (Number.isInteger(message.tabId)) adoptAutomatic(message.tabId);
      else if (message.undoId && ruleUndo) adoptAutomatic(ruleUndo.tabId);
      else if (message.trialId && trial) adoptAutomatic(trial.tabId);
    }
    function ruleKey(direction) { return direction === 'proxy' ? 'userRules' : 'userWhitelist'; }
    async function rulesDigest(rules) {
      const input = JSON.stringify(Array.isArray(rules) ? rules : []);
      if (input !== digestInput) {
        // A small fingerprint fences undo against later edits without storing
        // a second full copy of the user's rule list in a diagnostic receipt.
        const pending = Promise.resolve().then(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)))
          .then(bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''));
        digestInput = input;
        digestResult = pending.catch(error => {
          if (digestInput === input) { digestInput = null; digestResult = null; }
          throw error;
        });
      }
      return digestResult;
    }
    async function clearRuleUndo() {
      if (!ruleUndo) return;
      await remove([RULE_UNDO_KEY]);
      ruleUndo = null;
    }
    function validActionId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
    function report(error) {
      // Codes only: do not feed request URLs or hostnames to the fault journal.
      if (typeof PSL !== 'undefined') PSL.warn('diagnostics', 'Operation failed', error.code || 'internal_error');
    }
    function persist() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      // Automatic summaries live only in the recorder's session cache. Never
      // copy them into the legacy on-disk manual-capture record.
      if (session && session.auto) return Promise.resolve();
      if (!session) return remove([SESSION_KEY, 'diagnosticUiState']);
      return write({ [SESSION_KEY]: { session: { ...session }, rows: Array.from(rows.values(), row => ({ ...row, types: [...row.types] })) } });
    }
    function schedulePersist() {
      if (session && session.auto) return;
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        serialize(persist).catch(report);
      }, 300);
    }
    async function validateUiState() {
      // Read the latest value inside the mutation queue: an old storage event
      // must not remove a newer, valid selection from another extension page.
      const value = (await read([UI_KEY]))[UI_KEY];
      if (value === undefined) return;
      const recorded = automatic && value && automatic.find(value.sessionId);
      // Automatic selections belong to the in-memory session store, never
      // the legacy on-disk capture/UI record (including upgrade leftovers).
      if (recorded || session && session.auto && value && value.sessionId === session.id) {
        await remove([UI_KEY]); return;
      }
      const viewSession = recorded ? recorded.session : session;
      const observed = recorded ? new Set(recorded.rows.map(row => row.host)) : rows;
      const deadline = viewSession && (viewSession.auto ? viewSession.updatedAt : viewSession.startedAt) + RETENTION_MS;
      if (!value || !viewSession || value.sessionId !== viewSession.id || deadline <= now() ||
          !Number.isFinite(value.expiresAt) || value.expiresAt <= now()) {
        await remove([UI_KEY]);
        return;
      }
      const safe = {
        sessionId: viewSession.id,
        filter: ['different', 'failed', 'http', 'all'].includes(value.filter) ? value.filter : 'different',
        direction: value.direction === 'direct' ? 'direct' : 'proxy',
        selected: [...new Set((Array.isArray(value.selected) ? value.selected : [])
          .filter(host => typeof host === 'string' && routing.hostname(host) === host && observed.has(host)))].slice(0, MAX_DOMAINS),
        expiresAt: Math.min(value.expiresAt, deadline),
      };
      const pending = value.pendingMutation;
      if (pending && pending.sessionId === viewSession.id &&
          ['PS_DIAG_ADD_RULES', 'PS_DIAG_UNDO_RULES', 'PS_DIAG_RETRY_RULES'].includes(pending.type)) {
        const key = pending.type === 'PS_DIAG_ADD_RULES' ? 'actionId' : 'undoId';
        if (validActionId(pending[key])) safe.pendingMutation = {
          type: pending.type, sessionId: viewSession.id, [key]: pending[key],
        };
      }
      if (JSON.stringify(value) !== JSON.stringify(safe)) await write({ [UI_KEY]: safe });
    }
    async function validateAutomaticUi() {
      if (!automatic || !chrome.storage.session) return;
      const value = (await call(chrome.storage.session, 'get', [[AUTO_UI_KEY]], 'storage_failed'))[AUTO_UI_KEY];
      if (value === undefined) return;
      const recorded = value && automaticEnabled() && automatic.find(value.sessionId);
      const deadline = recorded && recorded.session.updatedAt + RETENTION_MS;
      if (!recorded || !Number.isFinite(value.expiresAt) || value.expiresAt <= now() || deadline <= now()) {
        await removeAutomaticUi(); return;
      }
      const observed = new Set(recorded.rows.map(row => row.host));
      const safe = {
        sessionId: recorded.session.id,
        filter: ['different', 'failed', 'http', 'all'].includes(value.filter) ? value.filter : 'all',
        direction: value.direction === 'direct' ? 'direct' : 'proxy',
        selected: [...new Set((Array.isArray(value.selected) ? value.selected : [])
          .filter(host => typeof host === 'string' && routing.hostname(host) === host && observed.has(host)))].slice(0, MAX_DOMAINS),
        expiresAt: Math.min(value.expiresAt, deadline),
      };
      const pending = value.pendingMutation;
      if (pending && pending.sessionId === recorded.session.id &&
          ['PS_DIAG_ADD_RULES', 'PS_DIAG_UNDO_RULES', 'PS_DIAG_RETRY_RULES'].includes(pending.type)) {
        const key = pending.type === 'PS_DIAG_ADD_RULES' ? 'actionId' : 'undoId';
        if (validActionId(pending[key])) safe.pendingMutation = { type: pending.type, sessionId: recorded.session.id, [key]: pending[key] };
      }
      if (JSON.stringify(value) !== JSON.stringify(safe)) {
        await call(chrome.storage.session, 'set', [{ [AUTO_UI_KEY]: safe }], 'storage_failed');
      }
    }
    function scheduleAlarm() {
      const deadlines = [];
      if (session && !session.auto) {
        deadlines.push(session.startedAt + RETENTION_MS);
        if (session.captureUntil) deadlines.push(session.captureUntil);
      }
      if (trial) deadlines.push(trial.expiresAt > now() ? trial.expiresAt : now() + 60000);
      if (ruleUndo) deadlines.push(ruleUndo.expiresAt > now() ? ruleUndo.expiresAt : now() + 60000);
      if (!deadlines.length) { chrome.alarms.clear(ALARM, () => {}); return; }
      chrome.alarms.create(ALARM, { when: Math.max(now() + 1000, Math.min(...deadlines)) });
    }
    function halt(reason) {
      if (!session) return;
      session.captureUntil = 0;
      session.stopReason = reason;
      session.updatedAt = now();
      if (reason === 'closed') session.closed = true;
      // Requests abandoned at a capture boundary are not falsely labelled failures.
      active.clear();
      httpErrorRequests.clear();
      detach();
      scheduleAlarm();
    }
    async function invalidateResults() {
      if (automaticEnabled()) {
        const tabId = session && session.tabId;
        await automatic.invalidate();
        if (session && session.auto) adoptAutomatic(tabId);
        return;
      }
      if (!session) return;
      halt('rules_changed');
      session.rulesChanged = true;
    }
    function hostOf(url) {
      try { const parsed = new URL(url); return /^(https?:)$/.test(parsed.protocol) ? routing.hostname(parsed.hostname) : null; }
      catch (_) { return null; }
    }
    function requestHostOf(url) {
      // WebSocket handshakes belong to an ordinary source page. Accept their
      // target domains without expanding which tabs may start a capture.
      try { const parsed = new URL(url); return /^(https?:|wss?:)$/.test(parsed.protocol) ? routing.hostname(parsed.hostname) : null; }
      catch (_) { return null; }
    }
    function observing(details) {
      if (!granted || !session || details.tabId !== session.tabId || !session.captureUntil) return false;
      if (now() >= session.captureUntil) { halt('expired'); schedulePersist(); return false; }
      return true;
    }
    function onRequest(kind, details) {
      if (session && session.auto) return;
      if (details.incognito) return;
      if (hydrated && !observing(details)) return;
      // Sanitize even the small pre-hydration queue; it must not retain raw URLs
      // (including paths/query strings) while the optional storage read resolves.
      const host = details.host || requestHostOf(details.url);
      if (!host) return;
      details = {
        host, tabId: details.tabId, requestId: details.requestId,
        type: /^[a-z_]{1,30}$/.test(details.type || '') ? details.type : 'other',
        statusCode: typeof details.statusCode === 'number' ? details.statusCode : null,
        error: /^net::ERR_[A-Z0-9_]+$/.test(details.error || '') ? details.error : 'request_failed',
      };
      if (!hydrated) {
        if (earlyEvents.length < MAX_REQUESTS) earlyEvents.push([kind, details]);
        return;
      }
      if (!observing(details)) return;
      if (kind === 'start') {
        if (details.type === 'main_frame' && host !== session.hostname) {
          halt('navigation'); schedulePersist(); return;
        }
        if (active.size >= MAX_REQUESTS && !active.has(details.requestId)) {
          session.dropped++; schedulePersist(); return;
        }
        if (!rows.has(host)) {
          if (rows.size >= MAX_DOMAINS) { session.dropped++; schedulePersist(); return; }
          rows.set(host, { host, count: 0, completed: 0, failed: 0, httpErrors: 0, pending: 0, types: [], lastStatus: null, error: null });
        }
        const oldHost = active.get(details.requestId);
        if (oldHost && rows.has(oldHost)) rows.get(oldHost).pending = Math.max(0, rows.get(oldHost).pending - 1);
        const row = rows.get(host);
        row.count++;
        row.pending++;
        if (details.type && !row.types.includes(details.type) && row.types.length < 20) row.types.push(details.type);
        active.set(details.requestId, host);
        httpErrorRequests.delete(details.requestId);
      } else {
        const trackedHost = active.get(details.requestId);
        if (!trackedHost || !rows.has(trackedHost)) return;
        const row = rows.get(trackedHost);
        if (typeof details.statusCode === 'number') row.lastStatus = details.statusCode;
        if (typeof details.statusCode === 'number' && details.statusCode >= 400 && !httpErrorRequests.has(details.requestId)) {
          row.httpErrors++;
          httpErrorRequests.add(details.requestId);
        }
        if (kind === 'done' || kind === 'error' || kind === 'redirect') {
          row.pending = Math.max(0, row.pending - 1);
          active.delete(details.requestId);
          httpErrorRequests.delete(details.requestId);
          if (kind === 'error') {
            row.failed++;
            // Chrome network error codes only, never arbitrary error text containing URLs.
            row.error = /^net::ERR_[A-Z0-9_]+$/.test(details.error || '') ? details.error : 'request_failed';
          } else {
            row.completed++;
          }
        }
      }
      session.updatedAt = now();
      schedulePersist();
    }
    function detach() {
      for (const [event, listener] of requestListeners.splice(0)) {
        try { chrome.webRequest[event].removeListener(listener); } catch (_) {}
      }
      attached = false;
      attachedTabId = null;
    }
    function attach(tabId = null) {
      if (!chrome.webRequest || (attached && attachedTabId === tabId)) return;
      detach();
      const listeners = [['onBeforeRequest', 'start'], ['onHeadersReceived', 'headers'], ['onCompleted', 'done'], ['onErrorOccurred', 'error'], ['onBeforeRedirect', 'redirect']];
      try {
        const filter = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };
        if (Number.isInteger(tabId)) filter.tabId = tabId;
        for (const [event, kind] of listeners) {
          const listener = details => onRequest(kind, details);
          chrome.webRequest[event].addListener(listener, filter);
          requestListeners.push([event, listener]);
        }
        attached = true;
        attachedTabId = tabId;
      } catch (_) { detach(); /* Optional permission has not been granted yet. */ }
    }
    async function permission() {
      granted = !!(await call(chrome.permissions, 'contains', [{ permissions: ['webRequest'] }], 'permission_required'));
      if (!granted) detach();
      else if (hydrated && session && !session.auto && session.captureUntil > now()) attach(session.tabId);
      return granted;
    }
    async function configuration() {
      const config = await read(CONFIG_KEYS);
      const signature = JSON.stringify(CONFIG_KEYS.slice(0, 4).map(key => config[key] || []));
      if (signature !== configSignature) { prepared = routing.prepare(config); configSignature = signature; }
      return config;
    }
    async function proxy() { return call(chrome.proxy.settings, 'get', [{}], 'proxy_failed'); }
    async function checkedTab(tabId) {
      if (!Number.isInteger(tabId) || tabId < 0) fail('invalid_tab');
      const tab = await call(chrome.tabs, 'get', [tabId], 'tab_closed');
      const hostname = hostOf(tab.url);
      if (tab.incognito || !hostname) fail('restricted_tab');
      return { tab, hostname };
    }
    async function refreshProxy() {
      try { await refresh(); } catch (_) { fail('proxy_failed'); }
    }
    async function discardTrial() {
      if (!trial) return;
      // Persist an inactive tombstone before rebuilding. If Chrome rejects the
      // refresh, keep that record so restart/GET/Undo can retry instead of losing
      // the only evidence that the installed PAC still needs to be refreshed.
      if (routing.activeTrial(trial, now())) {
        const inactive = { ...trial, expiresAt: 0, pendingCleanup: true };
        await write({ [TRIAL_KEY]: inactive }); trial = inactive;
      }
      if (!trial.saved) { await invalidateResults(); await persist(); }
      await refreshProxy();
      await remove([TRIAL_KEY]); trial = null;
      scheduleAlarm();
    }
    async function cleanup(startup = false) {
      let changed = false;
      if (automatic) {
        try {
          await automatic.cleanup(startup);
          if (session && session.auto) adoptAutomatic(session.tabId);
        } catch (error) {
          // A recorder-only preference failure must not disable manual rules or
          // prevent the user from explicitly retrying opt-in. The UI receives
          // its safe error state instead of a misleading empty auto capture.
          if (!automatic.status().error) throw error;
        }
      }
      if (session && !session.auto && (startup || session.startedAt + RETENTION_MS <= now())) {
        session = null; rows.clear(); active.clear(); httpErrorRequests.clear(); detach(); await persist();
      } else if (session && session.captureUntil && session.captureUntil <= now()) {
        halt('expired'); changed = true;
      }
      if (trial && (startup || !routing.activeTrial(trial, now()))) {
        await discardTrial(); changed = true;
      }
      if (ruleUndo && (startup || (!session && ruleUndo.context !== 'auto') || ruleUndo.expiresAt <= now())) await clearRuleUndo();
      if (changed) await persist();
      scheduleAlarm();
    }
    async function state(tabId, allowCleanup = true) {
      if (allowCleanup) await cleanup();
      if (automaticEnabled()) adoptAutomatic(Number.isInteger(tabId) ? tabId : session && session.tabId);
      const [config, settings, hasPermission] = await Promise.all([configuration(), proxy(), permission()]);
      let mode = settings && settings.value ? settings.value.mode : 'direct';
      if (mode === 'pac_script' && settings.levelOfControl !== 'controlled_by_this_extension') mode = 'unknown';
      const route = host => routing.evaluate(host, prepared, { mode, trial, now: now() });
      const undoMatches = !!(ruleUndo && ruleUndo.expiresAt > now() && !ruleUndo.invalidated &&
        (config[ruleKey(ruleUndo.direction)] === undefined || Array.isArray(config[ruleKey(ruleUndo.direction)])) &&
        await rulesDigest(config[ruleKey(ruleUndo.direction)]) === ruleUndo.afterDigest);
      let mainHost = session && session.hostname;
      if (!mainHost && Number.isInteger(tabId)) {
        try { mainHost = (await checkedTab(tabId)).hostname; } catch (_) { /* Empty view for restricted tabs. */ }
      }
      return {
        session: session ? { ...session } : null,
        trial: trial ? { ...trial, hosts: [...trial.hosts] } : null,
        ruleUndo: ruleUndo ? {
          id: ruleUndo.id, actionId: ruleUndo.actionId, sessionId: ruleUndo.sessionId,
          tabId: ruleUndo.tabId, hosts: [...ruleUndo.hosts], direction: ruleUndo.direction,
          expiresAt: ruleUndo.expiresAt, pendingApply: ruleUndo.pendingApply,
          undone: ruleUndo.undone, canUndo: !ruleUndo.undone && !!ruleUndo.hosts.length && undoMatches,
          ...(ruleUndo.context === 'auto' ? { context: 'auto' } : {}),
        } : null,
        ...(automatic ? { autoCapture: automatic.status() } : {}),
        mode,
        permission: hasPermission,
        rows: Array.from(rows.values(), row => ({
          ...row, types: [...row.types], ...route(row.host),
          stale: session && session.auto ? !!row.stale : !!(session && session.rulesChanged),
          conflict: routing.conflict(row.host, prepared, 'proxy') || routing.conflict(row.host, prepared, 'direct'),
          conflictProxy: routing.conflict(row.host, prepared, 'proxy'),
          conflictDirect: routing.conflict(row.host, prepared, 'direct'),
        })),
        main: mainHost ? { host: mainHost, ...route(mainHost) } : null,
        hasServer: !!((config.serverList || []).length),
      };
    }
    async function round(tabId, id) {
      const { hostname } = await checkedTab(tabId);
      const stamp = now();
      if (!id) await clearRuleUndo();
      session = { id: id || uuid(), tabId, hostname, startedAt: stamp, captureUntil: stamp + CAPTURE_MS, updatedAt: stamp, dropped: 0 };
      rows.clear(); active.clear(); httpErrorRequests.clear();
      await remove(['diagnosticUiState']);
      await persist();
      attach(tabId);
      scheduleAlarm();
    }
    async function reload(tabId) {
      try { await call(chrome.tabs, 'reload', [tabId, { bypassCache: true }], 'reload_failed'); }
      catch (error) { halt('reload_failed'); await persist(); throw error; }
    }
    function requireSession(id) {
      if (!session || session.id !== id || (session.auto && (!automatic || !automatic.find(id)))) fail('session_not_found');
    }
    function requireTrial(id) { if (!trial || trial.id !== id) fail('trial_not_found'); }
    function requireRuleUndo(id) { if (!ruleUndo || ruleUndo.id !== id || ruleUndo.expiresAt <= now()) fail('rule_undo_not_found'); }
    async function requirePac() {
      const settings = await proxy();
      if (!settings || !settings.value || settings.value.mode !== 'pac_script') fail('mode_required');
      if (settings.levelOfControl !== 'controlled_by_this_extension') fail('proxy_uncontrolled');
      const config = await configuration();
      if (!(config.serverList || []).length) fail('no_server');
      return config;
    }
    function observedHosts(message) {
      if (message.direction !== 'proxy' && message.direction !== 'direct') fail('invalid_direction');
      if (!Array.isArray(message.hosts) || !message.hosts.length || message.hosts.length > MAX_DOMAINS) fail('invalid_hosts');
      if (message.hosts.some(host => typeof host !== 'string' || routing.hostname(host) !== host ||
          !rows.has(host) || routing.localHost(host))) fail('invalid_hosts');
      const hosts = [...new Set(message.hosts)];
      return hosts;
    }
    async function applyRuleChange() {
      // The committed rule change remains undoable if Chrome cannot confirm
      // application. Retry only applies the current config; it never rewrites it.
      await refreshProxy();
      const applied = { ...ruleUndo, pendingApply: false };
      await write({ [RULE_UNDO_KEY]: applied });
      ruleUndo = applied;
      scheduleAlarm();
    }
    async function addRules(message) {
      await mutateConfiguration(async () => {
        requireSession(message.sessionId);
        if (!(await permission())) fail('permission_required');
        if (trial) fail('trial_conflict');
        if (!validActionId(message.actionId)) fail('invalid_action');
        const hosts = observedHosts(message);
        if (ruleUndo && ruleUndo.actionId === message.actionId) {
          if (ruleUndo.sessionId !== message.sessionId || ruleUndo.direction !== message.direction ||
              JSON.stringify(ruleUndo.requestedHosts) !== JSON.stringify(hosts)) fail('invalid_action');
          if (ruleUndo.pendingApply) fail('rule_application_pending');
          return; // A late UI reply or repeated request cannot add the batch twice.
        }
        if (ruleUndo && ruleUndo.pendingApply) fail('rule_application_pending');
        const config = await requirePac();
        if (hosts.some(host => routing.conflict(host, prepared, message.direction))) fail('rule_conflict');
        const key = ruleKey(message.direction);
        if (config[key] !== undefined && !Array.isArray(config[key])) fail('invalid_rules');
        const existing = config[key] || [];
        const additions = hosts.filter(host => !existing.includes(host));
        const rules = [...existing, ...additions];
        if (rules.length > 100000) fail('invalid_rules');
        const afterDigest = await rulesDigest(rules);
        const target = await checkedTab(session.tabId);
        if (target.hostname !== session.hostname) fail('session_conflict');
        requireSession(message.sessionId);
        const candidate = {
          id: uuid(), actionId: message.actionId, sessionId: session.id, tabId: session.tabId,
          direction: message.direction, hosts: additions, requestedHosts: hosts,
          afterDigest, expiresAt: now() + RULE_UNDO_MS, pendingApply: true, undone: false,
          ...(session.auto ? { context: 'auto' } : {}),
        };
        await write({ ...(additions.length ? { [key]: rules } : {}), [RULE_UNDO_KEY]: candidate });
        ruleUndo = candidate;
        await invalidateResults();
        await persist();
        scheduleAlarm();
        await refreshProxy();
        // A mode change during application must not be reported as an active
        // Auto route. Preserve the receipt so the user can retry or undo it.
        await requirePac();
        await write({ [RULE_UNDO_KEY]: { ...ruleUndo, pendingApply: false } });
        ruleUndo = { ...ruleUndo, pendingApply: false };
      });
    }
    async function undoRules(message) {
      await mutateConfiguration(async () => {
        requireRuleUndo(message.undoId);
        if (trial) fail('trial_conflict');
        if (ruleUndo.undone) {
          if (ruleUndo.pendingApply) fail('rule_application_pending');
          return;
        }
        const config = await configuration();
        const key = ruleKey(ruleUndo.direction);
        if (config[key] !== undefined && !Array.isArray(config[key])) fail('rule_undo_conflict');
        if (ruleUndo.invalidated || await rulesDigest(config[key]) !== ruleUndo.afterDigest) fail('rule_undo_conflict');
        const added = new Set(ruleUndo.hosts);
        const rules = (config[key] || []).filter(host => !added.has(host));
        const candidate = { ...ruleUndo, afterDigest: await rulesDigest(rules), pendingApply: true, undone: true };
        await write({ [key]: rules, [RULE_UNDO_KEY]: candidate });
        ruleUndo = candidate;
        await invalidateResults();
        await persist();
        await applyRuleChange();
      });
    }
    async function retryRules(message) {
      await mutateConfiguration(async () => {
        requireRuleUndo(message.undoId);
        if (trial) fail('trial_conflict');
        if (!ruleUndo.pendingApply) return;
        if (!ruleUndo.undone) await requirePac();
        // Later edits invalidate undo, not application retry: refresh the latest
        // configuration without replacing any of its rules with the old batch.
        await refreshProxy();
        if (!ruleUndo.undone) await requirePac();
        await write({ [RULE_UNDO_KEY]: { ...ruleUndo, pendingApply: false } });
        ruleUndo = { ...ruleUndo, pendingApply: false };
      });
    }
    async function mutate(message) {
      if (resetPending && message.type !== 'PS_DIAG_GET') fail('config_resetting');
      await bindAutomatic(message);
      await cleanup();
      switch (message.type) {
        case 'PS_DIAG_GET': break;
        case 'PS_DIAG_AUTO_ENABLE': {
          if (!automatic) fail('recorder_unavailable');
          if (message.consent !== true) fail('consent_required');
          // Previous webRequest grants are not consent for continuous recording.
          if (!(await permission())) fail('permission_required');
          await automatic.enable({ consent: true });
          if (session && !session.auto) { halt('automatic_enabled'); session = null; rows.clear(); }
          await remove([SESSION_KEY, UI_KEY]);
          await removeAutomaticUi();
          adoptAutomatic(message.tabId);
          break;
        }
        case 'PS_DIAG_AUTO_DISABLE': {
          if (!automatic) fail('recorder_unavailable');
          try { await automatic.disable(); }
          finally {
            // Stop takes effect immediately even when persisting that choice
            // fails. Never return a stale automatic snapshot in an error reply.
            if (session && session.auto) { session = null; rows.clear(); active.clear(); httpErrorRequests.clear(); }
            try { await removeAutomaticUi(); } catch (error) { report(error); }
          }
          await remove([UI_KEY]);
          await removeAutomaticUi();
          break;
        }
        case 'PS_DIAG_START': {
          if (!(await permission())) fail('permission_required');
          await checkedTab(message.tabId);
          if (trial) fail('trial_conflict');
          if (ruleUndo && ruleUndo.pendingApply) fail('rule_application_pending');
          if (automaticEnabled()) {
            await automatic.reset(message.tabId);
            adoptAutomatic(message.tabId);
            await reload(message.tabId);
            break;
          }
          if (session && session.tabId !== message.tabId && !message.replace) fail('session_conflict');
          await round(message.tabId);
          await reload(message.tabId);
          break;
        }
        case 'PS_DIAG_STOP':
          requireSession(message.sessionId);
          if (session.auto) fail('automatic_recording');
          halt('manual'); await persist(); break;
        case 'PS_DIAG_CLEAR':
          requireSession(message.sessionId);
          if (trial) fail('trial_conflict');
          if (ruleUndo && ruleUndo.pendingApply) fail('rule_application_pending');
          if (session.auto && automatic) {
            const tabId = session.tabId;
            if (ruleUndo && ruleUndo.sessionId === session.id) await clearRuleUndo();
            requireSession(message.sessionId);
            await automatic.clear(tabId, message.sessionId);
            adoptAutomatic(tabId);
            await remove([UI_KEY]);
            await removeAutomaticUi();
            break;
          }
          await clearRuleUndo();
          session = null; rows.clear(); active.clear(); httpErrorRequests.clear(); detach(); await persist(); scheduleAlarm(); break;
        case 'PS_DIAG_ADD_RULES': await addRules(message); break;
        case 'PS_DIAG_UNDO_RULES': await undoRules(message); break;
        case 'PS_DIAG_RETRY_RULES': await retryRules(message); break;
        case 'PS_DIAG_APPLY': {
          requireSession(message.sessionId);
          if (!(await permission())) fail('permission_required');
          if (trial) fail('trial_conflict');
          if (ruleUndo && ruleUndo.pendingApply) fail('rule_application_pending');
          if (message.direction !== 'proxy' && message.direction !== 'direct') fail('invalid_direction');
          if (!Array.isArray(message.hosts) || !message.hosts.length || message.hosts.length > MAX_DOMAINS) fail('invalid_hosts');
          const hosts = [...new Set(message.hosts.map(host => typeof host === 'string' ? routing.hostname(host) : null))];
          if (hosts.some(host => !host || !rows.has(host) || routing.localHost(host))) fail('invalid_hosts');
          await requirePac();
          if (hosts.some(host => routing.conflict(host, prepared, message.direction))) fail('rule_conflict');
          const target = await checkedTab(session.tabId);
          if (target.hostname !== session.hostname) fail('session_conflict');
          requireSession(message.sessionId);
          const candidate = { id: uuid(), sessionId: session.id, tabId: session.tabId, hosts, direction: message.direction, expiresAt: now() + TRIAL_MS };
          await write({ [TRIAL_KEY]: candidate }); trial = candidate;
          scheduleAlarm();
          try {
            await refreshProxy();
            // The user may change mode while storage/PAC APIs are in flight.
            // Do not claim a trial was applied if PAC is no longer selected.
            await requirePac();
          }
          catch (error) {
            try { await discardTrial(); } catch (_) { /* Keep retryable tombstone. */ }
            throw error;
          }
          if (automaticEnabled()) { await automatic.reset(candidate.tabId); adoptAutomatic(candidate.tabId); }
          else await round(candidate.tabId, candidate.sessionId);
          await reload(candidate.tabId);
          break;
        }
        case 'PS_DIAG_UNDO':
          requireTrial(message.trialId);
          await discardTrial(); break;
        case 'PS_DIAG_SAVE': {
          await mutateConfiguration(async () => {
          requireTrial(message.trialId);
          const config = await requirePac();
          if (trial.hosts.some(host => routing.conflict(host, prepared, trial.direction))) fail('rule_conflict');
          const key = trial.direction === 'proxy' ? 'userRules' : 'userWhitelist';
          const rules = [...new Set([...(Array.isArray(config[key]) ? config[key] : []), ...trial.hosts])];
          // Save latest rules and mark the overlay inactive atomically. Retain a
          // retryable tombstone until the installed PAC includes the saved rules.
          const saved = { ...trial, expiresAt: 0, pendingCleanup: true, saved: true };
          await write({ [key]: rules, [TRIAL_KEY]: saved }); trial = saved;
          await refreshProxy();
          await remove([TRIAL_KEY]); trial = null;
          scheduleAlarm();
          });
          break;
        }
        default: fail('invalid_message');
      }
      return { success: true, state: await state(message.tabId, false) };
    }
    // Register synchronously so Chrome can wake the worker for observed events.
    attach();
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (!message || typeof message.type !== 'string' || !message.type.startsWith('PS_DIAG_')) return;
      // Only our extension pages may change global routing through diagnostics.
      if (sender.id && sender.id !== chrome.runtime.id) { respond({ success: false, error: 'invalid_sender' }); return; }
      serialize(async () => {
        try { await ready; return await mutate(message); }
        catch (error) {
          report(error);
          let current;
          try { current = await state(message.tabId, false); } catch (_) {}
          return { success: false, error: error.code || 'internal_error', ...(current ? { state: current } : {}) };
        }
      }).then(respond, () => respond({ success: false, error: 'internal_error' }));
      return true;
    });
    chrome.tabs.onRemoved.addListener(tabId => serialize(async () => {
      await ready;
      if (session && !session.auto && session.tabId === tabId) { halt('closed'); await persist(); }
    }).catch(report));
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (!change.url) return;
      serialize(async () => {
        await ready;
        if (session && !session.auto && session.tabId === tabId && hostOf(change.url) !== session.hostname) { halt('navigation'); await persist(); }
      }).catch(report);
    });
    if (chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(() => serialize(async () => { await ready; await permission(); }).catch(report));
    if (chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(() => serialize(async () => {
      await ready;
      if (!(await permission()) && session) { halt('permission_revoked'); await persist(); }
    }).catch(report));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && (Object.prototype.hasOwnProperty.call(changes, AUTO_UI_KEY) ||
          Object.prototype.hasOwnProperty.call(changes, 'diagnosticAutoRecords'))) {
        serialize(async () => { await ready; await validateAutomaticUi(); }).catch(report);
        return;
      }
      if (area !== 'local') return;
      const uiWritten = Object.prototype.hasOwnProperty.call(changes, UI_KEY) && changes[UI_KEY].newValue !== undefined;
      const configChanged = CONFIG_KEYS.some(key => Object.prototype.hasOwnProperty.call(changes, key));
      const removedRecords = [SESSION_KEY, TRIAL_KEY, RULE_UNDO_KEY].filter(key =>
        Object.prototype.hasOwnProperty.call(changes, key) && changes[key].newValue === undefined);
      if (!uiWritten && !configChanged && !removedRecords.length) return;
      serialize(async () => {
        await ready;
        if (removedRecords.length) {
          // A reset must not resurrect cleared diagnostics from memory. Read
          // current storage so a delayed removal cannot erase a newer capture.
          const current = await read(removedRecords);
          if (removedRecords.includes(SESSION_KEY) && current[SESSION_KEY] === undefined) {
            session = null; rows.clear(); active.clear(); httpErrorRequests.clear(); detach();
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          }
          if (removedRecords.includes(TRIAL_KEY) && current[TRIAL_KEY] === undefined) trial = null;
          if (removedRecords.includes(RULE_UNDO_KEY) && current[RULE_UNDO_KEY] === undefined) ruleUndo = null;
          scheduleAlarm();
        }
        if (uiWritten) await validateUiState();
        if (!configChanged) return;
        // Ignore the save operation's formal-rule write: it preserves the
        // trial route that was already tested and removes the trial atomically.
        const savingTrial = Object.prototype.hasOwnProperty.call(changes, TRIAL_KEY) &&
          changes[TRIAL_KEY].newValue && changes[TRIAL_KEY].newValue.saved === true;
        const ownRuleChange = Object.prototype.hasOwnProperty.call(changes, RULE_UNDO_KEY) &&
          changes[RULE_UNDO_KEY].newValue && validActionId(changes[RULE_UNDO_KEY].newValue.actionId);
        if (ruleUndo && Object.prototype.hasOwnProperty.call(changes, ruleKey(ruleUndo.direction)) && !ownRuleChange) {
          ruleUndo = { ...ruleUndo, invalidated: true };
          await write({ [RULE_UNDO_KEY]: ruleUndo });
        }
        if (!savingTrial && !ownRuleChange) {
          if (automaticEnabled()) {
            await automatic.invalidate();
            if (session && session.auto) adoptAutomatic(session.tabId);
          } else if (session) { await invalidateResults(); await persist(); }
        }
        if (!trial) return;
        await configuration();
        if (trial.hosts.some(host => routing.conflict(host, prepared, trial.direction))) {
          await discardTrial();
        }
      }).catch(report);
    });
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === ALARM) serialize(async () => { await ready; await cleanup(); }).catch(report);
    });
    if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => serialize(async () => { await ready; await cleanup(true); }).catch(report));
    const ready = (async () => {
      if (automatic) { try { await automatic.ready; } catch (_) { /* Recorder reports its own bounded initialization fault. */ } }
      const data = await read([SESSION_KEY, TRIAL_KEY, RULE_UNDO_KEY]);
      const saved = data[SESSION_KEY];
      if (saved && saved.session && Array.isArray(saved.rows) && typeof saved.session.id === 'string' &&
        Number.isInteger(saved.session.tabId) && saved.session.tabId >= 0 &&
        typeof saved.session.hostname === 'string' && routing.hostname(saved.session.hostname) === saved.session.hostname &&
        Number.isFinite(saved.session.startedAt) && Number.isFinite(saved.session.captureUntil) &&
        saved.session.startedAt <= now() && saved.session.captureUntil <= saved.session.startedAt + CAPTURE_MS) {
        // Copy only the schema we own; do not propagate unknown imported fields.
        session = {
          id: saved.session.id, tabId: saved.session.tabId, hostname: saved.session.hostname,
          startedAt: saved.session.startedAt, captureUntil: Math.max(0, saved.session.captureUntil),
          updatedAt: Number.isFinite(saved.session.updatedAt) ? saved.session.updatedAt : saved.session.startedAt,
          dropped: Number(saved.session.dropped) || 0,
          ...(saved.session.closed === true ? { closed: true } : {}),
          ...(saved.session.rulesChanged === true ? { rulesChanged: true } : {}),
          ...(['manual', 'navigation', 'closed', 'expired', 'permission_revoked', 'reload_failed', 'rules_changed'].includes(saved.session.stopReason) ? { stopReason: saved.session.stopReason } : {}),
        };
        for (const row of saved.rows.slice(0, MAX_DOMAINS)) {
          if (row && routing.hostname(row.host) === row.host) rows.set(row.host, {
            host: row.host, count: Number(row.count) || 0, completed: Number(row.completed) || 0,
            failed: Number(row.failed) || 0,
            httpErrors: Number.isInteger(row.httpErrors) && row.httpErrors >= 0 ? row.httpErrors : (row.lastStatus >= 400 ? 1 : 0),
            pending: Number(row.pending) || 0,
            types: Array.isArray(row.types) ? row.types.filter(type => /^[a-z_]{1,30}$/.test(type)).slice(0, 20) : [],
            lastStatus: typeof row.lastStatus === 'number' ? row.lastStatus : null,
            error: /^net::ERR_[A-Z0-9_]+$/.test(row.error || '') ? row.error : null,
          });
        }
      }
      if (!session) await remove([SESSION_KEY, 'diagnosticUiState']);
      const savedTrial = data[TRIAL_KEY];
      trial = savedTrial && typeof savedTrial.id === 'string' && typeof savedTrial.sessionId === 'string' &&
        Number.isInteger(savedTrial.tabId) && Number.isFinite(savedTrial.expiresAt) && savedTrial.expiresAt <= now() + TRIAL_MS &&
        (savedTrial.direction === 'proxy' || savedTrial.direction === 'direct') &&
        Array.isArray(savedTrial.hosts) && savedTrial.hosts.length > 0 && savedTrial.hosts.length <= MAX_DOMAINS &&
        savedTrial.hosts.every(host => typeof host === 'string' && routing.hostname(host) === host) ? {
          id: savedTrial.id, sessionId: savedTrial.sessionId, tabId: savedTrial.tabId,
          hosts: savedTrial.hosts, direction: savedTrial.direction, expiresAt: savedTrial.expiresAt,
          ...(savedTrial.pendingCleanup === true ? { pendingCleanup: true } : {}),
          ...(savedTrial.saved === true ? { saved: true } : {}),
        } : null;
      if (savedTrial && !trial) { await remove([TRIAL_KEY]); await refreshProxy(); }
      const savedUndo = data[RULE_UNDO_KEY];
      if (savedUndo && validActionId(savedUndo.id) && validActionId(savedUndo.actionId) &&
          ((session && savedUndo.sessionId === session.id && savedUndo.tabId === session.tabId) ||
           (savedUndo.context === 'auto' && validActionId(savedUndo.sessionId) && Number.isInteger(savedUndo.tabId) && savedUndo.tabId >= 0)) &&
          ['proxy', 'direct'].includes(savedUndo.direction) && Number.isFinite(savedUndo.expiresAt) &&
          savedUndo.expiresAt > now() && savedUndo.expiresAt <= now() + RULE_UNDO_MS &&
          /^[a-f0-9]{64}$/.test(savedUndo.afterDigest || '') &&
          Array.isArray(savedUndo.hosts) && savedUndo.hosts.length <= MAX_DOMAINS &&
          new Set(savedUndo.hosts).size === savedUndo.hosts.length &&
          savedUndo.hosts.every(host => typeof host === 'string' && routing.hostname(host) === host && !routing.localHost(host)) &&
          Array.isArray(savedUndo.requestedHosts) && savedUndo.requestedHosts.length > 0 && savedUndo.requestedHosts.length <= MAX_DOMAINS &&
          new Set(savedUndo.requestedHosts).size === savedUndo.requestedHosts.length &&
          savedUndo.requestedHosts.every(host => typeof host === 'string' && routing.hostname(host) === host && !routing.localHost(host)) &&
          savedUndo.hosts.every(host => savedUndo.requestedHosts.includes(host)) &&
          typeof savedUndo.pendingApply === 'boolean' && typeof savedUndo.undone === 'boolean') {
        ruleUndo = {
          id: savedUndo.id, actionId: savedUndo.actionId, sessionId: savedUndo.sessionId, tabId: savedUndo.tabId,
          direction: savedUndo.direction, hosts: [...savedUndo.hosts], requestedHosts: [...savedUndo.requestedHosts],
          afterDigest: savedUndo.afterDigest, expiresAt: savedUndo.expiresAt,
          pendingApply: savedUndo.pendingApply, undone: savedUndo.undone,
          ...(savedUndo.context === 'auto' ? { context: 'auto' } : {}),
          ...(savedUndo.invalidated === true ? { invalidated: true } : {}),
        };
        if (JSON.stringify(savedUndo) !== JSON.stringify(ruleUndo)) await write({ [RULE_UNDO_KEY]: ruleUndo });
      } else if (savedUndo) await remove([RULE_UNDO_KEY]);
      await permission();
      await cleanup();
      await validateUiState();
      await validateAutomaticUi();
      if (session) {
        try {
          const target = await checkedTab(session.tabId);
          if (target.hostname !== session.hostname) halt('navigation');
        } catch (_) { halt('closed'); }
        if (!granted) halt('permission_revoked');
      }
      hydrated = true;
      for (const [kind, details] of earlyEvents.splice(0)) onRequest(kind, details);
      if (granted && session && session.captureUntil > now()) attach(session.tabId);
      else detach();
      scheduleAlarm();
    })();
    ready.catch(report);
    return {
      ready,
      handle: (message) => serialize(async () => { await ready; return mutate(message); }),
      beginReset() {
        // This synchronous fence also cancels a first opt-in whose preference
        // write has not completed; local.clear alone emits no absent-key event.
        resetPending = true;
        const stopping = automatic ? automatic.beginReset() : Promise.resolve();
        if (session && !session.auto) halt('manual');
        if (session && session.auto) { session = null; rows.clear(); active.clear(); httpErrorRequests.clear(); }
        return stopping.then(removeAutomaticUi);
      },
      endReset(success) { if (!success) resetPending = false; },
    };
  }
  root.ProxySwitchDiagnostics = { create };
})(typeof self !== 'undefined' ? self : globalThis);
