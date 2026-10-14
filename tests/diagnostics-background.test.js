'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const crypto = require('node:crypto').webcrypto;
const routingSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'routing.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'diagnostics-background.js'), 'utf8');
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function event() {
  const listeners = [];
  return {
    addListener(listener, filter) { listener.filter = filter; listeners.push(listener); },
    removeListener(listener) { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); }, listeners,
  };
}
async function worker(options = {}) {
  let time = options.time || 100000;
  let sequence = 0;
  let refreshes = 0;
  let refreshCalls = 0;
  let failure = options.failure || null;
  let permission = options.permission !== false;
  const timers = [];
  const reloads = [];
  const writes = [];
  const held = [];
  let hold = null;
  let mutationTail = Promise.resolve();
  let mutationCount = 0;
  const data = copy(options.data || {
    serverList: [{ id: 'a', host: '127.0.0.1', port: 7897 }], activeServerId: 'a', userRules: ['site.example'], userWhitelist: [],
  });
  const sessionData = copy(options.sessionData || {});
  const tabs = new Map([[1, { id: 1, url: 'https://site.example/', incognito: false }], [2, { id: 2, url: 'https://other.example/' }]]);
  const settings = { value: { mode: options.mode || 'pac_script' }, levelOfControl: options.control || 'controlled_by_this_extension' };
  function callback(operation, fn, value, before, argument) {
    const complete = () => {
      const bad = (Array.isArray(failure) ? failure.includes(operation) : failure === operation) || failure === 'preference_get' && operation === 'get' &&
        Array.isArray(argument) && argument.includes('diagnosticAutoCapture');
      chrome.runtime.lastError = bad ? { message: 'private error URL must not be exported' } : null;
      if (!bad && before) before();
      fn(copy(value));
      chrome.runtime.lastError = null;
    };
    if (hold && hold.operation === operation && (!hold.predicate || hold.predicate(argument))) {
      held.push({ operation, argument: copy(argument), complete });
    } else queueMicrotask(complete);
  }
  const chrome = {
    runtime: { id: 'extension', lastError: null, onMessage: event(), onStartup: event() },
    storage: {
      onChanged: event(),
      local: {
        get(keys, fn) { callback('get', fn, Object.fromEntries(keys.map(key => [key, data[key]])), undefined, keys); },
        set(items, fn) { callback('set', fn, undefined, () => {
          const changes = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { oldValue: copy(data[key]), newValue: copy(value) }]));
          writes.push(copy(items)); Object.assign(data, copy(items)); chrome.storage.onChanged.emit(changes, 'local');
        }, items); },
        remove(keys, fn) { callback('remove', fn, undefined, () => {
          const changes = Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, { oldValue: copy(data[key]) }]));
          keys.forEach(key => delete data[key]);
          if (Object.keys(changes).length) chrome.storage.onChanged.emit(changes, 'local');
        }, keys); },
        clear(fn) { callback('clear', fn, undefined, () => {
          const changes = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { oldValue: copy(value) }]));
          for (const key of Object.keys(data)) delete data[key];
          if (Object.keys(changes).length) chrome.storage.onChanged.emit(changes, 'local');
        }); },
      },
      ...(options.automatic ? { session: {
        get(keys, fn) { callback('session_get', fn, Object.fromEntries(keys.map(key => [key, sessionData[key]])), undefined, keys); },
        set(items, fn) { callback('session_set', fn, undefined, () => {
          const changes = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { oldValue: copy(sessionData[key]), newValue: copy(value) }]));
          Object.assign(sessionData, copy(items)); chrome.storage.onChanged.emit(changes, 'session');
        }, items); },
        remove(keys, fn) { callback('session_remove', fn, undefined, () => keys.forEach(key => delete sessionData[key]), keys); },
      } } : {}),
    },
    permissions: { onAdded: event(), onRemoved: event(), contains(_filter, fn) { callback('permission', fn, permission); } },
    proxy: { settings: { get(_filter, fn) { callback('proxy', fn, settings); } } },
    tabs: {
      onRemoved: event(), onUpdated: event(),
      query(_filter, fn) { callback('tab_query', fn, [...tabs.values()]); },
      get(id, fn) {
        if (!tabs.has(id)) {
          queueMicrotask(() => { chrome.runtime.lastError = { message: 'closed' }; fn(); chrome.runtime.lastError = null; });
        } else callback('tab', fn, tabs.get(id));
      },
      reload(id, _options, fn) { callback('reload', fn, undefined, () => reloads.push(id)); },
    },
    alarms: { onAlarm: event(), scheduled: null, create(name, options) { this.scheduled = { name, ...options }; }, clear(_name, callback) { this.scheduled = null; callback(true); } },
    webRequest: Object.fromEntries(['onBeforeRequest', 'onHeadersReceived', 'onCompleted', 'onErrorOccurred', 'onBeforeRedirect'].map(name => [name, event()])),
  };
  const vmCrypto = { subtle: { digest(...args) {
    if (failure === 'digest') return Promise.reject(new Error('private digest failure'));
    return crypto.subtle.digest(...args);
  } } };
  const context = vm.createContext({ chrome, URL, console, crypto: vmCrypto, TextEncoder, Uint8Array, setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout(id) { timers[id - 1] = null; } });
  vm.runInContext(routingSource, context);
  if (options.automatic) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'request-recorder.js'), 'utf8'), context);
  vm.runInContext(source, context);
  const mutateConfiguration = fn => {
    const result = mutationTail.then(async () => { mutationCount++; if (options.beforeMutation) await options.beforeMutation({ chrome, data, tabs, settings }); return fn(); });
    mutationTail = result.catch(() => {});
    return result;
  };
  const controller = context.ProxySwitchDiagnostics.create({ chrome, routing: context.ProxySwitchRouting, mutateConfiguration, now: () => time, uuid: () => `id-${++sequence}`, refresh: async () => {
    refreshCalls++;
    if (options.beforeRefresh) await options.beforeRefresh({ chrome, data, tabs, settings });
    if (failure === 'refresh') throw new Error('failed'); refreshes++;
  } });
  if (options.beforeReady) options.beforeReady({ chrome, tabs, data });
  await controller.ready;
  const send = message => new Promise(resolve => chrome.runtime.onMessage.listeners[0](message, { id: 'extension' }, resolve));
  return {
    data, sessionData, chrome, tabs, reloads, settings, send, writes, held, mutateConfiguration, controller,
    get: () => send({ type: 'PS_DIAG_GET', tabId: 1 }),
    start: (tabId = 1, replace) => send({ type: 'PS_DIAG_START', tabId, replace }),
    request(host, id = 'request', type = 'script', tabId = 1) { chrome.webRequest.onBeforeRequest.emit({ url: `https://${host}/private-path?secret=x`, requestId: id, type, tabId }); },
    requestUrl(url, id = 'request', type = 'websocket', tabId = 1, extra = {}) { chrome.webRequest.onBeforeRequest.emit({ url, requestId: id, type, tabId, ...extra }); },
    headersUrl(url, id = 'request', statusCode = 101, extra = {}) { chrome.webRequest.onHeadersReceived.emit({ url, requestId: id, statusCode, tabId: 1, ...extra }); },
    doneUrl(url, id = 'request', statusCode = 101, extra = {}) { chrome.webRequest.onCompleted.emit({ url, requestId: id, statusCode, tabId: 1, ...extra }); },
    errorUrl(url, id = 'request', error = 'net::ERR_CONNECTION_CLOSED', extra = {}) { chrome.webRequest.onErrorOccurred.emit({ url, requestId: id, error, tabId: 1, ...extra }); },
    done(host, id = 'request', statusCode = 200) { chrome.webRequest.onCompleted.emit({ url: `https://${host}/private-path?secret=x`, requestId: id, statusCode, tabId: 1 }); },
    error(host, error = 'net::ERR_TIMED_OUT', id = 'request') { chrome.webRequest.onErrorOccurred.emit({ url: `https://${host}/private-path?secret=x`, requestId: id, error, tabId: 1 }); },
    advance(ms) { time += ms; },
    revoke() { permission = false; chrome.permissions.onRemoved.emit({ permissions: ['webRequest'] }); },
    fail(operation) { failure = operation; },
    refreshes: () => refreshes,
    refreshCalls: () => refreshCalls,
    mutations: () => mutationCount,
    hold(operation, predicate) { hold = { operation, predicate }; },
    release() { hold = null; const pending = held.shift(); if (pending) queueMicrotask(pending.complete); return pending; },
    fireTimers() { for (const fn of timers.splice(0)) if (fn) fn(); },
    async tick(count = 30) { for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve)); },
    async flush() { for (const fn of timers.splice(0)) if (fn) fn(); await send({ type: 'PS_DIAG_GET', tabId: 1 }); },
  };
}
test('permission is optional: opening diagnostics does not start or reload anything', async () => {
  const w = await worker({ permission: false });
  const result = await w.get();
  assert.equal(result.state.permission, false);
  assert.equal(result.state.session, null);
  assert.equal((await w.start()).error, 'permission_required');
  assert.equal(w.reloads.length, 0);
});
test('capture only source tab, aggregate routes and results, never persist raw URL', async () => {
  const w = await worker();
  assert.equal((await w.start()).success, true);
  w.request('site.example', 'one', 'main_frame'); w.done('site.example', 'one');
  w.request('challenge.example', 'two'); w.error('challenge.example', undefined, 'two');
  w.request('private.example', 'three', 'script', 2);
  const state = (await w.get()).state;
  assert.equal(state.rows.length, 2);
  assert.equal(state.rows[0].route, 'proxy');
  assert.equal(state.rows[1].route, 'direct');
  assert.equal(state.rows[1].failed, 1);
  await w.flush();
  assert.doesNotMatch(JSON.stringify(w.data.diagnosticSession), /private-path|secret|https:/);
});
test('HTTP status is retained independently of completion and arbitrary errors are sanitized', async () => {
  const w = await worker(); await w.start();
  w.request('challenge.example');
  w.chrome.webRequest.onHeadersReceived.emit({ url: 'https://challenge.example/', requestId: 'request', statusCode: 403, tabId: 1 });
  w.error('challenge.example', 'Bad https://private.example/token');
  const row = (await w.get()).state.rows[0];
  assert.equal(row.lastStatus, 403); assert.equal(row.failed, 1); assert.equal(row.error, 'request_failed');
});

test('HTTP errors count once per request and remain visible after a later success', async () => {
  const w = await worker(); await w.start();
  for (const [index, statusCode] of [403, 429, 500].entries()) {
    const requestId = 'http-' + index;
    w.request('challenge.example', requestId);
    w.chrome.webRequest.onHeadersReceived.emit({ url: 'https://challenge.example/', requestId, statusCode, tabId: 1 });
    w.done('challenge.example', requestId, statusCode);
  }
  w.request('challenge.example', 'success'); w.done('challenge.example', 'success', 200);
  const row = (await w.get()).state.rows[0];
  assert.equal(row.httpErrors, 3); assert.equal(row.failed, 0); assert.equal(row.lastStatus, 200);
  await w.flush(); assert.equal(w.data.diagnosticSession.rows[0].httpErrors, 3);
});
test('capture ends after 60 seconds and records expire after 30 minutes', async () => {
  const w = await worker(); await w.start(); w.request('one.example');
  w.advance(60001); w.request('two.example');
  let state = (await w.get()).state;
  assert.equal(state.rows.length, 1); assert.equal(state.session.stopReason, 'expired'); assert.equal(state.rows[0].pending, 1);
  w.advance(30 * 60000); state = (await w.get()).state;
  assert.equal(state.session, null); assert.equal(state.rows.length, 0);
});
test('bounded capture drops excess domains and in-flight requests', async () => {
  const w = await worker(); await w.start();
  for (let i = 0; i < 201; i++) w.request(`host${i}.example`, `r${i}`);
  let state = (await w.get()).state;
  assert.equal(state.rows.length, 200); assert.equal(state.session.dropped, 1);
  for (let i = 201; i < 1002; i++) w.request('host0.example', `r${i}`);
  state = (await w.get()).state;
  assert.equal(state.session.dropped, 2);
});
test('one session binds exact source and cannot silently replace another', async () => {
  const w = await worker(); const first = await w.start();
  assert.equal((await w.start(2)).error, 'session_conflict');
  assert.equal((await w.send({ type: 'PS_DIAG_GET', tabId: 2 })).state.session.id, first.state.session.id);
  assert.equal((await w.start(2, true)).state.session.tabId, 2);
});
test('restricted and incognito tabs rejected; cross-host navigation stops capture', async () => {
  const w = await worker();
  w.tabs.get(2).url = 'chrome://settings'; assert.equal((await w.start(2)).error, 'restricted_tab');
  w.tabs.get(2).url = 'https://other.example'; w.tabs.get(2).incognito = true;
  assert.equal((await w.start(2)).error, 'restricted_tab');
  await w.start(); w.request('another.example', 'nav', 'main_frame');
  assert.equal((await w.get()).state.session.stopReason, 'navigation');
});
test('trial validates observed hosts and manual conflicts without changing chosen mode', async () => {
  const w = await worker(); const { state } = await w.start();
  const apply = hosts => w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts, direction: 'proxy' });
  assert.equal((await apply(['unseen.example'])).error, 'invalid_hosts');
  w.data.userWhitelist = ['challenge.example']; w.request('challenge.example');
  assert.equal((await apply(['challenge.example'])).error, 'rule_conflict');
  w.data.userWhitelist = []; w.settings.value.mode = 'system';
  assert.equal((await apply(['challenge.example'])).error, 'mode_required');
  assert.equal(w.refreshes(), 0);
});
test('trial applies once, resets request facts, survives reopening and undo preserves edits', async () => {
  const w = await worker(); const { state } = await w.start(); w.request('challenge.example'); w.done('challenge.example');
  let result = await w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: ['challenge.example'], direction: 'proxy' });
  assert.equal(result.success, true); assert.equal(result.state.rows.length, 0); assert.equal(w.refreshes(), 1); assert.equal(w.reloads.length, 2);
  assert.equal((await w.get()).state.trial.id, result.state.trial.id);
  assert.equal((await w.start()).error, 'trial_conflict');
  w.data.userRules.push('new-user-edit.example');
  result = await w.send({ type: 'PS_DIAG_UNDO', trialId: result.state.trial.id });
  assert.equal(result.success, true); assert.equal(result.state.trial, null); assert.ok(w.data.userRules.includes('new-user-edit.example'));
});
test('save merges latest formal rules and removes only trial overlay', async () => {
  const w = await worker(); const { state } = await w.start(); w.request('challenge.example');
  const applied = await w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: ['challenge.example'], direction: 'proxy' });
  w.data.userRules.push('later.example');
  const saved = await w.send({ type: 'PS_DIAG_SAVE', trialId: applied.state.trial.id });
  assert.equal(saved.success, true); assert.equal(saved.state.trial, null);
  assert.deepEqual(w.data.userRules, ['site.example', 'later.example', 'challenge.example']);
});
test('expired trial cannot be saved and cleanup refreshes PAC', async () => {
  const w = await worker(); const { state } = await w.start(); w.request('challenge.example');
  const applied = await w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: ['challenge.example'], direction: 'proxy' });
  w.advance(10 * 60000);
  assert.equal((await w.send({ type: 'PS_DIAG_SAVE', trialId: applied.state.trial.id })).error, 'trial_not_found');
  assert.equal(w.data.diagnosticTrial, undefined); assert.equal(w.refreshes(), 2);
});
test('permission revocation and tab closure stop capture', async () => {
  const w = await worker(); await w.start(); w.revoke();
  assert.equal((await w.get()).state.session.stopReason, 'permission_revoked');
  w.chrome.tabs.onRemoved.emit(1);
  assert.equal((await w.get()).state.session.closed, true);
});
test('worker restart preserves unfinished totals and browser restart clears the session', async () => {
  const first = await worker(); await first.start(); first.request('challenge.example'); await first.flush();
  const w = await worker({ data: first.data });
  assert.equal((await w.get()).state.rows[0].pending, 1);
  w.chrome.runtime.onStartup.emit();
  assert.equal((await w.get()).state.session, null);
});
test('failed storage never reports success; reload failure retains undo-able trial', async () => {
  const w = await worker(); const { state } = await w.start(); w.request('challenge.example');
  w.fail('set');
  const failed = await w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: ['challenge.example'], direction: 'proxy' });
  assert.equal(failed.error, 'storage_failed'); assert.equal(failed.state.trial, null);
  w.fail('reload');
  const reloadFailed = await w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: ['challenge.example'], direction: 'proxy' });
  assert.equal(reloadFailed.error, 'reload_failed'); assert.ok(reloadFailed.state.trial);
});
test('failed proxy apply retains inactive recovery record and GET retries rollback', async () => {
  const w = await worker(); const { state } = await w.start(); w.request('challenge.example'); w.fail('refresh');
  const result = await w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: ['challenge.example'], direction: 'proxy' });
  assert.equal(result.error, 'proxy_failed'); assert.equal(result.state.trial.pendingCleanup, true);
  assert.equal(w.data.diagnosticTrial.expiresAt, 0);
  w.fail(null);
  assert.equal((await w.get()).state.trial, null); assert.equal(w.data.diagnosticTrial, undefined);
});
test('failed undo retains recovery record; failed save retains formal rules and retries PAC', async () => {
  const w = await worker(); const { state } = await w.start(); w.request('challenge.example');
  let applied = await w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: ['challenge.example'], direction: 'proxy' });
  w.fail('refresh');
  assert.equal((await w.send({ type: 'PS_DIAG_UNDO', trialId: applied.state.trial.id })).error, 'proxy_failed');
  assert.equal(w.data.diagnosticTrial.pendingCleanup, true);
  w.fail(null); await w.get();
  const next = await w.start(); w.request('challenge.example');
  applied = await w.send({ type: 'PS_DIAG_APPLY', sessionId: next.state.session.id, hosts: ['challenge.example'], direction: 'proxy' });
  w.fail('refresh');
  assert.equal((await w.send({ type: 'PS_DIAG_SAVE', trialId: applied.state.trial.id })).error, 'proxy_failed');
  assert.ok(w.data.userRules.includes('challenge.example')); assert.equal(w.data.diagnosticTrial.saved, true);
  w.fail(null); assert.equal((await w.get()).state.trial, null);
});
test('external manual opposite rule cancels a trial without overwriting that rule', async () => {
  const w = await worker(); const { state } = await w.start(); w.request('challenge.example');
  await w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: ['challenge.example'], direction: 'proxy' });
  await new Promise(resolve => w.chrome.storage.local.set({ userWhitelist: ['challenge.example'] }, resolve));
  const result = await w.get();
  assert.equal(result.state.trial, null); assert.equal(result.state.session.rulesChanged, true);
  assert.deepEqual(w.data.userWhitelist, ['challenge.example']);
});
test('redirect is a completed network hop, not a permanently pending request', async () => {
  const w = await worker(); await w.start(); w.request('redirect.example');
  w.chrome.webRequest.onBeforeRedirect.emit({ url: 'https://redirect.example/start', requestId: 'request', tabId: 1, statusCode: 302 });
  w.request('destination.example'); w.done('destination.example');
  const rows = (await w.get()).state.rows;
  assert.equal(rows.length, 2); assert.equal(rows[0].lastStatus, 302);
  assert.equal(rows[0].completed, 1); assert.equal(rows[0].pending, 0);
});
test('idle diagnostics has no request listeners or alarm; capture is tab filtered and detaches when stopped', async () => {
  const w = await worker();
  assert.equal(w.chrome.webRequest.onBeforeRequest.listeners.length, 0);
  assert.equal(w.chrome.alarms.scheduled, null);
  const { state } = await w.start();
  assert.equal(w.chrome.webRequest.onBeforeRequest.listeners.length, 1);
  assert.equal(w.chrome.webRequest.onBeforeRequest.listeners[0].filter.tabId, 1);
  assert.equal(w.chrome.alarms.scheduled.when, state.session.captureUntil);
  await w.send({ type: 'PS_DIAG_STOP', sessionId: state.session.id });
  assert.equal(w.chrome.webRequest.onBeforeRequest.listeners.length, 0);
  assert.equal(w.chrome.alarms.scheduled.when, state.session.startedAt + 30 * 60000);
  w.data.diagnosticUiState = { selected: ['private.example'] };
  await w.send({ type: 'PS_DIAG_CLEAR', sessionId: state.session.id });
  assert.equal(w.chrome.alarms.scheduled, null);
  assert.equal(w.data.diagnosticUiState, undefined);
});
test('expired captures detach observers and expired session clears selected-domain UI state', async () => {
  const w = await worker(); await w.start();
  w.advance(60001); await w.get();
  assert.equal(w.chrome.webRequest.onBeforeRequest.listeners.length, 0);
  w.data.diagnosticUiState = { selected: ['private.example'] };
  w.advance(30 * 60000); await w.get();
  assert.equal(w.data.diagnosticUiState, undefined);
  assert.equal(w.chrome.alarms.scheduled, null);
});
test('proxy ownership is required and no configured server rejects trial', async () => {
  const w = await worker({ control: 'controlled_by_other_extensions' });
  const { state } = await w.start(); w.request('challenge.example');
  const message = { type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: ['challenge.example'], direction: 'proxy' };
  assert.equal((await w.send(message)).error, 'proxy_uncontrolled');
  assert.equal((await w.get()).state.mode, 'unknown');
  w.settings.levelOfControl = 'controlled_by_this_extension'; w.data.serverList = [];
  assert.equal((await w.send(message)).error, 'no_server');
  assert.equal(w.refreshes(), 0);
});
test('stale session commands cannot alter a newer capture and incognito events are ignored', async () => {
  const w = await worker(); const first = await w.start(); const second = await w.start();
  const stale = await w.send({ type: 'PS_DIAG_STOP', sessionId: first.state.session.id });
  assert.equal(stale.error, 'session_not_found');
  assert.equal(stale.state.session.id, second.state.session.id);
  w.chrome.webRequest.onBeforeRequest.emit({ url: 'https://private.example/', requestId: 'private', tabId: 1, type: 'script', incognito: true });
  assert.equal((await w.get()).state.rows.length, 0);
});
test('late UI writes after clear or retention expiry are removed without rearming idle alarms', async () => {
  for (const expired of [false, true]) {
    const w = await worker(); const { state } = await w.start(); w.request('private.example');
    const delayed = { sessionId: state.session.id, filter: 'all', direction: 'proxy', selected: ['private.example'], expiresAt: state.session.startedAt + 60 * 60000 };
    if (expired) { w.advance(31 * 60000); await w.get(); }
    else await w.send({ type: 'PS_DIAG_CLEAR', sessionId: state.session.id });
    await new Promise(resolve => w.chrome.storage.local.set({ diagnosticUiState: delayed }, resolve));
    await w.get();
    assert.equal(w.data.diagnosticUiState, undefined);
    assert.equal(w.chrome.alarms.scheduled, null);
    assert.equal(w.refreshes(), 0);
  }
});
test('UI state is limited to the current session, observed hosts and retention deadline', async () => {
  const w = await worker(); const first = await w.start(); const second = await w.start(); w.request('observed.example');
  await new Promise(resolve => w.chrome.storage.local.set({ diagnosticUiState: {
    sessionId: first.state.session.id, selected: ['old-private.example'], expiresAt: second.state.session.startedAt + 60000,
  } }, resolve));
  await w.get(); assert.equal(w.data.diagnosticUiState, undefined);
  await new Promise(resolve => w.chrome.storage.local.set({ diagnosticUiState: {
    sessionId: second.state.session.id, filter: 'all', direction: 'direct',
    selected: ['observed.example', 'observed.example', 'https://private.example/path', 'unobserved.example'],
    expiresAt: second.state.session.startedAt + 60 * 60000, extra: 'private data',
  } }, resolve));
  await w.get();
  assert.deepEqual(w.data.diagnosticUiState, {
    sessionId: second.state.session.id, filter: 'all', direction: 'direct', selected: ['observed.example'],
    expiresAt: second.state.session.startedAt + 30 * 60000,
  });
  assert.equal((await w.get()).state.session.captureUntil, second.state.session.captureUntil);
  assert.equal(w.refreshes(), 0);
});

test('pending UI recovery retains only a bounded identity, never an executable replay payload', async () => {
  const w = await worker(); const started = await w.start(); const sessionId = started.state.session.id;
  w.request('observed.example');
  const base = { sessionId, filter: 'all', direction: 'proxy', selected: ['observed.example'], expiresAt: started.state.session.startedAt + 60000 };
  for (const type of ['PS_DIAG_ADD_RULES', 'PS_DIAG_UNDO_RULES', 'PS_DIAG_RETRY_RULES']) {
    const key = type === 'PS_DIAG_ADD_RULES' ? 'actionId' : 'undoId';
    await new Promise(resolve => w.chrome.storage.local.set({ diagnosticUiState: {
      ...base, pendingMutation: { type, sessionId, [key]: 'operation-a', hosts: ['private.example'], direction: 'direct',
        url: 'https://private.example/path?token=secret', extra: 'private-body' },
    } }, resolve));
    await w.get();
    assert.deepEqual(w.data.diagnosticUiState.pendingMutation, { type, sessionId, [key]: 'operation-a' });
    assert.doesNotMatch(JSON.stringify(w.data.diagnosticUiState), /private|token|secret/);
  }
  for (const pendingMutation of [
    { type: 'PS_DIAG_ADD_RULES', sessionId: 'other', actionId: 'operation-a' },
    { type: 'PS_DIAG_SAVE', sessionId, trialId: 'operation-a' },
    { type: 'PS_DIAG_ADD_RULES', sessionId, actionId: 'https://private.example/' },
    { type: 'PS_DIAG_UNDO_RULES', sessionId, undoId: 'a'.repeat(129) },
  ]) {
    await new Promise(resolve => w.chrome.storage.local.set({ diagnosticUiState: { ...base, pendingMutation } }, resolve));
    await w.get(); assert.equal(w.data.diagnosticUiState.pendingMutation, undefined);
  }
  assert.equal(w.refreshes(), 0);
});

test('WebSocket observers register both schemes on every lifecycle event and only during capture', async () => {
  const w = await worker();
  const names = ['onBeforeRequest', 'onHeadersReceived', 'onCompleted', 'onErrorOccurred', 'onBeforeRedirect'];
  for (const name of names) assert.equal(w.chrome.webRequest[name].listeners.length, 0);
  await w.start();
  for (const name of names) {
    const listeners = w.chrome.webRequest[name].listeners;
    assert.equal(listeners.length, 1, name);
    assert.deepEqual(copy(listeners[0].filter), {
      urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'], tabId: 1,
    }, name);
  }
  const { state } = await w.get();
  await w.send({ type: 'PS_DIAG_STOP', sessionId: state.session.id });
  for (const name of names) assert.equal(w.chrome.webRequest[name].listeners.length, 0, name);
});

test('HTTP source observes WS and WSS domains without inheriting the main-site route', async () => {
  const w = await worker();
  w.tabs.get(1).url = 'https://muse.ai/chat';
  w.data.userRules = ['muse.ai'];
  w.requestUrl('wss://hatch.metaaivm.com/v1/noise?token=private', 'idle');
  assert.equal((await w.get()).state.rows.length, 0);
  await w.start();
  w.requestUrl('wss://hatch.metaaivm.com/v1/noise?token=private', 'wss');
  w.requestUrl('ws://socket.other.example/private-path?token=private', 'ws');
  const state = (await w.get()).state;
  assert.equal(state.session.hostname, 'muse.ai');
  assert.equal(state.main.route, 'proxy');
  assert.equal(state.rows.length, 2);
  for (const row of state.rows) {
    assert.equal(row.route, 'direct');
    assert.equal(row.source, 'default');
    assert.deepEqual(copy(row.types), ['websocket']);
    assert.equal(row.count, 1);
    assert.equal(row.pending, 1);
    assert.equal(row.failed, 0);
  }
  assert.deepEqual(copy(state.rows.map(row => row.host)), ['hatch.metaaivm.com', 'socket.other.example']);
  await w.flush();
  assert.doesNotMatch(JSON.stringify(w.data.diagnosticSession), /wss?:|private-path|\/v1\/noise|token=|private/);
});

test('WebSocket source tabs are not authorized by supported request schemes or pending HTTP URLs', async () => {
  for (const url of ['ws://socket.example/', 'wss://socket.example/', 'chrome://newtab/', 'file:///private/index.html']) {
    const w = await worker();
    w.tabs.get(1).url = url;
    w.tabs.get(1).pendingUrl = 'https://muse.ai/';
    const result = await w.start();
    assert.equal(result.error, 'restricted_tab', url);
    assert.equal(result.state.session, null, url);
    assert.equal(w.reloads.length, 0, url);
    assert.equal(w.chrome.webRequest.onBeforeRequest.listeners.length, 0, url);
  }
});

test('an ordinary HTTP tab stays a valid source even when its pending URL is WebSocket', async () => {
  const w = await worker();
  w.tabs.get(1).url = 'http://site.example/';
  w.tabs.get(1).pendingUrl = 'wss://hatch.metaaivm.com/v1/noise';
  assert.equal((await w.start()).success, true);
  w.requestUrl('wss://hatch.metaaivm.com/v1/noise');
  const state = (await w.get()).state;
  assert.equal(state.session.hostname, 'site.example');
  assert.equal(state.rows[0].host, 'hatch.metaaivm.com');
});

test('unsupported request schemes and local WebSocket targets are neither observed nor trial-able', async () => {
  const w = await worker(); const { state } = await w.start();
  for (const [index, url] of [
    'ftp://public.example/private', 'chrome-extension://private.example/private',
    'wss://localhost/private', 'ws://127.0.0.1/private', 'wss://192.168.1.1/private',
    'ws://10.0.0.1/private', 'wss://printer.local/private', 'ws://[::1]/private',
  ].entries()) w.requestUrl(url, 'ignored-' + index);
  assert.equal((await w.get()).state.rows.length, 0);
  for (const host of ['localhost', '127.0.0.1', '192.168.1.1', '10.0.0.1', 'printer.local', '::1', 'unseen.example']) {
    assert.equal((await w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: [host], direction: 'proxy' })).error, 'invalid_hosts', host);
  }
  assert.equal(w.refreshes(), 0);
});

test('WebSocket requests and terminal events remain source-tab and incognito filtered', async () => {
  const w = await worker(); await w.start();
  const url = 'wss://hatch.metaaivm.com/v1/noise';
  w.requestUrl(url, 'other', 'websocket', 2);
  w.requestUrl(url, 'background', 'websocket', -1);
  w.requestUrl(url, 'incognito', 'websocket', 1, { incognito: true });
  assert.equal((await w.get()).state.rows.length, 0);
  w.requestUrl(url, 'observed');
  w.doneUrl(url, 'observed', 101, { tabId: 2 });
  w.errorUrl(url, 'observed', 'net::ERR_FAILED', { incognito: true });
  let row = (await w.get()).state.rows[0];
  assert.equal(row.count, 1); assert.equal(row.pending, 1); assert.equal(row.completed, 0); assert.equal(row.failed, 0);
  w.doneUrl(url, 'observed');
  row = (await w.get()).state.rows[0];
  assert.equal(row.pending, 0); assert.equal(row.completed, 1); assert.equal(row.failed, 0);
});

test('HTTP-to-WebSocket navigation is not treated as an authorized source page', async () => {
  const w = await worker(); await w.start();
  w.requestUrl('wss://hatch.metaaivm.com/v1/noise', 'socket');
  w.tabs.get(1).url = 'wss://site.example/';
  w.chrome.tabs.onUpdated.emit(1, { url: 'wss://site.example/' });
  const state = (await w.get()).state;
  assert.equal(state.session.stopReason, 'navigation');
  assert.equal(state.rows[0].pending, 1); assert.equal(state.rows[0].failed, 0);
  assert.equal(w.chrome.webRequest.onBeforeRequest.listeners.length, 0);
});

test('WebSocket 101 handshakes are completed once without counting duplicate terminal events', async () => {
  const w = await worker(); await w.start();
  const url = 'wss://hatch.metaaivm.com/v1/noise';
  w.requestUrl(url, 'socket');
  w.headersUrl(url, 'socket', 101); w.headersUrl(url, 'socket', 101);
  let row = (await w.get()).state.rows[0];
  assert.equal(row.lastStatus, 101); assert.equal(row.httpErrors, 0); assert.equal(row.failed, 0);
  w.doneUrl(url, 'socket', 101); w.doneUrl(url, 'socket', 101);
  w.headersUrl(url, 'socket', 500); w.errorUrl(url, 'socket');
  row = (await w.get()).state.rows[0];
  assert.equal(row.count, 1); assert.equal(row.completed, 1); assert.equal(row.pending, 0);
  assert.equal(row.lastStatus, 101); assert.equal(row.httpErrors, 0); assert.equal(row.failed, 0);
  assert.equal(row.error, null);
});

test('a WebSocket with no terminal handshake event stays pending rather than becoming a false failure', async () => {
  const w = await worker(); await w.start();
  w.requestUrl('wss://hatch.metaaivm.com/v1/noise');
  w.advance(60001);
  const state = (await w.get()).state;
  assert.equal(state.session.stopReason, 'expired');
  assert.equal(state.rows[0].pending, 1); assert.equal(state.rows[0].failed, 0);
  assert.equal(state.rows[0].httpErrors, 0);
  assert.equal(w.chrome.webRequest.onBeforeRequest.listeners.length, 0);
  w.doneUrl('wss://hatch.metaaivm.com/v1/noise');
  assert.equal((await w.get()).state.rows[0].completed, 0);
});

test('WebSocket handshake HTTP exceptions aggregate independently from network failures and later successes', async () => {
  const w = await worker(); await w.start();
  const url = 'wss://hatch.metaaivm.com/v1/noise';
  for (const [index, status] of [401, 403, 500].entries()) {
    const id = 'rejected-' + index;
    w.requestUrl(url, id);
    w.headersUrl(url, id, status); w.headersUrl(url, id, status);
    w.errorUrl(url, id, 'net::ERR_FAILED'); w.errorUrl(url, id, 'net::ERR_FAILED');
    w.doneUrl(url, id, status);
  }
  w.requestUrl(url, 'accepted'); w.headersUrl(url, 'accepted', 101); w.doneUrl(url, 'accepted', 101);
  let row = (await w.get()).state.rows[0];
  assert.equal(row.count, 4); assert.equal(row.httpErrors, 3); assert.equal(row.failed, 3);
  assert.equal(row.completed, 1); assert.equal(row.pending, 0); assert.equal(row.lastStatus, 101);
  assert.equal(row.error, 'net::ERR_FAILED');
  await w.flush();
  row = w.data.diagnosticSession.rows[0];
  assert.equal(row.httpErrors, 3); assert.equal(row.failed, 3);
});

test('WebSocket rejected handshakes completed with HTTP statuses count once and remain visible', async () => {
  const w = await worker(); await w.start();
  const url = 'ws://socket.other.example/private';
  for (const [index, status] of [401, 403, 500].entries()) {
    const id = 'status-' + index;
    w.requestUrl(url, id);
    w.headersUrl(url, id, status); w.doneUrl(url, id, status); w.doneUrl(url, id, status);
  }
  const row = (await w.get()).state.rows[0];
  assert.equal(row.count, 3); assert.equal(row.completed, 3); assert.equal(row.httpErrors, 3);
  assert.equal(row.failed, 0); assert.equal(row.pending, 0); assert.equal(row.lastStatus, 500);
});

test('arbitrary WebSocket error messages cannot leak query strings or authorization into persisted rows', async () => {
  const w = await worker(); await w.start();
  const url = 'wss://hatch.metaaivm.com/v1/noise?authorization=secret-token';
  w.requestUrl(url); w.errorUrl(url, 'request', 'Authorization: secret-token; ' + url);
  const row = (await w.get()).state.rows[0];
  assert.equal(row.failed, 1); assert.equal(row.error, 'request_failed');
  await w.flush();
  assert.doesNotMatch(JSON.stringify(w.data.diagnosticSession), /secret-token|authorization|Authorization|\/v1\/noise|wss:/);
});

test('WebSocket capture never reads request headers, response headers, frames or request bodies', async () => {
  const w = await worker(); await w.start();
  const details = { url: 'wss://user:pass@hatch.metaaivm.com/v1/noise?token=private', requestId: 'private', tabId: 1, type: 'websocket' };
  for (const key of ['requestHeaders', 'responseHeaders', 'requestBody', 'frames', 'cookies', 'authorization', 'unknown']) {
    Object.defineProperty(details, key, { get() { throw new Error('must not read ' + key); } });
  }
  w.chrome.webRequest.onBeforeRequest.emit(details);
  w.doneUrl(details.url, 'private', 101);
  const row = (await w.get()).state.rows[0];
  assert.equal(row.host, 'hatch.metaaivm.com'); assert.deepEqual(copy(row.types), ['websocket']);
  await w.flush();
  assert.doesNotMatch(JSON.stringify(w.data.diagnosticSession), /token|private|user:pass|authorization|frames|requestBody|cookies/);
});

test('pre-hydration WebSocket events are copied as sanitized host-only facts', async () => {
  const seed = await worker(); await seed.start(); await seed.flush();
  const early = {
    url: 'wss://hatch.metaaivm.com/v1/noise?token=private', requestId: 'early', tabId: 1, type: 'websocket',
    requestHeaders: [{ name: 'Cookie', value: 'private-cookie' }], responseHeaders: [{ name: 'Authorization', value: 'private-auth' }],
    requestBody: { raw: ['private-body'] }, frames: ['private-chat'], extra: 'private-extra',
  };
  const w = await worker({ data: seed.data, beforeReady({ chrome }) {
    chrome.webRequest.onBeforeRequest.emit(early);
    chrome.webRequest.onHeadersReceived.emit({ ...early, statusCode: 101 });
    chrome.webRequest.onCompleted.emit({ ...early, statusCode: 101 });
    early.url = 'wss://mutated.example/private'; early.type = 'mutated';
  } });
  const row = (await w.get()).state.rows[0];
  assert.equal(row.host, 'hatch.metaaivm.com'); assert.deepEqual(copy(row.types), ['websocket']);
  assert.equal(row.count, 1); assert.equal(row.completed, 1); assert.equal(row.lastStatus, 101);
  await w.flush();
  assert.doesNotMatch(JSON.stringify(w.data.diagnosticSession), /private|token|Cookie|Authorization|headers|frames|requestBody|mutated|wss:/i);
});

test('pre-hydration WebSocket events do not bypass source-tab, incognito or permission guards', async () => {
  const seed = await worker(); await seed.start(); await seed.flush();
  const w = await worker({ data: seed.data, beforeReady({ chrome }) {
    chrome.webRequest.onBeforeRequest.emit({ url: 'wss://other-tab.example/private', requestId: 'other', tabId: 2, type: 'websocket' });
    chrome.webRequest.onBeforeRequest.emit({ url: 'wss://incognito.example/private', requestId: 'incognito', tabId: 1, type: 'websocket', incognito: true });
    chrome.webRequest.onBeforeRequest.emit({ url: 'wss://observed.example/private', requestId: 'normal', tabId: 1, type: 'websocket' });
  } });
  assert.deepEqual(copy((await w.get()).state.rows.map(row => row.host)), ['observed.example']);
  const revoked = await worker({ data: seed.data, permission: false, beforeReady({ chrome }) {
    chrome.webRequest.onBeforeRequest.emit({ url: 'wss://denied.example/private', requestId: 'denied', tabId: 1, type: 'websocket' });
  } });
  const state = (await revoked.get()).state;
  assert.equal(state.session.stopReason, 'permission_revoked'); assert.equal(state.rows.length, 0);
  assert.equal(revoked.chrome.webRequest.onBeforeRequest.listeners.length, 0);
});

test('WebSocket rows survive worker hydration but imported private fields and invalid types do not', async () => {
  const first = await worker(); await first.start();
  first.requestUrl('wss://hatch.metaaivm.com/v1/noise', 'completed'); first.doneUrl('wss://hatch.metaaivm.com/v1/noise', 'completed');
  first.requestUrl('wss://hatch.metaaivm.com/v1/noise', 'unfinished'); await first.flush();
  first.data.diagnosticSession.session.url = 'https://site.example/private-token';
  Object.assign(first.data.diagnosticSession.rows[0], {
    url: 'wss://hatch.metaaivm.com/private-token', cookies: 'private-cookie', headers: ['private-header'],
    frames: ['private-chat'], authorization: 'private-auth', extra: 'private-extra',
    types: ['websocket', 'https://private.example/token', 'WebSocket'],
  });
  const w = await worker({ data: first.data });
  let row = (await w.get()).state.rows[0];
  assert.equal(row.host, 'hatch.metaaivm.com'); assert.deepEqual(copy(row.types), ['websocket']);
  assert.equal(row.count, 2); assert.equal(row.completed, 1); assert.equal(row.pending, 1); assert.equal(row.failed, 0);
  assert.doesNotMatch(JSON.stringify((await w.get()).state), /private-token|private-cookie|private-header|private-chat|private-auth|private-extra|wss:/);
  w.requestUrl('wss://second.example/noise', 'next'); await w.flush();
  assert.doesNotMatch(JSON.stringify(w.data.diagnosticSession), /private-token|private-cookie|private-header|private-chat|private-auth|private-extra|wss:/);
  w.chrome.runtime.onStartup.emit();
  assert.equal((await w.get()).state.session, null); assert.equal((await w.get()).state.rows.length, 0);
});

test('permission revocation halts active WebSocket capture without creating failures or keeping listeners', async () => {
  const w = await worker(); await w.start();
  const url = 'wss://hatch.metaaivm.com/v1/noise';
  w.requestUrl(url, 'socket'); w.revoke();
  let state = (await w.get()).state;
  assert.equal(state.session.stopReason, 'permission_revoked'); assert.equal(state.permission, false);
  assert.equal(state.rows[0].pending, 1); assert.equal(state.rows[0].failed, 0);
  w.requestUrl(url, 'ignored'); w.errorUrl(url, 'socket');
  state = (await w.get()).state;
  assert.equal(state.rows[0].count, 1); assert.equal(state.rows[0].failed, 0);
  for (const entry of Object.values(w.chrome.webRequest)) assert.equal(entry.listeners.length, 0);
});

test('observed WebSocket domains reuse trial routing, undo and explicit save without storing URLs', async () => {
  const w = await worker(); let { state } = await w.start();
  const url = 'wss://hatch.metaaivm.com/v1/noise?token=private';
  w.requestUrl(url, 'before'); w.errorUrl(url, 'before');
  const applied = await w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: ['hatch.metaaivm.com'], direction: 'proxy' });
  assert.equal(applied.success, true); assert.deepEqual(copy(applied.state.trial.hosts), ['hatch.metaaivm.com']);
  assert.equal(applied.state.rows.length, 0); assert.equal(w.refreshes(), 1);
  w.requestUrl(url, 'trial'); w.doneUrl(url, 'trial');
  let row = (await w.get()).state.rows[0];
  assert.equal(row.route, 'proxy'); assert.equal(row.source, 'trial'); assert.equal(row.rule, 'hatch.metaaivm.com');
  const undone = await w.send({ type: 'PS_DIAG_UNDO', trialId: applied.state.trial.id });
  assert.equal(undone.success, true); assert.equal(undone.state.trial, null);
  assert.deepEqual(w.data.userRules, ['site.example']);
  state = (await w.start()).state;
  w.requestUrl(url, 'again');
  const next = await w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: ['hatch.metaaivm.com'], direction: 'proxy' });
  w.requestUrl(url, 'saved'); w.doneUrl(url, 'saved');
  const saved = await w.send({ type: 'PS_DIAG_SAVE', trialId: next.state.trial.id });
  assert.equal(saved.success, true); assert.equal(saved.state.trial, null);
  assert.deepEqual(w.data.userRules, ['site.example', 'hatch.metaaivm.com']);
  row = saved.state.rows[0]; assert.equal(row.route, 'proxy'); assert.equal(row.source, 'user');
  await w.flush();
  assert.doesNotMatch(JSON.stringify(w.data), /\/v1\/noise|token=private|wss:/);
});

test('WebSocket trial cannot target unobserved domains, arbitrary URLs or changed source pages', async () => {
  const w = await worker(); const { state } = await w.start();
  w.requestUrl('wss://hatch.metaaivm.com/v1/noise');
  for (const host of ['unobserved.example', 'wss://hatch.metaaivm.com/v1/noise', 'hatch.metaaivm.com/v1/noise']) {
    assert.equal((await w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: [host], direction: 'proxy' })).error, 'invalid_hosts', host);
  }
  w.tabs.get(1).url = 'https://changed.example/';
  const changed = await w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: ['hatch.metaaivm.com'], direction: 'proxy' });
  assert.equal(changed.error, 'session_conflict'); assert.equal(changed.state.trial, null);
  assert.equal(w.refreshes(), 0); assert.deepEqual(w.data.userRules, ['site.example']);
});

test('explicit direct WebSocket rules keep priority and opposite-rule guards are not bypassed', async () => {
  const w = await worker(); const { state } = await w.start();
  w.data.userRules = ['muse.ai']; w.data.userWhitelist = ['metaaivm.com'];
  w.requestUrl('wss://hatch.metaaivm.com/v1/noise');
  const row = (await w.get()).state.rows[0];
  assert.equal(row.route, 'direct'); assert.equal(row.source, 'whitelist'); assert.equal(row.rule, 'metaaivm.com');
  const result = await w.send({ type: 'PS_DIAG_APPLY', sessionId: state.session.id, hosts: ['hatch.metaaivm.com'], direction: 'proxy' });
  assert.equal(result.error, 'rule_conflict'); assert.equal(result.state.trial, null); assert.equal(w.refreshes(), 0);
  assert.deepEqual(w.data.userWhitelist, ['metaaivm.com']);
});

const addRules = (w, sessionId, hosts = ['challenge.example'], direction = 'proxy', actionId = 'action-1') =>
  w.send({ type: 'PS_DIAG_ADD_RULES', sessionId, hosts, direction, actionId });
const undoRules = (w, undoId) => w.send({ type: 'PS_DIAG_UNDO_RULES', undoId });
const retryRules = (w, undoId) => w.send({ type: 'PS_DIAG_RETRY_RULES', undoId });
async function observedWorker(options = {}, hosts = ['challenge.example']) {
  const w = await worker(options);
  const started = await w.start();
  assert.equal(started.success, true);
  for (const [index, host] of hosts.entries()) w.request(host, 'observed-' + index);
  return { w, sessionId: started.state.session.id };
}
function formalWrites(w) {
  return w.writes.filter(items => Object.hasOwn(items, 'userRules') || Object.hasOwn(items, 'userWhitelist'));
}

test('direct add saves observed proxy hosts once, retains facts and does not reload or switch mode', async () => {
  const { w, sessionId } = await observedWorker({}, ['challenge.example', 'cdn.example']);
  w.done('challenge.example', 'observed-0');
  const before = (await w.get()).state;
  const saved = await addRules(w, sessionId, ['challenge.example', 'cdn.example']);
  assert.equal(saved.success, true);
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example', 'cdn.example']);
  assert.deepEqual(w.data.userWhitelist, []);
  assert.equal(w.reloads.length, 1);
  assert.equal(w.refreshes(), 1);
  assert.equal(w.settings.value.mode, 'pac_script');
  assert.equal(saved.state.trial, null);
  assert.equal(saved.state.session.id, sessionId);
  assert.equal(saved.state.session.startedAt, before.session.startedAt);
  assert.equal(saved.state.session.captureUntil, 0);
  assert.equal(saved.state.session.rulesChanged, true);
  assert.equal(saved.state.rows.length, 2);
  assert.equal(saved.state.rows[0].completed, 1);
  assert.equal(saved.state.rows[1].pending, 1);
  for (const row of saved.state.rows) {
    assert.equal(row.route, 'proxy'); assert.equal(row.source, 'user'); assert.equal(row.stale, true);
  }
  assert.equal(w.chrome.webRequest.onBeforeRequest.listeners.length, 0);
  assert.equal(formalWrites(w).length, 1);
  assert.ok(Object.hasOwn(formalWrites(w)[0], 'diagnosticRuleUndo'), 'rules and undo receipt commit atomically');
  assert.equal(saved.state.ruleUndo.canUndo, true);
  assert.equal(saved.state.ruleUndo.actionId, 'action-1');
  assert.equal(saved.state.ruleUndo.sessionId, sessionId);
  assert.equal(saved.state.ruleUndo.tabId, 1);
  assert.deepEqual(copy(saved.state.ruleUndo.hosts), ['challenge.example', 'cdn.example']);
});

test('direct whitelist add uses the same one-step save without changing proxy or other formal fields', async () => {
  const { w, sessionId } = await observedWorker();
  w.data.gfwDomains = ['challenge.example']; w.data.tempRules = ['temporary.example'];
  const saved = await addRules(w, sessionId, ['challenge.example'], 'direct');
  assert.equal(saved.success, true);
  assert.deepEqual(w.data.userWhitelist, ['challenge.example']);
  assert.deepEqual(w.data.userRules, ['site.example']);
  assert.deepEqual(w.data.gfwDomains, ['challenge.example']);
  assert.deepEqual(w.data.tempRules, ['temporary.example']);
  assert.equal(saved.state.ruleUndo.direction, 'direct');
  assert.equal(saved.state.rows[0].route, 'direct');
  assert.equal(saved.state.rows[0].source, 'whitelist');
  assert.equal(w.reloads.length, 1); assert.equal(w.settings.value.mode, 'pac_script');
});

test('direct WebSocket rule add stores only a host and makes the observed connection use user routing', async () => {
  const { w, sessionId } = await observedWorker({}, []);
  w.requestUrl('wss://hatch.metaaivm.com/v1/noise?token=private', 'socket');
  const saved = await addRules(w, sessionId, ['hatch.metaaivm.com']);
  assert.equal(saved.success, true);
  assert.deepEqual(w.data.userRules, ['site.example', 'hatch.metaaivm.com']);
  assert.deepEqual(copy(saved.state.rows[0].types), ['websocket']);
  assert.equal(saved.state.rows[0].route, 'proxy');
  assert.equal(saved.state.rows[0].pending, 1);
  assert.doesNotMatch(JSON.stringify(w.data.diagnosticRuleUndo), /wss:|\/v1\/noise|token|private/);
});

test('direct add rejects unobserved, noncanonical, path-bearing, local and oversized host selections', async () => {
  const { w, sessionId } = await observedWorker();
  const bad = [
    [], ['unobserved.example'], ['wss://challenge.example/noise'], ['challenge.example/noise'],
    ['CHALLENGE.EXAMPLE'], [' challenge.example '], ['challenge.example.'], ['localhost'],
    ['127.0.0.1'], ['192.168.1.1'], ['10.0.0.1'], ['printer.local'], ['::1'], [null], [123],
    Array.from({ length: 201 }, () => 'challenge.example'),
  ];
  for (const hosts of bad) {
    const failed = await addRules(w, sessionId, hosts);
    assert.equal(failed.success, false, JSON.stringify(hosts));
    assert.equal(failed.error, 'invalid_hosts', JSON.stringify(hosts));
  }
  assert.equal(formalWrites(w).length, 0); assert.equal(w.refreshCalls(), 0);
  assert.deepEqual(w.data.userRules, ['site.example']);
});

test('direct add rejects invalid directions and action identifiers without creating a receipt', async () => {
  const { w, sessionId } = await observedWorker();
  for (const direction of ['system', 'global', '', null]) {
    assert.equal((await addRules(w, sessionId, undefined, direction)).error, 'invalid_direction');
  }
  for (const actionId of ['', null, 123, 'x'.repeat(129), '私人行动', 'abc\nprivate', 'https://private.example/token']) {
    const failed = await addRules(w, sessionId, undefined, 'proxy', actionId);
    assert.equal(failed.success, false, String(actionId));
    assert.equal(failed.error, 'invalid_action', String(actionId));
  }
  assert.equal(w.data.diagnosticRuleUndo, undefined); assert.equal(formalWrites(w).length, 0);
});

test('direct add cannot target a missing or stale session', async () => {
  const w = await worker();
  assert.equal((await addRules(w, 'not-found')).error, 'session_not_found');
  const first = await w.start(); const second = await w.start(); w.request('challenge.example');
  const failed = await addRules(w, first.state.session.id);
  assert.equal(failed.error, 'session_not_found');
  assert.equal(failed.state.session.id, second.state.session.id);
  assert.equal(formalWrites(w).length, 0);
});

test('direct add requires optional request permission and refuses an active temporary trial', async () => {
  const { w, sessionId } = await observedWorker();
  w.revoke();
  assert.equal((await addRules(w, sessionId)).error, 'permission_required');
  assert.equal(formalWrites(w).length, 0);
  const next = await observedWorker();
  const applied = await next.w.send({ type: 'PS_DIAG_APPLY', sessionId: next.sessionId, hosts: ['challenge.example'], direction: 'proxy' });
  const failed = await addRules(next.w, next.sessionId);
  assert.equal(failed.error, 'trial_conflict');
  assert.equal(failed.state.trial.id, applied.state.trial.id);
  assert.deepEqual(next.w.data.userRules, ['site.example']);
});

test('direct add requires owned Auto mode and an available server but never takes over proxy ownership', async () => {
  for (const [options, error] of [
    [{ mode: 'system' }, 'mode_required'], [{ mode: 'direct' }, 'mode_required'],
    [{ mode: 'fixed_servers' }, 'mode_required'], [{ control: 'controlled_by_other_extensions' }, 'proxy_uncontrolled'],
  ]) {
    const { w, sessionId } = await observedWorker(options);
    assert.equal((await addRules(w, sessionId)).error, error);
    assert.equal(formalWrites(w).length, 0); assert.equal(w.refreshCalls(), 0);
    assert.equal(w.settings.value.mode, options.mode || 'pac_script');
  }
  const { w, sessionId } = await observedWorker();
  w.data.serverList = [];
  assert.equal((await addRules(w, sessionId)).error, 'no_server');
  assert.equal(formalWrites(w).length, 0);
});

test('direct add rejects changed, restricted, incognito and closed source tabs', async () => {
  for (const [change, error] of [
    [w => { w.tabs.get(1).url = 'https://changed.example/'; }, 'session_conflict'],
    [w => { w.tabs.get(1).url = 'wss://site.example/noise'; }, 'restricted_tab'],
    [w => { w.tabs.get(1).url = 'chrome://settings'; }, 'restricted_tab'],
    [w => { w.tabs.get(1).incognito = true; }, 'restricted_tab'],
    [w => { w.tabs.delete(1); }, 'tab_closed'],
  ]) {
    const { w, sessionId } = await observedWorker(); change(w);
    assert.equal((await addRules(w, sessionId)).error, error);
    assert.equal(formalWrites(w).length, 0); assert.equal(w.refreshCalls(), 0);
  }
});

test('opposite exact and parent rules block one-step add instead of deleting existing choices', async () => {
  for (const [direction, key, rule] of [
    ['proxy', 'userWhitelist', 'challenge.example'], ['proxy', 'userWhitelist', 'example'],
    ['direct', 'userRules', 'challenge.example'], ['direct', 'userRules', '*.example'],
  ]) {
    const { w, sessionId } = await observedWorker();
    w.data[key] = [rule];
    const snapshot = copy({ rules: w.data.userRules, whitelist: w.data.userWhitelist });
    const failed = await addRules(w, sessionId, undefined, direction);
    assert.equal(failed.error, 'rule_conflict', rule);
    assert.deepEqual({ rules: w.data.userRules, whitelist: w.data.userWhitelist }, snapshot);
    assert.equal(formalWrites(w).length, 0); assert.equal(w.data.diagnosticRuleUndo, undefined);
  }
});

test('one-step add deduplicates exact existing hosts and records only its actual additions', async () => {
  const { w, sessionId } = await observedWorker({}, ['site.example', 'challenge.example']);
  const saved = await addRules(w, sessionId, ['site.example', 'challenge.example', 'challenge.example']);
  assert.equal(saved.success, true);
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
  assert.deepEqual(copy(saved.state.ruleUndo.hosts), ['challenge.example']);
  assert.equal((await undoRules(w, saved.state.ruleUndo.id)).success, true);
  assert.deepEqual(w.data.userRules, ['site.example']);
});

test('direct add reads formal fields inside the shared queue and preserves preceding edits', async () => {
  let enter; let release;
  const waiting = new Promise(resolve => { enter = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const { w, sessionId } = await observedWorker({ beforeMutation: async ({ data }) => {
    enter(); await barrier; data.userRules.push('queued-edit.example');
  } });
  const pending = addRules(w, sessionId);
  await waiting;
  assert.equal(formalWrites(w).length, 0);
  release();
  const result = await pending;
  assert.equal(result.success, true);
  assert.deepEqual(w.data.userRules, ['site.example', 'queued-edit.example', 'challenge.example']);
  assert.equal(w.mutations(), 1);
});

test('guards are revalidated after entering the shared configuration lease', async () => {
  for (const [mutate, error] of [
    [({ data }) => { data.userWhitelist = ['challenge.example']; }, 'rule_conflict'],
    [({ settings }) => { settings.value.mode = 'system'; }, 'mode_required'],
    [({ settings }) => { settings.levelOfControl = 'controlled_by_other_extensions'; }, 'proxy_uncontrolled'],
    [({ tabs }) => { tabs.get(1).url = 'https://changed.example/'; }, 'session_conflict'],
    [({ chrome }) => {
      chrome.permissions.contains = (_filter, callback) => queueMicrotask(() => callback(false));
      chrome.permissions.onRemoved.emit({ permissions: ['webRequest'] });
    }, 'permission_required'],
  ]) {
    const { w, sessionId } = await observedWorker({ beforeMutation: mutate });
    const failed = await addRules(w, sessionId);
    assert.equal(failed.success, false); assert.equal(failed.error, error);
    assert.equal(formalWrites(w).length, 0); assert.equal(w.data.diagnosticRuleUndo, undefined);
  }
});

test('an unacknowledged one-step storage write retains its lease and cannot report success', async () => {
  const { w, sessionId } = await observedWorker();
  w.hold('set', items => Object.hasOwn(items, 'userRules'));
  let finished = false;
  const pending = addRules(w, sessionId).then(result => { finished = true; return result; });
  await w.tick();
  assert.equal(w.held.length, 1); assert.equal(finished, false);
  assert.deepEqual(w.data.userRules, ['site.example']); assert.equal(w.data.diagnosticRuleUndo, undefined);
  let competing = false;
  const queued = w.mutateConfiguration(() => { competing = true; w.data.userRules.push('competing.example'); });
  await w.tick(); assert.equal(competing, false);
  w.release();
  assert.equal((await pending).success, true);
  await queued;
  assert.equal(competing, true);
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example', 'competing.example']);
});

test('late successful write callback is acknowledged once and queued duplicate action is idempotent', async () => {
  const { w, sessionId } = await observedWorker();
  w.hold('set', items => Object.hasOwn(items, 'userRules'));
  const pending = addRules(w, sessionId);
  await w.tick();
  const duplicate = addRules(w, sessionId);
  w.advance(9000);
  await w.tick(); assert.equal(formalWrites(w).length, 0);
  w.release();
  const [first, second] = await Promise.all([pending, duplicate]);
  assert.equal(first.success, true); assert.equal(second.success, true);
  assert.equal(first.state.ruleUndo.id, second.state.ruleUndo.id);
  assert.equal(formalWrites(w).length, 1); assert.equal(w.refreshCalls(), 1);
});

test('failed direct rule storage write leaves formal rules and success receipt unchanged', async () => {
  const { w, sessionId } = await observedWorker();
  w.fail('set');
  const failed = await addRules(w, sessionId);
  assert.equal(failed.success, false); assert.equal(failed.error, 'storage_failed');
  assert.deepEqual(w.data.userRules, ['site.example']);
  assert.equal(w.data.diagnosticRuleUndo, undefined); assert.equal(failed.state.ruleUndo, null);
  assert.equal(w.refreshCalls(), 0);
  w.fail(null);
  assert.equal((await addRules(w, sessionId)).success, true, 'same action may retry if its write never committed');
});

test('duplicate committed action returns the existing receipt without a second write or extended undo deadline', async () => {
  const { w, sessionId } = await observedWorker();
  const first = await addRules(w, sessionId);
  w.advance(60000);
  const second = await addRules(w, sessionId);
  assert.equal(second.success, true);
  assert.equal(second.state.ruleUndo.id, first.state.ruleUndo.id);
  assert.equal(second.state.ruleUndo.expiresAt, first.state.ruleUndo.expiresAt);
  assert.equal(formalWrites(w).length, 1); assert.equal(w.refreshCalls(), 1);
});

test('reusing a committed action identifier with another payload is rejected', async () => {
  const { w, sessionId } = await observedWorker({}, ['challenge.example', 'cdn.example']);
  await addRules(w, sessionId);
  const changed = await addRules(w, sessionId, ['cdn.example']);
  assert.equal(changed.success, false); assert.equal(changed.error, 'invalid_action');
  assert.equal(formalWrites(w).length, 1);
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
});

test('proxy application failure keeps committed formal rules and a pending retryable undo receipt', async () => {
  const { w, sessionId } = await observedWorker();
  w.fail('refresh');
  const failed = await addRules(w, sessionId);
  assert.equal(failed.success, false); assert.equal(failed.error, 'proxy_failed');
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
  assert.equal(failed.state.ruleUndo.pendingApply, true); assert.equal(failed.state.ruleUndo.canUndo, true);
  assert.equal(w.data.diagnosticRuleUndo.pendingApply, true);
  const duplicate = await addRules(w, sessionId);
  assert.equal(duplicate.state.ruleUndo.id, failed.state.ruleUndo.id);
  assert.equal(formalWrites(w).length, 1); assert.equal(w.refreshCalls(), 1);
  w.fail(null);
  const retried = await retryRules(w, failed.state.ruleUndo.id);
  assert.equal(retried.success, true); assert.equal(retried.state.ruleUndo.pendingApply, false);
  assert.equal(formalWrites(w).length, 1); assert.equal(w.refreshCalls(), 2);
  assert.equal(w.reloads.length, 1);
});

test('mode change during proxy refresh does not turn Auto back on or lose persisted rules', async () => {
  const { w, sessionId } = await observedWorker({ beforeRefresh: ({ settings }) => { settings.value.mode = 'system'; } });
  const saved = await addRules(w, sessionId);
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
  assert.equal(w.settings.value.mode, 'system');
  assert.equal(w.reloads.length, 1); assert.ok(saved.state.ruleUndo);
  assert.equal(formalWrites(w).length, 1);
});

test('undo removes only new exact rules and remains available outside Auto without switching mode', async () => {
  for (const direction of ['proxy', 'direct']) {
    const { w, sessionId } = await observedWorker();
    const saved = await addRules(w, sessionId, undefined, direction);
    w.settings.value.mode = 'system';
    const undone = await undoRules(w, saved.state.ruleUndo.id);
    assert.equal(undone.success, true); assert.equal(w.settings.value.mode, 'system');
    assert.deepEqual(w.data.userRules, ['site.example']); assert.deepEqual(w.data.userWhitelist, []);
    assert.equal(undone.state.ruleUndo.undone, true); assert.equal(undone.state.ruleUndo.canUndo, false);
    assert.equal(w.reloads.length, 1);
  }
});

test('undo refuses changed target-list digest and never overwrites edits from elsewhere', async () => {
  const { w, sessionId } = await observedWorker();
  const saved = await addRules(w, sessionId);
  w.data.userRules.push('later-user-edit.example');
  assert.equal((await w.get()).state.ruleUndo.canUndo, false);
  const undone = await undoRules(w, saved.state.ruleUndo.id);
  assert.equal(undone.success, false); assert.equal(undone.error, 'rule_undo_conflict');
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example', 'later-user-edit.example']);
  assert.equal(formalWrites(w).length, 1);
});

test('undo target digest is freshly checked inside the shared mutation queue', async () => {
  let writes = 0;
  const { w, sessionId } = await observedWorker({ beforeMutation: ({ data }) => {
    if (++writes === 2) data.userRules.push('lease-edit.example');
  } });
  const saved = await addRules(w, sessionId);
  const undone = await undoRules(w, saved.state.ruleUndo.id);
  assert.equal(undone.error, 'rule_undo_conflict');
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example', 'lease-edit.example']);
  assert.equal(formalWrites(w).length, 1);
});

test('failed undo storage commit retains the still-valid undo and formal rules', async () => {
  const { w, sessionId } = await observedWorker();
  const saved = await addRules(w, sessionId);
  w.fail('set');
  const failed = await undoRules(w, saved.state.ruleUndo.id);
  assert.equal(failed.error, 'storage_failed');
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
  assert.equal(failed.state.ruleUndo.canUndo, true); assert.equal(failed.state.ruleUndo.undone, false);
  w.fail(null);
  assert.equal((await undoRules(w, saved.state.ruleUndo.id)).success, true);
  assert.deepEqual(w.data.userRules, ['site.example']);
});

test('failed undo PAC refresh retains an undone pending tombstone and retry does not delete again', async () => {
  const { w, sessionId } = await observedWorker();
  const saved = await addRules(w, sessionId);
  w.fail('refresh');
  const failed = await undoRules(w, saved.state.ruleUndo.id);
  assert.equal(failed.error, 'proxy_failed'); assert.deepEqual(w.data.userRules, ['site.example']);
  assert.equal(failed.state.ruleUndo.undone, true); assert.equal(failed.state.ruleUndo.pendingApply, true);
  assert.equal(failed.state.ruleUndo.canUndo, false);
  const count = formalWrites(w).length;
  w.data.userRules.push('independent.example'); w.fail(null);
  const retried = await retryRules(w, saved.state.ruleUndo.id);
  assert.equal(retried.success, true); assert.equal(retried.state.ruleUndo.pendingApply, false);
  assert.equal(formalWrites(w).length, count);
  assert.deepEqual(w.data.userRules, ['site.example', 'independent.example']);
});

test('ordinary worker hydration restores one-step undo without repeating the formal mutation', async () => {
  const first = await observedWorker();
  const saved = await addRules(first.w, first.sessionId);
  await first.w.flush();
  const restarted = await worker({ data: first.w.data });
  const state = (await restarted.get()).state;
  assert.equal(state.ruleUndo.id, saved.state.ruleUndo.id); assert.equal(state.ruleUndo.canUndo, true);
  assert.equal(formalWrites(restarted).length, 0); assert.equal(restarted.refreshCalls(), 0);
  const duplicate = await addRules(restarted, first.sessionId);
  assert.equal(duplicate.success, true); assert.equal(duplicate.state.ruleUndo.id, saved.state.ruleUndo.id);
  assert.equal(formalWrites(restarted).length, 0);
  assert.equal((await undoRules(restarted, saved.state.ruleUndo.id)).success, true);
  assert.deepEqual(restarted.data.userRules, ['site.example']);
});

test('pending add application survives worker hydration and explicit retry does not merge again', async () => {
  const first = await observedWorker(); first.w.fail('refresh');
  const failed = await addRules(first.w, first.sessionId);
  await first.w.flush();
  const restarted = await worker({ data: first.w.data });
  const state = (await restarted.get()).state;
  assert.equal(state.ruleUndo.pendingApply, true);
  assert.deepEqual(restarted.data.userRules, ['site.example', 'challenge.example']);
  assert.equal((await retryRules(restarted, failed.state.ruleUndo.id)).success, true);
  assert.equal(formalWrites(restarted).length, 0);
});

test('undo receipt stores a bounded delta and SHA-256 digest, not original rule snapshots or payload secrets', async () => {
  const { w, sessionId } = await observedWorker();
  w.data.userRules.push('original-private-rule.example');
  const payload = {
    type: 'PS_DIAG_ADD_RULES', sessionId, hosts: ['challenge.example'], direction: 'proxy', actionId: 'safe-action',
    url: 'https://private.example/token', cookies: 'secret-cookie', token: 'secret-token',
    beforeRules: ['forged-private.example'], frames: ['secret-chat'], requestHeaders: ['secret-auth'],
  };
  const saved = await w.send(payload); assert.equal(saved.success, true);
  const receipt = w.data.diagnosticRuleUndo;
  assert.ok(receipt);
  assert.ok(Object.values(receipt).some(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)), 'receipt stores SHA-256');
  assert.doesNotMatch(JSON.stringify(receipt), /original-private|forged-private|secret|https:|beforeRules|requestHeaders|frames|cookies|token/i);
  assert.deepEqual(copy(receipt.hosts), ['challenge.example']);
  assert.deepEqual(Object.keys(saved.state.ruleUndo).sort(), ['actionId', 'canUndo', 'direction', 'expiresAt', 'hosts', 'id', 'pendingApply', 'sessionId', 'tabId', 'undone'].sort());
});

test('poisoned persisted undo private fields are discarded while a valid delta remains usable', async () => {
  const first = await observedWorker();
  const saved = await addRules(first.w, first.sessionId); await first.w.flush();
  Object.assign(first.w.data.diagnosticRuleUndo, {
    beforeRules: ['private-before.example'], url: 'https://private.example/token', frames: ['private-chat'],
    cookies: 'private-cookie', extra: 'private-extra',
  });
  const restarted = await worker({ data: first.w.data });
  const state = (await restarted.get()).state;
  assert.equal(state.ruleUndo.id, saved.state.ruleUndo.id);
  assert.doesNotMatch(JSON.stringify(state.ruleUndo), /private|beforeRules|frames|cookies|url/i);
  assert.doesNotMatch(JSON.stringify(restarted.data.diagnosticRuleUndo), /private|beforeRules|frames|cookies|url/i);
  assert.equal((await undoRules(restarted, saved.state.ruleUndo.id)).success, true);
});

test('clearing capture, a new session and browser startup discard receipts but never undo formal rules', async () => {
  for (const cleanup of ['clear', 'start', 'startup']) {
    const { w, sessionId } = await observedWorker();
    const saved = await addRules(w, sessionId);
    if (cleanup === 'clear') await w.send({ type: 'PS_DIAG_CLEAR', sessionId });
    else if (cleanup === 'start') await w.start();
    else w.chrome.runtime.onStartup.emit();
    const state = (await w.get()).state;
    assert.equal(state.ruleUndo, null, cleanup); assert.equal(w.data.diagnosticRuleUndo, undefined, cleanup);
    assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
    assert.equal((await undoRules(w, saved.state.ruleUndo.id)).success, false, cleanup);
    assert.equal(formalWrites(w).length, 1, cleanup);
  }
});

test('undo expiration and capture retention cleanup keep the added permanent rule', async () => {
  for (const age of [10 * 60000, 31 * 60000]) {
    const { w, sessionId } = await observedWorker();
    const saved = await addRules(w, sessionId);
    assert.equal(saved.state.ruleUndo.expiresAt, 100000 + 10 * 60000);
    w.advance(age);
    const state = (await w.get()).state;
    assert.equal(state.ruleUndo, null);
    assert.equal(w.data.diagnosticRuleUndo, undefined);
    assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
    assert.equal((await undoRules(w, saved.state.ruleUndo.id)).success, false);
    assert.equal(formalWrites(w).length, 1);
  }
});

test('revoking collection permission after a successful add never rolls back permanent rules', async () => {
  const { w, sessionId } = await observedWorker();
  const saved = await addRules(w, sessionId);
  w.revoke();
  const state = (await w.get()).state;
  assert.equal(state.permission, false);
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
  assert.equal(formalWrites(w).length, 1);
  assert.equal((await undoRules(w, saved.state.ruleUndo.id)).success, true, 'undo is not a new request capture');
  assert.deepEqual(w.data.userRules, ['site.example']);
});

test('another direct add on the retained session replaces only the last undo receipt', async () => {
  const { w, sessionId } = await observedWorker({}, ['challenge.example', 'cdn.example']);
  const first = await addRules(w, sessionId);
  w.advance(1000);
  const second = await addRules(w, sessionId, ['cdn.example'], 'proxy', 'action-2');
  assert.equal(second.success, true);
  assert.notEqual(second.state.ruleUndo.id, first.state.ruleUndo.id);
  assert.deepEqual(copy(second.state.ruleUndo.hosts), ['cdn.example']);
  assert.equal(second.state.session.id, sessionId);
  assert.equal(second.state.session.startedAt, 100000);
  assert.equal(second.state.ruleUndo.expiresAt, 701000);
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example', 'cdn.example']);
  assert.equal((await undoRules(w, first.state.ruleUndo.id)).error, 'rule_undo_not_found');
  assert.equal((await undoRules(w, second.state.ruleUndo.id)).success, true);
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
  assert.equal(w.reloads.length, 1);
});

test('adding only existing exact rules does not rewrite or accidentally remove those rules', async () => {
  const { w, sessionId } = await observedWorker({}, ['site.example']);
  const saved = await addRules(w, sessionId, ['site.example']);
  assert.equal(saved.success, true);
  assert.equal(formalWrites(w).length, 0);
  assert.deepEqual(copy(saved.state.ruleUndo.hosts), []);
  assert.equal(saved.state.ruleUndo.canUndo, false);
  assert.deepEqual(w.data.userRules, ['site.example']);
});

test('one-step direct add handles the entire bounded set of 200 observed hosts', async () => {
  const hosts = Array.from({ length: 200 }, (_, index) => `domain-${index}.example`);
  const { w, sessionId } = await observedWorker({}, hosts);
  const saved = await addRules(w, sessionId, hosts);
  assert.equal(saved.success, true);
  assert.equal(saved.state.ruleUndo.hosts.length, 200);
  assert.deepEqual(w.data.userRules, ['site.example', ...hosts]);
  assert.equal(formalWrites(w).length, 1);
  assert.equal((await undoRules(w, saved.state.ruleUndo.id)).success, true);
  assert.deepEqual(w.data.userRules, ['site.example']);
});

test('corrupt existing target-list types are rejected rather than overwritten during direct add', async () => {
  for (const invalid of ['site.example', { rules: ['site.example'] }, null, 123]) {
    const { w, sessionId } = await observedWorker();
    w.data.userRules = copy(invalid);
    const failed = await addRules(w, sessionId);
    assert.equal(failed.success, false);
    assert.equal(failed.error, 'invalid_rules');
    assert.deepEqual(w.data.userRules, invalid);
    assert.equal(formalWrites(w).length, 0); assert.equal(w.data.diagnosticRuleUndo, undefined);
  }
});

test('the formal rule limit is checked before one-step save dispatch', async () => {
  const { w, sessionId } = await observedWorker();
  w.data.userRules = Array.from({ length: 100000 }, () => 'site.example');
  const failed = await addRules(w, sessionId);
  assert.equal(failed.error, 'invalid_rules');
  assert.equal(w.data.userRules.length, 100000);
  assert.equal(formalWrites(w).length, 0); assert.equal(w.data.diagnosticRuleUndo, undefined);
});

test('digest rejection cannot commit rules or cache a permanently failed retry', async () => {
  const { w, sessionId } = await observedWorker();
  w.fail('digest');
  const failed = await addRules(w, sessionId);
  assert.equal(failed.success, false);
  assert.equal(formalWrites(w).length, 0); assert.equal(w.data.diagnosticRuleUndo, undefined);
  assert.deepEqual(w.data.userRules, ['site.example']);
  assert.doesNotMatch(JSON.stringify(failed), /private digest failure/);
  w.fail(null);
  const retried = await addRules(w, sessionId);
  assert.equal(retried.success, true);
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
});

test('receipt hydration rejects mismatched sessions and tabs without rolling back formal rules', async () => {
  const first = await observedWorker();
  await addRules(first.w, first.sessionId); await first.w.flush();
  for (const patch of [{ sessionId: 'other-session' }, { tabId: 2 }]) {
    const data = copy(first.w.data);
    Object.assign(data.diagnosticRuleUndo, patch);
    const restarted = await worker({ data });
    assert.equal((await restarted.get()).state.ruleUndo, null);
    assert.equal(restarted.data.diagnosticRuleUndo, undefined);
    assert.deepEqual(restarted.data.userRules, ['site.example', 'challenge.example']);
    assert.equal(formalWrites(restarted).length, 0);
  }
});

test('receipt hydration rejects duplicated, local, unobserved and non-subset host deltas', async () => {
  const first = await observedWorker();
  await addRules(first.w, first.sessionId); await first.w.flush();
  for (const patch of [
    { hosts: ['challenge.example', 'challenge.example'] },
    { requestedHosts: ['challenge.example', 'challenge.example'] },
    { hosts: ['unobserved.example'] }, { requestedHosts: ['unobserved.example'] },
    { hosts: ['localhost'], requestedHosts: ['localhost'] },
    { hosts: ['challenge.example'], requestedHosts: ['site.example'] },
    { hosts: ['wss://challenge.example/noise'] }, { hosts: ['CHALLENGE.EXAMPLE'] },
  ]) {
    const data = copy(first.w.data); Object.assign(data.diagnosticRuleUndo, patch);
    const restarted = await worker({ data });
    const state = (await restarted.get()).state;
    assert.equal(state.ruleUndo, null, JSON.stringify(patch));
    assert.equal(restarted.data.diagnosticRuleUndo, undefined, JSON.stringify(patch));
    assert.deepEqual(restarted.data.userRules, ['site.example', 'challenge.example']);
  }
});

test('receipt hydration rejects private-looking identifiers, invalid digests and invalid flags', async () => {
  const first = await observedWorker();
  await addRules(first.w, first.sessionId); await first.w.flush();
  for (const patch of [
    { id: 'https://private.example/token' }, { id: 'x'.repeat(129) }, { id: '' },
    { actionId: 'private\nmessage' }, { afterDigest: 'not-a-digest' }, { afterDigest: 'A'.repeat(64) },
    { expiresAt: 100000 + 11 * 60000 }, { pendingApply: 'true' }, { undone: 'false' },
  ]) {
    const data = copy(first.w.data); Object.assign(data.diagnosticRuleUndo, patch);
    const restarted = await worker({ data });
    assert.equal((await restarted.get()).state.ruleUndo, null, JSON.stringify(patch));
    assert.equal(restarted.data.diagnosticRuleUndo, undefined, JSON.stringify(patch));
    assert.deepEqual(restarted.data.userRules, ['site.example', 'challenge.example']);
  }
});

test('retrying committed add after a later edit applies current configuration without re-merging the batch', async () => {
  const { w, sessionId } = await observedWorker(); w.fail('refresh');
  const failed = await addRules(w, sessionId);
  await new Promise(resolve => w.chrome.storage.local.set({ userRules: ['site.example', 'later.example'] }, resolve));
  assert.equal((await w.get()).state.ruleUndo.canUndo, false);
  const count = formalWrites(w).length; w.fail(null);
  const retried = await retryRules(w, failed.state.ruleUndo.id);
  assert.equal(retried.success, true); assert.equal(retried.state.ruleUndo.pendingApply, false);
  assert.equal(formalWrites(w).length, count);
  assert.deepEqual(w.data.userRules, ['site.example', 'later.example']);
  assert.equal(retried.state.ruleUndo.canUndo, false);
  assert.equal(w.reloads.length, 1);
});

test('unknown or stale permanent receipt operations never modify formal rules', async () => {
  const { w, sessionId } = await observedWorker();
  for (const send of [undoRules, retryRules]) assert.equal((await send(w, 'not-found')).error, 'rule_undo_not_found');
  const saved = await addRules(w, sessionId);
  for (const send of [undoRules, retryRules]) assert.equal((await send(w, 'stale-id')).error, 'rule_undo_not_found');
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
  assert.equal(formalWrites(w).length, 1);
  assert.equal(saved.state.ruleUndo.canUndo, true);
});

test('repeated undo is idempotent and cannot delete a subsequently restored exact rule', async () => {
  const { w, sessionId } = await observedWorker();
  const saved = await addRules(w, sessionId);
  assert.equal((await undoRules(w, saved.state.ruleUndo.id)).success, true);
  const count = formalWrites(w).length;
  w.data.userRules.push('challenge.example');
  const duplicate = await undoRules(w, saved.state.ruleUndo.id);
  assert.equal(duplicate.success, true); assert.equal(duplicate.state.ruleUndo.canUndo, false);
  assert.equal(formalWrites(w).length, count);
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
});

test('timed-out prerequisite reads never commit direct rules when their callback arrives late', async () => {
  for (const [operation, predicate] of [
    ['get', keys => Array.isArray(keys) && keys.includes('userRules')], ['proxy'], ['permission'], ['tab'],
  ]) {
    const { w, sessionId } = await observedWorker();
    w.hold(operation, predicate);
    const pending = addRules(w, sessionId);
    await w.tick();
    assert.equal(w.held.length, 1, operation);
    w.fireTimers(); w.release();
    const failed = await pending;
    assert.equal(failed.success, false, operation);
    assert.equal(formalWrites(w).length, 0, operation);
    assert.equal(w.data.diagnosticRuleUndo, undefined, operation);
    assert.deepEqual(w.data.userRules, ['site.example']);
    assert.equal((await addRules(w, sessionId)).success, true, operation);
  }
});

test('storage writes have no timer-driven success or rollback while acknowledgment is missing', async () => {
  const { w, sessionId } = await observedWorker();
  w.hold('set', items => Object.hasOwn(items, 'userRules'));
  let settled = false;
  const pending = addRules(w, sessionId).then(result => { settled = true; return result; });
  await w.tick(); assert.equal(w.held.length, 1);
  w.advance(9000); w.fireTimers(); await w.tick();
  assert.equal(settled, false);
  assert.equal(formalWrites(w).length, 0); assert.deepEqual(w.data.userRules, ['site.example']);
  w.release();
  assert.equal((await pending).success, true);
  assert.equal(formalWrites(w).length, 1); assert.equal(w.refreshCalls(), 1);
});

test('a pending PAC application keeps formal rules and its receipt while both queues wait', async () => {
  let reached; let resume;
  const started = new Promise(resolve => { reached = resolve; });
  const barrier = new Promise(resolve => { resume = resolve; });
  const { w, sessionId } = await observedWorker({ beforeRefresh: async () => { reached(); await barrier; } });
  let settled = false;
  const pending = addRules(w, sessionId).then(result => { settled = true; return result; });
  await started;
  assert.equal(settled, false); assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
  assert.equal(w.data.diagnosticRuleUndo.pendingApply, true);
  let competing = false;
  const next = w.mutateConfiguration(() => { competing = true; });
  w.advance(9000); w.fireTimers(); await w.tick();
  assert.equal(competing, false); assert.equal(settled, false);
  resume();
  const saved = await pending; await next;
  assert.equal(saved.success, true); assert.equal(saved.state.ruleUndo.pendingApply, false);
  assert.equal(competing, true); assert.equal(formalWrites(w).length, 1);
});

test('pending formal-rule application blocks new adds and temporary trials without replacing the receipt', async () => {
  const { w, sessionId } = await observedWorker({}, ['challenge.example', 'cdn.example']); w.fail('refresh');
  const failed = await addRules(w, sessionId);
  assert.equal(failed.state.ruleUndo.pendingApply, true);
  const next = await addRules(w, sessionId, ['cdn.example'], 'proxy', 'next-action');
  assert.equal(next.error, 'rule_application_pending');
  const trial = await w.send({ type: 'PS_DIAG_APPLY', sessionId, hosts: ['cdn.example'], direction: 'proxy' });
  assert.equal(trial.error, 'rule_application_pending');
  assert.equal(w.data.diagnosticTrial, undefined);
  assert.equal((await w.get()).state.ruleUndo.id, failed.state.ruleUndo.id);
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
  assert.equal(formalWrites(w).length, 1);
});

test('external storage reset cannot recreate a deleted capture, selection or formal-rule receipt', async () => {
  const { w, sessionId } = await observedWorker();
  await addRules(w, sessionId); await w.flush();
  w.data.diagnosticUiState = { sessionId, selected: ['challenge.example'], expiresAt: 700000 };
  const before = w.writes.length;
  await new Promise(resolve => w.chrome.storage.local.clear(resolve));
  const state = (await w.get()).state;
  assert.equal(state.session, null); assert.equal(state.ruleUndo, null); assert.equal(state.trial, null);
  assert.equal(w.data.diagnosticSession, undefined);
  assert.equal(w.data.diagnosticRuleUndo, undefined); assert.equal(w.data.diagnosticUiState, undefined);
  assert.equal(w.data.userRules, undefined); assert.equal(w.data.userWhitelist, undefined);
  assert.equal(w.chrome.webRequest.onBeforeRequest.listeners.length, 0);
  assert.equal(w.chrome.alarms.scheduled, null);
  assert.equal(w.writes.slice(before).some(items => Object.hasOwn(items, 'diagnosticSession') || Object.hasOwn(items, 'diagnosticRuleUndo')), false);
});

test('a late metadata deletion event cannot clear a newer capture and its new undo receipt', async () => {
  const { w, sessionId } = await observedWorker();
  await addRules(w, sessionId); await w.flush();
  const originalEmit = w.chrome.storage.onChanged.emit;
  const delayed = [];
  w.chrome.storage.onChanged.emit = (changes, area) => {
    if (changes.diagnosticSession && changes.diagnosticSession.newValue === undefined) delayed.push([changes, area]);
    else originalEmit(changes, area);
  };
  await new Promise(resolve => w.chrome.storage.local.clear(resolve));
  assert.equal(delayed.length, 1);
  await new Promise(resolve => w.chrome.storage.local.set({
    serverList: [{ id: 'a', host: '127.0.0.1', port: 7897 }], activeServerId: 'a', userRules: ['site.example'], userWhitelist: [],
  }, resolve));
  const next = await w.start(); assert.equal(next.success, true);
  w.request('cdn.example');
  const saved = await addRules(w, next.state.session.id, ['cdn.example'], 'proxy', 'new-action');
  assert.equal(saved.success, true);
  w.chrome.storage.onChanged.emit = originalEmit;
  for (const args of delayed) originalEmit(...args);
  const state = (await w.get()).state;
  assert.equal(state.session.id, next.state.session.id);
  assert.equal(state.ruleUndo.id, saved.state.ruleUndo.id);
  assert.equal(w.data.diagnosticSession.session.id, next.state.session.id);
  assert.equal(w.data.diagnosticRuleUndo.id, saved.state.ruleUndo.id);
  assert.deepEqual(w.data.userRules, ['site.example', 'cdn.example']);
});

test('automatic recording requires separate explicit consent even after a previous permission grant', async () => {
  const w = await worker({ automatic: true });
  w.request('challenge.example');
  const before = (await w.get()).state;
  assert.equal(before.permission, true); assert.equal(before.autoCapture.enabled, false);
  assert.equal(before.session, null); assert.deepEqual(copy(before.rows), []);
  assert.equal((await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1 })).error, 'consent_required');
  const response = await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
  assert.equal(response.success, true); assert.equal(response.state.autoCapture.enabled, true);
  assert.equal(w.data.diagnosticAutoCapture, true); assert.equal(w.reloads.length, 0);
  assert.equal(w.refreshes(), 0); assert.deepEqual(w.data.userRules, ['site.example']);
});

test('automatic records are selected per tab and can be added without starting or reloading a capture', async () => {
  const w = await worker({ automatic: true });
  await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
  w.request('challenge.example', 'a'); w.error('challenge.example', undefined, 'a');
  w.request('other-api.example', 'b', 'xmlhttprequest', 2);
  const a = (await w.get()).state;
  const b = (await w.send({ type: 'PS_DIAG_GET', tabId: 2 })).state;
  assert.equal(a.session.auto, true); assert.equal(b.session.auto, true);
  assert.notEqual(a.session.id, b.session.id);
  assert.deepEqual(copy(a.rows.map(row => row.host)), ['challenge.example']);
  assert.deepEqual(copy(b.rows.map(row => row.host)), ['other-api.example']);
  const added = await addRules(w, a.session.id);
  assert.equal(added.success, true); assert.equal(added.state.ruleUndo.context, 'auto');
  assert.equal(added.state.session.tabId, 1); assert.equal(w.reloads.length, 0);
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
  assert.equal(w.data.diagnosticSession, undefined, 'automatic rows must never enter legacy local storage');
  assert.ok((await w.send({ type: 'PS_DIAG_GET', tabId: 2 })).state.rows.every(row => row.stale));
  w.request('challenge.example', 'new'); w.done('challenge.example', 'new');
  const fresh = (await w.get()).state.rows[0];
  assert.equal(fresh.route, 'proxy'); assert.equal(fresh.stale, false); assert.equal(fresh.failed, 0);
  const undone = await w.send({ type: 'PS_DIAG_UNDO_RULES', undoId: added.state.ruleUndo.id });
  assert.equal(undone.success, true); assert.deepEqual(w.data.userRules, ['site.example']);
});

test('auto disabling clears summaries but preserves permanent rules and their safe undo receipt', async () => {
  const w = await worker({ automatic: true });
  await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
  w.request('challenge.example'); const a = (await w.get()).state;
  const added = await addRules(w, a.session.id);
  const disabled = await w.send({ type: 'PS_DIAG_AUTO_DISABLE', tabId: 1 });
  assert.equal(disabled.success, true); assert.equal(disabled.state.autoCapture.enabled, false);
  assert.equal(disabled.state.session, null); assert.deepEqual(copy(disabled.state.rows), []);
  assert.equal(disabled.state.ruleUndo.id, added.state.ruleUndo.id);
  assert.equal(disabled.state.ruleUndo.canUndo, true);
  assert.equal(w.data.diagnosticAutoCapture, false); assert.equal(w.sessionData.diagnosticAutoRecords, undefined);
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
  const undone = await w.send({ type: 'PS_DIAG_UNDO_RULES', undoId: added.state.ruleUndo.id });
  assert.equal(undone.success, true); assert.deepEqual(w.data.userRules, ['site.example']);
});

test('automatic clear affects only the selected tab without navigation, rules or false capture conflicts', async () => {
  const w = await worker({ automatic: true });
  await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
  w.request('challenge.example', 'a'); w.request('other-api.example', 'b', 'script', 2);
  const a = (await w.get()).state; const b = (await w.send({ type: 'PS_DIAG_GET', tabId: 2 })).state;
  const clear = await w.send({ type: 'PS_DIAG_CLEAR', sessionId: a.session.id, tabId: 1 });
  assert.equal(clear.success, true); assert.equal(clear.state.session.id, a.session.id);
  assert.deepEqual(copy(clear.state.rows), []); assert.equal(w.reloads.length, 0);
  assert.deepEqual((await w.send({ type: 'PS_DIAG_GET', tabId: 2 })).state.rows.map(row => row.host), b.rows.map(row => row.host));
  w.request('fresh.example', 'fresh'); assert.equal((await w.get()).state.rows[0].host, 'fresh.example');
  const reload = await w.send({ type: 'PS_DIAG_START', tabId: 2 });
  assert.equal(reload.success, true); assert.deepEqual(w.reloads, [2]);
  assert.equal(reload.state.session.auto, true);
});

test('auto navigation invalidates old selection and denies a queued addition from the old epoch', async () => {
  let resume; let started;
  const gate = new Promise(resolve => { resume = resolve; }); const acquired = new Promise(resolve => { started = resolve; });
  const w = await worker({ automatic: true, beforeMutation: async () => { started(); await gate; } });
  await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
  w.request('challenge.example', 'a'); const a = (await w.get()).state;
  const pending = addRules(w, a.session.id); await acquired;
  w.request('site.example', 'navigation', 'main_frame');
  w.request('new-api.example', 'b'); resume();
  const denied = await pending;
  assert.equal(denied.success, false); assert.equal(denied.error, 'session_not_found');
  assert.deepEqual(w.data.userRules, ['site.example']);
  assert.equal(w.writes.some(items => Object.hasOwn(items, 'diagnosticRuleUndo')), false);
  assert.notEqual((await w.get()).state.session.id, a.session.id);
});

test('automatic worker wake restores session-only summaries, not a permanently pending request', async () => {
  const w = await worker({ automatic: true });
  await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
  w.request('challenge.example', 'pending'); await w.flush();
  const restored = await worker({ automatic: true, data: w.data, sessionData: w.sessionData });
  const state = (await restored.get()).state;
  assert.equal(state.autoCapture.enabled, true); assert.equal(state.session.auto, true);
  assert.equal(state.rows[0].pending, 0); assert.equal(state.rows[0].unconfirmed, 1); assert.equal(state.rows[0].failed, 0);
  assert.equal(restored.data.diagnosticSession, undefined); assert.equal(restored.reloads.length, 0);
});

test('automatic initialization failure is visible and explicit opt-in can recover without touching rules', async () => {
  const w = await worker({ automatic: true, failure: 'preference_get' });
  const before = (await w.get()).state;
  assert.equal(before.autoCapture.enabled, false);
  assert.equal(before.autoCapture.error, 'storage_failed');
  assert.equal(before.autoCapture.recovering, true);
  w.request('unconsented.example');
  assert.deepEqual(copy((await w.get()).state.rows), []);
  w.fail(null);
  const enabled = await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
  assert.equal(enabled.success, true);
  assert.equal(enabled.state.autoCapture.enabled, true);
  assert.equal(enabled.state.autoCapture.error, undefined);
  assert.equal(w.reloads.length, 0); assert.equal(w.refreshes(), 0);
  assert.deepEqual(w.data.userRules, ['site.example']);
  w.request('fresh.example');
  assert.deepEqual(copy((await w.get()).state.rows.map(row => row.host)), ['fresh.example']);
});

test('automatic rule-addition receipt survives a worker restart and can undo only its actual delta', async () => {
  const w = await worker({ automatic: true });
  await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
  w.request('challenge.example'); const observed = (await w.get()).state;
  const added = await addRules(w, observed.session.id); await w.flush();
  const restored = await worker({ automatic: true, data: w.data, sessionData: w.sessionData });
  const current = (await restored.get()).state;
  assert.equal(current.ruleUndo.id, added.state.ruleUndo.id);
  assert.equal(current.ruleUndo.context, 'auto'); assert.equal(current.ruleUndo.canUndo, true);
  const undone = await undoRules(restored, current.ruleUndo.id);
  assert.equal(undone.success, true); assert.deepEqual(restored.data.userRules, ['site.example']);
  assert.equal(restored.reloads.length, 0);
});

test('undo from a closed automatic source invalidates request facts in other tabs', async () => {
  const w = await worker({ automatic: true });
  await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
  w.request('challenge.example'); const observed = (await w.get()).state;
  const added = await addRules(w, observed.session.id);
  w.request('challenge.example', 'other', 'script', 2);
  let other = (await w.send({ type: 'PS_DIAG_GET', tabId: 2 })).state;
  assert.equal(other.rows[0].route, 'proxy'); assert.equal(other.rows[0].stale, false);
  w.tabs.delete(1); w.chrome.tabs.onRemoved.emit(1); await w.tick();
  const undone = await undoRules(w, added.state.ruleUndo.id);
  assert.equal(undone.success, true);
  other = (await w.send({ type: 'PS_DIAG_GET', tabId: 2 })).state;
  assert.equal(other.rows[0].route, 'direct'); assert.equal(other.rows[0].stale, true);
});

test('an automatic clear delayed by receipt removal cannot erase a newly navigated page', async () => {
  const w = await worker({ automatic: true });
  await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
  w.request('challenge.example'); const observed = (await w.get()).state;
  await addRules(w, observed.session.id);
  w.hold('remove', keys => keys.includes('diagnosticRuleUndo'));
  const pending = w.send({ type: 'PS_DIAG_CLEAR', sessionId: observed.session.id, tabId: 1 });
  await w.tick(); assert.equal(w.held.length, 1);
  w.request('site.example', 'navigation', 'main_frame'); w.request('fresh.example', 'new');
  w.release(); const denied = await pending;
  assert.equal(denied.success, false); assert.equal(denied.error, 'session_not_found');
  const current = (await w.get()).state;
  assert.notEqual(current.session.id, observed.session.id);
  assert.equal(current.rows.some(row => row.host === 'fresh.example'), true);
  assert.deepEqual(w.data.userRules, ['site.example', 'challenge.example']);
  assert.equal(w.reloads.length, 0);
});

test('automatic clear guards preserve active trial and pending formal-rule application', async () => {
  for (const phase of ['trial', 'pendingApply']) {
    const w = await worker({ automatic: true });
    await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
    w.request('challenge.example'); let observed = (await w.get()).state;
    if (phase === 'trial') {
      const applied = await w.send({ type: 'PS_DIAG_APPLY', sessionId: observed.session.id,
        hosts: ['challenge.example'], direction: 'proxy' });
      assert.equal(applied.success, true); w.request('challenge.example', 'next');
    } else { w.fail('refresh'); await addRules(w, observed.session.id); w.fail(null); }
    observed = (await w.get()).state;
    const denied = await w.send({ type: 'PS_DIAG_CLEAR', sessionId: observed.session.id, tabId: 1 });
    assert.equal(denied.error, phase === 'trial' ? 'trial_conflict' : 'rule_application_pending');
    assert.equal(denied.state.rows.length, observed.rows.length);
    const disabled = await w.send({ type: 'PS_DIAG_AUTO_DISABLE', tabId: 1 });
    assert.equal(disabled.success, true);
    assert.equal(phase === 'trial' ? !!disabled.state.trial : disabled.state.ruleUndo.pendingApply, true);
  }
});

test('a failed automatic disable never returns the old adopted domain summaries', async () => {
  const w = await worker({ automatic: true });
  await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
  w.request('challenge.example'); assert.equal((await w.get()).state.rows.length, 1);
  w.fail(['set', 'remove']);
  const disabled = await w.send({ type: 'PS_DIAG_AUTO_DISABLE', tabId: 1 });
  assert.equal(disabled.success, false);
  assert.equal(disabled.state.autoCapture.enabled, false);
  assert.equal(disabled.state.session, null); assert.deepEqual(copy(disabled.state.rows), []);
  assert.deepEqual(w.data.userRules, ['site.example']);
});

test('explicit reset fences a first automatic opt-in even when local clear has no preference removal event', async () => {
  const w = await worker({ automatic: true });
  assert.equal(w.data.diagnosticAutoCapture, undefined);
  w.hold('set', items => items.diagnosticAutoCapture === true);
  const enabling = w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
  await w.tick(); assert.equal(w.held.length, 1);
  const stopping = w.controller.beginReset();
  await new Promise(resolve => w.chrome.storage.local.clear(resolve));
  w.release(); await stopping;
  assert.equal((await enabling).success, false);
  w.request('after-reset.example');
  const state = (await w.get()).state;
  assert.equal(state.autoCapture.enabled, false); assert.deepEqual(copy(state.rows), []);
  assert.notEqual(w.data.diagnosticAutoCapture, true);
  assert.equal(w.data.userRules, undefined);
  assert.equal((await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true })).error, 'config_resetting');
  w.controller.endReset(false);
  assert.equal((await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true })).success, true);
});

test('automatic domain selections cannot enter the legacy local UI record', async () => {
  const w = await worker({ automatic: true });
  await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
  w.request('challenge.example'); const observed = (await w.get()).state;
  await new Promise(resolve => w.chrome.storage.local.set({ diagnosticUiState: {
    sessionId: observed.session.id, selected: ['challenge.example'], filter: 'all', expiresAt: 1000000,
  } }, resolve));
  await w.tick();
  assert.equal(w.data.diagnosticUiState, undefined);
  assert.equal((await w.get()).state.rows[0].host, 'challenge.example');
});

test('automatic selection cache is bounded, session-only and removed at its page boundary', async () => {
  const w = await worker({ automatic: true });
  await w.send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: 1, consent: true });
  w.request('challenge.example'); const observed = (await w.get()).state;
  await new Promise(resolve => w.chrome.storage.session.set({ diagnosticAutoUiState: {
    sessionId: observed.session.id, selected: ['challenge.example', 'challenge.example', 'unobserved.example'],
    filter: 'all', direction: 'proxy', expiresAt: 9000000, privateUrl: 'https://private.example/?token=secret',
    pendingMutation: { type: 'PS_DIAG_ADD_RULES', sessionId: observed.session.id, actionId: 'opaque-action', hosts: ['private.example'] },
  } }, resolve));
  await w.tick();
  const saved = w.sessionData.diagnosticAutoUiState;
  assert.deepEqual(copy(saved.selected), ['challenge.example']);
  assert.equal(saved.expiresAt, observed.session.updatedAt + 30 * 60000);
  assert.equal(saved.privateUrl, undefined); assert.equal(saved.pendingMutation.hosts, undefined);
  assert.equal(w.data.diagnosticAutoUiState, undefined); assert.equal(w.data.diagnosticUiState, undefined);
  w.request('site.example', 'navigation', 'main_frame');
  await w.flush(); await w.tick();
  assert.equal(w.sessionData.diagnosticAutoUiState, undefined);
});
