// Automatic, consent-gated domain summaries. Request URLs never enter the cache.
(function (root) {
  'use strict';
  const PREFERENCE = 'diagnosticAutoCapture';
  const RECORDS = 'diagnosticAutoRecords';
  // A session-only kill switch protects a stopped recorder when a local write
  // fails or a worker exits before its preference update completes.
  const STOPPED = 'diagnosticAutoCaptureStopped';
  const ALARM = 'proxyswitch-request-recorder';
  const RETENTION_MS = 30 * 60000;
  const PENDING_MS = 2 * 60000;
  const MAX_TABS = 20;
  const MAX_DOMAINS = 200;
  const MAX_GLOBAL_DOMAINS = 2000;
  const MAX_REQUESTS = 1000;
  const MAX_EARLY = 1000;
  const MAX_DOCUMENTS = 128;
  const MAX_FRAMES = 128;
  const MAX_BYTES = 680 * 1024;
  const EVENTS = [['onBeforeRequest', 'start'], ['onHeadersReceived', 'headers'],
    ['onCompleted', 'done'], ['onErrorOccurred', 'error'], ['onBeforeRedirect', 'redirect']];
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const counter = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1000000000) : 0;
  const opaque = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
  const typeOf = value => typeof value === 'string' && /^[a-z_]{1,30}$/.test(value) ? value : 'other';
  const errorOf = value => typeof value === 'string' && /^net::ERR_[A-Z0-9_]{1,80}$/.test(value) ? value : 'request_failed';
  const canceled = value => /^net::ERR_(?:ABORTED|CANCELLED|CANCELED)$/.test(value);

  function create({ chrome, routing, now = Date.now, uuid = () => crypto.randomUUID() }) {
    const contexts = new Map();
    const tabs = new Map();
    const active = new Map();
    const checking = new Set();
    const early = [];
    const listeners = new Map();
    let enabled = false;
    let granted = false;
    let hydrated = false;
    let recovering = true;
    let storage = chrome.storage && chrome.storage.session ? 'session' : 'memory';
    let preferenceRevision = 0;
    let flushTimer = null;
    let queue = Promise.resolve();
    let startupSeen = false;
    let ready;
    let initializationError = null;

    const safeError = code => Object.assign(new Error(code), { code });
    const fail = code => { throw safeError(code); };
    function call(object, method, args, code) {
      return new Promise((resolve, reject) => {
        let finished = false;
        let timer;
        const finish = (error, value) => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          error ? reject(safeError(code)) : resolve(value);
        };
        if (['get', 'query', 'contains'].includes(method)) timer = setTimeout(() => finish(true), 8000);
        try {
          if (!object || typeof object[method] !== 'function') { finish(true); return; }
          object[method](...args, value => finish(chrome.runtime && chrome.runtime.lastError, value));
        } catch (_) { finish(true); }
      });
    }
    function serialize(fn) {
      const result = queue.then(fn);
      queue = result.catch(() => {});
      return result;
    }
    // Reporting deliberately carries a fixed code, never a hostname or an API message.
    function report(error) {
      if (typeof PSL !== 'undefined') PSL.warn('request-recorder', 'Operation failed', error && error.code || 'internal_error');
    }
    function hostOf(value, request = false) {
      try {
        const parsed = new URL(value);
        if (!(request ? /^(?:https?|wss?):$/ : /^https?:$/).test(parsed.protocol)) return null;
        return routing.hostname(parsed.hostname);
      } catch (_) { return null; }
    }
    function safeTab(tab) {
      if (!tab || !Number.isInteger(tab.id) || tab.id < 0) return null;
      return { id: tab.id, hostname: tab.incognito ? null : hostOf(tab.url), incognito: !!tab.incognito };
    }
    function rememberTab(tab) {
      tabs.delete(tab.id);
      tabs.set(tab.id, tab);
      if (tabs.size > MAX_TABS) tabs.delete(tabs.keys().next().value);
    }
    async function loadTabs(preferred = []) {
      const values = await call(chrome.tabs, 'query', [{}], 'tab_closed');
      const selected = new Set(preferred.slice(-MAX_TABS));
      for (const value of values || []) {
        const tab = safeTab(value);
        if (tab && !selected.has(tab.id)) rememberTab(tab);
      }
      // Restorable contexts take priority over unobserved source metadata.
      for (const value of values || []) {
        const tab = safeTab(value);
        if (tab && selected.has(tab.id)) rememberTab(tab);
      }
    }
    function sanitize(kind, details) {
      if (!details || details.incognito || !Number.isInteger(details.tabId) || details.tabId < 0) return null;
      const host = hostOf(details.url, true);
      const requestId = opaque(details.requestId);
      if (!host || !requestId) return null;
      return {
        kind, host, tabId: details.tabId, requestId, type: typeOf(details.type),
        documentId: opaque(details.documentId), parentDocumentId: opaque(details.parentDocumentId),
        frameId: Number.isInteger(details.frameId) ? details.frameId : null,
        parentFrameId: Number.isInteger(details.parentFrameId) ? details.parentFrameId : null,
        statusCode: Number.isInteger(details.statusCode) && details.statusCode >= 100 && details.statusCode <= 599 ? details.statusCode : null,
        error: kind === 'error' ? errorOf(details.error) : null,
        sourceHost: hostOf(details.documentUrl) || hostOf(details.initiator),
        observedAt: now(),
      };
    }
    function requestKey(details) { return details.tabId + ':' + details.requestId; }
    function clone(ctx) {
      return ctx ? { session: { ...ctx.session }, rows: Array.from(ctx.rows.values(), row => ({ ...row, types: [...row.types] })) } : null;
    }
    function status() {
      return { enabled, permission: granted, storage, ...(recovering ? { recovering: true } : {}),
        ...(initializationError ? { error: initializationError.code || 'internal_error' } : {}) };
    }
    function snapshot(tabId) {
      expire(now());
      return clone(contexts.get(tabId));
    }
    function find(sessionId) {
      expire(now());
      for (const ctx of contexts.values()) if (ctx.session.id === sessionId) return clone(ctx);
      return null;
    }
    function touch(ctx, stamp = now()) {
      ctx.session.updatedAt = stamp;
      contexts.delete(ctx.session.tabId);
      contexts.set(ctx.session.tabId, ctx);
    }
    function abandon(item) {
      const ctx = contexts.get(item.tabId);
      if (!ctx || ctx.session.id !== item.epoch) return;
      const row = ctx.rows.get(item.host);
      if (row) { row.pending = Math.max(0, row.pending - 1); row.unconfirmed++; }
    }
    function forgetRequests(tabId, host, markUnknown = false) {
      for (const [key, item] of active) {
        if (item.tabId !== tabId || host && item.host !== host) continue;
        if (markUnknown) abandon(item);
        active.delete(key);
      }
    }
    function drop(tabId) { forgetRequests(tabId); contexts.delete(tabId); }
    function dropAll() {
      contexts.clear(); active.clear(); tabs.clear(); early.length = 0; checking.clear();
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      scheduleAlarm();
    }
    function newContext(tabId, hostname, details = {}) {
      const previous = contexts.get(tabId);
      const previousId = previous && previous.session.id;
      const previousDocument = previous && previous.documentId;
      drop(tabId);
      if (contexts.size >= MAX_TABS) drop(contexts.keys().next().value);
      const stamp = now();
      let id = opaque(uuid());
      for (let attempt = 0; attempt < 3 && (!id || id === previousId || Array.from(contexts.values()).some(ctx => ctx.session.id === id)); attempt++) id = opaque(uuid());
      if (!id || id === previousId || Array.from(contexts.values()).some(ctx => ctx.session.id === id)) id = 'auto-' + stamp + '-' + tabId + '-' + preferenceRevision;
      const ctx = {
        session: { id, tabId, hostname, startedAt: stamp, updatedAt: stamp, auto: true, captureUntil: 0, dropped: 0 },
        // A main-frame navigation may still name its departing document.
        // The first request from frame 0 establishes the new document identity.
        rows: new Map(), documentId: details.awaitingMain ? previousDocument || null : details.type === 'main_frame' ? null : details.documentId || null,
        retiredDocumentId: details.type === 'main_frame' ? previousDocument || null : null,
        mainRequestId: details.requestId || null,
        awaitingMain: !!details.awaitingMain,
        awaitingTabUpdate: !!details.requestId,
        documents: details.awaitingMain && previous ? new Map(previous.documents) : new Map(),
        frames: details.awaitingMain && previous ? new Map(previous.frames) : new Map(),
        retiredDocuments: new Set(previous ? previous.retiredDocuments : []),
        fenced: details.type === 'main_frame' || !!(previous && previous.fenced),
      };
      if (details.type === 'main_frame' && previous) retireDocuments(ctx, previous);
      contexts.set(tabId, ctx);
      return ctx;
    }
    function boundedRemember(map, key, value, limit) {
      map.delete(key); map.set(key, value);
      if (map.size > limit) map.delete(map.keys().next().value);
    }
    function retireDocuments(ctx, previous = ctx) {
      const identities = [previous.documentId, ...previous.documents.keys()];
      for (const identity of identities) if (identity) {
        ctx.retiredDocuments.delete(identity); ctx.retiredDocuments.add(identity);
        if (ctx.retiredDocuments.size > MAX_DOCUMENTS) ctx.retiredDocuments.delete(ctx.retiredDocuments.values().next().value);
      }
      ctx.documents.clear(); ctx.frames.clear(); ctx.fenced = true;
    }
    function belongs(ctx, documentId) {
      const seen = new Set();
      for (let identity = documentId; identity && !seen.has(identity) && seen.size <= MAX_DOCUMENTS;) {
        if (identity === ctx.documentId) return true;
        if (ctx.retiredDocuments.has(identity)) return false;
        seen.add(identity); identity = ctx.documents.get(identity);
      }
      return false;
    }
    function frameBelongs(ctx, frameId) {
      const seen = new Set();
      for (let frame = frameId; Number.isInteger(frame) && frame >= 0 && !seen.has(frame) && seen.size <= MAX_FRAMES;) {
        if (frame === 0) return true;
        const item = ctx.frames.get(frame);
        if (!item || item.documentId && !belongs(ctx, item.documentId)) return false;
        seen.add(frame); frame = item.parentFrameId;
      }
      return false;
    }
    function acceptDocument(ctx, details) {
      const topDocument = details.frameId === 0 ? details.documentId : details.parentFrameId === 0 ? details.parentDocumentId : null;
      if (topDocument && (ctx.documentId && topDocument !== ctx.documentId ||
          topDocument === ctx.retiredDocumentId || ctx.retiredDocuments.has(topDocument))) return false;
      // A sub-frame navigation may name its departing document just like a
      // main-frame navigation. Its parent, not that old identity, authorizes it.
      if (details.type !== 'sub_frame' && details.documentId && ctx.retiredDocuments.has(details.documentId)) return false;
      if (details.parentDocumentId && ctx.retiredDocuments.has(details.parentDocumentId)) return false;
      if (topDocument && !ctx.documentId) ctx.documentId = topDocument;
      if (ctx.fenced && details.frameId > 0 && details.parentFrameId === 0 &&
          !details.parentDocumentId && details.documentId && !belongs(ctx, details.documentId)) return false;
      const nested = details.frameId > 0 && details.parentFrameId !== 0;
      if (nested && ctx.fenced) {
        // Never attach an unverified descendant of an old iframe to a new page.
        // Older Chromium without document IDs uses bounded, current-epoch frame
        // ancestry instead; unseen parents are deliberately omitted.
        const hasDocumentIdentity = !!(details.parentDocumentId || details.documentId);
        const verified = hasDocumentIdentity ? belongs(ctx, details.parentDocumentId || details.documentId) :
          frameBelongs(ctx, details.parentFrameId);
        if (!verified) return false;
      }
      if (details.documentId && details.frameId > 0 && details.type !== 'sub_frame') {
        boundedRemember(ctx.documents, details.documentId, details.parentDocumentId || null, MAX_DOCUMENTS);
      }
      if (Number.isInteger(details.frameId) && details.frameId >= 0) {
        boundedRemember(ctx.frames, details.frameId, {
          documentId: details.type === 'sub_frame' ? null : details.documentId,
          parentFrameId: details.parentFrameId,
        }, MAX_FRAMES);
      }
      return true;
    }
    function domainCount() { let count = 0; for (const ctx of contexts.values()) count += ctx.rows.size; return count; }
    function emptyRow(host) {
      return { host, count: 0, completed: 0, failed: 0, httpErrors: 0, pending: 0, unconfirmed: 0, types: [], lastStatus: null, error: null, stale: false };
    }
    function expire(stamp) {
      let changed = false;
      for (const [tabId, ctx] of contexts) {
        if (ctx.session.updatedAt + RETENTION_MS <= stamp) { drop(tabId); changed = true; }
      }
      for (const [key, item] of active) {
        if (item.startedAt + PENDING_MS <= stamp) { abandon(item); active.delete(key); changed = true; }
      }
      if (changed) { schedulePersist(); scheduleAlarm(); }
      return changed;
    }
    function scheduleAlarm() {
      if (!chrome.alarms) return;
      const deadlines = [];
      for (const ctx of contexts.values()) deadlines.push(ctx.session.updatedAt + RETENTION_MS);
      for (const item of active.values()) deadlines.push(item.startedAt + PENDING_MS);
      try {
        if (!enabled || !deadlines.length) chrome.alarms.clear(ALARM, () => {});
        else chrome.alarms.create(ALARM, { when: Math.max(now() + 1000, Math.min(...deadlines)) });
      } catch (_) { /* Events also enforce retention when alarms are unavailable. */ }
    }
    function payload() {
      return { version: 1, records: Array.from(contexts.values(), ctx => ({
        ...clone(ctx), documentId: ctx.documentId, mainRequestId: ctx.mainRequestId,
        retiredDocumentId: ctx.retiredDocumentId,
        awaitingMain: ctx.awaitingMain, awaitingTabUpdate: ctx.awaitingTabUpdate,
        documents: Array.from(ctx.documents), frames: Array.from(ctx.frames),
        retiredDocuments: Array.from(ctx.retiredDocuments), fenced: ctx.fenced,
      })) };
    }
    function boundStorage() {
      let data = payload();
      // All allowed fields are ASCII. The JSON length is its UTF-8 byte size.
      while (JSON.stringify(data).length + RECORDS.length > MAX_BYTES && contexts.size) {
        drop(contexts.keys().next().value);
        data = payload();
      }
      return data;
    }
    async function persist() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      const data = boundStorage();
      if (storage !== 'session') {
        if ((!enabled || !contexts.size) && chrome.storage.session) {
          try { await call(chrome.storage.session, 'remove', [[RECORDS]], 'storage_failed'); } catch (_) {}
        }
        return;
      }
      try {
        if (!enabled || !contexts.size) await call(chrome.storage.session, 'remove', [[RECORDS]], 'storage_failed');
        else await call(chrome.storage.session, 'set', [{ [RECORDS]: data }], 'storage_failed');
      } catch (_) {
        storage = 'memory';
        report(safeError('storage_failed'));
        // Best effort removal avoids leaving an obsolete cache after a quota error.
        try { await call(chrome.storage.session, 'remove', [[RECORDS]], 'storage_failed'); } catch (_) {}
      }
      scheduleAlarm();
    }
    function schedulePersist() {
      if (!hydrated || flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        serialize(persist).catch(report);
      }, 250);
    }
    function attach() {
      if (!chrome.webRequest) return;
      for (const [name, kind] of EVENTS) {
        if (listeners.has(name) || !chrome.webRequest[name]) continue;
        const listener = details => receive(kind, details);
        try {
          chrome.webRequest[name].addListener(listener, { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] });
          listeners.set(name, listener);
        } catch (_) { /* A later explicit optional grant will retry registration. */ }
      }
    }
    function enqueue(details) {
      if (early.length < MAX_EARLY) early.push(details);
      else {
        const ctx = contexts.get(details.tabId);
        if (ctx) { ctx.session.dropped++; schedulePersist(); }
      }
    }
    function receive(kind, raw) {
      if (hydrated && (!enabled || !granted)) return;
      const details = sanitize(kind, raw);
      if (!details) return;
      if (!hydrated) { enqueue(details); return; }
      expire(details.observedAt);
      if (!tabs.has(details.tabId) && contexts.has(details.tabId)) rememberTab({
        id: details.tabId, hostname: contexts.get(details.tabId).session.hostname, incognito: false,
      });
      if (tabs.has(details.tabId)) { observe(details); return; }
      enqueue(details);
      checkSource(details.tabId);
    }
    function checkSource(tabId) {
      if (checking.has(tabId)) return;
      checking.add(tabId);
      const revision = preferenceRevision;
      serialize(async () => {
        try {
          const tab = safeTab(await call(chrome.tabs, 'get', [tabId], 'tab_closed'));
          if (tab && enabled && granted && revision === preferenceRevision) rememberTab(tab);
        } catch (_) { /* Closed/restricted source requests are discarded. */ }
        checking.delete(tabId);
        const pending = early.filter(item => item.tabId === tabId);
        for (let i = early.length - 1; i >= 0; i--) if (early[i].tabId === tabId) early.splice(i, 1);
        if (enabled && granted && revision === preferenceRevision) for (const details of pending) dispatch(details);
      }).catch(report);
    }
    function dispatch(details) {
      if (details.kind === 'tab_update') observeUpdate(details);
      else observe(details);
    }
    function observeUpdate(details) {
      if (!enabled || !granted) return;
      const previous = tabs.get(details.tabId);
      const hostname = details.hostname !== undefined ? details.hostname : previous && previous.hostname;
      rememberTab({ id: details.tabId, hostname, incognito: details.incognito });
      if (!hostname || details.incognito) { drop(details.tabId); schedulePersist(); return; }
      let ctx = contexts.get(details.tabId);
      if (details.loading || details.urlChanged) {
        if (ctx && (ctx.awaitingTabUpdate || ctx.awaitingMain)) ctx.session.hostname = hostname;
        else ctx = newContext(details.tabId, hostname, { awaitingMain: true });
        touch(ctx); schedulePersist(); scheduleAlarm();
      }
      if (details.complete && ctx) { ctx.awaitingTabUpdate = false; ctx.awaitingMain = false; schedulePersist(); }
    }
    function observe(details) {
      if (!enabled || !granted) return;
      const tab = tabs.get(details.tabId);
      if (!tab || tab.incognito || !tab.hostname) return;
      if (details.observedAt + RETENTION_MS <= now()) return;
      let ctx = contexts.get(details.tabId);
      if (details.kind === 'start') {
        if (details.type === 'main_frame') {
          // Redirects reuse their main-frame request ID. A paired tabs update
          // adopts this epoch instead of erasing the already observed requests.
          if (!ctx || !ctx.awaitingMain && ctx.mainRequestId !== details.requestId) {
            ctx = newContext(details.tabId, details.host, details);
          } else {
            if (ctx.awaitingMain) {
              retireDocuments(ctx);
              ctx.retiredDocumentId = ctx.documentId;
              ctx.documentId = null;
              forgetRequests(details.tabId);
              ctx.rows.clear();
            }
            ctx.session.hostname = details.host;
            ctx.mainRequestId = details.requestId;
            ctx.awaitingMain = false;
            ctx.awaitingTabUpdate = true;
          }
          tab.hostname = details.host;
        } else {
          if (!ctx) ctx = newContext(details.tabId, tab.hostname);
          if (!acceptDocument(ctx, details)) return;
        }
        const key = requestKey(details);
        const previous = active.get(key);
        if (previous) { abandon(previous); active.delete(key); }
        if (active.size >= MAX_REQUESTS) { ctx.session.dropped++; touch(ctx); schedulePersist(); return; }
        let row = ctx.rows.get(details.host);
        if (row && row.stale) {
          forgetRequests(details.tabId, details.host);
          row = emptyRow(details.host);
          ctx.rows.set(details.host, row);
          if (!Array.from(ctx.rows.values()).some(item => item.stale)) delete ctx.session.rulesChanged;
        }
        if (!row) {
          if (ctx.rows.size >= MAX_DOMAINS || domainCount() >= MAX_GLOBAL_DOMAINS) {
            ctx.session.dropped++; touch(ctx); schedulePersist(); return;
          }
          row = emptyRow(details.host);
          ctx.rows.set(details.host, row);
        }
        row.count++; row.pending++;
        if (!row.types.includes(details.type) && row.types.length < 20) row.types.push(details.type);
        active.set(key, {
          tabId: details.tabId, epoch: ctx.session.id, host: details.host, type: details.type,
          documentId: details.documentId, frameId: details.frameId, startedAt: details.observedAt, httpError: false,
          parentDocumentId: details.parentDocumentId, parentFrameId: details.parentFrameId,
        });
      } else {
        const key = requestKey(details);
        const item = active.get(key);
        if (!ctx || !item || item.epoch !== ctx.session.id || !['main_frame', 'sub_frame'].includes(item.type) && item.documentId && details.documentId && item.documentId !== details.documentId ||
            item.frameId !== null && details.frameId !== null && item.frameId !== details.frameId) return;
        if (item.type === 'sub_frame' && details.kind === 'done' && details.documentId) {
          // onCompleted may supply the committed iframe identity before that
          // document has made any subresource request. Learn it so its own
          // nested iframe loads are attributed without waiting for a script.
          acceptDocument(ctx, { ...details, type: 'other',
            parentDocumentId: details.parentDocumentId || item.parentDocumentId,
            parentFrameId: details.parentFrameId === null ? item.parentFrameId : details.parentFrameId });
        }
        const row = ctx.rows.get(item.host);
        if (!row) return;
        if (details.statusCode !== null) row.lastStatus = details.statusCode;
        if (details.statusCode >= 400 && !item.httpError) { row.httpErrors++; item.httpError = true; }
        // The WebSocket upgrade completes the observable HTTP handshake.
        const upgrade = details.kind === 'headers' && item.type === 'websocket' && details.statusCode === 101;
        if (upgrade || ['done', 'redirect', 'error'].includes(details.kind)) {
          row.pending = Math.max(0, row.pending - 1);
          active.delete(key);
          if (details.kind === 'error') {
            if (canceled(details.error)) row.unconfirmed++;
            else { row.failed++; row.error = details.error; }
          } else row.completed++;
        }
      }
      touch(ctx, Math.max(ctx.session.updatedAt, details.observedAt));
      schedulePersist(); scheduleAlarm();
    }
    async function checkedTab(tabId) {
      if (!Number.isInteger(tabId) || tabId < 0) fail('invalid_tab');
      const tab = safeTab(await call(chrome.tabs, 'get', [tabId], 'tab_closed'));
      if (!tab || tab.incognito || !tab.hostname) fail('restricted_tab');
      rememberTab(tab);
      return tab;
    }
    async function permission() {
      const revision = preferenceRevision;
      try { granted = !!await call(chrome.permissions, 'contains', [{ permissions: ['webRequest'] }], 'permission_required') && revision === preferenceRevision; }
      catch (_) { granted = false; }
      return granted;
    }
    function restore(saved) {
      if (!saved || saved.version !== 1 || !Array.isArray(saved.records)) return;
      for (const record of saved.records.slice(-MAX_TABS)) {
        const value = record && record.session;
        if (!value || !opaque(value.id) || !Number.isInteger(value.tabId) || value.tabId < 0 || !routing.hostname(value.hostname) ||
            routing.hostname(value.hostname) !== value.hostname || !Number.isFinite(value.startedAt) || value.startedAt > now() ||
            !Number.isFinite(value.updatedAt) || value.updatedAt < value.startedAt || value.updatedAt > now() ||
            value.updatedAt + RETENTION_MS <= now() || !Array.isArray(record.rows)) continue;
        const tab = tabs.get(value.tabId);
        if (!tab || tab.incognito || tab.hostname !== value.hostname) continue;
        const ctx = {
          session: { id: value.id, tabId: value.tabId, hostname: value.hostname, startedAt: value.startedAt,
            updatedAt: value.updatedAt, auto: true, captureUntil: 0, dropped: counter(value.dropped),
            ...(value.rulesChanged === true ? { rulesChanged: true } : {}) },
          rows: new Map(), documentId: opaque(record.documentId), retiredDocumentId: opaque(record.retiredDocumentId), mainRequestId: opaque(record.mainRequestId),
          awaitingMain: record.awaitingMain === true, awaitingTabUpdate: record.awaitingTabUpdate === true,
          documents: new Map(), frames: new Map(), retiredDocuments: new Set(), fenced: record.fenced === true,
        };
        for (const identity of (Array.isArray(record.retiredDocuments) ? record.retiredDocuments : []).slice(-MAX_DOCUMENTS)) {
          if (opaque(identity)) ctx.retiredDocuments.add(identity);
        }
        for (const item of (Array.isArray(record.documents) ? record.documents : []).slice(-MAX_DOCUMENTS)) {
          if (Array.isArray(item) && opaque(item[0]) && (item[1] === null || opaque(item[1]))) ctx.documents.set(item[0], item[1]);
        }
        for (const item of (Array.isArray(record.frames) ? record.frames : []).slice(-MAX_FRAMES)) {
          if (Array.isArray(item) && Number.isSafeInteger(item[0]) && item[0] >= 0 && item[1] &&
              (item[1].documentId === null || opaque(item[1].documentId)) &&
              (item[1].parentFrameId === null || Number.isSafeInteger(item[1].parentFrameId) && item[1].parentFrameId >= -1)) {
            ctx.frames.set(item[0], { documentId: item[1].documentId, parentFrameId: item[1].parentFrameId });
          }
        }
        for (const item of record.rows.slice(0, MAX_DOMAINS)) {
          if (!item || typeof item.host !== 'string' || !routing.hostname(item.host) || routing.hostname(item.host) !== item.host ||
              domainCount() + ctx.rows.size >= MAX_GLOBAL_DOMAINS) continue;
          const row = emptyRow(item.host);
          row.count = counter(item.count);
          row.completed = Math.min(row.count, counter(item.completed));
          row.failed = Math.min(row.count - row.completed, counter(item.failed));
          row.httpErrors = Math.min(row.count, counter(item.httpErrors));
          row.unconfirmed = Math.min(row.count - row.completed - row.failed, counter(item.unconfirmed) + counter(item.pending));
          row.types = [...new Set((Array.isArray(item.types) ? item.types : []).filter(value => typeOf(value) === value))].slice(0, 20);
          row.lastStatus = Number.isInteger(item.lastStatus) && item.lastStatus >= 100 && item.lastStatus <= 599 ? item.lastStatus : null;
          row.error = errorOf(item.error) === item.error ? item.error : null;
          row.stale = item.stale === true;
          ctx.rows.set(row.host, row);
        }
        contexts.set(value.tabId, ctx);
      }
      boundStorage();
    }
    function stop() {
      preferenceRevision++;
      enabled = false;
      dropAll();
    }
    async function writePreference(value) {
      await call(chrome.storage.local, 'set', [{ [PREFERENCE]: value }], 'storage_failed');
    }
    async function clearPreference() {
      try { await writePreference(false); }
      catch (_) {
        // Absence is default-off. Removing the old consent is durable even if a
        // quota error prevented replacing it with false.
        await call(chrome.storage.local, 'remove', [[PREFERENCE]], 'storage_failed');
      }
    }
    async function markStopped() {
      if (!chrome.storage.session) return false;
      try {
        await call(chrome.storage.session, 'set', [{ [STOPPED]: true }], 'storage_failed');
        return true;
      } catch (_) { return false; }
    }
    async function removeStopped() {
      if (chrome.storage.session) await call(chrome.storage.session, 'remove', [[STOPPED]], 'storage_failed');
    }
    async function revokeAsLastResort() {
      // The user explicitly asked to stop. With neither a local off preference
      // nor a session kill switch, losing the optional observation grant is the
      // final fail-closed route. The persistence error is still surfaced.
      try {
        await call(chrome.permissions, 'remove', [{ permissions: ['webRequest'] }], 'storage_failed');
        await permission();
      } catch (_) { granted = false; }
    }
    async function persistDisabled(stopped) {
      if (stopped) await stopped;
      // An older enable may have been awaiting an API when stop first wrote
      // its kill switch. Refresh it inside the serialized off transaction;
      // never trust an acknowledgement for a marker since removed elsewhere.
      const marked = await markStopped();
      let error = null;
      try {
        await clearPreference();
        // A leftover kill switch is safe, so a cleanup failure does not undo a
        // confirmed local default-off preference.
        try { await removeStopped(); } catch (_) { report(safeError('storage_failed')); }
      } catch (_) {
        error = safeError('storage_failed');
        if (!marked) await revokeAsLastResort();
      }
      await persist();
      if (error) { initializationError = error; recovering = true; throw error; }
    }
    function enable(options = {}) {
      return serialize(async () => {
        // An explicit consent action may recover a failed preference read.
        try { await ready; } catch (error) { if (!initializationError) throw error; }
        if (options.consent !== true) fail('consent_required');
        const revision = preferenceRevision;
        const guard = async () => {
          if (revision === preferenceRevision) return;
          await persistDisabled();
          fail('recorder_disabled');
        };
        if (!await permission()) fail('permission_required');
        try { await loadTabs(); } catch (error) { report(error); }
        await guard();
        try {
          // Keep any failed-disable kill switch until the new consent write is
          // acknowledged. Only this successful explicit action may clear it.
          await writePreference(true);
          await guard();
          await removeStopped();
          await guard();
        } catch (error) {
          if (revision !== preferenceRevision || !enabled) {
            stop(); await persistDisabled();
          }
          throw error;
        }
        enabled = true;
        initializationError = null; recovering = false; ready = Promise.resolve();
        attach(); scheduleAlarm();
        return status();
      });
    }
    function disable() {
      stop();
      recovering = true;
      // Do not wait behind a pending enable or cache write to stop the next
      // worker instance. This carries only a boolean, never request metadata.
      const stopped = markStopped();
      return serialize(async () => {
        try { await ready; } catch (error) { if (!initializationError) throw error; }
        await persistDisabled(stopped);
        initializationError = null; recovering = false; ready = Promise.resolve();
        return status();
      });
    }
    function beginReset() { return disable(); }
    function clear(tabId, expectedEpoch) {
      return serialize(async () => {
        await ready;
        if (!Number.isInteger(tabId) || tabId < 0) fail('invalid_tab');
        const ctx = contexts.get(tabId);
        if (expectedEpoch !== undefined && (!ctx || ctx.session.id !== expectedEpoch)) fail('session_not_found');
        if (ctx) { forgetRequests(tabId); ctx.rows.clear(); ctx.session.dropped = 0; delete ctx.session.rulesChanged; }
        await persist();
        return clone(ctx);
      });
    }
    function reset(tabId) {
      return serialize(async () => {
        await ready;
        if (!enabled) fail('recorder_disabled');
        if (!await permission()) { stop(); await persistDisabled(); fail('permission_required'); }
        const revision = preferenceRevision;
        const tab = await checkedTab(tabId);
        if (!enabled || revision !== preferenceRevision) fail('recorder_disabled');
        const ctx = newContext(tabId, tab.hostname);
        await persist();
        return clone(ctx);
      });
    }
    function invalidate(tabId) {
      const values = tabId === undefined ? contexts.values() : [contexts.get(tabId)];
      for (const ctx of values) if (ctx) {
        ctx.session.rulesChanged = true;
        for (const row of ctx.rows.values()) row.stale = true;
      }
      schedulePersist();
    }
    function cleanup(startup = false) {
      if (startup) dropAll();
      return serialize(async () => { await ready; if (startup) { dropAll(); await persist(); } else if (expire(now())) await persist(); });
    }

    // MV3 wake-up listeners must be registered before any asynchronous reads.
    attach();
    if (chrome.tabs && chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener(tabId => {
      tabs.delete(tabId); drop(tabId);
      for (let i = early.length - 1; i >= 0; i--) if (early[i].tabId === tabId) early.splice(i, 1);
      schedulePersist(); scheduleAlarm();
    });
    if (chrome.tabs && chrome.tabs.onUpdated) chrome.tabs.onUpdated.addListener((tabId, change, rawTab) => {
      const previous = tabs.get(tabId);
      const normalized = safeTab(rawTab);
      const hostname = own(change, 'url') ? hostOf(change.url) : normalized ? normalized.hostname : previous && previous.hostname;
      const details = { kind: 'tab_update', tabId, hostname, incognito: !!(normalized ? normalized.incognito : previous && previous.incognito),
        loading: change.status === 'loading', complete: change.status === 'complete', urlChanged: own(change, 'url'), observedAt: now() };
      if (!hydrated || checking.has(tabId)) { enqueue(details); return; }
      observeUpdate(details);
    });
    if (chrome.permissions && chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(() => {
      serialize(async () => { await ready; await permission(); attach(); }).catch(report);
    });
    if (chrome.permissions && chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(change => {
      if (change && Array.isArray(change.permissions) && !change.permissions.includes('webRequest')) return;
      granted = false; stop();
      serialize(async () => { try { await ready; } catch (_) {} await persistDisabled(); }).catch(report);
    });
    if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !own(changes, PREFERENCE) || changes[PREFERENCE].newValue === true) return;
      stop();
      serialize(async () => { await ready; await persist(); }).catch(report);
    });
    if (chrome.alarms && chrome.alarms.onAlarm) chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === ALARM) cleanup().catch(report);
    });
    if (chrome.runtime && chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => {
      startupSeen = true;
      cleanup(true).catch(report);
    });
    ready = (async () => {
      const revision = preferenceRevision;
      const results = await Promise.allSettled([
        call(chrome.storage.local, 'get', [[PREFERENCE]], 'storage_failed'),
        permission(),
        storage === 'session' ? call(chrome.storage.session, 'get', [[RECORDS, STOPPED]], 'storage_failed') : Promise.resolve({}),
      ]);
      if (results[2].status !== 'fulfilled') { storage = 'memory'; report(safeError('storage_failed')); }
      const wantsCapture = results[0].status === 'fulfilled' && results[0].value && results[0].value[PREFERENCE] === true;
      const stopped = results[2].status === 'fulfilled' && results[2].value && results[2].value[STOPPED] === true;
      const unreadStop = !!chrome.storage.session && results[2].status !== 'fulfilled';
      enabled = wantsCapture && !stopped && !unreadStop && granted && revision === preferenceRevision;
      const saved = results[2].status === 'fulfilled' && results[2].value && results[2].value[RECORDS];
      if (enabled) {
        try { await loadTabs(saved && Array.isArray(saved.records) ? saved.records.map(record => record && record.session && record.session.tabId) : []); }
        catch (error) { report(error); }
        if (enabled && revision === preferenceRevision && !startupSeen) restore(saved);
        else dropAll();
      }
      let preferenceError = results[0].status === 'rejected' || wantsCapture && unreadStop ? safeError('storage_failed') : null;
      if ((!granted || stopped) && wantsCapture) {
        try { await clearPreference(); } catch (error) { preferenceError = error; }
        if (!preferenceError) { try { await removeStopped(); } catch (_) { report(safeError('storage_failed')); } }
      }
      hydrated = true; recovering = !!preferenceError;
      const pending = early.splice(0);
      if (enabled) for (const details of pending) {
        if (details.kind === 'tab_update' || tabs.has(details.tabId)) dispatch(details);
        else { enqueue(details); checkSource(details.tabId); }
      }
      await persist();
      attach(); scheduleAlarm();
      if (preferenceError) { initializationError = preferenceError; throw preferenceError; }
    })();
    ready.catch(report);
    return { get ready() { return ready; }, enable, disable, beginReset, clear, reset, cleanup, snapshot, find, status, invalidate };
  }
  root.ProxySwitchRequestRecorder = { create };
})(typeof self !== 'undefined' ? self : globalThis);
