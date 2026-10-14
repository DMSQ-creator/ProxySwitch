'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const routingSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'routing.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'request-recorder.js'), 'utf8');
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function event() {
  const listeners = [];
  return {
    listeners,
    addListener(listener, filter) { listener.filter = filter; listeners.push(listener); },
    removeListener(listener) { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
  };
}
function worker(options = {}) {
  let time = options.time || 100000;
  let sequence = 0;
  let granted = options.permission !== false;
  let failure = options.failure || null;
  let hold = options.hold || null;
  const local = copy(options.local || {});
  const cache = copy(options.cache || {});
  const writes = [];
  const held = [];
  const timers = new Map();
  const reports = [];
  let timerId = 0;
  const tabs = new Map((options.tabs || [
    { id: 1, url: 'https://page.example/private-document?secret=one' },
    { id: 2, url: 'https://other.example/' },
  ]).map(tab => [tab.id, tab]));
  function callback(operation, fn, value, before) {
    const complete = () => {
      const bad = failure === operation || Array.isArray(failure) && failure.includes(operation);
      chrome.runtime.lastError = bad ? { message: 'private API error https://secret.example/path' } : null;
      if (!bad && before) before();
      fn(copy(value));
      chrome.runtime.lastError = null;
    };
    if (hold === operation) held.push(complete);
    else queueMicrotask(complete);
  }
  function area(name, data) {
    return {
      get(keys, fn) { callback(name + '.get', fn, Object.fromEntries(keys.map(key => [key, data[key]]))); },
      set(items, fn) { callback(name + '.set', fn, undefined, () => {
        const changes = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { oldValue: copy(data[key]), newValue: copy(value) }]));
        Object.assign(data, copy(items)); writes.push({ area: name, items: copy(items) });
        chrome.storage.onChanged.emit(changes, name);
      }); },
      remove(keys, fn) { callback(name + '.remove', fn, undefined, () => {
        const changes = Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, { oldValue: copy(data[key]) }]));
        keys.forEach(key => delete data[key]);
        if (Object.keys(changes).length) chrome.storage.onChanged.emit(changes, name);
      }); },
      clear(fn) { callback(name + '.clear', fn, undefined, () => {
        const changes = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { oldValue: copy(value) }]));
        for (const key of Object.keys(data)) delete data[key];
        chrome.storage.onChanged.emit(changes, name);
      }); },
    };
  }
  const chrome = {
    runtime: { lastError: null, onStartup: event() },
    storage: { onChanged: event() },
    permissions: {
      onAdded: event(), onRemoved: event(),
      contains(_permissions, fn) { callback('permission', fn, granted); },
      remove(_permissions, fn) { callback('permission.remove', fn, true, () => {
        const previous = granted; granted = false;
        if (previous) chrome.permissions.onRemoved.emit({ permissions: ['webRequest'] });
      }); },
    },
    tabs: {
      onRemoved: event(), onUpdated: event(),
      query(_filter, fn) { callback('tabs.query', fn, [...tabs.values()]); },
      get(id, fn) {
        if (tabs.has(id)) callback('tabs.get', fn, tabs.get(id));
        else queueMicrotask(() => { chrome.runtime.lastError = { message: 'private tab error' }; fn(); chrome.runtime.lastError = null; });
      },
    },
    alarms: {
      onAlarm: event(), scheduled: null,
      create(name, alarm) { this.scheduled = { name, ...alarm }; },
      clear(_name, fn) { this.scheduled = null; if (fn) fn(true); },
    },
    webRequest: Object.fromEntries(['onBeforeRequest', 'onHeadersReceived', 'onCompleted', 'onBeforeRedirect', 'onErrorOccurred'].map(name => [name, event()])),
  };
  chrome.storage.local = area('local', local);
  if (options.session !== false) chrome.storage.session = area('session', cache);
  const context = vm.createContext({
    chrome, URL, PSL: { warn(...args) { reports.push(args); } },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(routingSource, context);
  vm.runInContext(source, context);
  const recorder = context.ProxySwitchRequestRecorder.create({ chrome, routing: context.ProxySwitchRouting, now: () => time, uuid: () => 'epoch-' + ++sequence });
  function emit(name, options = {}) {
    const value = { url: 'https://resource.example/private-path?token=private', tabId: 1, requestId: 'request', type: 'script', frameId: 0, ...options };
    chrome.webRequest[name].emit(value);
  }
  return {
    recorder, chrome, tabs, local, cache, writes, reports, held, timers,
    ready: recorder.ready,
    snapshot: (id = 1) => copy(recorder.snapshot(id)),
    start: (options = {}) => emit('onBeforeRequest', options),
    headers: (options = {}) => emit('onHeadersReceived', { statusCode: 200, ...options }),
    done: (options = {}) => emit('onCompleted', { statusCode: 200, ...options }),
    error: (options = {}) => emit('onErrorOccurred', { error: 'net::ERR_TIMED_OUT', ...options }),
    redirect: (options = {}) => emit('onBeforeRedirect', { statusCode: 302, ...options }),
    advance(ms) { time += ms; },
    setPermission(value) { granted = value; },
    revoke() { granted = false; chrome.permissions.onRemoved.emit({ permissions: ['webRequest'] }); },
    grant() { granted = true; chrome.permissions.onAdded.emit({ permissions: ['webRequest'] }); },
    update(id, change) {
      const tab = tabs.get(id);
      if (tab && change.url) tab.url = change.url;
      chrome.tabs.onUpdated.emit(id, change, tab);
    },
    close(id) { tabs.delete(id); chrome.tabs.onRemoved.emit(id); },
    fail(operation) { failure = operation; },
    hold(operation) { hold = operation; },
    release() { hold = null; for (const fn of held.splice(0)) queueMicrotask(fn); },
    async tick(count = 20) { for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve)); },
    async flush() {
      for (const [id, timer] of [...timers]) if (timer.ms === 250) { timers.delete(id); timer.fn(); }
      await this.tick();
    },
  };
}
async function enabled(options = {}) {
  const w = worker(options); await w.ready;
  await w.recorder.enable({ consent: true });
  return w;
}

test('wake listeners register synchronously and old permission does not imply consent', async () => {
  const w = worker({ hold: 'local.get' });
  assert.equal(w.chrome.webRequest.onBeforeRequest.listeners.length, 1);
  assert.equal(w.chrome.webRequest.onCompleted.listeners.length, 1);
  w.start(); w.release(); await w.ready;
  assert.equal(w.recorder.status().enabled, false);
  assert.equal(w.snapshot(), null);
  assert.deepEqual(w.local, {});
  await assert.rejects(w.recorder.enable({}), { code: 'consent_required' });
  await w.recorder.enable({ consent: true });
  assert.equal(w.local.diagnosticAutoCapture, true);
  assert.equal(w.recorder.status().enabled, true);
});

test('a consent preference needs a fresh optional permission check', async () => {
  const w = worker({ permission: false, local: { diagnosticAutoCapture: true } });
  await w.ready;
  assert.equal(w.recorder.status().enabled, false);
  assert.equal(w.local.diagnosticAutoCapture, false);
  await assert.rejects(w.recorder.enable({ consent: true }), { code: 'permission_required' });
  w.grant(); await w.tick();
  assert.equal(w.recorder.status().enabled, false);
  await w.recorder.enable({ consent: true });
  assert.equal(w.recorder.status().enabled, true);
});

test('HTTP source tabs collect independent domain summaries and cloned snapshots', async () => {
  const w = await enabled();
  w.start({ requestId: 'one', documentId: 'doc-one' });
  w.done({ requestId: 'one', documentId: 'doc-one' });
  w.start({ tabId: 2, requestId: 'two', url: 'https://second.example/private' });
  w.error({ tabId: 2, requestId: 'two', url: 'https://second.example/private' });
  const first = w.snapshot(); const second = w.snapshot(2);
  assert.equal(first.session.hostname, 'page.example');
  assert.equal(first.session.auto, true); assert.equal(first.session.captureUntil, 0);
  assert.equal(first.rows[0].completed, 1); assert.equal(first.rows[0].failed, 0);
  assert.equal(second.session.hostname, 'other.example'); assert.equal(second.rows[0].failed, 1);
  first.rows[0].types.push('injected'); first.session.hostname = 'bad.example';
  assert.equal(w.snapshot().session.hostname, 'page.example');
  assert.deepEqual(w.snapshot().rows[0].types, ['script']);
  assert.equal(copy(w.recorder.find(second.session.id)).session.tabId, 2);
  assert.equal(w.recorder.find('missing'), null);
});

test('non-HTTP, incognito and unattributed requests never create summaries', async () => {
  const w = await enabled({ tabs: [
    { id: 1, url: 'chrome://settings/' },
    { id: 2, url: 'https://private.example/', incognito: true },
    { id: 3, url: 'https://normal.example/' },
  ] });
  w.start(); w.start({ tabId: 2 }); w.start({ tabId: -1 });
  w.start({ tabId: 3, incognito: true }); w.start({ tabId: 3, url: 'file:///secret.txt' });
  assert.equal(w.snapshot(), null); assert.equal(w.snapshot(2), null); assert.equal(w.snapshot(3), null);
  w.tabs.set(4, { id: 4, url: 'https://new.example/' });
  w.start({ tabId: 4, requestId: 'new-tab' }); w.done({ tabId: 4, requestId: 'new-tab' });
  await w.tick();
  assert.equal(w.snapshot(4).rows[0].completed, 1);
});

test('same-host main-frame navigations replace epochs and ignore old terminal events', async () => {
  const w = await enabled();
  w.start({ requestId: 'old', documentId: 'old-document' });
  const first = w.snapshot().session.id;
  w.start({ requestId: 'navigation', type: 'main_frame', documentId: 'new-document', url: 'https://page.example/second?private=1' });
  const second = w.snapshot().session.id;
  assert.notEqual(second, first); assert.equal(w.recorder.find(first), null);
  w.error({ requestId: 'old', documentId: 'old-document' });
  assert.equal(w.snapshot().rows.length, 1); assert.equal(w.snapshot().rows[0].failed, 0);
  w.update(1, { status: 'loading' });
  w.update(1, { url: 'https://page.example/second?private=1' });
  assert.equal(w.snapshot().session.id, second);
  w.done({ requestId: 'navigation', type: 'main_frame', documentId: 'new-document', url: 'https://page.example/second' });
  w.update(1, { status: 'complete' });
  w.start({ requestId: 'reload', type: 'main_frame', documentId: 'reload-document', url: 'https://page.example/second' });
  assert.notEqual(w.snapshot().session.id, second);
});

test('tabs navigation arriving first is adopted by its main-frame request', async () => {
  const w = await enabled(); w.start({ requestId: 'before' });
  w.update(1, { status: 'loading' });
  const epoch = w.snapshot().session.id;
  w.update(1, { url: 'https://destination.example/secret' });
  w.start({ requestId: 'navigate', type: 'main_frame', url: 'https://destination.example/secret', documentId: 'new-doc' });
  assert.equal(w.snapshot().session.id, epoch);
  assert.equal(w.snapshot().session.hostname, 'destination.example');
  assert.equal(w.snapshot().rows.length, 1);
});

test('document IDs prevent old-document requests and mismatched terminals entering a new epoch', async () => {
  const w = await enabled();
  w.start({ requestId: 'navigate', type: 'main_frame', documentId: 'departing-doc', url: 'https://page.example/' });
  w.start({ requestId: 'current', documentId: 'current-doc' });
  w.start({ requestId: 'late', documentId: 'previous-doc' });
  assert.equal(w.snapshot().rows.length, 2);
  w.done({ requestId: 'current', documentId: 'previous-doc' });
  assert.equal(w.snapshot().rows[1].pending, 1);
  w.done({ requestId: 'current', documentId: 'current-doc' });
  assert.equal(w.snapshot().rows[1].completed, 1);
  w.done({ requestId: 'navigate', type: 'main_frame', documentId: 'current-doc', url: 'https://page.example/' });
  assert.equal(w.snapshot().rows[0].completed, 1);
});

test('redirects reuse one document epoch and independently complete observed hops', async () => {
  const w = await enabled();
  w.start({ requestId: 'navigate', type: 'main_frame', url: 'https://page.example/' });
  const epoch = w.snapshot().session.id;
  w.redirect({ requestId: 'navigate', type: 'main_frame', url: 'https://page.example/' });
  w.start({ requestId: 'navigate', type: 'main_frame', url: 'https://destination.example/private' });
  w.done({ requestId: 'navigate', type: 'main_frame', url: 'https://destination.example/private' });
  assert.equal(w.snapshot().session.id, epoch);
  assert.equal(w.snapshot().session.hostname, 'destination.example');
  assert.deepEqual(w.snapshot().rows.map(row => row.completed), [1, 1]);
});

test('WebSocket 101 completes only the handshake while the socket stays open', async () => {
  const w = await enabled();
  w.start({ requestId: 'socket', type: 'websocket', url: 'wss://socket.example/private?token=x' });
  w.headers({ requestId: 'socket', type: 'websocket', statusCode: 101, url: 'wss://socket.example/private?token=x' });
  let row = w.snapshot().rows[0];
  assert.equal(row.count, 1); assert.equal(row.pending, 0); assert.equal(row.completed, 1); assert.equal(row.lastStatus, 101);
  w.done({ requestId: 'socket', statusCode: 101, url: 'wss://socket.example/private?token=x' });
  w.error({ requestId: 'socket', error: 'net::ERR_CONNECTION_CLOSED', url: 'wss://socket.example/private?token=x' });
  row = w.snapshot().rows[0]; assert.equal(row.completed, 1); assert.equal(row.failed, 0);
});

test('cancellation is unconfirmed and HTTP errors count once with safe network error codes', async () => {
  const w = await enabled();
  w.start({ requestId: 'abort' }); w.error({ requestId: 'abort', error: 'net::ERR_ABORTED' });
  w.start({ requestId: 'http' }); w.headers({ requestId: 'http', statusCode: 403 }); w.done({ requestId: 'http', statusCode: 403 });
  w.start({ requestId: 'bad' }); w.error({ requestId: 'bad', error: 'Bad private https://secret.example/private' });
  const row = w.snapshot().rows[0];
  assert.equal(row.unconfirmed, 1); assert.equal(row.failed, 1); assert.equal(row.completed, 1);
  assert.equal(row.httpErrors, 1); assert.equal(row.pending, 0); assert.equal(row.error, 'request_failed');
});

test('in-flight attribution is abandoned after two minutes without false failure', async () => {
  const w = await enabled(); w.start();
  w.advance(120001); await w.recorder.cleanup();
  const row = w.snapshot().rows[0]; assert.equal(row.pending, 0); assert.equal(row.unconfirmed, 1); assert.equal(row.failed, 0);
  w.error(); assert.equal(w.snapshot().rows[0].failed, 0);
});

test('clear affects one context without reload; reset validates and replaces its epoch', async () => {
  const w = await enabled(); w.start(); w.start({ tabId: 2, requestId: 'second' });
  const first = w.snapshot().session.id; const second = w.snapshot(2).session.id;
  await w.recorder.clear(1);
  assert.equal(w.snapshot().session.id, first); assert.equal(w.snapshot().rows.length, 0);
  assert.equal(w.snapshot(2).session.id, second); assert.equal(w.snapshot(2).rows.length, 1);
  w.done(); assert.equal(w.snapshot().rows.length, 0);
  await w.recorder.reset(1); assert.notEqual(w.snapshot().session.id, first);
  w.tabs.get(1).url = 'chrome://settings/';
  await assert.rejects(w.recorder.reset(1), { code: 'restricted_tab' });
  await assert.rejects(w.recorder.reset(-1), { code: 'invalid_tab' });
});

test('queued clear is bound to its observed epoch rather than a newly navigated page', async () => {
  const w = await enabled(); w.start({ requestId: 'before', documentId: 'old-top' });
  const epoch = w.snapshot().session.id;
  const clearing = w.recorder.clear(1, epoch);
  w.start({ requestId: 'navigate', type: 'main_frame', documentId: 'old-top', url: 'https://page.example/new' });
  w.start({ requestId: 'after', documentId: 'new-top', url: 'https://new-resource.example/' });
  await assert.rejects(clearing, { code: 'session_not_found' });
  assert.ok(w.snapshot().rows.some(row => row.host === 'new-resource.example'));
  await w.recorder.clear(1, w.snapshot().session.id); assert.equal(w.snapshot().rows.length, 0);
});

test('invalidation retains stale facts until each domain receives a fresh request', async () => {
  const w = await enabled();
  w.start({ requestId: 'one' }); w.done({ requestId: 'one' });
  w.start({ requestId: 'two', url: 'https://another.example/' });
  w.start({ requestId: 'other', tabId: 2 });
  await w.recorder.invalidate();
  assert.equal(w.snapshot().session.rulesChanged, true);
  assert.equal(w.snapshot(2).rows[0].stale, true);
  w.start({ requestId: 'fresh' }); w.done({ requestId: 'fresh' });
  const row = w.snapshot().rows.find(item => item.host === 'resource.example');
  assert.equal(row.count, 1); assert.equal(row.completed, 1); assert.equal(row.stale, false);
  assert.equal(w.snapshot().rows.find(item => item.host === 'another.example').stale, true);
});

test('retention follows observed activity and uses its own alarm', async () => {
  const w = await enabled(); w.start(); w.done();
  const startedAt = w.snapshot().session.startedAt;
  w.advance(29 * 60000); w.start({ requestId: 'fresh' }); w.done({ requestId: 'fresh' });
  w.advance(2 * 60000); await w.recorder.cleanup();
  assert.equal(w.snapshot().session.startedAt, startedAt);
  assert.equal(w.snapshot().rows[0].count, 2);
  assert.equal(w.chrome.alarms.scheduled.name, 'proxyswitch-request-recorder');
  w.advance(28 * 60000); w.chrome.alarms.onAlarm.emit({ name: 'proxyswitch-request-recorder' }); await w.tick();
  assert.equal(w.snapshot(), null); assert.equal(w.chrome.alarms.scheduled, null);
});

test('tab closure, disable, revocation and browser startup drop private summaries', async () => {
  for (const operation of ['close', 'disable', 'revoke', 'startup']) {
    const w = await enabled(); w.start(); await w.flush();
    assert.ok(w.cache.diagnosticAutoRecords);
    if (operation === 'close') w.close(1);
    if (operation === 'disable') await w.recorder.disable();
    if (operation === 'revoke') w.revoke();
    if (operation === 'startup') w.chrome.runtime.onStartup.emit();
    await w.tick(); await w.flush();
    assert.equal(w.snapshot(), null, operation);
    assert.equal(w.cache.diagnosticAutoRecords, undefined, operation);
    if (['disable', 'revoke'].includes(operation)) { assert.equal(w.recorder.status().enabled, false); assert.equal(w.local.diagnosticAutoCapture, false); }
  }
});

test('local reset stops immediately and cannot resurrect a queued session write', async () => {
  const w = await enabled(); w.start(); await w.flush();
  w.hold('session.set'); w.start({ requestId: 'pending-write' });
  const flushing = w.flush(); await w.tick();
  assert.equal(w.held.length, 1);
  await new Promise(resolve => w.chrome.storage.local.clear(resolve));
  assert.equal(w.recorder.status().enabled, false); assert.equal(w.snapshot(), null);
  w.release(); await flushing; await w.tick();
  assert.equal(w.cache.diagnosticAutoRecords, undefined);
  assert.equal(w.local.diagnosticAutoCapture, undefined);
  w.start({ requestId: 'after-reset' }); assert.equal(w.snapshot(), null);
});

test('worker wake restores summaries as unconfirmed and ignores unmatched old terminals', async () => {
  const original = await enabled(); original.start({ requestId: 'in-flight', documentId: 'known-doc' });
  original.start({ requestId: 'complete', url: 'https://completed.example/' }); original.done({ requestId: 'complete', url: 'https://completed.example/' });
  await original.flush();
  const waking = worker({ local: original.local, cache: original.cache });
  waking.done({ requestId: 'in-flight', documentId: 'known-doc' });
  await waking.ready;
  assert.equal(waking.recorder.status().enabled, true);
  const row = waking.snapshot().rows.find(item => item.host === 'resource.example');
  assert.equal(row.pending, 0); assert.equal(row.unconfirmed, 1); assert.equal(row.failed, 0); assert.equal(row.completed, 0);
  assert.equal(waking.snapshot().rows.find(item => item.host === 'completed.example').completed, 1);
  waking.start({ requestId: 'new' }); waking.done({ requestId: 'new' });
  assert.equal(waking.snapshot().rows.find(item => item.host === 'resource.example').completed, 1);
});

test('early wake queue is bounded and sanitized before consent hydration', async () => {
  const w = worker({ local: { diagnosticAutoCapture: true }, hold: 'local.get' });
  for (let i = 0; i < 1500; i++) w.start({ requestId: 'early-' + i });
  w.release(); await w.ready;
  const row = w.snapshot().rows[0]; assert.equal(row.count, 1000); assert.equal(row.pending, 1000);
  assert.doesNotMatch(JSON.stringify(w.cache), /private-path|private-document|token|secret|https:/);
});

test('Chrome 95 and session storage failures use bounded memory without writing local summaries', async () => {
  for (const options of [{ session: false }, { failure: 'session.get' }, { failure: 'session.set' }]) {
    const w = await enabled(options); w.start(); w.done(); await w.flush();
    assert.equal(w.recorder.status().storage, 'memory');
    assert.equal(w.snapshot().rows[0].completed, 1);
    assert.deepEqual(Object.keys(w.local), ['diagnosticAutoCapture']);
    assert.ok(w.writes.every(write => write.area !== 'local' || !Object.hasOwn(write.items, 'diagnosticAutoRecords')));
  }
});

test('tab LRU, per-tab domains, global domains, in-flight and cache bytes stay bounded', async () => {
  const tabs = Array.from({ length: 22 }, (_, i) => ({ id: i + 1, url: 'https://page' + i + '.example/' }));
  const w = await enabled({ tabs });
  for (let id = 1; id <= 20; id++) { w.start({ tabId: id, requestId: 'tab-' + id }); w.done({ tabId: id, requestId: 'tab-' + id }); await w.tick(1); }
  w.start({ tabId: 1, requestId: 'touch' }); w.done({ tabId: 1, requestId: 'touch' });
  w.start({ tabId: 21, requestId: 'new-tab' }); w.done({ tabId: 21, requestId: 'new-tab' });
  await w.tick(1);
  assert.equal(w.snapshot(2), null); assert.ok(w.snapshot(1));
  for (let i = 0; i < 210; i++) {
    w.start({ tabId: 1, requestId: 'domain-' + i, url: 'https://domain' + i + '.example/' });
    w.done({ tabId: 1, requestId: 'domain-' + i, url: 'https://domain' + i + '.example/' });
  }
  assert.equal(w.snapshot(1).rows.length, 200); assert.ok(w.snapshot(1).session.dropped > 0);
  for (let id = 3; id <= 20; id++) for (let i = 0; i < 200; i++) {
    const options = { tabId: id, requestId: 'global-' + i, url: 'https://domain' + i + '.tab' + id + '.example/' };
    w.start(options); w.done(options);
  }
  let domains = 0; for (let id = 1; id <= 22; id++) domains += w.snapshot(id)?.rows.length || 0;
  assert.ok(domains <= 2000);
  await w.flush(); assert.ok(JSON.stringify(w.cache.diagnosticAutoRecords).length <= 700 * 1024);
  const flight = await enabled();
  for (let i = 0; i < 1001; i++) flight.start({ requestId: 'flight-' + i });
  assert.equal(flight.snapshot().rows[0].pending, 1000); assert.equal(flight.snapshot().session.dropped, 1);
});

test('malformed imported cache fields never propagate private strings', async () => {
  const w = worker({ local: { diagnosticAutoCapture: true }, cache: { diagnosticAutoRecords: { version: 1, records: [{
    session: { id: 'saved', tabId: 1, hostname: 'page.example', startedAt: 50000, updatedAt: 80000, private: 'https://private.example/' },
    rows: [{ host: 'safe.example', count: 1, pending: 1, types: ['script', 'https://private.example'], error: 'private error https://private.example', extra: 'secret' }],
    documentId: 'https://private.example', other: 'secret',
  }] } } });
  await w.ready;
  assert.equal(w.snapshot().rows[0].unconfirmed, 1);
  assert.doesNotMatch(JSON.stringify(w.snapshot()), /private|secret|https:/);
  assert.doesNotMatch(JSON.stringify(w.cache), /private|secret|https:/);
  assert.ok(w.reports.every(report => !/secret|https:/.test(JSON.stringify(report))));
});

test('failed preference hydration is a safe error and explicit consent can retry it', async () => {
  const w = worker({ failure: 'local.get' });
  await assert.rejects(w.ready, { code: 'storage_failed' });
  assert.equal(w.recorder.status().enabled, false);
  assert.equal(w.recorder.status().recovering, true);
  assert.equal(w.recorder.status().error, 'storage_failed');
  w.fail(null); await w.recorder.enable({ consent: true });
  await w.recorder.ready;
  assert.equal(w.recorder.status().enabled, true);
  assert.equal(w.recorder.status().recovering, undefined);
  assert.equal(w.recorder.status().error, undefined);
  w.start(); assert.equal(w.snapshot().rows[0].count, 1);
});

test('disable falls back to durable consent removal when replacing the preference fails', async () => {
  const w = await enabled(); w.start(); await w.flush();
  w.fail('local.set');
  const stopping = w.recorder.disable();
  assert.equal(w.recorder.status().enabled, false); assert.equal(w.recorder.status().recovering, true);
  await stopping;
  assert.equal(w.snapshot(), null); assert.equal(w.recorder.status().enabled, false);
  assert.equal(w.recorder.status().recovering, undefined);
  assert.equal(w.cache.diagnosticAutoRecords, undefined);
  assert.equal(w.local.diagnosticAutoCapture, undefined);
  w.start(); assert.equal(w.snapshot(), null);
  const waking = worker({ local: w.local, cache: w.cache }); await waking.ready;
  waking.start(); assert.equal(waking.recorder.status().enabled, false); assert.equal(waking.snapshot(), null);
  w.fail(null); await w.recorder.disable(); assert.equal(w.local.diagnosticAutoCapture, false);
});

test('failed local off operations retain a session kill switch across worker restarts', async () => {
  const w = await enabled(); w.start(); await w.flush();
  w.fail(['local.set', 'local.remove']);
  await assert.rejects(w.recorder.disable(), { code: 'storage_failed' });
  assert.equal(w.recorder.status().enabled, false); assert.equal(w.recorder.status().error, 'storage_failed');
  assert.equal(w.local.diagnosticAutoCapture, true); assert.equal(w.cache.diagnosticAutoCaptureStopped, true);
  assert.equal(w.cache.diagnosticAutoRecords, undefined);
  const waking = worker({ local: w.local, cache: w.cache, failure: ['local.set', 'local.remove'] });
  await assert.rejects(waking.ready, { code: 'storage_failed' });
  waking.start(); assert.equal(waking.recorder.status().enabled, false); assert.equal(waking.snapshot(), null);
  waking.fail(null); await waking.recorder.enable({ consent: true });
  assert.equal(waking.recorder.status().enabled, true); assert.equal(waking.cache.diagnosticAutoCaptureStopped, undefined);
  waking.start(); assert.equal(waking.snapshot().rows[0].count, 1);
});

test('in-flight disable reports recovery until durable acknowledgement and blocks a waking worker', async () => {
  const w = await enabled(); w.start(); await w.flush();
  w.hold('local.set'); const stopping = w.recorder.disable(); await w.tick();
  assert.equal(w.recorder.status().enabled, false); assert.equal(w.recorder.status().recovering, true);
  assert.equal(w.local.diagnosticAutoCapture, true); assert.equal(w.cache.diagnosticAutoCaptureStopped, true);
  const waking = worker({ local: w.local, cache: w.cache }); await waking.ready;
  waking.start(); assert.equal(waking.recorder.status().enabled, false); assert.equal(waking.snapshot(), null);
  w.release(); await stopping;
  assert.equal(w.recorder.status().recovering, undefined); assert.equal(w.local.diagnosticAutoCapture, false);
  assert.equal(w.cache.diagnosticAutoCaptureStopped, undefined);
});

test('a stale enable cannot erase the reset kill switch when both local off operations fail', async () => {
  const w = await enabled();
  w.hold('tabs.query'); const enabling = w.recorder.enable({ consent: true }).catch(error => error.code);
  await w.tick(); assert.equal(w.held.length, 1);
  const resetting = w.recorder.beginReset().catch(error => error.code);
  await w.tick(); assert.equal(w.cache.diagnosticAutoCaptureStopped, true);
  w.fail(['local.set', 'local.remove']); w.release();
  assert.deepEqual(await Promise.all([enabling, resetting]), ['storage_failed', 'storage_failed']);
  await w.tick(); assert.equal(w.local.diagnosticAutoCapture, true);
  assert.equal(w.cache.diagnosticAutoCaptureStopped, true); assert.equal(w.recorder.status().enabled, false);
  const waking = worker({ local: w.local, cache: w.cache }); await waking.ready;
  waking.start(); assert.equal(waking.recorder.status().enabled, false); assert.equal(waking.snapshot(), null);
});

test('a stop during an older enable marker removal refreshes the marker before surfacing local failures', async () => {
  const w = await enabled();
  w.hold('session.remove'); const enabling = w.recorder.enable({ consent: true }).catch(error => error.code);
  await w.tick(); assert.equal(w.held.length, 1);
  const stopping = w.recorder.disable().catch(error => error.code);
  await w.tick(); w.fail(['local.set', 'local.remove']); w.release();
  assert.deepEqual(await Promise.all([enabling, stopping]), ['storage_failed', 'storage_failed']);
  await w.tick(); assert.equal(w.cache.diagnosticAutoCaptureStopped, true);
  const waking = worker({ local: w.local, cache: w.cache }); await waking.ready;
  waking.start(); assert.equal(waking.recorder.status().enabled, false); assert.equal(waking.snapshot(), null);
});

test('failed re-enable preserves a previous stop rather than reviving an old true preference', async () => {
  const w = await enabled(); w.fail(['local.set', 'local.remove']);
  await assert.rejects(w.recorder.disable(), { code: 'storage_failed' });
  await assert.rejects(w.recorder.enable({ consent: true }), { code: 'storage_failed' });
  assert.equal(w.recorder.status().enabled, false); assert.equal(w.cache.diagnosticAutoCaptureStopped, true);
  const waking = worker({ local: w.local, cache: w.cache }); await waking.ready;
  waking.start(); assert.equal(waking.recorder.status().enabled, false); assert.equal(waking.snapshot(), null);
});

test('unreadable session kill switch fails closed even when consent was previously enabled', async () => {
  const w = worker({ local: { diagnosticAutoCapture: true }, failure: 'session.get' });
  await assert.rejects(w.ready, { code: 'storage_failed' });
  w.start(); assert.equal(w.recorder.status().enabled, false); assert.equal(w.snapshot(), null);
  w.fail(null); await w.recorder.enable({ consent: true });
  w.start(); assert.equal(w.snapshot().rows[0].count, 1);
});

test('with neither local off persistence nor session storage, explicit stop revokes observation as last resort', async () => {
  const w = await enabled({ session: false });
  w.fail(['local.set', 'local.remove']);
  await assert.rejects(w.recorder.disable(), { code: 'storage_failed' }); await w.tick();
  assert.equal(w.recorder.status().enabled, false); assert.equal(w.recorder.status().permission, false);
  const waking = worker({ session: false, local: w.local, permission: false, failure: ['local.set', 'local.remove'] });
  await assert.rejects(waking.ready, { code: 'storage_failed' });
  waking.start(); assert.equal(waking.snapshot(), null);
});

test('unchanged cleanup does not repeatedly write private cache', async () => {
  const w = await enabled(); w.start(); w.done(); await w.flush();
  const writes = w.writes.length;
  for (let i = 0; i < 20; i++) await w.recorder.cleanup();
  assert.equal(w.writes.length, writes);
});

test('explicit reset fences a first enable even when real local.clear emits no preference removal', async () => {
  const w = worker(); await w.ready;
  w.hold('local.set'); const enabling = w.recorder.enable({ consent: true });
  await w.tick(); assert.equal(w.held.length, 1);
  const reset = w.recorder.beginReset();
  await new Promise(resolve => w.chrome.storage.local.clear(resolve));
  assert.deepEqual(w.local, {}); assert.equal(w.recorder.status().enabled, false);
  w.release(); await assert.rejects(enabling, { code: 'recorder_disabled' });
  await reset; await w.tick(); assert.equal(w.local.diagnosticAutoCapture, false); assert.equal(w.snapshot(), null);
});

test('a same-host tab navigation that wakes the worker replaces recovered rows', async () => {
  const original = await enabled(); original.start(); original.done(); await original.flush();
  const waking = worker({ local: original.local, cache: original.cache, hold: 'local.get' });
  waking.update(1, { url: 'https://page.example/new-private-document', status: 'loading' });
  waking.release(); await waking.ready;
  assert.notEqual(waking.snapshot().session.id, original.snapshot().session.id);
  assert.equal(waking.snapshot().rows.length, 0);
});

test('null imported hosts and contradictory counters are sanitized', async () => {
  const w = worker({ local: { diagnosticAutoCapture: true }, cache: { diagnosticAutoRecords: { version: 1, records: [{
    session: { id: 'saved', tabId: 1, hostname: 'page.example', startedAt: 50000, updatedAt: 80000 },
    rows: [{ host: null, count: 1 }, { host: 'safe.example', count: 2, completed: 900, failed: 999, pending: 999, unconfirmed: 999, httpErrors: 999 }],
  }] } } });
  await w.ready;
  const rows = w.snapshot().rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].completed, 2); assert.equal(rows[0].failed, 0);
  assert.equal(rows[0].unconfirmed, 0); assert.equal(rows[0].httpErrors, 2);
});

test('retired top documents also fence late direct child-frame requests', async () => {
  const w = await enabled();
  w.start({ requestId: 'old', documentId: 'old-top' });
  w.start({ requestId: 'navigate', type: 'main_frame', documentId: 'old-top', url: 'https://page.example/new' });
  w.start({ requestId: 'late-child', documentId: 'child-old', parentDocumentId: 'old-top', frameId: 8, parentFrameId: 0 });
  w.start({ requestId: 'new-child', documentId: 'child-new', parentDocumentId: 'new-top', frameId: 9, parentFrameId: 0 });
  w.start({ requestId: 'new-top-request', documentId: 'new-top' });
  const row = w.snapshot().rows.find(item => item.host === 'resource.example');
  assert.equal(row.count, 2);
  w.error({ requestId: 'late-child', documentId: 'child-old', parentDocumentId: 'old-top', frameId: 8, parentFrameId: 0 });
  assert.equal(row.failed, 0);
});

test('nested iframe ancestry rejects old and unverified grandchildren while accepting the new page tree', async () => {
  const w = await enabled();
  w.start({ requestId: 'old-top', documentId: 'old-top' });
  w.start({ requestId: 'old-frame-load', type: 'sub_frame', frameId: 8, parentFrameId: 0,
    documentId: undefined, parentDocumentId: 'old-top', url: 'https://old-child.example/' });
  w.start({ requestId: 'old-child-resource', frameId: 8, parentFrameId: 0,
    documentId: 'old-child', parentDocumentId: 'old-top', url: 'https://old-child-resource.example/' });
  w.start({ requestId: 'old-grandchild-resource', frameId: 9, parentFrameId: 8,
    documentId: 'old-grandchild', parentDocumentId: 'old-child', url: 'https://old-grandchild.example/' });
  w.start({ requestId: 'navigation', type: 'main_frame', documentId: 'old-top', url: 'https://page.example/new' });
  w.start({ requestId: 'new-top', documentId: 'new-top' });
  w.start({ requestId: 'late-grandchild', frameId: 9, parentFrameId: 8,
    documentId: 'old-grandchild', parentDocumentId: 'old-child', url: 'https://old-private.example/' });
  w.start({ requestId: 'unseen-old-grandchild', frameId: 12, parentFrameId: 11,
    documentId: 'unseen-grandchild', parentDocumentId: 'unseen-old-child', url: 'https://unverified.example/' });
  w.start({ requestId: 'new-child-load', type: 'sub_frame', frameId: 8, parentFrameId: 0,
    documentId: undefined, parentDocumentId: 'new-top', url: 'https://new-child.example/' });
  w.start({ requestId: 'new-child-resource', frameId: 8, parentFrameId: 0,
    documentId: 'new-child', parentDocumentId: 'new-top', url: 'https://new-child-resource.example/' });
  w.start({ requestId: 'unidentified-new-parent', frameId: 14, parentFrameId: 0,
    documentId: 'unverified-child', parentDocumentId: undefined, url: 'https://unverified-child.example/' });
  w.start({ requestId: 'unidentified-old-grandchild', frameId: 15, parentFrameId: 8,
    documentId: 'unverified-grandchild', parentDocumentId: undefined, url: 'https://unverified-grandchild.example/' });
  w.start({ requestId: 'new-grandchild-load', type: 'sub_frame', frameId: 9, parentFrameId: 8,
    documentId: undefined, parentDocumentId: 'new-child', url: 'https://new-grandchild.example/' });
  w.start({ requestId: 'new-grandchild-resource', frameId: 9, parentFrameId: 8,
    documentId: 'new-grandchild', parentDocumentId: 'new-child', url: 'https://new-grandchild-resource.example/' });
  const hosts = w.snapshot().rows.map(row => row.host);
  assert.ok(hosts.includes('new-grandchild.example')); assert.ok(hosts.includes('new-grandchild-resource.example'));
  assert.ok(!hosts.includes('old-private.example')); assert.ok(!hosts.includes('unverified.example'));
  assert.ok(!hosts.includes('unverified-child.example')); assert.ok(!hosts.includes('unverified-grandchild.example'));
  assert.ok(!hosts.includes('old-grandchild.example')); assert.ok(!hosts.includes('old-child-resource.example'));
  await w.flush();
  const waking = worker({ local: w.local, cache: w.cache }); await waking.ready;
  waking.start({ requestId: 'fresh-after-wake', frameId: 9, parentFrameId: 8,
    documentId: 'new-grandchild', parentDocumentId: 'new-child', url: 'https://wake-resource.example/' });
  waking.start({ requestId: 'old-after-wake', frameId: 9, parentFrameId: 8,
    documentId: 'old-grandchild', parentDocumentId: 'old-child', url: 'https://old-after-wake.example/' });
  assert.ok(waking.snapshot().rows.some(row => row.host === 'wake-resource.example'));
  assert.ok(!waking.snapshot().rows.some(row => row.host === 'old-after-wake.example'));
});

test('older Chromium frame ancestry permits observed nested frames but not an unseen departed tree', async () => {
  const w = await enabled();
  w.start({ requestId: 'navigation', type: 'main_frame', url: 'https://page.example/' });
  w.start({ requestId: 'old-unverified', frameId: 9, parentFrameId: 8, url: 'https://unverified.example/' });
  w.start({ requestId: 'child', type: 'sub_frame', frameId: 8, parentFrameId: 0, url: 'https://child.example/' });
  w.start({ requestId: 'grandchild', frameId: 9, parentFrameId: 8, url: 'https://grandchild.example/' });
  assert.ok(w.snapshot().rows.some(row => row.host === 'grandchild.example'));
  assert.ok(!w.snapshot().rows.some(row => row.host === 'unverified.example'));
});

test('committed iframe navigation learns its new identity before any child subresource exists', async () => {
  const w = await enabled();
  w.start({ requestId: 'old-top', documentId: 'old-top' });
  w.start({ requestId: 'old-child', documentId: 'old-child', parentDocumentId: 'old-top', frameId: 8, parentFrameId: 0 });
  w.start({ requestId: 'navigation', type: 'main_frame', documentId: 'old-top', url: 'https://page.example/new' });
  w.start({ requestId: 'new-top', documentId: 'new-top' });
  w.start({ requestId: 'new-child-load', type: 'sub_frame', documentId: 'old-child', parentDocumentId: 'new-top',
    frameId: 8, parentFrameId: 0, url: 'https://new-child.example/' });
  w.done({ requestId: 'new-child-load', type: 'sub_frame', documentId: 'new-child', parentDocumentId: 'new-top',
    frameId: 8, parentFrameId: 0, url: 'https://new-child.example/' });
  w.start({ requestId: 'nested-load', type: 'sub_frame', documentId: undefined, parentDocumentId: 'new-child',
    frameId: 9, parentFrameId: 8, url: 'https://nested.example/' });
  w.done({ requestId: 'nested-load', type: 'sub_frame', documentId: 'new-grandchild', parentDocumentId: 'new-child',
    frameId: 9, parentFrameId: 8, url: 'https://nested.example/' });
  w.start({ requestId: 'nested-resource', documentId: 'new-grandchild', parentDocumentId: 'new-child',
    frameId: 9, parentFrameId: 8, url: 'https://nested-resource.example/' });
  const rows = w.snapshot().rows;
  assert.equal(rows.find(row => row.host === 'new-child.example').completed, 1);
  assert.equal(rows.find(row => row.host === 'nested.example').completed, 1);
  assert.equal(rows.find(row => row.host === 'nested-resource.example').count, 1);
});

test('iframe attribution metadata is bounded and stores only opaque IDs and frame numbers', async () => {
  const w = await enabled(); w.start({ requestId: 'top', documentId: 'top' });
  for (let index = 1; index <= 150; index++) w.start({ requestId: 'child-' + index,
    frameId: index, parentFrameId: 0, documentId: 'child-' + index, parentDocumentId: 'top' });
  await w.flush();
  const context = w.cache.diagnosticAutoRecords.records[0];
  assert.equal(context.documents.length, 128); assert.equal(context.frames.length, 128);
  assert.doesNotMatch(JSON.stringify(context), /private-path|token|https:/);
});

test('same-document URL changes replace counters but retain their valid document identity', async () => {
  const w = await enabled();
  w.start({ requestId: 'first', documentId: 'same-document' }); w.done({ requestId: 'first', documentId: 'same-document' });
  const first = w.snapshot().session.id;
  w.update(1, { url: 'https://page.example/client-route' });
  assert.notEqual(w.snapshot().session.id, first);
  w.start({ requestId: 'client-route', documentId: 'same-document' });
  assert.equal(w.snapshot().rows[0].count, 1);
  w.start({ requestId: 'reload', type: 'main_frame', documentId: 'same-document', url: 'https://page.example/client-route' });
  w.start({ requestId: 'late', documentId: 'same-document' });
  w.start({ requestId: 'fresh', documentId: 'reloaded-document' });
  assert.equal(w.snapshot().rows.find(item => item.host === 'resource.example').count, 1);
});
