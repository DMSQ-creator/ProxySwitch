'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const configuration = require('../js/configuration.js');
const { create } = require('../js/cloud-sync.js');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(t, remote = { backupVer: 5, userRules: [], userWhitelist: [] }, initial = {}) {
  const data = { userRules: ['old.example'], userWhitelist: ['direct.example'], serverList: [],
    activeServerId: '', gfwlistUrl: '', syncProvider: 'webdav', davUrl: 'https://backup.example/dav/',
    davUser: 'user', davPass: 'private', ...initial };
  let clock = 100000; let id = 0; let refreshes = 0;
  const calls = []; const alarms = []; let alarmListener;
  let nextFailure = null; let onFetch = null; let onWrite = null; let onRead = null;
  const chrome = { runtime: { lastError: null }, storage: { local: {
    get(keys, callback) {
      const value = clone(keys === null ? data : Object.fromEntries(keys.filter(key => data[key] !== undefined).map(key => [key, data[key]])));
      queueMicrotask(() => onRead ? onRead(keys, value, callback) : callback(value));
    },
    set(items, callback) { queueMicrotask(() => {
      if (nextFailure === 'set') { nextFailure = null; chrome.runtime.lastError = { message: 'failed' }; }
      else { Object.assign(data, clone(items)); if (onWrite) onWrite(items); }
      callback(); chrome.runtime.lastError = null;
    }); },
    remove(keys, callback) { queueMicrotask(() => { for (const key of keys) delete data[key]; callback(); }); },
  } }, alarms: { create(name, info) { alarms.push({ name, ...info }); }, clear(_name, callback) { callback(); },
    onAlarm: { addListener(listener) { alarmListener = listener; } } } };
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (onFetch) await onFetch(url, options);
    return { ok: true, status: 200, headers: { get() { return null; } }, text: async () => JSON.stringify(remote) };
  };
  const service = create({ chrome, configuration, fetch: fetcher, now: () => clock, uuid: () => 'id-' + (++id),
    refresh: async () => { refreshes++; }, report() {}, networkTimeout: 30 });
  t.after(() => service.dispose());
  return { data, service, calls, alarms, advance: ms => { clock += ms; }, refreshes: () => refreshes,
    failSet: () => { nextFailure = 'set'; }, onFetch: fn => { onFetch = fn; }, onWrite: fn => { onWrite = fn; },
    onRead: fn => { onRead = fn; },
    alarm: name => alarmListener({ name }) };
}
test('cloud restore requires a preview, accepts empty lists and preserves unrelated local settings', async t => {
  const f = fixture(t, { backupVer: 5, userRules: [], userWhitelist: [], tempRules: ['ignored.example'],
    appLanguage: 'en', gitToken: 'remote-secret', diagnosticSession: { invalid: true } },
  { tempRules: ['session.example'], appLanguage: 'zh_CN', gitToken: 'local-secret' });
  await f.service.ready;
  await assert.rejects(f.service.apply('unknown'), { code: 'preview_expired' });
  const preview = await f.service.preview();
  assert.equal(preview.summary.fields[0].clears, true);
  assert.deepEqual(f.data.userRules, ['old.example']);
  assert.equal((await f.service.apply(preview.previewId)).applyPending, false);
  assert.deepEqual(f.data.userRules, []); assert.deepEqual(f.data.userWhitelist, []);
  assert.deepEqual(f.data.tempRules, ['session.example']); assert.equal(f.data.gitToken, 'local-secret');
  assert.equal(f.data.appLanguage, 'zh_CN'); assert.equal(f.data.diagnosticSession, undefined);
  assert.equal(f.data.cloudRestorePreview, undefined); assert.ok(f.data.cloudRestoreUndo);
  assert.equal(f.refreshes(), 1);
  await f.service.undo();
  assert.deepEqual(f.data.userRules, ['old.example']); assert.deepEqual(f.data.userWhitelist, ['direct.example']);
  assert.equal(f.data.cloudRestoreUndo, undefined);
});
test('cloud preview never applies invalid data, credentials, unknown keys or unsupported versions', async t => {
  for (const remote of [{ backupVer: 5, userRules: [123] }, { backupVer: 99, userRules: [] },
    { backupVer: 5, autoSync: true }, { userRules: [] }]) {
    const f = fixture(t, remote); await f.service.ready;
    await assert.rejects(f.service.preview());
    assert.deepEqual(f.data.userRules, ['old.example']); assert.equal(f.data.cloudRestoreUndo, undefined);
  }
});
test('stale preview and undo never overwrite edits made after a preview or restore', async t => {
  const f = fixture(t); await f.service.ready;
  const first = await f.service.preview(); f.data.userRules.push('new.example');
  await assert.rejects(f.service.apply(first.previewId), { code: 'restore_modified' });
  const second = await f.service.preview(); await f.service.apply(second.previewId);
  f.data.userRules.push('after.example');
  await assert.rejects(f.service.undo(), { code: 'restore_modified' });
  assert.deepEqual(f.data.userRules, ['after.example']);
});
test('expired restore preview is rejected and failed storage keeps existing local settings', async t => {
  const f = fixture(t); await f.service.ready;
  let preview = await f.service.preview(); f.advance(5 * 60000);
  await assert.rejects(f.service.apply(preview.previewId), { code: 'preview_expired' });
  preview = await f.service.preview(); f.failSet();
  await assert.rejects(f.service.apply(preview.previewId), { code: 'storage_failed' });
  assert.deepEqual(f.data.userRules, ['old.example']); assert.equal(f.data.cloudRestoreUndo, undefined);
});
test('backup upload has a strict schema and excludes temporary rules, undo and diagnostic records', async t => {
  const f = fixture(t, undefined, { tempRules: ['temporary.example'], diagnosticSession: { hostname: 'private.example' },
    diagnosticRuleUndo: { hosts: ['private.example'], afterDigest: 'private' }, diagnosticUiState: { pendingMutation: { actionId: 'private' } },
    diagnosticAutoCapture: true, diagnosticAutoRecords: { records: [{ hostname: 'private.example' }] },
    cloudRestoreUndo: { before: { userRules: ['undo.example'] } }, autoSync: false });
  await f.service.ready; await f.service.upload();
  const body = JSON.parse(f.calls.find(call => call.options.method === 'PUT').options.body);
  assert.equal(body.backupVer, 5); assert.deepEqual(body.userRules, ['old.example']);
  for (const key of ['tempRules', 'davPass', 'gitToken', 'diagnosticSession', 'diagnosticRuleUndo', 'diagnosticUiState', 'diagnosticAutoCapture', 'diagnosticAutoRecords', 'cloudRestoreUndo']) assert.equal(body[key], undefined);
});
test('editing during upload retains a durable pending marker and a later upload includes the edit', async t => {
  const f = fixture(t, undefined, { autoSync: true }); await f.service.ready;
  await f.service.changed({ userRules: { newValue: f.data.userRules } });
  let first = true;
  f.onFetch(async (_url, options) => {
    if (options.method === 'PUT' && first) {
      first = false; f.data.userRules.push('during.example');
      await f.service.changed({ userRules: { newValue: f.data.userRules } });
    }
  });
  await f.service.upload(); assert.ok(f.data.cloudSyncPending);
  await f.service.upload(); assert.equal(f.data.cloudSyncPending, undefined);
  assert.deepEqual(JSON.parse(f.calls.filter(c => c.options.method === 'PUT')[1].options.body).userRules,
    ['old.example', 'during.example']);
});
test('worker restart re-arms persisted auto-upload without starting a page capture', async t => {
  const f = fixture(t, undefined, { autoSync: true, cloudSyncPending: { revision: 'old', changedAt: 1 } });
  await f.service.ready; assert.ok(f.alarms.some(alarm => alarm.name === 'proxyswitch-cloud-sync'));
  await f.service.flushAuto(); assert.equal(f.data.cloudSyncPending, undefined);
  assert.ok(f.calls.some(call => call.options.method === 'PUT'));
});
test('remote WebDAV HTTP credentials are refused, and network abort leaves pending sync retryable', async t => {
  const f = fixture(t, undefined, { davUrl: 'http://remote.example/dav/' }); await f.service.ready;
  await assert.rejects(f.service.upload(), { code: 'insecure_backup_url' }); assert.equal(f.calls.length, 0);
  const g = fixture(t, undefined, { cloudSyncPending: { revision: 'pending' } }); await g.service.ready;
  g.onFetch((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Abort'), { name: 'AbortError' })), { once: true });
  }));
  await assert.rejects(g.service.upload(), { code: 'network_timeout' }); assert.ok(g.data.cloudSyncPending);
});

test('queued automatic upload rechecks opt-out after a preceding manual operation', async t => {
  const f = fixture(t, undefined, { autoSync: true, cloudSyncPending: { revision: 'pending' } });
  await f.service.ready;
  let releaseFlags; let releaseDownload;
  f.onRead((keys, value, callback) => {
    if (keys && keys.length === 2 && keys[0] === 'autoSync' && !releaseFlags) releaseFlags = () => callback(value);
    else callback(value);
  });
  const auto = f.service.flushAuto();
  await Promise.resolve(); await Promise.resolve();
  f.onFetch(() => new Promise(resolve => { releaseDownload = resolve; }));
  const preview = f.service.preview();
  for (let count = 0; count < 20 && !releaseDownload; count++) await Promise.resolve();
  assert.equal(typeof releaseDownload, 'function');
  f.data.autoSync = false;
  releaseFlags(); releaseDownload();
  await Promise.all([auto, preview]);
  assert.equal(f.calls.filter(call => call.options.method === 'PUT').length, 0);
  assert.ok(f.data.cloudSyncPending);
});
