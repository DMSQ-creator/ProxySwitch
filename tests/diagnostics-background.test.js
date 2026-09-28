'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
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
  let failure = null;
  let permission = options.permission !== false;
  const timers = [];
  const reloads = [];
  const data = copy(options.data || {
    serverList: [{ id: 'a', host: '127.0.0.1', port: 7897 }], activeServerId: 'a', userRules: ['site.example'], userWhitelist: [],
  });
  const tabs = new Map([[1, { id: 1, url: 'https://site.example/', incognito: false }], [2, { id: 2, url: 'https://other.example/' }]]);
  const settings = { value: { mode: options.mode || 'pac_script' }, levelOfControl: options.control || 'controlled_by_this_extension' };
  function callback(operation, fn, value, before) {
    queueMicrotask(() => {
      const bad = failure === operation;
      chrome.runtime.lastError = bad ? { message: 'private error URL must not be exported' } : null;
      if (!bad && before) before();
      fn(copy(value));
      chrome.runtime.lastError = null;
    });
  }
  const chrome = {
    runtime: { id: 'extension', lastError: null, onMessage: event(), onStartup: event() },
    storage: {
      onChanged: event(),
      local: {
        get(keys, fn) { callback('get', fn, Object.fromEntries(keys.map(key => [key, data[key]]))); },
        set(items, fn) { callback('set', fn, undefined, () => {
          const changes = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { oldValue: copy(data[key]), newValue: copy(value) }]));
          Object.assign(data, copy(items)); chrome.storage.onChanged.emit(changes, 'local');
        }); },
        remove(keys, fn) { callback('remove', fn, undefined, () => { keys.forEach(key => delete data[key]); }); },
      },
    },
    permissions: { onAdded: event(), onRemoved: event(), contains(_filter, fn) { callback('permission', fn, permission); } },
    proxy: { settings: { get(_filter, fn) { callback('proxy', fn, settings); } } },
    tabs: {
      onRemoved: event(), onUpdated: event(),
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
  const context = vm.createContext({ chrome, URL, console, setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout(id) { timers[id - 1] = null; } });
  vm.runInContext(routingSource, context);
  vm.runInContext(source, context);
  const controller = context.ProxySwitchDiagnostics.create({ chrome, routing: context.ProxySwitchRouting, now: () => time, uuid: () => `id-${++sequence}`, refresh: async () => { if (failure === 'refresh') throw new Error('failed'); refreshes++; } });
  await controller.ready;
  const send = message => new Promise(resolve => chrome.runtime.onMessage.listeners[0](message, { id: 'extension' }, resolve));
  return {
    data, chrome, tabs, reloads, settings, send,
    get: () => send({ type: 'PS_DIAG_GET', tabId: 1 }),
    start: (tabId = 1, replace) => send({ type: 'PS_DIAG_START', tabId, replace }),
    request(host, id = 'request', type = 'script', tabId = 1) { chrome.webRequest.onBeforeRequest.emit({ url: `https://${host}/private-path?secret=x`, requestId: id, type, tabId }); },
    done(host, id = 'request', statusCode = 200) { chrome.webRequest.onCompleted.emit({ url: `https://${host}/private-path?secret=x`, requestId: id, statusCode, tabId: 1 }); },
    error(host, error = 'net::ERR_TIMED_OUT', id = 'request') { chrome.webRequest.onErrorOccurred.emit({ url: `https://${host}/private-path?secret=x`, requestId: id, error, tabId: 1 }); },
    advance(ms) { time += ms; },
    revoke() { permission = false; chrome.permissions.onRemoved.emit({ permissions: ['webRequest'] }); },
    fail(operation) { failure = operation; },
    refreshes: () => refreshes,
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
