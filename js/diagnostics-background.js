// Optional, bounded request diagnostics. Never stores URLs, headers or bodies.
(function (root) {
  'use strict';
  const SESSION_KEY = 'diagnosticSession';
  const TRIAL_KEY = 'diagnosticTrial';
  const UI_KEY = 'diagnosticUiState';
  const CONFIG_KEYS = ['userRules', 'userWhitelist', 'gfwDomains', 'tempRules', 'serverList', 'activeServerId'];
  const ALARM = 'proxyswitch-diagnostics';
  const CAPTURE_MS = 60000;
  const RETENTION_MS = 30 * 60000;
  const TRIAL_MS = 10 * 60000;
  const MAX_DOMAINS = 200;
  const MAX_REQUESTS = 1000;
  function create({ chrome, routing, refresh, now = Date.now, uuid = () => crypto.randomUUID() }) {
    let session = null;
    let trial = null;
    let rows = new Map();
    const active = new Map();
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
    const serialize = (fn) => {
      const result = mutation.then(fn);
      mutation = result.catch(() => {});
      return result;
    };
    function report(error) {
      // Codes only: do not feed request URLs or hostnames to the fault journal.
      if (typeof PSL !== 'undefined') PSL.warn('diagnostics', 'Operation failed', error.code || 'internal_error');
    }
    function persist() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!session) return remove([SESSION_KEY, 'diagnosticUiState']);
      return write({ [SESSION_KEY]: { session: { ...session }, rows: Array.from(rows.values(), row => ({ ...row, types: [...row.types] })) } });
    }
    function schedulePersist() {
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
      const deadline = session && session.startedAt + RETENTION_MS;
      if (!value || !session || value.sessionId !== session.id || deadline <= now() ||
          !Number.isFinite(value.expiresAt) || value.expiresAt <= now()) {
        await remove([UI_KEY]);
        return;
      }
      const safe = {
        sessionId: session.id,
        filter: ['different', 'failed', 'all'].includes(value.filter) ? value.filter : 'different',
        direction: value.direction === 'direct' ? 'direct' : 'proxy',
        selected: [...new Set((Array.isArray(value.selected) ? value.selected : [])
          .filter(host => typeof host === 'string' && routing.hostname(host) === host && rows.has(host)))].slice(0, MAX_DOMAINS),
        expiresAt: Math.min(value.expiresAt, deadline),
      };
      if (JSON.stringify(value) !== JSON.stringify(safe)) await write({ [UI_KEY]: safe });
    }
    function scheduleAlarm() {
      const deadlines = [];
      if (session) {
        deadlines.push(session.startedAt + RETENTION_MS);
        if (session.captureUntil) deadlines.push(session.captureUntil);
      }
      if (trial) deadlines.push(trial.expiresAt > now() ? trial.expiresAt : now() + 60000);
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
      detach();
      scheduleAlarm();
    }
    function invalidateResults() {
      if (!session) return;
      halt('rules_changed');
      session.rulesChanged = true;
    }
    function hostOf(url) {
      try { const parsed = new URL(url); return /^(https?:)$/.test(parsed.protocol) ? routing.hostname(parsed.hostname) : null; }
      catch (_) { return null; }
    }
    function observing(details) {
      if (!granted || !session || details.tabId !== session.tabId || !session.captureUntil) return false;
      if (now() >= session.captureUntil) { halt('expired'); schedulePersist(); return false; }
      return true;
    }
    function onRequest(kind, details) {
      if (details.incognito) return;
      if (hydrated && !observing(details)) return;
      // Sanitize even the small pre-hydration queue; it must not retain raw URLs
      // (including paths/query strings) while the optional storage read resolves.
      const host = details.host || hostOf(details.url);
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
          rows.set(host, { host, count: 0, completed: 0, failed: 0, pending: 0, types: [], lastStatus: null, error: null });
        }
        const oldHost = active.get(details.requestId);
        if (oldHost && rows.has(oldHost)) rows.get(oldHost).pending = Math.max(0, rows.get(oldHost).pending - 1);
        const row = rows.get(host);
        row.count++;
        row.pending++;
        if (details.type && !row.types.includes(details.type) && row.types.length < 20) row.types.push(details.type);
        active.set(details.requestId, host);
      } else {
        const trackedHost = active.get(details.requestId);
        if (!trackedHost || !rows.has(trackedHost)) return;
        const row = rows.get(trackedHost);
        if (typeof details.statusCode === 'number') row.lastStatus = details.statusCode;
        if (kind === 'done' || kind === 'error' || kind === 'redirect') {
          row.pending = Math.max(0, row.pending - 1);
          active.delete(details.requestId);
          if (kind === 'error') {
            row.failed++;
            // Chrome network error codes only, never arbitrary error text containing URLs.
            row.error = /^net::ERR_[A-Z0-9_]+$/.test(details.error || '') ? details.error : 'request_failed';
          } else { row.completed++; }
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
        const filter = { urls: ['http://*/*', 'https://*/*'] };
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
      else if (hydrated && session && session.captureUntil > now()) attach(session.tabId);
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
      if (!trial.saved) { invalidateResults(); await persist(); }
      await refreshProxy();
      await remove([TRIAL_KEY]); trial = null;
      scheduleAlarm();
    }
    async function cleanup(startup = false) {
      let changed = false;
      if (session && (startup || session.startedAt + RETENTION_MS <= now())) {
        session = null; rows.clear(); active.clear(); detach(); await persist();
      } else if (session && session.captureUntil && session.captureUntil <= now()) {
        halt('expired'); changed = true;
      }
      if (trial && (startup || !routing.activeTrial(trial, now()))) {
        await discardTrial(); changed = true;
      }
      if (changed) await persist();
      scheduleAlarm();
    }
    async function state(tabId, allowCleanup = true) {
      if (allowCleanup) await cleanup();
      const [config, settings, hasPermission] = await Promise.all([configuration(), proxy(), permission()]);
      let mode = settings && settings.value ? settings.value.mode : 'direct';
      if (mode === 'pac_script' && settings.levelOfControl !== 'controlled_by_this_extension') mode = 'unknown';
      const route = host => routing.evaluate(host, prepared, { mode, trial, now: now() });
      let mainHost = session && session.hostname;
      if (!mainHost && Number.isInteger(tabId)) {
        try { mainHost = (await checkedTab(tabId)).hostname; } catch (_) { /* Empty view for restricted tabs. */ }
      }
      return {
        session: session ? { ...session } : null,
        trial: trial ? { ...trial, hosts: [...trial.hosts] } : null,
        mode,
        permission: hasPermission,
        rows: Array.from(rows.values(), row => ({
          ...row, types: [...row.types], ...route(row.host),
          stale: !!(session && session.rulesChanged),
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
      session = { id: id || uuid(), tabId, hostname, startedAt: stamp, captureUntil: stamp + CAPTURE_MS, updatedAt: stamp, dropped: 0 };
      rows.clear(); active.clear();
      await remove(['diagnosticUiState']);
      await persist();
      attach(tabId);
      scheduleAlarm();
    }
    async function reload(tabId) {
      try { await call(chrome.tabs, 'reload', [tabId, { bypassCache: true }], 'reload_failed'); }
      catch (error) { halt('reload_failed'); await persist(); throw error; }
    }
    function requireSession(id) { if (!session || session.id !== id) fail('session_not_found'); }
    function requireTrial(id) { if (!trial || trial.id !== id) fail('trial_not_found'); }
    async function requirePac() {
      const settings = await proxy();
      if (!settings || !settings.value || settings.value.mode !== 'pac_script') fail('mode_required');
      if (settings.levelOfControl !== 'controlled_by_this_extension') fail('proxy_uncontrolled');
      const config = await configuration();
      if (!(config.serverList || []).length) fail('no_server');
      return config;
    }
    async function mutate(message) {
      await cleanup();
      switch (message.type) {
        case 'PS_DIAG_GET': break;
        case 'PS_DIAG_START': {
          if (!(await permission())) fail('permission_required');
          await checkedTab(message.tabId);
          if (trial) fail('trial_conflict');
          if (session && session.tabId !== message.tabId && !message.replace) fail('session_conflict');
          await round(message.tabId);
          await reload(message.tabId);
          break;
        }
        case 'PS_DIAG_STOP':
          requireSession(message.sessionId); halt('manual'); await persist(); break;
        case 'PS_DIAG_CLEAR':
          requireSession(message.sessionId);
          if (trial) fail('trial_conflict');
          session = null; rows.clear(); active.clear(); detach(); await persist(); scheduleAlarm(); break;
        case 'PS_DIAG_APPLY': {
          requireSession(message.sessionId);
          if (!(await permission())) fail('permission_required');
          if (trial) fail('trial_conflict');
          if (message.direction !== 'proxy' && message.direction !== 'direct') fail('invalid_direction');
          if (!Array.isArray(message.hosts) || !message.hosts.length || message.hosts.length > MAX_DOMAINS) fail('invalid_hosts');
          const hosts = [...new Set(message.hosts.map(host => typeof host === 'string' ? routing.hostname(host) : null))];
          if (hosts.some(host => !host || !rows.has(host) || routing.localHost(host))) fail('invalid_hosts');
          await requirePac();
          if (hosts.some(host => routing.conflict(host, prepared, message.direction))) fail('rule_conflict');
          const target = await checkedTab(session.tabId);
          if (target.hostname !== session.hostname) fail('session_conflict');
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
          await round(candidate.tabId, candidate.sessionId);
          await reload(candidate.tabId);
          break;
        }
        case 'PS_DIAG_UNDO':
          requireTrial(message.trialId);
          await discardTrial(); break;
        case 'PS_DIAG_SAVE': {
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
      if (session && session.tabId === tabId) { halt('closed'); await persist(); }
    }).catch(report));
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (!change.url) return;
      serialize(async () => {
        await ready;
        if (session && session.tabId === tabId && hostOf(change.url) !== session.hostname) { halt('navigation'); await persist(); }
      }).catch(report);
    });
    if (chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(() => serialize(async () => { await ready; await permission(); }).catch(report));
    if (chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(() => serialize(async () => {
      await ready;
      if (!(await permission()) && session) { halt('permission_revoked'); await persist(); }
    }).catch(report));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const uiWritten = Object.prototype.hasOwnProperty.call(changes, UI_KEY) && changes[UI_KEY].newValue !== undefined;
      const configChanged = CONFIG_KEYS.some(key => Object.prototype.hasOwnProperty.call(changes, key));
      if (!uiWritten && !configChanged) return;
      serialize(async () => {
        await ready;
        if (uiWritten) await validateUiState();
        if (!configChanged) return;
        // Ignore the save operation's formal-rule write: it preserves the
        // trial route that was already tested and removes the trial atomically.
        const savingTrial = Object.prototype.hasOwnProperty.call(changes, TRIAL_KEY) &&
          changes[TRIAL_KEY].newValue && changes[TRIAL_KEY].newValue.saved === true;
        if (!savingTrial && session) { invalidateResults(); await persist(); }
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
      const data = await read([SESSION_KEY, TRIAL_KEY]);
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
            failed: Number(row.failed) || 0, pending: Number(row.pending) || 0,
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
      await permission();
      await cleanup();
      await validateUiState();
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
    return { ready, handle: (message) => serialize(async () => { await ready; return mutate(message); }) };
  }
  root.ProxySwitchDiagnostics = { create };
})(typeof self !== 'undefined' ? self : globalThis);
