'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'background.js'), 'utf8');

function createWorker({ mode = 'pac_script', noServer = false, control = 'controlled_by_this_extension' } = {}) {
  const data = {
    serverList: noServer ? [] : [{ id: 'main', host: '127.0.0.1', port: 10808, scheme: 'SOCKS5' }],
    activeServerId: 'main',
    userRules: ['example.com'],
    userWhitelist: ['docs.example.com'],
  };
  const state = { mode, control, fault: null, writes: [], timers: [], icons: [], onPersist: null };
  let ready = false;
  let messageListener;
  let context;
  const event = { addListener() {} };
  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: 'test' }),
      onInstalled: event,
      onConnect: event,
      onMessage: { addListener(listener) { messageListener = listener; } },
    },
    storage: {
      onChanged: event,
      local: {
        get(keys, callback) {
          // Startup is outside this rule-refresh test; leave its initial read pending.
          if (!ready) return;
          invoke('storage.get', callback, Object.fromEntries(keys.map((key) => [key, data[key]])));
        },
        set(items, callback) {
          if (!callback) return Promise.resolve(); // Boot journal writes.
          invoke('storage.set', callback, undefined, () => {
            Object.assign(data, items);
            if (state.onPersist) state.onPersist();
          });
        },
      },
    },
    proxy: {
      settings: {
        get(_details, callback) {
          assert.equal(vm.runInContext('isApplyingProxy', context), true,
            'refresh must retain the operation lock through PAC persistence');
          invoke('proxy.get', callback, { value: { mode: state.mode }, levelOfControl: state.control });
        },
        set(details, callback) {
          invoke('proxy.set', callback, undefined, () => {
            state.writes.push(details);
            state.mode = details.value.mode;
          });
        },
      },
    },
    tabs: { onUpdated: event, onActivated: event, onRemoved: event },
  };

  function invoke(operation, callback, value, beforeCallback) {
    const fault = state.fault && state.fault.operation === operation ? state.fault : null;
    if (fault && fault.sync) throw new Error(`${operation} failed`);
    queueMicrotask(() => {
      chrome.runtime.lastError = fault ? { message: `${operation} failed` } : null;
      if (!fault && beforeCallback) beforeCallback();
      try { callback(value); } finally { chrome.runtime.lastError = null; }
    });
  }

  context = vm.createContext({
    chrome,
    console: { error() {}, warn() {}, log() {} },
    crypto: { randomUUID: () => 'test-boot' },
    self: { addEventListener() {} },
    PSL: { setBootId() {}, perf() {}, error() {}, warn() {}, info() {}, checkpoint() {} },
    importScripts() {},
    ProxySwitchRouting: require('../js/routing.js'),
    URL,
    setTimeout(callback) { state.timers.push(callback); return state.timers.length; },
    clearTimeout() {},
    recordIcon: (selectedMode) => state.icons.push(selectedMode),
  });
  vm.runInContext(SOURCE, context, { filename: 'background.js' });
  vm.runInContext('handleGlobalIconUpdate = recordIcon;', context);
  ready = true;

  return {
    data,
    state,
    context,
    refresh(applyIfPac = true) {
      return new Promise((resolve) => {
        assert.equal(messageListener({ type: 'REFRESH_PROXY', applyIfPac }, {}, resolve), true);
      });
    },
    refreshDiagnostics() {
      return new Promise((resolve) => {
        context.diagnosticRefreshDone = (error) => resolve(error ? { success: false, error: error.message } : { success: true });
        vm.runInContext('refreshCacheAndIcon(diagnosticRefreshDone, true, true);', context);
      });
    },
    locked: () => vm.runInContext('isApplyingProxy', context),
  };
}

function route(script, hostname) {
  const context = vm.createContext({
    isPlainHostName: (host) => !host.includes('.'),
    shExpMatch: (host, pattern) => pattern === '*.local' && host.endsWith('.local'),
    isInNet: () => false,
  });
  vm.runInContext(script, context);
  return context.FindProxyForURL(`https://${hostname}/`, hostname);
}

test('explicit refresh applies whitelist immediately, and undo restores the original proxy rule', async () => {
  const worker = createWorker();
  assert.equal((await worker.refresh()).success, true);
  assert.equal(worker.state.writes.length, 1);
  assert.equal(route(worker.state.writes[0].value.pacScript.data, 'docs.example.com'), 'DIRECT');
  assert.match(route(worker.state.writes[0].value.pacScript.data, 'other.example.com'), /^SOCKS5 /);
  assert.equal(worker.locked(), false);

  worker.data.userWhitelist = [];
  assert.equal((await worker.refresh()).success, true);
  assert.match(route(worker.state.writes[1].value.pacScript.data, 'docs.example.com'), /^SOCKS5 /);
});

test('ordinary refresh regenerates PAC without applying proxy settings', async () => {
  const worker = createWorker();
  assert.equal((await worker.refresh(false)).success, true);
  assert.match(worker.data.pacScriptData, /docs\.example\.com/);
  assert.equal(worker.state.writes.length, 0);
  assert.equal(worker.locked(), false);
});

for (const control of ['controlled_by_other_extensions', 'controllable_by_this_extension', 'not_controllable']) {
  test(`diagnostic cleanup preserves PAC owned elsewhere: ${control}`, async () => {
    const worker = createWorker({ control });
    assert.equal((await worker.refreshDiagnostics()).success, true);
    assert.equal(worker.state.writes.length, 0);
    assert.equal(worker.locked(), false);
  });
}

test('diagnostic refresh rechecks PAC ownership after persistence', async () => {
  const worker = createWorker();
  worker.state.onPersist = () => { worker.state.control = 'controlled_by_other_extensions'; };
  assert.equal((await worker.refreshDiagnostics()).success, true);
  assert.equal(worker.state.writes.length, 0);
  assert.equal(worker.locked(), false);
});

test('diagnostic refresh applies PAC while still controlled by this extension', async () => {
  const worker = createWorker();
  assert.equal((await worker.refreshDiagnostics()).success, true);
  assert.equal(worker.state.writes.length, 1);
  assert.equal(worker.locked(), false);
});

for (const mode of ['system', 'direct', 'fixed_servers']) {
  test(`explicit refresh preserves ${mode}, including mode changes during persistence`, async () => {
    const worker = createWorker();
    worker.state.onPersist = () => { worker.state.mode = mode; };
    assert.equal((await worker.refresh()).success, true);
    assert.equal(worker.state.writes.length, 0);
    assert.equal(worker.state.mode, mode);
    assert.deepEqual(worker.state.icons, [mode]);
    assert.equal(worker.locked(), false);
  });
}

test('waiting for an ongoing operation preserves the explicit PAC application request', async () => {
  const worker = createWorker();
  vm.runInContext('isApplyingProxy = true;', worker.context);
  const response = worker.refresh();
  assert.equal(worker.state.timers.length, 1);
  vm.runInContext('isApplyingProxy = false;', worker.context);
  worker.state.timers.shift()();
  assert.equal((await response).success, true);
  assert.equal(worker.state.writes.length, 1);
});

test('explicit PAC refresh without a server reports failure and releases the lock', async () => {
  const worker = createWorker({ noServer: true });
  const response = await worker.refresh();
  assert.equal(response.success, false);
  assert.equal(response.error, 'no_server');
  assert.equal(worker.state.writes.length, 0);
  assert.equal(worker.locked(), false);
});

for (const mode of ['system', 'direct', 'fixed_servers']) {
  test(`explicit refresh without a server succeeds in ${mode} without changing the mode`, async () => {
    const worker = createWorker({ mode, noServer: true });
    assert.equal((await worker.refresh()).success, true);
    assert.equal(worker.state.writes.length, 0);
    assert.equal(worker.state.mode, mode);
    assert.deepEqual(worker.state.icons, [mode]);
    assert.equal(worker.locked(), false);
  });
}

for (const operation of ['storage.get', 'storage.set', 'proxy.get', 'proxy.set']) {
  for (const sync of [false, true]) {
    test(`${operation} ${sync ? 'exception' : 'callback failure'} returns an error and permits retry`, async () => {
      const worker = createWorker();
      worker.state.fault = { operation, sync };
      const response = await worker.refresh();
      assert.equal(response.success, false);
      assert.equal(response.error, `${operation} failed`);
      assert.equal(worker.locked(), false);
      worker.state.fault = null;
      assert.equal((await worker.refresh()).success, true);
      assert.equal(worker.state.writes.length, 1);
      assert.equal(worker.locked(), false);
    });
  }
}
