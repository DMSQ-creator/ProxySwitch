'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'background.js'), 'utf8');

function createWorker({ mode = 'pac_script', noServer = false, control = 'controlled_by_this_extension', diagnosticReset } = {}) {
  const data = {
    serverList: noServer ? [] : [{ id: 'main', host: '127.0.0.1', port: 10808, scheme: 'SOCKS5' }],
    activeServerId: 'main',
    userRules: ['example.com'],
    userWhitelist: ['docs.example.com'],
  };
  const state = { mode, value: { mode }, control, fault: null, writes: [], proxyClears: [], timers: [], icons: [], badges: [], logs: [], cloudChanges: [], onPersist: null, held: [] };
  let messageListener;
  let context;
  const event = { addListener() {} };
  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: 'test' }),
      onInstalled: event,
      onStartup: { addListener(listener) { state.onStartup = listener; } },
      onConnect: event,
      onMessage: { addListener(listener) { messageListener = listener; } },
    },
    storage: {
      onChanged: { addListener(listener) { state.storageChanged = listener; } },
      local: {
        get(keys, callback) {
          const result = Object.fromEntries(keys.map((key) => [key, data[key]]));
          if (!callback) return Promise.resolve(result);
          invoke('storage.get', callback, result);
        },
        set(items, callback) {
          if (!callback) { Object.assign(data, items); return Promise.resolve(); }
          invoke('storage.set', callback, undefined, () => {
            Object.assign(data, items);
            if (state.onPersist) state.onPersist();
          });
        },
        clear(callback) {
          invoke('storage.clear', callback, undefined, () => {
            for (const key of Object.keys(data)) delete data[key];
          });
        },
      },
    },
    proxy: {
      settings: {
        onChange: { addListener(listener) { state.proxyChanged = listener; } },
        get(_details, callback) {
          assert.equal(vm.runInContext('isApplyingProxy', context), true,
            'refresh must retain the operation lock through PAC persistence');
          invoke('proxy.get', callback, { value: { ...state.value, mode: state.mode }, levelOfControl: state.control });
        },
        set(details, callback) {
          invoke('proxy.set', callback, undefined, () => {
            state.writes.push(details);
            state.mode = details.value.mode;
            state.value = details.value;
            state.control = 'controlled_by_this_extension';
          });
        },
        clear(details, callback) {
          invoke('proxy.clear', callback, undefined, () => {
            state.proxyClears.push(details);
            if (state.control === 'controlled_by_this_extension') {
              state.mode = 'system';
              state.value = { mode: 'system' };
              state.control = 'controllable_by_this_extension';
            }
          });
        },
      },
      onProxyError: { addListener(listener) { state.proxyError = listener; } },
    },
    tabs: { onUpdated: event, onActivated: event, onRemoved: event, query(_query, callback) { callback([]); } },
    action: { setBadgeText(details) { state.badges.push(details.text); }, setBadgeBackgroundColor() {} },
  };

  function invoke(operation, callback, value, beforeCallback) {
    const fault = state.fault && state.fault.operation === operation ? state.fault : null;
    if (fault && fault.pending) { state.held.push(() => invoke(operation, callback, value, beforeCallback)); return; }
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
    generateUUID: () => 'test-id',
    self: { addEventListener() {} },
    PSL: { setBootId() {}, perf() {}, error(...args) { state.logs.push(args); }, warn(...args) { state.logs.push(args); }, info(...args) { state.logs.push(args); }, checkpoint() {}, prune() {} },
    importScripts() {},
    ProxySwitchRouting: require('../js/routing.js'),
    ProxySwitchConfiguration: require('../js/configuration.js'),
    ProxySwitchConfigurationStore: require('../js/configuration-store.js'),
    ProxySwitchCloudSync: { create: () => ({ changed(changes) { state.cloudChanges.push(changes); return Promise.resolve(); } }) },
    ...(diagnosticReset ? { ProxySwitchDiagnostics: { create: () => diagnosticReset } } : {}),
    URL,
    setTimeout(callback, delay) { const timer = { callback, delay, cancelled: false }; state.timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    recordIcon: (selectedMode) => state.icons.push(selectedMode),
  });
  // Each test starts an operation explicitly so startup cannot hide a refresh failure.
  vm.runInContext(SOURCE.replace('updateCacheAndApply(undefined, undefined, undefined, true);', ''), context, { filename: 'background.js' });
  vm.runInContext('handleGlobalIconUpdate = recordIcon;', context);

  return {
    data,
    state,
    context,
    refresh(applyIfPac = true) {
      return new Promise((resolve) => {
        assert.equal(messageListener({ type: 'REFRESH_PROXY', applyIfPac }, {}, resolve), true);
      });
    },
    selectMode(selectedMode) {
      return new Promise(resolve => { messageListener({ type: 'SET_PROXY_MODE', mode: selectedMode }, {}, resolve); });
    },
    request(message) {
      return new Promise(resolve => messageListener(message, {}, resolve));
    },
    refreshDiagnostics() {
      return new Promise((resolve) => {
        context.diagnosticRefreshDone = (error) => resolve(error ? { success: false, error: error.message } : { success: true });
        vm.runInContext('refreshCacheAndIcon(diagnosticRefreshDone, true, true);', context);
      });
    },
    maintenance(traceBoot = false) {
      return new Promise((resolve) => {
        context.maintenanceDone = (error) => resolve(error ? { success: false, error: error.message } : { success: true });
        vm.runInContext(`enqueueProxyOperation({ kind: 'maintenance', traceBoot: ${traceBoot}, done: maintenanceDone });`, context);
      });
    },
    changeRules(rules) {
      const oldValue = data.userRules;
      data.userRules = rules;
      state.storageChanged({ userRules: { oldValue, newValue: rules } }, 'local');
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

test('configuration reset stops and fences diagnostics before releasing PAC or clearing local storage', async () => {
  let release; let stopped = false;
  const gate = new Promise(resolve => { release = resolve; });
  const worker = createWorker({ diagnosticReset: {
    beginReset() { stopped = true; return gate; }, endReset() { assert.fail('successful reset must keep the fence'); },
  } });
  const reset = worker.request({ type: 'RESET_CONFIGURATION' });
  assert.equal(stopped, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.state.proxyClears.length, 0);
  assert.deepEqual(worker.data.userRules, ['example.com']);
  release(); assert.equal((await reset).success, true);
  assert.equal(worker.state.proxyClears.length, 1); assert.equal(worker.data.userRules, undefined);
});

test('diagnostic stop failure aborts reset without deleting configuration and releases the reset fence', async () => {
  const endings = [];
  const worker = createWorker({ diagnosticReset: {
    beginReset: () => Promise.reject(Object.assign(new Error('storage_failed'), { code: 'storage_failed' })),
    endReset(success) { endings.push(success); },
  } });
  const reset = await worker.request({ type: 'RESET_CONFIGURATION' });
  assert.equal(reset.error, 'storage_failed');
  assert.deepEqual(endings, [false]); assert.equal(worker.state.proxyClears.length, 0);
  assert.deepEqual(worker.data.userRules, ['example.com']);
  assert.equal((await worker.request({ type: 'SAVE_CONFIGURATION', items: { userRules: ['later.example'] },
    expected: { userRules: { exists: true, value: ['example.com'] } } })).success, true);
});

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
  worker.state.fault = { operation: 'storage.get', pending: true };
  const first = worker.refresh(false);
  const response = worker.refresh();
  assert.equal(worker.state.held.length, 1, 'the second operation cannot read before the first finishes');
  assert.equal(worker.state.timers.filter(timer => !timer.cancelled).length, 1);
  worker.state.fault = null;
  worker.state.held.shift()();
  assert.equal((await first).success, true);
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

for (const control of ['controlled_by_other_extensions', 'controllable_by_this_extension', 'not_controllable']) {
  for (const mode of ['pac_script', 'fixed_servers']) {
    test(`ordinary refresh and maintenance never take over ${mode}: ${control}`, async () => {
      const worker = createWorker({ mode, control });
      assert.equal((await worker.refresh()).success, true);
      assert.equal((await worker.maintenance()).success, true);
      assert.equal(worker.state.writes.length, 0);
      assert.equal(worker.data.proxyRuntimeStatus.levelOfControl, control);
      assert.equal(worker.state.mode, mode);
    });
  }
}

test('rule changes while PAC persistence is pending are reread instead of discarded', async () => {
  const worker = createWorker();
  worker.state.onPersist = () => {
    worker.state.onPersist = null;
    worker.changeRules(['example.com', 'new.example']);
  };
  assert.equal((await worker.refresh()).success, true);
  await new Promise(resolve => setImmediate(resolve));
  const last = worker.state.writes.at(-1).value.pacScript.data;
  assert.match(route(last, 'new.example'), /^SOCKS5 /);
  assert.match(route(worker.data.pacScriptData, 'new.example'), /^SOCKS5 /);
  assert.equal(worker.locked(), false);
});

test('many busy configuration notifications are coalesced without losing the newest snapshot', async () => {
  const worker = createWorker();
  worker.state.fault = { operation: 'storage.get', pending: true };
  const first = worker.refresh(false);
  worker.changeRules(['old.example']);
  worker.changeRules(['latest.example']);
  assert.equal(worker.state.cloudChanges.length, 2, 'cloud change notifications are never skipped by the proxy lock');
  assert.equal(vm.runInContext('proxyOperationQueue.length', worker.context), 1);
  worker.state.fault = null;
  worker.state.held.shift()();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.match(route(worker.state.writes.at(-1).value.pacScript.data, 'latest.example'), /^SOCKS5 /);
  assert.equal(route(worker.state.writes.at(-1).value.pacScript.data, 'old.example'), 'DIRECT');
});

test('a timed-out operation releases the queue and cannot resume via a late callback', async () => {
  const worker = createWorker();
  worker.state.fault = { operation: 'storage.get', pending: true };
  const first = worker.refresh();
  const second = worker.refresh();
  const timeout = worker.state.timers.find(timer => !timer.cancelled && timer.delay === 8000);
  assert.ok(timeout);
  worker.state.fault = null;
  timeout.callback();
  assert.equal((await first).error, 'proxy_operation_timeout');
  assert.equal((await second).success, true);
  const writeCount = worker.state.writes.length;
  worker.state.held.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.state.writes.length, writeCount);
  assert.equal(worker.locked(), false);
});

for (const operation of ['storage.set', 'proxy.set']) {
  test(`a timed-out ${operation} retains its write lease until the old commit completes`, async () => {
    const worker = createWorker();
    worker.state.fault = { operation, pending: true };
    const first = worker.refresh();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(worker.state.held.length, 1);
    let secondFinished = false;
    const second = worker.refresh().then(result => { secondFinished = true; return result; });
    worker.changeRules(['newest.example']);
    const timeout = worker.state.timers.find(timer => !timer.cancelled && timer.delay === 8000);
    timeout.callback();
    assert.equal((await first).error, 'proxy_operation_timeout');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(worker.locked(), true, 'an unacknowledged write still owns the serial lease');
    assert.equal(secondFinished, false, 'new writes must not race a still-pending old commit');
    assert.equal(worker.state.writes.length, 0);
    worker.state.fault = null;
    worker.state.held.shift()(); // The old write actually commits now, before its callback.
    assert.equal((await second).success, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(route(worker.state.writes.at(-1).value.pacScript.data, 'newest.example'), /^SOCKS5 /);
    assert.match(route(worker.data.pacScriptData, 'newest.example'), /^SOCKS5 /);
    assert.equal(worker.locked(), false);
  });
}

test('startup maintenance tolerates malformed stored rule lists and server entries', async () => {
  const worker = createWorker();
  worker.data.userRules = ['example.com', 42, null, {}, '  SAFE.EXAMPLE  '];
  worker.data.userWhitelist = { invalid: true };
  worker.data.diagnosticTrial = { direction: 'proxy', hosts: [null, 7, 'trial.example'], expiresAt: Date.now() + 60000 };
  worker.data.serverList.unshift(null, {}, { id: 'bad', host: 'host/name', port: 7897, scheme: 'HTTP' });
  assert.equal((await worker.maintenance(true)).success, true);
  assert.match(route(worker.state.writes[0].value.pacScript.data, 'safe.example'), /^SOCKS5 /);
  assert.equal(vm.runInContext('initReadyResolver', worker.context), null);
  assert.equal(vm.runInContext('cachedDiagnosticTrial.hosts.join(",")', worker.context), 'trial.example');
});

test('matching short hashes never hide a stale or corrupt persisted PAC script', async () => {
  const worker = createWorker();
  assert.equal((await worker.refresh(false)).success, true);
  const expected = worker.data.pacScriptData;
  worker.data.pacScriptData = 'function FindProxyForURL() { return "DIRECT"; }';
  assert.equal((await worker.refresh(false)).success, true);
  assert.equal(worker.data.pacScriptData, expected);
});

test('no valid server does not silently replace PAC with direct mode', async () => {
  const worker = createWorker();
  worker.data.serverList = [{ id: 'main', host: '127.0.0.1', port: 'not-a-port', scheme: 'HTTP' }];
  assert.equal((await worker.maintenance()).error, 'no_server');
  assert.equal(worker.state.writes.length, 0);
  assert.equal(worker.state.mode, 'pac_script');
});

test('temporary rules survive worker wake but are cleared on browser startup only', async () => {
  const worker = createWorker();
  worker.data.tempRules = ['temporary.example'];
  assert.equal((await worker.maintenance()).success, true);
  assert.deepEqual(worker.data.tempRules, ['temporary.example']);
  await worker.state.onStartup();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.data.tempRules.length, 0);
  assert.equal(route(worker.data.pacScriptData, 'temporary.example'), 'DIRECT');
});

test('external proxy changes update observed state without applying this extension rules', async () => {
  const worker = createWorker();
  worker.state.proxyChanged({ value: { mode: 'fixed_servers' }, levelOfControl: 'controlled_by_other_extensions' });
  assert.equal(vm.runInContext('currentProxyMode', worker.context), 'fixed_servers');
  assert.equal(worker.data.proxyRuntimeStatus.levelOfControl, 'controlled_by_other_extensions');
  assert.equal(worker.state.badges.at(-1), '!');
  assert.equal(worker.state.writes.length, 0);
});

test('proxy errors persist safe categories and alert without storing request URLs', async () => {
  const worker = createWorker();
  worker.state.proxyError({ error: 'net::ERR_PROXY_CONNECTION_FAILED', fatal: true, details: 'https://private.example/path?token=secret' });
  assert.equal(worker.data.proxyRuntimeStatus.error.message, 'net::ERR_PROXY_CONNECTION_FAILED');
  assert.equal(worker.state.badges.at(-1), '!');
  assert.doesNotMatch(JSON.stringify(worker.data.proxyRuntimeStatus), /private|token|secret/);
  worker.state.proxyError({ error: 'https://private.example/path', details: 'secret' });
  assert.equal(worker.data.proxyRuntimeStatus.error.message, 'proxy_error');
});

for (const control of ['controlled_by_this_extension', 'controllable_by_this_extension']) {
  for (const mode of ['direct', 'system', 'fixed_servers', 'pac_script']) {
    test(`explicit mode choice ${mode} may apply when control is ${control}`, async () => {
      const worker = createWorker({ mode: 'system', control });
      const response = await worker.selectMode(mode);
      assert.equal(response.success, true);
      assert.equal(response.mode, mode);
      assert.equal(response.levelOfControl, 'controlled_by_this_extension');
      assert.equal(worker.state.writes.length, 1);
      assert.equal(worker.state.mode, mode);
    });
  }
}

for (const control of ['controlled_by_other_extensions', 'not_controllable']) {
  test(`explicit mode choice refuses unavailable proxy control: ${control}`, async () => {
    const worker = createWorker({ control });
    assert.equal((await worker.selectMode('direct')).error, 'proxy_uncontrolled');
    assert.equal(worker.state.writes.length, 0);
  });
}

test('explicit direct/system remain usable with failed configuration storage and no server', async () => {
  const worker = createWorker({ noServer: true });
  worker.state.fault = { operation: 'storage.get', sync: true };
  assert.equal((await worker.selectMode('direct')).success, true);
  assert.equal((await worker.selectMode('system')).success, true);
  assert.equal((await worker.selectMode('fixed_servers')).error, 'proxy_failed');
  worker.state.fault = null;
  assert.equal((await worker.selectMode('fixed_servers')).error, 'no_server');
  assert.equal((await worker.selectMode('pac_script')).error, 'no_server');
  assert.equal((await worker.selectMode('unknown')).error, 'invalid_mode');
});

test('explicit mode switching shares the write lease and reads the actual final mode', async () => {
  const worker = createWorker({ mode: 'system' });
  worker.state.fault = { operation: 'proxy.set', pending: true };
  const first = worker.selectMode('pac_script');
  await new Promise(resolve => setImmediate(resolve));
  let secondFinished = false;
  const second = worker.selectMode('direct').then(response => { secondFinished = true; return response; });
  worker.state.timers.find(timer => !timer.cancelled && timer.delay === 8000).callback();
  assert.equal((await first).error, 'proxy_timeout');
  assert.equal(secondFinished, false);
  assert.equal(worker.locked(), true);
  worker.state.fault = null;
  worker.state.held.shift()();
  const response = await second;
  assert.equal(response.success, true);
  assert.equal(response.mode, 'direct');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.state.mode, 'direct');
  assert.deepEqual(worker.state.writes.map(write => write.value.mode), ['pac_script', 'direct']);
});

test('SAVE_CONFIGURATION uses the shared mutation gate and rejects stale UI baselines after restore', async () => {
  const worker = createWorker();
  vm.runInContext('runConfigurationMutation(() => new Promise(resolve => { releaseConfiguration = resolve; }));', worker.context);
  await new Promise(resolve => setImmediate(resolve));
  let saveFinished = false;
  const save = worker.request({ type: 'SAVE_CONFIGURATION', items: { userRules: ['ui.example'] },
    expected: { userRules: { exists: true, value: ['example.com'] } } }).then(response => { saveFinished = true; return response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saveFinished, false);
  worker.data.userRules = ['cloud.example'];
  vm.runInContext('releaseConfiguration();', worker.context);
  assert.equal((await save).error, 'config_changed');
  assert.deepEqual(worker.data.userRules, ['cloud.example']);
});

test('configuration reset waits for the mutation lease and fences all new UI saves', async () => {
  const worker = createWorker();
  vm.runInContext('runConfigurationMutation(() => new Promise(resolve => { releaseConfiguration = resolve; }));', worker.context);
  await new Promise(resolve => setImmediate(resolve));
  let resetFinished = false;
  const reset = worker.request({ type: 'RESET_CONFIGURATION' }).then(response => { resetFinished = true; return response; });
  assert.equal((await worker.request({ type: 'SAVE_CONFIGURATION', items: { userRules: [] },
    expected: { userRules: { exists: true, value: ['example.com'] } } })).error, 'config_resetting');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resetFinished, false);
  assert.deepEqual(worker.data.userRules, ['example.com']);
  vm.runInContext('releaseConfiguration();', worker.context);
  assert.equal((await reset).success, true);
  assert.equal(worker.data.userRules, undefined);
  assert.equal((await worker.request({ type: 'RESET_CONFIGURATION' })).error, 'config_resetting');
});

test('failed reset releases its UI fence and configuration SAVE never permits internal-key injection', async () => {
  const worker = createWorker();
  worker.state.fault = { operation: 'storage.clear' };
  assert.equal((await worker.request({ type: 'RESET_CONFIGURATION' })).error, 'storage_failed');
  worker.state.fault = null;
  const response = await worker.request({ type: 'SAVE_CONFIGURATION', items: { gitToken: 'private-secret', cloudRestoreUndo: { private: true } },
    expected: { gitToken: { exists: false }, cloudRestoreUndo: { exists: false } } });
  assert.equal(response.error, 'invalid_configuration');
  assert.equal(worker.data.gitToken, undefined);
  assert.equal((await worker.request({ type: 'SAVE_CONFIGURATION', items: { userRules: ['new.example'] },
    expected: { userRules: { exists: true, value: ['example.com'] } } })).success, true);
  assert.deepEqual(worker.data.userRules, ['new.example']);
});

test('reset releases an installed owned PAC before clearing configuration, even without a server', async () => {
  const worker = createWorker();
  assert.equal((await worker.refresh()).success, true);
  assert.match(route(worker.state.value.pacScript.data, 'example.com'), /^SOCKS5 /);
  worker.data.serverList = [];
  const response = await worker.request({ type: 'RESET_CONFIGURATION' });
  assert.equal(response.success, true);
  assert.equal(response.mode, 'system');
  assert.equal(response.levelOfControl, 'controllable_by_this_extension');
  assert.equal(worker.state.proxyClears.length, 1);
  assert.equal(worker.state.proxyClears[0].scope, 'regular');
  assert.equal(worker.state.value.pacScript, undefined);
  assert.equal(worker.data.userRules, undefined);
});

for (const control of ['controlled_by_other_extensions', 'not_controllable', 'controllable_by_this_extension']) {
  test(`reset clears only this extension's setting and never applies a mode: ${control}`, async () => {
    const worker = createWorker({ mode: 'pac_script', control });
    worker.state.value = { mode: 'pac_script', pacScript: { data: 'external-script' } };
    assert.equal((await worker.request({ type: 'RESET_CONFIGURATION' })).success, true);
    assert.equal(worker.state.writes.length, 0);
    assert.equal(worker.state.proxyClears.length, 1);
    assert.equal(worker.state.value.pacScript.data, 'external-script');
    assert.equal(worker.state.control, control);
  });
}

test('failed proxy release never deletes the existing configuration', async () => {
  const worker = createWorker();
  worker.state.fault = { operation: 'proxy.clear' };
  const response = await worker.request({ type: 'RESET_CONFIGURATION' });
  assert.equal(response.error, 'proxy_failed');
  assert.deepEqual(worker.data.userRules, ['example.com']);
  assert.equal(worker.state.proxyClears.length, 0);
  assert.equal(worker.state.mode, 'pac_script');
});

test('reset release waits for an older timed-out PAC write to commit before clearing proxy and storage', async () => {
  const worker = createWorker({ mode: 'system' });
  worker.state.fault = { operation: 'proxy.set', pending: true };
  const earlier = worker.selectMode('pac_script');
  await new Promise(resolve => setImmediate(resolve));
  let resetFinished = false;
  const reset = worker.request({ type: 'RESET_CONFIGURATION' }).then(response => { resetFinished = true; return response; });
  worker.state.timers.find(timer => !timer.cancelled && timer.delay === 8000).callback();
  assert.equal((await earlier).error, 'proxy_timeout');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resetFinished, false);
  assert.equal(worker.state.proxyClears.length, 0);
  assert.deepEqual(worker.data.userRules, ['example.com']);
  assert.equal((await worker.selectMode('direct')).error, 'config_resetting');
  worker.state.fault = null;
  worker.state.held.shift()(); // The old PAC write really commits before release may start.
  assert.equal((await reset).success, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.state.writes.length, 1);
  assert.equal(worker.state.proxyClears.length, 1);
  assert.equal(worker.state.mode, 'system');
  assert.equal(worker.state.value.pacScript, undefined);
  assert.equal(worker.data.userRules, undefined);
});

test('timed-out proxy release keeps configuration and retains its lease until the clear actually commits', async () => {
  const worker = createWorker();
  worker.state.fault = { operation: 'proxy.clear', pending: true };
  const reset = worker.request({ type: 'RESET_CONFIGURATION' });
  await new Promise(resolve => setImmediate(resolve));
  worker.state.timers.find(timer => !timer.cancelled && timer.delay === 8000).callback();
  assert.equal((await reset).error, 'proxy_timeout');
  assert.equal(worker.locked(), true);
  assert.deepEqual(worker.data.userRules, ['example.com']);
  worker.state.fault = null;
  worker.state.held.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.locked(), false);
  assert.equal(worker.state.proxyClears.length, 1);
  assert.deepEqual(worker.data.userRules, ['example.com'], 'a release timeout must not silently continue to erase configuration');
});
