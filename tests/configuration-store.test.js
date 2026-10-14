'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const configuration = require('../js/configuration.js');
const { create } = require('../js/configuration-store.js');
const { create: createCloud } = require('../js/cloud-sync.js');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(initial = {}) {
  const data = { userRules: ['old.example'], userWhitelist: [], serverList: [], activeServerId: '', ...initial };
  const state = { reads: 0, writes: [], hold: false, held: [], fail: null };
  const chrome = { runtime: { lastError: null }, storage: { local: {
    get(keys, callback) {
      state.reads++;
      queueMicrotask(() => {
        chrome.runtime.lastError = state.fail === 'get' ? { message: 'private storage detail' } : null;
        const selected = keys === null ? Object.keys(data) : keys;
        const result = Object.fromEntries(selected.filter(key => Object.hasOwn(data, key)).map(key => [key, clone(data[key])]));
        try { callback(result); } finally { chrome.runtime.lastError = null; }
      });
    },
    set(items, callback) {
      const commit = () => {
        chrome.runtime.lastError = state.fail === 'set' ? { message: 'private storage detail' } : null;
        if (!chrome.runtime.lastError) { Object.assign(data, clone(items)); state.writes.push(clone(items)); }
        try { callback(); } finally { chrome.runtime.lastError = null; }
      };
      if (state.hold) { state.hold = false; state.held.push(commit); }
      else queueMicrotask(commit);
    },
    remove(keys, callback) {
      queueMicrotask(() => { for (const key of keys) delete data[key]; callback(); });
    },
  } } };
  const store = create({ chrome, configuration });
  const expected = keys => Object.fromEntries(keys.map(key => [key, Object.hasOwn(data, key) ?
    { exists: true, value: clone(data[key]) } : { exists: false }]));
  return { data, state, chrome, store, expected };
}

test('configuration save validates and compares an exact per-field baseline before writing', async () => {
  const f = fixture();
  const saved = await f.store.save({ userRules: [' EXAMPLE.com ', 'example.com'] }, f.expected(['userRules']));
  assert.deepEqual(saved.userRules, ['example.com']);
  assert.deepEqual(f.data.userRules, ['example.com']);
  await assert.rejects(f.store.save({ userRules: ['stale.example'] }, { userRules: { exists: true, value: ['old.example'] } }), { code: 'config_changed' });
  assert.deepEqual(f.data.userRules, ['example.com']);
  assert.equal(f.state.writes.length, 1);
});

test('absent, present-null and reordered object baseline values are distinguished correctly', async () => {
  const f = fixture({ davUser: null, serverList: [{ id: 'main', name: 'Proxy', scheme: 'HTTP', host: '127.0.0.1', port: 7890 }], activeServerId: 'main' });
  await assert.rejects(f.store.save({ davUser: 'user' }, { davUser: { exists: false } }), { code: 'config_changed' });
  await f.store.save({ davUser: 'user', theme: 'dark' }, { davUser: { exists: true, value: null }, theme: { exists: false } });
  const server = f.data.serverList[0];
  const reversed = Object.fromEntries(Object.entries(server).reverse());
  await f.store.save({ serverList: [server] }, { serverList: { exists: true, value: [reversed] } });
  assert.equal(f.data.davUser, 'user');
  assert.equal(f.data.theme, 'dark');
});

test('internal diagnostic/runtime/undo keys and unknown keys reject the entire credential write', async () => {
  for (const key of ['diagnosticSession', 'diagnosticRuleUndo', 'diagnosticUiState', 'diagnosticAutoCapture', 'diagnosticAutoRecords', 'proxyRuntimeStatus', 'cloudRestoreUndo', 'pacScriptData', '__proto__', 'unknown']) {
    const f = fixture();
    const items = JSON.parse(JSON.stringify({ gitToken: 'private-token', [key]: 'injected' }));
    await assert.rejects(f.store.save(items, { gitToken: { exists: false }, [key]: { exists: false } }), { code: 'invalid_configuration' });
    assert.equal(f.data.gitToken, undefined);
    assert.equal(f.state.writes.length, 0);
  }
});

test('known credentials and preferences have bounded types without logging their contents', async () => {
  const f = fixture();
  const items = { gitToken: 'private-token', davUrl: 'https://backup.example/dav/', davUser: 'user', davPass: 'private-password',
    syncProvider: 'webdav', autoSync: true, theme: 'light', appLanguage: 'zh_CN' };
  await f.store.save(items, f.expected(Object.keys(items)));
  assert.equal(f.data.davPass, 'private-password');
  for (const [key, value] of [['gitToken', 123], ['davPass', 'x'.repeat(4097)], ['theme', 'invalid'], ['autoSync', 'yes']]) {
    await assert.rejects(f.store.save({ [key]: value }, f.expected([key])), error =>
      error.code === 'invalid_configuration' && error.message === 'invalid_configuration' && !error.message.includes('private'));
  }
});

test('empty server lists and active IDs are valid, while invalid IDs and malformed rules are rejected', async () => {
  const f = fixture();
  await f.store.save({ serverList: [], activeServerId: '', tempRules: ['temporary.example'], gfwlistUrl: 'https://partially-typed' },
    f.expected(['serverList', 'activeServerId', 'tempRules', 'gfwlistUrl']));
  assert.deepEqual(f.data.serverList, []);
  assert.equal(f.data.gfwlistUrl, 'https://partially-typed');
  await assert.rejects(f.store.save({ activeServerId: 'missing' }, f.expected(['activeServerId'])), { code: 'invalid_configuration' });
  await assert.rejects(f.store.save({ userRules: ['valid.example', 123] }, f.expected(['userRules'])), { code: 'invalid_rules' });
  await f.store.save({ gfwlistUrl: 'h' }, f.expected(['gfwlistUrl']));
  assert.equal(f.data.gfwlistUrl, 'h');
});

test('subscription metadata and all required optimistic-baseline fields are checked', async () => {
  const f = fixture();
  await assert.rejects(f.store.save({ userRules: [] }, {}), { code: 'invalid_configuration' });
  await assert.rejects(f.store.save({ userRules: [] }, { userRules: { exists: true } }), { code: 'invalid_configuration' });
  await assert.rejects(f.store.save({ gfwDomains: ['site.example'], ruleCount: 2 },
    f.expected(['gfwDomains', 'ruleCount'])), { code: 'invalid_configuration' });
  await f.store.save({ gfwDomains: ['site.example'], ruleCount: 1, lastUpdate: '2026-10-13' }, f.expected(['gfwDomains', 'ruleCount', 'lastUpdate']));
  assert.equal(f.data.ruleCount, 1);
});

test('a cloud-style mutation holds its lease from reading until its delayed commit; stale UI saves wait then reject', async () => {
  const f = fixture();
  const baseline = f.expected(['userRules']);
  f.state.hold = true;
  const restore = f.store.run(async () => {
    const before = await new Promise(resolve => f.chrome.storage.local.get(['userRules'], resolve));
    await new Promise(resolve => f.chrome.storage.local.set({ userRules: ['cloud.example'], cloudRestoreUndo: { before } }, resolve));
  });
  await tick();
  assert.equal(f.state.held.length, 1);
  const reads = f.state.reads;
  let done = false;
  const save = f.store.save({ userRules: ['old.example', 'ui.example'] }, baseline).finally(() => { done = true; });
  // Attach a rejection handler now; the delayed lease must not cause an unhandled rejection.
  const rejected = assert.rejects(save, { code: 'config_changed' });
  await tick();
  assert.equal(done, false);
  assert.equal(f.state.reads, reads, 'UI cannot read-and-write inside a restore commit lease');
  f.state.held.shift()();
  await restore;
  await rejected;
  assert.deepEqual(f.data.userRules, ['cloud.example']);
  assert.ok(f.data.cloudRestoreUndo);
  assert.equal(f.state.writes.length, 1);
});

test('a delayed UI write blocks every later configuration mutation until Chrome confirms it', async () => {
  const f = fixture();
  f.state.hold = true;
  const first = f.store.save({ userRules: ['first.example'] }, f.expected(['userRules']));
  await tick();
  let entered = false;
  const later = f.store.run(() => { entered = true; });
  await tick();
  assert.equal(entered, false);
  f.state.held.shift()();
  await first; await later;
  assert.equal(entered, true);
});

test('failed read/write operations report only a safe category and permit a later retry', async () => {
  for (const method of ['get', 'set']) {
    const f = fixture(); f.state.fail = method;
    await assert.rejects(f.store.save({ userRules: ['new.example'] }, f.expected(['userRules'])), { code: 'storage_failed', message: 'storage_failed' });
    f.state.fail = null;
    await f.store.save({ userRules: ['new.example'] }, f.expected(['userRules']));
    assert.deepEqual(f.data.userRules, ['new.example']);
  }
});

for (const phase of ['apply', 'undo']) {
  test(`real cloud ${phase} and UI SAVE share the same delayed-commit mutation lease`, async t => {
    const f = fixture({ syncProvider: 'webdav', davUrl: 'https://backup.example/dav/', davUser: 'user', davPass: 'private' });
    const service = createCloud({ chrome: f.chrome, configuration, mutateConfiguration: fn => f.store.run(fn),
      fetch: async () => ({ ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ backupVer: 5, userRules: ['cloud.example'] }) }),
      uuid: () => 'cloud-id', refresh: async () => {}, report() {} });
    t.after(() => service.dispose());
    await service.ready;
    const preview = await service.preview();
    if (phase === 'undo') await service.apply(preview.previewId);
    const baseline = f.expected(['userRules']);
    f.state.hold = true;
    const cloudOperation = phase === 'apply' ? service.apply(preview.previewId) : service.undo();
    await tick();
    assert.equal(f.state.held.length, 1);
    const reads = f.state.reads;
    let uiFinished = false;
    const uiSave = f.store.save({ userRules: ['ui.example'] }, baseline).finally(() => { uiFinished = true; });
    const rejected = assert.rejects(uiSave, { code: 'config_changed' });
    await tick();
    assert.equal(uiFinished, false);
    assert.equal(f.state.reads, reads, 'UI comparison must wait until the cloud write truly commits');
    f.state.held.shift()();
    await cloudOperation;
    await rejected;
    assert.deepEqual(f.data.userRules, [phase === 'apply' ? 'cloud.example' : 'old.example']);
  });
}

test('read timeouts safely release the queue and a late read cannot dispatch an obsolete write', async () => {
  const f = fixture();
  let lateRead; let reads = 0;
  const originalGet = f.chrome.storage.local.get;
  f.chrome.storage.local.get = (keys, callback) => {
    if (++reads === 1) lateRead = callback;
    else originalGet(keys, callback);
  };
  const store = create({ chrome: f.chrome, configuration, readTimeout: 15 });
  const first = store.save({ userRules: ['stale.example'] }, f.expected(['userRules']));
  const rejected = assert.rejects(first, { code: 'storage_timeout' });
  const second = store.save({ userRules: ['latest.example'] }, f.expected(['userRules']));
  await rejected; await second;
  lateRead({ userRules: ['old.example'] });
  await tick();
  assert.deepEqual(f.data.userRules, ['latest.example']);
  assert.equal(f.state.writes.length, 1);
});
