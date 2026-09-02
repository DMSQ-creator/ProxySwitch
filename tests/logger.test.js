'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const LOGGER_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'logger.js'), 'utf8');
const PAGE_BOOT_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'page-boot.js'), 'utf8');
const BACKGROUND_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'background.js'), 'utf8');

let uuidCounter = 0;

class MemoryLocalStorage {
  constructor() {
    this.values = new Map();
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  getItem(key) {
    return this.values.has(String(key)) ? this.values.get(String(key)) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }
}

class FailingWriteLocalStorage extends MemoryLocalStorage {
  setItem() {
    throw new Error('page storage unavailable');
  }
}

function fakeUuid() {
  uuidCounter += 1;
  return `${uuidCounter.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function pickStorage(data, keys) {
  if (keys == null) return { ...data };
  if (typeof keys === 'string') return { [keys]: data[keys] };
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.map((key) => [key, data[key]]));
  }
  const result = { ...keys };
  for (const key of Object.keys(keys)) {
    if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = data[key];
  }
  return result;
}

function createFakeChrome(initial = {}, options = {}) {
  const data = { ...initial };
  const listeners = [];
  const stats = { getCalls: 0, setCalls: [], removeCalls: [] };

  function dispatch(changes) {
    queueMicrotask(() => {
      for (const listener of listeners) listener(changes, 'local');
    });
  }

  const local = {
    get(keys, callback) {
      stats.getCalls += 1;
      if (options.hangGetNull && keys == null) return new Promise(() => {});
      const result = pickStorage(data, keys);
      if (typeof callback === 'function') {
        queueMicrotask(() => callback(result));
        return undefined;
      }
      return Promise.resolve(result);
    },
    set(items, callback) {
      stats.setCalls.push(Object.keys(items));
      if (options.rejectSet) {
        const failure = Promise.reject(new Error('storage unavailable'));
        if (typeof callback === 'function') failure.catch(() => callback());
        return failure;
      }
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data[key], newValue: value };
        data[key] = value;
      }
      dispatch(changes);
      if (typeof callback === 'function') queueMicrotask(callback);
      return Promise.resolve();
    },
    remove(keys, callback) {
      const list = Array.isArray(keys) ? keys : [keys];
      stats.removeCalls.push([...list]);
      const changes = {};
      for (const key of list) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        changes[key] = { oldValue: data[key], newValue: undefined };
        delete data[key];
      }
      if (Object.keys(changes).length) dispatch(changes);
      if (typeof callback === 'function') queueMicrotask(callback);
      return Promise.resolve();
    },
  };

  const chrome = {
    storage: {
      local,
      onChanged: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
    },
    runtime: {
      lastError: null,
      getManifest() {
        return {
          version: '7.9.0-test',
          manifest_version: 3,
          action: { default_popup: 'html/popup.html' },
        };
      },
    },
    proxy: {
      settings: {
        get(_details, callback) {
          if (options.hangProxy) return;
          callback({ value: { mode: 'pac_script' }, levelOfControl: 'controlled_by_this_extension' });
        },
      },
    },
    action: {
      getPopup(_details, callback) {
        if (options.hangAction || options.hangGetPopup) return;
        callback('chrome-extension://abcdefghijklmnopabcdefghijklmnop/html/popup.html');
      },
      isEnabled() {
        if (options.hangAction || options.hangIsEnabled) return new Promise(() => {});
        return Promise.resolve(options.actionEnabled !== false);
      },
    },
  };

  return { chrome, data, stats };
}

function createLoggerContext({ chrome, localStorage, pathname, page = true, withEarlyProbe = false }) {
  const effectivePathname = pathname || (page ? '/popup.html' : '/js/background.js');
  const sandbox = {
    chrome,
    console: { log() {}, warn() {}, error() {} },
    crypto: { randomUUID: fakeUuid },
    Date,
    Error,
    JSON,
    Math,
    Map,
    Set,
    Promise,
    URL,
    navigator: {
      userAgent: 'UnitTest Browser/1.0',
      platform: 'UnitTest OS',
      language: 'en-US',
    },
    location: { pathname: effectivePathname },
    localStorage,
    setTimeout,
    clearTimeout,
  };
  if (page) sandbox.document = { readyState: 'loading' };
  const context = vm.createContext(sandbox);
  if (withEarlyProbe) vm.runInContext(PAGE_BOOT_SOURCE, context, { filename: 'page-boot.js' });
  vm.runInContext(LOGGER_SOURCE, context, { filename: 'logger.js' });
  return { context, PSL: vm.runInContext('PSL', context) };
}

test('earliest page marker and logger checkpoints share one ordered context without waking the worker', async () => {
  const backend = createFakeChrome();
  const pageStorage = new MemoryLocalStorage();
  const { PSL } = createLoggerContext({
    chrome: backend.chrome,
    localStorage: pageStorage,
    withEarlyProbe: true,
  });

  await PSL.checkpoint('popup', 'popup.script_entered');
  const logs = await PSL.getLogs();

  assert.equal(backend.stats.setCalls.length, 0, 'page diagnostics must not use chrome.storage.set');
  assert.deepEqual(Array.from(logs, (entry) => entry.message), [
    'popup.page_boot_entered',
    'popup.script_entered',
  ]);
  assert.equal(new Set(logs.map((entry) => entry.contextId)).size, 1);
  assert.deepEqual(Array.from(logs, (entry) => entry.sequence), [1, 2]);
  assert.equal(logs[0].detail, '{"readyState":"loading"}');
});

test('page recorder failure does not fall back to storage that can wake the worker', async () => {
  const backend = createFakeChrome();
  const { PSL } = createLoggerContext({
    chrome: backend.chrome,
    localStorage: new FailingWriteLocalStorage(),
  });

  assert.equal(await PSL.checkpoint('popup', 'popup.script_entered'), false);
  assert.equal(backend.stats.setCalls.length, 0);
});

test('page context without localStorage never writes through the worker backend', async () => {
  const backend = createFakeChrome();
  const { PSL } = createLoggerContext({ chrome: backend.chrome, localStorage: undefined });

  assert.equal(await PSL.checkpoint('popup', 'popup.script_entered'), false);
  assert.equal(backend.stats.setCalls.length, 0);
});

test('two popup contexts append concurrently with unique keys and no read-modify-write loss', async () => {
  const backend = createFakeChrome();
  const pageStorage = new MemoryLocalStorage();
  const first = createLoggerContext({ chrome: backend.chrome, localStorage: pageStorage, withEarlyProbe: true });
  const second = createLoggerContext({ chrome: backend.chrome, localStorage: pageStorage, withEarlyProbe: true });

  await Promise.all([
    ...Array.from({ length: 50 }, (_, index) => first.PSL.checkpoint('popup', `first.${index}`)),
    ...Array.from({ length: 50 }, (_, index) => second.PSL.checkpoint('popup', `second.${index}`)),
  ]);

  const logs = await first.PSL.getLogs();
  assert.equal(logs.length, 102);
  assert.equal(new Set(logs.map((entry) => entry.id)).size, 102);
  assert.equal(new Set(logs.map((entry) => entry.contextId)).size, 2);
  assert.equal(backend.stats.setCalls.length, 0);
});

test('diagnosis preserves an older popup failure without mutating worker storage', async () => {
  const baseTime = Date.now() - 10_000;
  const initial = {};
  for (let index = 0; index < 501; index += 1) {
    const createdAtMs = baseTime + 1_000 + index;
    const id = `background-noise-${index}`;
    initial[`__psl_log_v2__:${String(createdAtMs).padStart(13, '0')}:${id}`] = {
      schemaVersion: 2,
      id,
      createdAtMs,
      createdAt: new Date(createdAtMs).toISOString(),
      level: 'info',
      source: 'background',
      message: 'background.noise',
      context: 'background',
      contextId: 'background:test',
      sequence: index + 1,
    };
  }

  const pageStorage = new MemoryLocalStorage();
  const popupEntry = {
    schemaVersion: 2,
    id: 'retained-popup-boot',
    createdAtMs: baseTime,
    createdAt: new Date(baseTime).toISOString(),
    level: 'checkpoint',
    source: 'popup',
    message: 'popup.page_boot_entered',
    context: 'popup',
    contextId: 'popup:retained-failure',
    sequence: 1,
  };
  pageStorage.setItem(`__psl_log_v2__:${String(baseTime).padStart(13, '0')}:${popupEntry.id}`, JSON.stringify(popupEntry));

  const backend = createFakeChrome(initial);
  const { PSL } = createLoggerContext({ chrome: backend.chrome, localStorage: pageStorage, pathname: '/options.html' });
  const report = await PSL.getDiagnosticReport();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(report, /PAGE BOOT SCRIPT RAN, MAIN SCRIPT NOT REACHED/);
  assert.match(report, /popup\.page_boot_entered/);
  assert.equal(backend.stats.setCalls.length, 0);
  assert.equal(backend.stats.removeCalls.length, 0, 'reading a report must not prune worker storage');
});

test('diagnostic report redacts credentials, browsing URLs, and extension IDs', async () => {
  const backend = createFakeChrome();
  const { PSL } = createLoggerContext({ chrome: backend.chrome, page: false });

  await PSL.error(
    'test',
    'failed at https://outlook.live.com/mail/notes?token=VISIBLE#fragment',
    {
      token: 'TOP_SECRET_TOKEN',
      password: 'TOP_SECRET_PASSWORD',
      endpoint: 'https://proxy.example.test/path?q=private',
      stack: 'Error at chrome-extension://abcdefghijklmnopabcdefghijklmnop/js/popup.js:10:2',
      headerText: 'Authorization: Basic dXNlcjpwYXNz',
      cookieText: 'Cookie: session=VERY_PRIVATE_COOKIE; theme=dark',
      address: '127.0.0.1:10808',
    },
  );
  await backend.chrome.storage.local.set({
    '__psl_log_v2__:0000000000001:unsafe-old-entry': {
      schemaVersion: 2,
      id: 'unsafe-old-entry',
      createdAtMs: Date.now(),
      createdAt: new Date().toISOString(),
      level: 'error',
      source: 'old',
      message: 'legacy v2 https://private-old.example/path?secret=yes',
      detail: 'Authorization: Basic b2xkOnNlY3JldA==',
      context: 'background',
      contextId: 'background:old',
      sequence: 1,
      unexpectedSecretField: 'MUST_NEVER_BE_EXPORTED',
    },
  });
  const report = await PSL.getDiagnosticReport();

  assert.doesNotMatch(report, /outlook\.live\.com|proxy\.example\.test|VISIBLE|fragment/);
  assert.doesNotMatch(report, /TOP_SECRET_TOKEN|TOP_SECRET_PASSWORD/);
  assert.doesNotMatch(report, /dXNlcjpwYXNz|VERY_PRIVATE_COOKIE|127\.0\.0\.1|10808/);
  assert.doesNotMatch(report, /private-old\.example|b2xkOnNlY3JldA|MUST_NEVER_BE_EXPORTED/);
  assert.doesNotMatch(report, /abcdefghijklmnopabcdefghijklmnop/);
  assert.match(report, /\[url\]/);
  assert.match(report, /\[extension\]\/js\/popup\.js:10:2/);
  assert.match(report, /Popup: manifest=html\/popup\.html effective=\/html\/popup\.html/);
});

test('generation barrier keeps new contexts and rejects delayed writes from an old generation', async () => {
  const backend = createFakeChrome();
  const pageStorage = new MemoryLocalStorage();
  const options = createLoggerContext({
    chrome: backend.chrome,
    localStorage: pageStorage,
    pathname: '/options.html',
    withEarlyProbe: true,
  });

  await options.PSL.clearLogs();
  const generation = backend.data.__psl_log_generation_v2;
  const cutoff = backend.data.__psl_log_clear_before_v2;
  const first = createLoggerContext({ chrome: backend.chrome, localStorage: pageStorage, withEarlyProbe: true });
  const second = createLoggerContext({ chrome: backend.chrome, localStorage: pageStorage, withEarlyProbe: true });
  await Promise.all([
    first.PSL.checkpoint('popup', 'generation.first'),
    second.PSL.checkpoint('popup', 'generation.second'),
  ]);

  await backend.chrome.storage.local.set({
    '__psl_log_v2__:9999999999999:delayed-old-generation': {
      schemaVersion: 2,
      id: 'delayed-old-generation',
      createdAtMs: cutoff + 100000,
      createdAt: new Date(cutoff + 100000).toISOString(),
      level: 'checkpoint',
      source: 'background',
      message: 'must.stay.hidden',
      context: 'background',
      contextId: 'background:old-generation',
      generation: 'previous-generation',
      sequence: 1,
    },
  });

  const messages = Array.from(await options.PSL.getLogs(), (entry) => entry.message);
  assert.ok(messages.includes('popup.page_boot_entered'), 'a page boot after clear must remain visible');
  assert.ok(messages.includes('generation.first'));
  assert.ok(messages.includes('generation.second'));
  assert.ok(!messages.includes('must.stay.hidden'));
  assert.equal(pageStorage.getItem('__psl_page_log_generation_v2'), generation);
});

test('generation-less early worker event remains visible until recorder settings resolve', async () => {
  const cutoff = Date.now() - 1000;
  const backend = createFakeChrome({
    __psl_log_generation_v2: 'current-generation',
    __psl_log_clear_before_v2: cutoff,
  });
  const { PSL } = createLoggerContext({ chrome: backend.chrome, page: false });

  // Called synchronously before the initial resolved Promise runs its .then handler.
  const write = PSL.error('background', 'early.before_generation_loaded');
  await write;
  const logs = await PSL.getLogs();
  assert.deepEqual(Array.from(logs, (entry) => entry.message), ['early.before_generation_loaded']);
});

test('immediate diagnosis surfaces retained failed sessions and correlates popup acknowledgement to a boot', async () => {
  const now = Date.now();
  const failedBoot = 'aaaaaaaa-0000-4000-8000-000000000000';
  const healthyBoot = 'bbbbbbbb-0000-4000-8000-000000000000';
  const backend = createFakeChrome({
    '__psl_boot_v2__:corrupt': { bootId: 123, createdAtMs: 'not-a-time', phase: { secret: 'bad' } },
    [`__psl_boot_v2__:${failedBoot}:01:script_entered`]: {
      schemaVersion: 2,
      bootId: failedBoot,
      sequence: 1,
      phase: 'script_entered',
      createdAtMs: now - 10000,
      version: 'test',
    },
    [`__psl_boot_v2__:${healthyBoot}:01:script_entered`]: {
      schemaVersion: 2,
      bootId: healthyBoot,
      sequence: 1,
      phase: 'script_entered',
      createdAtMs: now - 5000,
      version: 'test',
    },
    [`__psl_boot_v2__:${healthyBoot}:02:ready`]: {
      schemaVersion: 2,
      bootId: healthyBoot,
      sequence: 2,
      phase: 'ready',
      createdAtMs: now - 4900,
      version: 'test',
    },
  });
  const pageStorage = new MemoryLocalStorage();
  const failedPopup = createLoggerContext({ chrome: backend.chrome, localStorage: pageStorage, withEarlyProbe: true });
  await failedPopup.PSL.checkpoint('popup', 'popup.script_entered');
  const healthyPopup = createLoggerContext({ chrome: backend.chrome, localStorage: pageStorage, withEarlyProbe: true });
  const healthyContextId = healthyPopup.PSL.getContextId();
  await healthyPopup.PSL.checkpoint('popup', 'popup.script_entered');
  await healthyPopup.PSL.checkpoint('popup', 'popup.open_sent');
  await healthyPopup.PSL.checkpoint('popup', 'popup.background_ack', {
    workerBootId: healthyBoot.slice(0, 12),
    workerReady: true,
  });
  await healthyPopup.PSL.checkpoint('popup', 'popup.ui_state_applied');
  const background = createLoggerContext({ chrome: backend.chrome, page: false });
  await background.PSL.checkpoint('background', 'popup.open_received', { popupContextId: healthyContextId });

  const snapshot = await healthyPopup.PSL.getDiagnosticSnapshot();
  assert.match(snapshot.diagnosis.worker, /READY/);
  assert.match(snapshot.diagnosis.workerHistory, /aaaaaaaa-000/);
  assert.match(snapshot.diagnosis.popup, /UI STATE APPLIED/);
  assert.match(snapshot.diagnosis.popupHistory, /RETAINED INCOMPLETE POPUP/);
  assert.match(snapshot.diagnosis.handshake, /ready boot bbbbbbbb-000/);
});

test('logical clear hides late old writes, retains boot history, and never removes configuration', async () => {
  const bootId = 'boot-before-clear';
  const initial = {
    serverList: [{ id: 'server-1', host: 'private.example' }],
    activeServerId: 'server-1',
    [`__psl_boot_v2__:${bootId}:01:script_entered`]: {
      schemaVersion: 2,
      bootId,
      sequence: 1,
      phase: 'script_entered',
      createdAtMs: Date.now() - 5000,
      version: '7.9.0-test',
    },
  };
  const backend = createFakeChrome(initial);
  const pageStorage = new MemoryLocalStorage();
  const background = createLoggerContext({ chrome: backend.chrome, page: false });
  const options = createLoggerContext({
    chrome: backend.chrome,
    localStorage: pageStorage,
    pathname: '/options.html',
    withEarlyProbe: true,
  });

  await background.PSL.checkpoint('background', 'old.worker.event');
  await options.PSL.checkpoint('options', 'old.page.event');
  await options.PSL.clearLogs();

  const cutoff = backend.data.__psl_log_clear_before_v2;
  const lateKey = `__psl_log_v2__:${cutoff}:late-old-write`;
  await backend.chrome.storage.local.set({
    [lateKey]: {
      schemaVersion: 2,
      id: 'late-old-write',
      createdAtMs: cutoff,
      createdAt: new Date(cutoff).toISOString(),
      level: 'checkpoint',
      source: 'background',
      message: 'late.old.event',
      context: 'background',
      contextId: 'background:late',
      sequence: 1,
    },
  });

  assert.equal((await options.PSL.getLogs()).length, 0);
  assert.equal(backend.data.activeServerId, 'server-1');
  assert.deepEqual(backend.data.serverList, initial.serverList);
  assert.equal((await options.PSL.getBootRecords()).length, 1);

  while (Date.now() <= cutoff) await new Promise((resolve) => setTimeout(resolve, 1));
  await background.PSL.checkpoint('background', 'new.worker.event');
  assert.deepEqual(Array.from(await options.PSL.getLogs(), (entry) => entry.message), ['new.worker.event']);
});

test('retention converges to 500 events without touching business keys', async () => {
  const backend = createFakeChrome({
    serverList: [{ id: 'keep-me' }],
    gitToken: 'must-not-be-exported-or-removed',
  });
  const { PSL } = createLoggerContext({ chrome: backend.chrome, page: false });

  await Promise.all(Array.from({ length: 510 }, (_, index) => PSL.checkpoint('load', `event.${index}`)));
  await PSL.flush();
  await PSL.prune();

  const logKeys = Object.keys(backend.data).filter((key) => key.startsWith('__psl_log_v2__:'));
  assert.equal(logKeys.length, 500);
  assert.deepEqual(backend.data.serverList, [{ id: 'keep-me' }]);
  assert.equal(backend.data.gitToken, 'must-not-be-exported-or-removed');

  const report = await PSL.getDiagnosticReport();
  assert.doesNotMatch(report, /must-not-be-exported-or-removed/);
});

test('many short-lived popup realms trigger cross-session page retention', async () => {
  const backend = createFakeChrome();
  const pageStorage = new MemoryLocalStorage();

  for (let index = 0; index < 200; index++) {
    const popup = createLoggerContext({ chrome: backend.chrome, localStorage: pageStorage, withEarlyProbe: true });
    await popup.PSL.checkpoint('popup', `short.${index}.a`);
    await popup.PSL.checkpoint('popup', `short.${index}.b`);
  }

  const logKeys = Array.from(pageStorage.values.keys()).filter((key) => key.startsWith('__psl_log_v2__:'));
  assert.ok(logKeys.length <= 552, `page retention should stay bounded, got ${logKeys.length}`);
  assert.ok(logKeys.length >= 500, 'retention should preserve a useful recent window');
});

test('diagnostic report returns page-local evidence when chrome storage never responds', async () => {
  const backend = createFakeChrome({}, { hangGetNull: true });
  const pageStorage = new MemoryLocalStorage();
  const { PSL } = createLoggerContext({ chrome: backend.chrome, localStorage: pageStorage, withEarlyProbe: true });
  await PSL.checkpoint('popup', 'popup.script_entered');
  await PSL.checkpoint('popup', 'popup.ui_state_applied');

  const startedAt = Date.now();
  const report = await PSL.getDiagnosticReport();
  const durationMs = Date.now() - startedAt;
  assert.ok(durationMs >= 1400 && durationMs < 3000, `unexpected partial-report timeout ${durationMs}ms`);
  assert.match(report, /worker-side storage could not be read|Worker boot history unavailable/);
  assert.match(report, /popup\.page_boot_entered/);
  assert.match(report, /popup\.ui_state_applied/);
  assert.match(report, /Config: unavailable/);
});

test('proxy and action snapshot timeouts do not block the diagnostic report forever', async () => {
  const backend = createFakeChrome({}, { hangProxy: true, hangAction: true });
  const { PSL } = createLoggerContext({ chrome: backend.chrome, page: false });

  const startedAt = Date.now();
  const report = await PSL.getDiagnosticReport();
  const durationMs = Date.now() - startedAt;
  assert.ok(durationMs >= 1100 && durationMs < 2500, `unexpected API timeout ${durationMs}ms`);
  assert.match(report, /Proxy: mode=unavailable/);
  assert.match(report, /Popup: manifest=html\/popup\.html effective=unavailable enabled=unavailable/);
  assert.match(report, /chrome\.action\.getPopup timeout/);
  assert.match(report, /chrome\.action\.isEnabled timeout/);
});

test('action snapshot preserves successful isEnabled when getPopup times out', async () => {
  const backend = createFakeChrome({}, { hangGetPopup: true, actionEnabled: true });
  const { PSL } = createLoggerContext({ chrome: backend.chrome, page: false });

  const report = await PSL.getDiagnosticReport();

  assert.match(report, /Popup: manifest=html\/popup\.html effective=unavailable enabled=true/);
  assert.match(report, /chrome\.action\.getPopup timeout/);
  assert.doesNotMatch(report, /chrome\.action\.isEnabled timeout/);
});

test('action snapshot preserves successful getPopup when isEnabled times out', async () => {
  const backend = createFakeChrome({}, { hangIsEnabled: true });
  const { PSL } = createLoggerContext({ chrome: backend.chrome, page: false });

  const report = await PSL.getDiagnosticReport();

  assert.match(report, /Popup: manifest=html\/popup\.html effective=\/html\/popup\.html enabled=unavailable/);
  assert.match(report, /chrome\.action\.isEnabled timeout/);
  assert.doesNotMatch(report, /chrome\.action\.getPopup timeout/);
});

test('storage failure is attempted once and does not recursively log itself', async () => {
  const backend = createFakeChrome({}, { rejectSet: true });
  const { PSL } = createLoggerContext({ chrome: backend.chrome, page: false });

  assert.equal(await PSL.error('background', 'write should fail'), false);
  await PSL.flush();
  assert.equal(backend.stats.setCalls.length, 1);
});

test('worker boot phases are submitted immediately even when storage promises never settle', () => {
  const writes = [];
  const sandbox = vm.createContext({
    chrome: {
      runtime: { getManifest: () => ({ version: 'test' }) },
      storage: {
        local: {
          set(items) {
            writes.push(items);
            return new Promise(() => {});
          },
        },
      },
    },
    console: { log() {}, warn() {}, error() {} },
    crypto: { randomUUID: fakeUuid },
    Date,
    Error,
    JSON,
    Math,
    Promise,
    importScripts() {
      throw new Error('simulated missing import');
    },
  });

  assert.throws(
    () => vm.runInContext(BACKGROUND_SOURCE, sandbox, { filename: 'background.js' }),
    /core modules failed to load/,
  );
  const phases = writes.map((item) => Object.values(item)[0].phase);
  assert.deepEqual(phases, ['script_entered', 'imports_completed']);
});

test('worker boot journal write failures never replace the real startup failure', () => {
  let writeAttempts = 0;
  const sandbox = vm.createContext({
    chrome: {
      runtime: { getManifest: () => ({ version: 'test' }) },
      storage: {
        local: {
          set() {
            writeAttempts += 1;
            throw new Error('simulated synchronous storage failure');
          },
        },
      },
    },
    console: { log() {}, warn() {}, error() {} },
    crypto: { randomUUID: fakeUuid },
    Date,
    Error,
    JSON,
    Math,
    Promise,
    importScripts() {
      throw new Error('simulated missing import');
    },
  });

  assert.throws(
    () => vm.runInContext(BACKGROUND_SOURCE, sandbox, { filename: 'background.js' }),
    /core modules failed to load/,
  );
  assert.equal(writeAttempts, 2, 'both startup phases should still be attempted');
});
