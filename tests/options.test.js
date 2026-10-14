'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SOURCE = fs.readFileSync(path.join(__dirname, '../js/options.js'), 'utf8');
const configuration = require('../js/configuration.js');
const copy = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.attributes = {}; this.style = {}; this.dataset = {};
    this.disabled = false; this.hidden = false; this.value = ''; this.textContent = ''; this.listeners = {}; this.className = '';
    const classes = new Set();
    this.classList = { add: (...list) => list.forEach(value => classes.add(value)), remove: (...list) => list.forEach(value => classes.delete(value)),
      toggle: (value, force) => { if (force === undefined ? !classes.has(value) : force) classes.add(value); else classes.delete(value); }, contains: value => classes.has(value) };
  }
  set innerHTML(value) { this.html = value; if (!value) this.children = []; }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(key, listener) { this.listeners[key] = listener; }
  focus() { this.focused = true; }
  click() { const event = { target: this, preventDefault() {}, stopPropagation() {} }; if (this.listeners.click) this.listeners.click(event); return this.onclick && this.onclick(event); }
  querySelector(selector) {
    const matches = element => selector.startsWith('.') ? element.className.split(' ').includes(selector.slice(1)) : element.tagName.toLowerCase() === selector;
    return this.children.find(matches) || this.children.map(child => child.querySelector(selector)).find(Boolean) || null;
  }
}

function harness(options = {}) {
  const elements = new Map();
  const selectIds = new Set(['syncProvider', 'themeSelect', 'langSelect', 'editScheme', 'ruleTypeSelect']);
  const inputIds = new Set(['gitToken', 'davUrl', 'davUser', 'davPass', 'autoSync', 'editName', 'editHost', 'editPort', 'gfwUrlInput', 'ruleAddInput', 'ruleSearch']);
  const element = id => { if (!elements.has(id)) elements.set(id, new Element(id.endsWith('Btn') || ['configurationPreviewConfirm','configurationPreviewCancel'].includes(id) ? 'button' : selectIds.has(id) ? 'select' : inputIds.has(id) ? 'input' : 'div', id)); return elements.get(id); };
  const data = copy({ serverList: [], userRules: [], userWhitelist: [], ...options.data });
  const writes = [], writeCallbacks = [], calls = [], confirms = [], alerts = [];
  const stats = { reloads: 0, pageReloads: 0, pageClears: 0, reads: 0 };
  const logs = { checkpoint: [], info: [], warn: [], error: [], perf: [] };
  const clock = { now: options.now ?? Date.now() };
  class HarnessDate extends Date { static now() { return clock.now; } }
  const messageCallbacks = [];
  const timers = new Map(); let sequence = 0; let latestReader;
  const navigation = ['server', 'rules', 'gfw', 'sync', 'about'].map(target => { const item = new Element('li'); item.dataset.target = target; return item; });
  const mirrors = (options.mirrors || []).map(url => { const item = new Element('button'); item.dataset.url = url; return item; });
  const cloudIds = ['saveSyncSettingsBtn', 'cloudUploadBtn', 'cloudDownloadBtn', 'cloudUndoBtn', 'syncProvider', 'autoSync', 'gitToken', 'davUrl', 'davUser', 'davPass'];
  cloudIds.forEach(element); element('cloudUndoBtn').disabled = !data.cloudRestoreUndo;
  const chrome = {
    runtime: { lastError: null, reload() { stats.reloads++; }, sendMessage(message, callback) {
      calls.push(copy(message));
      if (options.throwMessage) throw new Error('Extension context invalidated');
      if (message.type === 'SAVE_CONFIGURATION') {
        writes.push(copy(message.items));
        writeCallbacks.push((result = { success: true }) => callback(result));
        if (options.hangWrite) return;
        queueMicrotask(() => {
          if (options.failWrite) { callback({ success: false, error: 'storage_failed' }); return; }
          if (options.beforeSave) options.beforeSave(message, data);
          const stale = Object.entries(message.expected).some(([key, expected]) =>
            Object.prototype.hasOwnProperty.call(data, key) !== expected.exists ||
            (expected.exists && JSON.stringify(data[key]) !== JSON.stringify(expected.value)));
          if (stale) { callback({ success: false, error: 'config_changed' }); return; }
          const clean = options.canonicalize ? options.canonicalize(copy(message.items)) : copy(message.items);
          Object.assign(data, clean);
          callback({ success: true, items: clean });
        });
        return;
      }
      messageCallbacks.push(callback);
      if (options.hangMessage) return;
      const reply = options.reply ? options.reply(message, data) : { success: true, time: 'now' };
      queueMicrotask(() => {
        if (options.runtimeError) chrome.runtime.lastError = { message: options.runtimeError };
        try { callback(reply); } finally { chrome.runtime.lastError = null; }
      });
    } },
    i18n: { getMessage: key => key },
    storage: { onChanged: { addListener() {} }, local: {
      set(items, callback) {
        writes.push(copy(items));
        writeCallbacks.push(callback);
        if (options.hangWrite) return;
        queueMicrotask(() => {
          if (options.failWrite) chrome.runtime.lastError = { message: 'Storage failure' };
          else Object.assign(data, copy(items));
          callback(); chrome.runtime.lastError = null;
        });
      },
      get(_keys, callback) { stats.reads++; queueMicrotask(() => callback(copy(data))); },
    } },
  };
  const document = {
    readyState: 'loading', body: new Element('body'), addEventListener() {}, getElementById: element, createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'),
    querySelector: selector => selector === '#configurationPreview' && !options.dialog ? null : element(selector.slice(1)),
    querySelectorAll: selector => selector === '.menu-item' ? navigation : selector === '.gfw-mirror-btn' ? mirrors : selector === '.section' ? navigation.map(item => element('section-' + item.dataset.target)) :
      selector.startsWith('#section-sync') ? cloudIds.map(element).filter(control => selector.includes('input') || selector.includes('select') || control.tagName === 'BUTTON') :
      selector === 'button' ? Array.from(elements.values()).filter(control => control.tagName === 'BUTTON') : Array.from(elements.values()),
  };
  class FileReader {
    constructor() { latestReader = this; }
    readAsText(file) { this.promise = Promise.resolve().then(() => this.onload({ target: { result: file.content } })); }
  }
  const context = vm.createContext({ document, window: { addEventListener() {}, location: { hash: '', reload() { stats.pageReloads++; } } }, chrome, ProxySwitchConfiguration: configuration,
    PSL: { ...Object.fromEntries(Object.keys(logs).map(level => [level, (...args) => logs[level].push(copy(args))])),
      clearPageDiagnostics() { stats.pageClears++; } }, console, URL, AbortController, Date: HarnessDate, Set, FileReader, atob, fetch: options.fetch, generateUUID: () => 'new-server-id',
    confirm: text => { confirms.push(text); if (options.onConfirm) options.onConfirm(data); return options.confirm !== false; }, alert: text => alerts.push(text),
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(SOURCE, context);
  vm.runInContext('allData = ' + JSON.stringify(data) + '; configurationBaseline = ' + JSON.stringify(data), context);
  return { context, data, writes, writeCallbacks, messageCallbacks, calls, confirms, alerts, stats, logs, clock, element, navigation, mirrors, timers, latestReader: () => latestReader,
    run: source => vm.runInContext(source, context), flush: async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); },
  };
}

test('configuration write failure never invokes the success callback', async () => {
  const page = harness({ failWrite: true });
  page.run('globalThis.completed = 0; writeConfiguration({autoSync:true}, () => completed++);');
  await page.flush();
  assert.equal(page.context.completed, 0);
  assert.equal(page.element('toast').textContent, 'msgStorageWriteFailed');
  assert.equal(page.data.autoSync, undefined);
});

test('configuration write timeout locks future edits; late success cannot claim completion', async () => {
  const page = harness({ hangWrite: true });
  page.run('globalThis.completed = 0; writeConfiguration({userRules:[]}, () => completed++);');
  const timer = [...page.timers.values()].find(value => value.delay === 8000);
  timer.callback(); await page.flush();
  assert.equal(page.run('diagnosticReadOnlyMode'), true);
  assert.equal(page.run('writeConfiguration({autoSync:true})'), false);
  page.writeCallbacks[0](); await page.flush();
  assert.equal(page.context.completed, 0); assert.equal(page.writes.length, 1);
});

test('successful configuration writes acknowledge once and suppress duplicate writes', async () => {
  const page = harness();
  page.run('globalThis.completed = 0; writeConfiguration({autoSync:true}, () => completed++);');
  assert.equal(page.run('writeConfiguration({autoSync:false})'), false);
  await page.flush();
  assert.equal(page.context.completed, 1); assert.equal(page.run('allData.autoSync'), true); assert.equal(page.writes.length, 1);
});

test('configuration writes use independent expected baselines despite in-place working-array edits', async () => {
  const page = harness({ data: { userRules: ['old.example'] } });
  page.run("allData.userRules.push('new.example'); writeConfiguration({userRules:allData.userRules});");
  await page.flush();
  const message = page.calls[0];
  assert.equal(message.type, 'SAVE_CONFIGURATION');
  assert.deepEqual(message.expected.userRules, { exists: true, value: ['old.example'] });
  assert.deepEqual(page.data.userRules, ['old.example', 'new.example']);
  assert.deepEqual(copy(page.run('configurationBaseline.userRules')), ['old.example', 'new.example']);
});

test('acknowledged canonical values replace submitted-field baselines instead of raw drafts', async () => {
  const page = harness({ canonicalize: items => ({ ...items, userRules: configuration.validateRules(items.userRules) }) });
  page.run("writeConfiguration({userRules:['EXAMPLE.com','example.com']});"); await page.flush();
  assert.deepEqual(copy(page.run('allData.userRules')), ['example.com']);
  assert.deepEqual(copy(page.run('configurationBaseline.userRules')), ['example.com']);
  page.run("writeConfiguration({userRules:['next.example']});"); await page.flush();
  assert.deepEqual(page.data.userRules, ['next.example']);
});

test('stale configuration writes are rejected without overwriting newer edits or invoking success', async () => {
  const page = harness({ data: { userRules: ['old.example'] } });
  page.data.userRules.push('another-page.example');
  page.run("globalThis.completed=0; writeConfiguration({userRules:['mine.example']},()=>completed++);");
  await page.flush();
  assert.equal(page.context.completed, 0);
  assert.deepEqual(page.data.userRules, ['old.example', 'another-page.example']);
  assert.equal(page.element('toast').textContent, 'msgConfigurationChanged');
  assert.deepEqual(copy(page.run('configurationBaseline.userRules')), ['old.example']);
  assert.equal(page.element('serverOperationStatus').hidden, false);
  assert.ok(page.element('serverOperationStatus').children.some(child => child.className.includes('configuration-reload')));
});

test('successful saves update only submitted baselines so unrelated newer edits remain protected', async () => {
  const page = harness({ data: { userRules: ['old.example'], activeServerId: 'before' } });
  page.data.userRules.push('foreign.example');
  page.run("writeConfiguration({activeServerId:'after'});"); await page.flush();
  assert.equal(page.run('configurationBaseline.activeServerId'), 'after');
  assert.deepEqual(copy(page.run('configurationBaseline.userRules')), ['old.example']);
  page.run("writeConfiguration({userRules:['stale.example']});"); await page.flush();
  assert.deepEqual(page.data.userRules, ['old.example', 'foreign.example']);
});

test('formal rule writes compare the opposite list, but preferences have no unrelated dependencies', async () => {
  const page = harness();
  page.run("writeConfiguration({userRules:['mine.example']});"); await page.flush();
  assert.deepEqual(Object.keys(page.calls[0].expected).sort(), ['userRules', 'userWhitelist']);
  assert.deepEqual(page.calls[0].expected.userWhitelist, { exists: true, value: [] });
  page.run("writeConfiguration({theme:'dark'});"); await page.flush();
  assert.deepEqual(Object.keys(page.calls[1].expected), ['theme']);
});

test('a newly conflicting list change after import preview is rejected by the atomic save', async () => {
  const page = harness({ beforeSave(_message, data) { data.userWhitelist.push('new.example'); } });
  page.run('initRuleModule()');
  page.element('ruleFile').onchange({ target: { files: [{ content: '["new.example"]' }], value: 'file' } });
  await page.latestReader().promise; await page.flush();
  assert.deepEqual(page.calls[0].expected.userWhitelist, { exists: true, value: [] });
  assert.deepEqual(page.data.userRules, []);
  assert.deepEqual(page.data.userWhitelist, ['new.example']);
  assert.equal(page.element('toast').textContent, 'msgConfigurationChanged');
});

test('server activation rejects a list changed after the user selects its displayed server', async () => {
  const servers = [{ id: 'a', name: 'First', scheme: 'HTTP', host: 'old-a.example', port: 80 },
    { id: 'b', name: 'Second', scheme: 'HTTP', host: 'old-b.example', port: 80 }];
  const page = harness({ data: { serverList: servers, activeServerId: 'a' }, beforeSave(_message, data) { data.serverList[1].host = 'changed-b.example'; } });
  page.run("activateServer('b');"); await page.flush();
  assert.deepEqual(page.calls[0].expected.serverList, { exists: true, value: servers });
  assert.equal(page.data.activeServerId, 'a'); assert.equal(page.data.serverList[1].host, 'changed-b.example');
  assert.equal(page.element('toast').textContent, 'msgConfigurationChanged');
});

test('reset routes through the backend and clears page logs/reloads only after success', async () => {
  const page = harness(); page.run('initGeneralModule()');
  await page.element('resetAppBtn').click();
  assert.deepEqual(page.calls.map(call => call.type), ['RESET_CONFIGURATION']);
  assert.equal(page.stats.pageClears, 1); assert.equal(page.stats.reloads, 1);
});

test('failed reset or unavailable worker never clears page evidence or reloads', async () => {
  for (const error of ['storage_failed', 'runtime_unavailable', 'config_resetting']) {
    const page = harness({ reply: () => ({ success: false, error }) }); page.run('initGeneralModule()');
    await page.element('resetAppBtn').click();
    assert.equal(page.stats.pageClears, 0); assert.equal(page.stats.reloads, 0);
  }
  const page = harness({ hangMessage: true }); page.run('initGeneralModule()');
  const pending = page.element('resetAppBtn').click();
  [...page.timers.values()].find(timer => timer.delay === 8000).callback(); await pending;
  assert.equal(page.stats.pageClears, 0); assert.equal(page.stats.reloads, 0);
  assert.equal(page.run('diagnosticReadOnlyMode'), true);
});

test('overlapping operation locks keep controls disabled until every owner releases', () => {
  const page = harness();
  page.run("globalThis.firstLock=lockControls([$('#cloudUploadBtn')]); globalThis.secondLock=lockControls([$('#cloudUploadBtn')]); unlockControls(firstLock);");
  assert.equal(page.element('cloudUploadBtn').disabled, true);
  page.run('unlockControls(secondLock)'); assert.equal(page.element('cloudUploadBtn').disabled, false);
});

test('a finishing network operation does not bypass a storage lock or leave its button disabled', () => {
  const page = harness(); page.element('testLatencyBtn').disabled = true;
  page.run("globalThis.lock=lockControls([$('#testLatencyBtn')]); releaseControlBusy($('#testLatencyBtn'));");
  assert.equal(page.element('testLatencyBtn').disabled, true);
  page.run('unlockControls(lock)'); assert.equal(page.element('testLatencyBtn').disabled, false);
});

test('server rendering treats imported names and addresses as text and uses keyboard-native buttons', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const page = harness({ data: { serverList: [{ id: 'x', name: malicious, host: malicious, port: 80, scheme: 'HTTP' }], activeServerId: 'x' } });
  page.run('renderServerList()');
  const row = page.element('serverListContainer').children[0];
  assert.equal(row.innerHTML, '');
  const select = row.children[0];
  assert.equal(select.tagName, 'BUTTON'); assert.ok(select.children[0].textContent.includes(malicious));
  assert.ok(select.children[1].textContent.includes(malicious));
  assert.equal(select.getAttribute('aria-pressed'), 'true');
  assert.equal(row.children[1].children[0].getAttribute('aria-label'), 'btnEditServer');
});

test('rendering an intentionally empty server list has no storage side effect', () => {
  const page = harness(); page.run('renderServerList()');
  assert.equal(page.writes.length, 0); assert.equal(page.element('serverListContainer').children[0].textContent, 'msgNoServers');
});

test('cloud restore requires preview and confirmation before download', async () => {
  const page = harness({ reply: message => message.type === 'MANUAL_SYNC_PREVIEW' ?
    { success: true, previewId: 'preview-1', summary: { fields: [{ key: 'userRules', count: 0, previousCount: 5, clears: true }] } } : { success: true } });
  page.run('initSyncModule()');
  await page.element('cloudDownloadBtn').click();
  assert.deepEqual(page.calls.map(call => call.type), ['MANUAL_SYNC_PREVIEW', 'MANUAL_SYNC_DOWNLOAD']);
  assert.equal(page.calls[1].previewId, 'preview-1');
  assert.ok(page.confirms[0].includes('5 → 0')); assert.ok(page.confirms[0].includes('txtRestoreClears'));
});

test('canceling restore preview does not mutate configuration', async () => {
  const page = harness({ confirm: false, reply: () => ({ success: true, previewId: 'p', summary: { fields: [] } }) });
  page.run('initSyncModule()'); await page.element('cloudDownloadBtn').click();
  assert.deepEqual(page.calls.map(call => call.type), ['MANUAL_SYNC_PREVIEW']); assert.equal(page.writes.length, 0);
});

test('cloud busy guard suppresses repeated uploads and restores controls afterwards', async () => {
  const page = harness(); page.run('initSyncModule()');
  const first = page.element('cloudUploadBtn').click();
  await page.element('cloudUploadBtn').click(); await first;
  assert.equal(page.calls.length, 1); assert.equal(page.element('cloudUploadBtn').disabled, false);
});

const CLOUD_ACTIONS = ['MANUAL_SYNC_UPLOAD', 'MANUAL_SYNC_PREVIEW', 'MANUAL_SYNC_DOWNLOAD', 'MANUAL_SYNC_UNDO'];

for (const action of CLOUD_ACTIONS) {
  test(`${action} records successful 1457ms and long network waits as ordinary outcome logs`, async () => {
    for (const duration of [1457, 59000]) {
      const page = harness({ now: 0, reply: () => ({ success: true }) });
      const result = page.run(`cloudRequest({type:'${action}'})`);
      page.clock.now = duration;
      assert.equal((await result).success, true);
      assert.deepEqual(page.logs.info, [['options', `${action} ${duration}ms`, 'result=success']]);
      assert.deepEqual(page.logs.perf, []);
      assert.deepEqual(page.logs.warn, []);
      assert.deepEqual(page.logs.error, []);
    }
  });
}

test('cloud restore and undo log acknowledged but pending proxy application without a false failure', async () => {
  for (const action of ['MANUAL_SYNC_DOWNLOAD', 'MANUAL_SYNC_UNDO']) {
    const page = harness({ now: 0, reply: () => ({ success: true, applyPending: true }) });
    const pending = page.run(`cloudRequest({type:'${action}'})`);
    page.clock.now = 1457;
    assert.equal((await pending).applyPending, true);
    assert.deepEqual(page.logs.info, [['options', `${action} 1457ms`, 'result=success proxyApply=pending']]);
    assert.deepEqual(page.logs.perf, []);
    assert.deepEqual(page.logs.warn, []);
    assert.deepEqual(page.logs.error, []);
  }
});

test('failed cloud replies still raise an error with their safe outcome code, not performance noise', async () => {
  for (const action of CLOUD_ACTIONS) {
    const page = harness({ now: 0, reply: () => ({ success: false, error: 'network_timeout' }) });
    const pending = page.run(`cloudRequest({type:'${action}'})`);
    page.clock.now = 20000;
    assert.equal(await pending, null);
    assert.deepEqual(page.logs.error, [['options', `${action} failed 20000ms`, 'network_timeout']]);
    assert.deepEqual(page.logs.info, []);
    assert.deepEqual(page.logs.perf, []);
    assert.deepEqual(page.logs.warn, []);
    assert.equal(page.element('toast').textContent, 'msgCloudTimeout');
  }
});

test('cloud request timeout still warns, records failure, and ignores a late successful reply', async () => {
  for (const action of CLOUD_ACTIONS) {
    const page = harness({ now: 0, hangMessage: true });
    const pending = page.run(`cloudRequest({type:'${action}'})`);
    page.clock.now = 60000;
    [...page.timers.values()].find(timer => timer.delay === 60000).callback();
    assert.equal(await pending, null);
    assert.deepEqual(page.logs.warn, [['options', `${action} timeout`, '60000ms']]);
    assert.deepEqual(page.logs.error, [['options', `${action} failed 60000ms`, 'timeout']]);
    page.clock.now = 70000;
    page.messageCallbacks[0]({ success: true }); await page.flush();
    assert.deepEqual(page.logs.info, []);
    assert.deepEqual(page.logs.perf, []);
    assert.equal(page.logs.warn.length, 1);
    assert.equal(page.logs.error.length, 1);
  }
});

test('cloud runtime callback failure and unavailable context remain failures with no success log', async () => {
  for (const options of [{ runtimeError: 'Could not establish connection. Receiving end does not exist.' }, { throwMessage: true }]) {
    const page = harness({ now: 0, ...options });
    const pending = page.run("cloudRequest({type:'MANUAL_SYNC_PREVIEW'})");
    page.clock.now = 1457;
    assert.equal(await pending, null);
    assert.ok(page.logs.error.some(entry => entry[1].startsWith('MANUAL_SYNC_PREVIEW failed ')));
    assert.equal(page.element('toast').textContent, 'msgCloudFailed');
    assert.deepEqual(page.logs.info, []);
    assert.deepEqual(page.logs.perf, []);
  }
});

test('non-cloud local requests retain the 300ms performance threshold', async () => {
  const page = harness({ now: 0 });
  const pending = page.run("sendMessageWithTimeout({type:'REFRESH_PROXY'},8000,'REFRESH_PROXY')");
  page.clock.now = 1457;
  assert.equal((await pending).success, true);
  assert.deepEqual(page.logs.perf, [['options', 'REFRESH_PROXY', 0, null, 300]]);
  assert.deepEqual(page.logs.info, []);
  assert.deepEqual(page.logs.warn, []);
  assert.deepEqual(page.logs.error, []);
});

test('cloud outcome logs omit message credentials and returned backup contents on success and failure', async () => {
  for (const success of [true, false]) {
    const secret = 'credential-marker-never-log';
    const page = harness({ now: 0, reply: () => ({ success, error: success ? undefined : 'invalid_backup',
      previewId: secret, summary: { fields: [{ key: secret }] }, config: { userRules: ['private.example'], gitToken: secret, davPass: secret }, detail: secret }) });
    const pending = page.run(`cloudRequest({type:'MANUAL_SYNC_PREVIEW',gitToken:'${secret}',davPass:'${secret}',previewId:'${secret}'})`);
    page.clock.now = 1457;
    await pending;
    const recorded = JSON.stringify(page.logs);
    assert.equal(recorded.includes(secret), false);
    assert.equal(recorded.includes('private.example'), false);
    assert.equal(recorded.includes('config'), false);
    assert.equal(recorded.includes('summary'), false);
    assert.deepEqual(page.logs.perf, []);
    assert.deepEqual(page.logs.warn, []);
    assert.equal(page.logs.info.length, success ? 1 : 0);
    assert.equal(page.logs.error.length, success ? 0 : 1);
  }
});

test('restore errors are localized and proxy-apply pending is not presented as fully applied', async () => {
  for (const [reply, key] of [[{ success: false, error: 'restore_modified' }, 'msgRestorePreviewStale'], [{ success: false, error: 'network_timeout' }, 'msgCloudTimeout']]) {
    const page = harness({ reply: () => reply }); page.run('initSyncModule()'); await page.element('cloudDownloadBtn').click();
    assert.equal(page.element('toast').textContent, key);
  }
  const page = harness({ reply: message => message.type === 'MANUAL_SYNC_PREVIEW' ? { success: true, previewId: 'p', summary: { fields: [] } } : { success: true, applyPending: true } });
  page.run('initSyncModule()'); await page.element('cloudDownloadBtn').click();
  assert.equal(page.element('toast').textContent, 'msgRestoreApplyPending');
});

test('undo restores through its own explicit confirmed operation', async () => {
  const page = harness({ data: { cloudRestoreUndo: { id: 'u' } } });
  page.run('initSyncModule()'); await page.element('cloudUndoBtn').click();
  assert.deepEqual(page.calls.map(call => call.type), ['MANUAL_SYNC_UNDO']);
});

test('sync metadata refresh preserves business drafts and independent comparison baselines', () => {
  const page = harness({ data: { userRules: ['old.example'] } });
  page.run("allData.userRules.push('draft.example'); refreshCloudMetadata({lastSyncTime:{newValue:'today'},cloudRestoreUndo:{newValue:{createdAt:1}}},'local');");
  assert.deepEqual(copy(page.run('allData.userRules')), ['old.example', 'draft.example']);
  assert.deepEqual(copy(page.run('configurationBaseline.userRules')), ['old.example']);
  assert.equal(page.element('syncStatusBadge').className, 'server-tag synced');
  assert.equal(page.element('syncStatusBadge').textContent, 'msgStatusLasttoday');
  assert.equal(page.element('cloudUndoBtn').disabled, false);
  page.run("refreshCloudMetadata({cloudRestoreUndo:{oldValue:{createdAt:1}}},'local');");
  assert.equal(page.element('cloudUndoBtn').disabled, true);
});

test('undo metadata becoming available cannot bypass an in-progress control lock', () => {
  const page = harness();
  page.run("globalThis.lock=lockControls([$('#cloudUndoBtn')]); refreshCloudMetadata({cloudRestoreUndo:{newValue:{createdAt:1}}},'local');");
  assert.equal(page.element('cloudUndoBtn').disabled, true);
  page.run('unlockControls(lock)'); assert.equal(page.element('cloudUndoBtn').disabled, false);
});

test('invalid rule import rejects atomically before confirmation or storage writes', async () => {
  const page = harness(); page.run('initRuleModule()');
  page.element('ruleFile').onchange({ target: { files: [{ content: '["valid.example", 123]' }], value: 'file' } });
  await page.latestReader().promise;
  assert.deepEqual(page.alerts, ['msgInvalidRules']); assert.equal(page.writes.length, 0); assert.equal(page.confirms.length, 0);
});

test('valid rule import previews additions, duplicates and same-rule conflicts before merging', async () => {
  const page = harness({ confirm: false, data: { userRules: ['old.example'], userWhitelist: ['direct.example'] } });
  page.run("customMessages = {msgImportPreview:{message:'new:%NEW%,duplicates:%DUPLICATES%,conflicts:%CONFLICTS%'}}; initRuleModule();");
  page.element('ruleFile').onchange({ target: { files: [{ content: '["OLD.example", "new.example", "new.example", "direct.example"]' }], value: 'file' } });
  await page.latestReader().promise;
  assert.ok(page.confirms[0].includes('new:2,duplicates:2,conflicts:1')); assert.equal(page.writes.length, 0);
});

test('rule import confirmation cannot silently apply after another page changes relevant rules', async () => {
  const page = harness({ data: { userRules: ['old.example'] }, onConfirm(data) { data.userRules.push('another-page.example'); } });
  page.run('initRuleModule()');
  page.element('ruleFile').onchange({ target: { files: [{ content: '["new.example"]' }], value: 'file' } });
  await page.latestReader().promise;
  assert.equal(page.writes.length, 0); assert.equal(page.element('toast').textContent, 'msgImportPreviewStale');
  assert.deepEqual(page.data.userRules, ['old.example', 'another-page.example']);
});

test('validated rule import writes only normalized additions after acceptance', async () => {
  const page = harness({ data: { userRules: ['old.example'] } });
  // Rendering happens only in the acknowledged callback and is not under test here.
  page.run('renderRuleList = () => {}; initRuleModule()');
  page.element('ruleFile').onchange({ target: { files: [{ content: '["OLD.example", "NEW.example", "NEW.example"]' }], value: 'file' } });
  await page.latestReader().promise; await page.flush();
  assert.deepEqual(page.data.userRules, ['old.example', 'new.example']); assert.equal(page.writes.length, 1);
});

test('unavailable proxy status cannot hang the route latency test indefinitely', async () => {
  const page = harness(); page.context.chrome.proxy = { settings: { get() {} } };
  page.run('initServerModule()'); const pending = page.element('testLatencyBtn').click();
  assert.equal(page.element('testLatencyBtn').disabled, true);
  const timer = [...page.timers.values()].find(value => value.delay === 5000); timer.callback();
  await pending;
  assert.equal(page.element('testLatencyBtn').disabled, false); assert.equal(page.element('toast').textContent, 'msgProxyStatusUnavailable');
});

test('navigation supports Enter and Space without relying on mouse-only li actions', () => {
  const page = harness(); page.run('initNav()');
  const target = page.navigation.find(item => item.dataset.target === 'sync'); let prevented = false;
  target.listeners.keydown({ key: ' ', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(page.run('currentSection'), 'sync'); assert.equal(target.tabIndex, 0); assert.equal(target.getAttribute('aria-current'), 'page');
});

test('preview dialog supports cancel, Escape, and focuses its safe initial action', async () => {
  const page = harness({ dialog: true }); const dialog = page.element('configurationPreview');
  dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; };
  const result = page.run("confirmConfiguration('Preview', ['replace fields'])");
  assert.equal(page.element('configurationPreviewCancel').focused, true);
  dialog.oncancel({ preventDefault() {} });
  assert.equal(await result, false); assert.equal(dialog.open, false);
});

test('pending ordinary saves lock submit controls without disabling or blurring draft inputs', () => {
  const page = harness({ hangWrite: true });
  page.element('saveServerItemBtn'); page.element('editName'); page.element('editScheme');
  page.run("writeConfiguration({theme:'dark'})");
  assert.equal(page.element('saveServerItemBtn').disabled, true);
  assert.equal(page.element('editName').disabled, false);
  assert.equal(page.element('editScheme').disabled, false);
});

test('failed writes preserve GFW, credential and server drafts without a hidden data reload', async () => {
  const page = harness({ failWrite: true, data: { gfwlistUrl: 'https://old.example/rules.txt', gitToken: 'old' } });
  page.run('initGfwModule(); initSyncModule(); renderAll()');
  page.element('gfwUrlInput').value = 'https://draft.example/rules.txt';
  page.element('gitToken').value = 'unsaved-secret';
  page.element('editName').value = 'Keep editing';
  page.run("writeConfiguration({gfwlistUrl:'https://draft.example/rules.txt'})"); await page.flush();
  assert.equal(page.stats.reads, 0);
  assert.equal(page.element('gfwUrlInput').value, 'https://draft.example/rules.txt');
  assert.equal(page.element('gitToken').value, 'unsaved-secret');
  assert.equal(page.element('editName').value, 'Keep editing');
  assert.equal(page.run('configurationBaseline.gfwlistUrl'), 'https://old.example/rules.txt');
});

test('GFW source typing is a draft until an explicit save acknowledges it', async () => {
  const page = harness(); page.run('initGfwModule()');
  page.element('gfwUrlInput').value = 'https://source.example/list.txt';
  page.element('gfwUrlInput').listeners.input?.({ target: page.element('gfwUrlInput') });
  assert.equal(page.writes.length, 0);
  assert.equal(page.element('gfwUrlInput').disabled, false);
  await page.element('saveGfwUrlBtn').click(); await page.flush();
  assert.equal(page.data.gfwlistUrl, 'https://source.example/list.txt');
  assert.equal(page.run("isDraft('gfwUrlInput')"), false);
});

test('choosing a mirror updates only the editable draft, not persistent settings', () => {
  const page = harness({ mirrors: ['https://mirror.example/list.txt'] }); page.run('initGfwModule()');
  page.mirrors[0].click();
  assert.equal(page.element('gfwUrlInput').value, 'https://mirror.example/list.txt');
  assert.equal(page.writes.length, 0);
  assert.equal(page.run("isDraft('gfwUrlInput')"), true);
});

test('a late successful source save cannot erase text entered during its round trip', async () => {
  const page = harness({ hangWrite: true }); page.run('initGfwModule()');
  page.element('gfwUrlInput').value = 'https://first.example/list.txt';
  const pending = page.element('saveGfwUrlBtn').click();
  page.element('gfwUrlInput').value = 'https://second.example/unfinished';
  page.writeCallbacks[0]({ success: true, items: { gfwlistUrl: 'https://first.example/list.txt' } });
  await pending; await page.flush(); page.run('renderAll()');
  assert.equal(page.run('configurationBaseline.gfwlistUrl'), 'https://first.example/list.txt');
  assert.equal(page.element('gfwUrlInput').value, 'https://second.example/unfinished');
  assert.equal(page.run("isDraft('gfwUrlInput')"), true);
});

test('refreshing committed restore data preserves dirty fields and their old expectations', async () => {
  const page = harness({ data: { gfwlistUrl: 'https://old.example/list', gitToken: 'old', serverList: [{ id: 'a' }] } });
  page.run('initGfwModule(); initSyncModule(); renderAll()');
  page.element('gfwUrlInput').value = 'https://draft.example/list';
  page.element('gitToken').value = 'draft-secret';
  page.element('serverForm').style.display = 'block'; page.element('editName').value = 'Draft server';
  page.data.gfwlistUrl = 'https://restored.example/list'; page.data.gitToken = 'foreign'; page.data.serverList = [{ id: 'restored' }];
  await page.run('loadAllData()'); page.run('renderAll()');
  assert.equal(page.element('gfwUrlInput').value, 'https://draft.example/list');
  assert.equal(page.element('gitToken').value, 'draft-secret');
  assert.equal(page.element('editName').value, 'Draft server');
  assert.equal(page.run('allData.gfwlistUrl'), 'https://restored.example/list');
  assert.equal(page.run('configurationBaseline.gfwlistUrl'), 'https://old.example/list');
  assert.equal(page.run('configurationBaseline.gitToken'), 'old');
  assert.deepEqual(copy(page.run('configurationBaseline.serverList')), [{ id: 'a' }]);
});

function firstRuleRow(page) { return page.element('ruleListContainer').children[0].children[0]; }
function openFirstRuleEditor(page) {
  page.run('renderRuleList()'); const row = firstRuleRow(page); row.querySelector('.btn-edit').click(); return row.querySelector('input');
}

test('rule edit is explicit, never saves on blur, and Escape cancels without writes', () => {
  const page = harness({ data: { userRules: ['old.example'] } });
  const input = openFirstRuleEditor(page); input.value = 'new.example';
  assert.equal(input.onblur, undefined); assert.equal(input.listeners.blur, undefined);
  input.listeners.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(page.writes.length, 0); assert.equal(page.run('activeRuleEditor'), null);
  assert.equal(firstRuleRow(page).children[0].textContent, 'old.example');
});

test('Enter saves a validated rule while composition Enter never prematurely submits', async () => {
  const page = harness({ data: { userRules: ['old.example'] } });
  const input = openFirstRuleEditor(page); input.value = 'NEW.example';
  input.listeners.keydown({ key: 'Enter', isComposing: true, preventDefault() {} });
  assert.equal(page.writes.length, 0);
  input.listeners.keydown({ key: 'Enter', preventDefault() {} }); await page.flush();
  assert.deepEqual(page.data.userRules, ['new.example']); assert.equal(page.run('activeRuleEditor'), null);
});

test('invalid rule edit keeps the editor and inline error available instead of dismissing the draft', () => {
  const page = harness({ data: { userRules: ['old.example'] } });
  const input = openFirstRuleEditor(page); input.value = 'not a host!';
  input.listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(page.writes.length, 0); assert.equal(input.value, 'not a host!');
  assert.equal(page.element('ruleOperationStatus').textContent, 'msgInvalidRules');
  assert.equal(page.element('ruleOperationStatus').hidden, false); assert.equal(page.alerts.length, 0);
});

test('single rule deletion can be undone through the same guarded save path', async () => {
  const page = harness({ data: { userRules: ['a.example', 'b.example'] } }); page.run('initRuleModule()');
  page.run("deleteRule('a.example')"); await page.flush();
  assert.deepEqual(page.data.userRules, ['b.example']); assert.equal(page.element('ruleUndoBtn').hidden, false);
  page.element('ruleUndoBtn').click(); await page.flush();
  assert.deepEqual(page.data.userRules, ['a.example', 'b.example']); assert.equal(page.element('ruleUndoBtn').hidden, true);
});

test('undo never overwrites a newer edit in another page or discards other section drafts', async () => {
  const page = harness({ data: { userRules: ['a.example', 'b.example'] } }); page.run('initRuleModule(); initGfwModule()');
  page.run("deleteRule('a.example')"); await page.flush();
  page.data.userRules.push('foreign.example'); page.element('gfwUrlInput').value = 'https://unfinished.example/list';
  page.element('ruleUndoBtn').click(); await page.flush();
  assert.deepEqual(page.data.userRules, ['b.example', 'foreign.example']);
  assert.equal(page.element('gfwUrlInput').value, 'https://unfinished.example/list');
  assert.deepEqual(copy(page.run('configurationBaseline.userRules')), ['b.example']);
  assert.equal(page.stats.reads, 0);
});

test('clearing a list offers undo but a later local edit invalidates that whole-list snapshot', async () => {
  const page = harness({ data: { userRules: ['a.example'] } }); page.run('initRuleModule()');
  page.element('ruleClearBtn').click(); await page.flush();
  assert.deepEqual(page.data.userRules, []); assert.equal(page.element('ruleUndoBtn').hidden, false);
  page.run("writeConfiguration({userRules:['mine.example']})"); await page.flush();
  const writes = page.writes.length;
  page.element('ruleUndoBtn').click(); await page.flush();
  assert.equal(page.writes.length, writes); assert.deepEqual(page.data.userRules, ['mine.example']);
  assert.equal(page.element('ruleOperationStatus').textContent, 'msgRuleUndoUnavailable');
});

test('invalid server input keeps all draft fields and presents a persistent inline error', () => {
  const page = harness(); page.run('initServerModule(); openServerEdit(null)');
  page.element('editName').value = 'Keep this name'; page.element('editPort').value = '70000';
  page.element('saveServerItemBtn').click();
  assert.equal(page.writes.length, 0); assert.equal(page.alerts.length, 0);
  assert.equal(page.element('editName').value, 'Keep this name'); assert.equal(page.element('editPort').value, '70000');
  assert.equal(page.element('serverOperationStatus').textContent, 'msgErrPort');
  assert.equal(page.element('serverForm').style.display, 'block');
});

test('cloud failure remains visible and retry repeats the original restore flow with a fresh preview', async () => {
  const page = harness({ reply: message => message.type === 'MANUAL_SYNC_PREVIEW' ? { success: true, previewId: 'p', summary: { fields: [] } } : { success: false, error: 'network_timeout' } });
  page.run('initSyncModule()'); await page.element('cloudDownloadBtn').click();
  assert.equal(page.element('cloudOperationStatus').hidden, false);
  assert.equal(page.element('cloudOperationStatus').textContent, 'msgCloudTimeout');
  assert.equal(page.element('cloudRetryBtn').hidden, false);
  [...page.timers.values()].filter(timer => timer.delay === 3000).forEach(timer => timer.callback());
  assert.equal(page.element('cloudOperationStatus').hidden, false);
  await page.element('cloudRetryBtn').click();
  assert.deepEqual(page.calls.map(call => call.type), ['MANUAL_SYNC_PREVIEW', 'MANUAL_SYNC_DOWNLOAD', 'MANUAL_SYNC_PREVIEW', 'MANUAL_SYNC_DOWNLOAD']);
});

test('cloud upload preserves dirty fields elsewhere and only updates backup metadata', async () => {
  const page = harness({ data: { gfwlistUrl: 'https://old.example/list' } });
  page.run('initGfwModule(); initSyncModule(); renderAll()');
  page.element('gfwUrlInput').value = 'https://draft.example/list';
  await page.element('cloudUploadBtn').click();
  assert.equal(page.stats.reads, 0); assert.equal(page.element('gfwUrlInput').value, 'https://draft.example/list');
  assert.equal(page.element('cloudOperationStatus').textContent, 'msgUploadSuccess');
  assert.equal(page.element('cloudOperationStatus').hidden, false);
});

test('rapid feedback clears old dismissal timers so fresh success and persistent errors are not erased', () => {
  const page = harness(); page.run("showToast('first', {target:'ruleOperationStatus'})");
  const oldTimers = [...page.timers.keys()];
  page.run("showToast('failure', {kind:'error',target:'ruleOperationStatus'})");
  assert.ok(oldTimers.every(id => !page.timers.has(id)));
  [...page.timers.values()].forEach(timer => timer.callback());
  assert.equal(page.element('ruleOperationStatus').textContent, 'failure'); assert.equal(page.element('ruleOperationStatus').hidden, false);
});

test('pending configuration saves keep navigation and read-only viewing controls available', () => {
  const page = harness({ hangWrite: true });
  const nav = page.element('navBtn'); nav.dataset.target = 'sync';
  page.element('ruleExportBtn'); page.element('toggleGfwPreviewBtn'); page.element('saveServerItemBtn');
  page.run("writeConfiguration({theme:'dark'})");
  assert.equal(nav.disabled, false); assert.equal(page.element('ruleExportBtn').disabled, false);
  assert.equal(page.element('toggleGfwPreviewBtn').disabled, false);
  assert.equal(page.element('saveServerItemBtn').disabled, true);
});

test('navigation during a save does not relocate that operation error to an unrelated section', async () => {
  const page = harness({ hangWrite: true });
  page.run("writeConfiguration({theme:'dark'}); currentSection='rules';");
  page.writeCallbacks[0]({ success: false, error: 'storage_failed' }); await page.flush();
  assert.equal(page.element('serverOperationStatus').textContent, 'msgStorageWriteFailed');
  assert.equal(page.element('ruleOperationStatus').textContent, '');
});

test('a server editor canceled and reopened during a save is not retargeted by the old acknowledgement', async () => {
  const page = harness({ hangWrite: true }); page.run('initServerModule(); openServerEdit(null)');
  page.element('editName').value = 'First draft'; page.element('saveServerItemBtn').click();
  page.run('closeServerEdit(); openServerEdit(null)'); page.element('editName').value = 'Second draft';
  page.writeCallbacks[0]({ success: true }); await page.flush();
  assert.equal(page.run('editingServerId'), null); assert.equal(page.element('editName').value, 'Second draft');
  assert.equal(page.element('serverForm').style.display, 'block');
});

test('a newer source saved during a GFW download is not overwritten by the old fetch result', async () => {
  let finishFetch;
  const response = new Promise(resolve => { finishFetch = resolve; });
  const page = harness({ data: { gfwlistUrl: 'https://first.example/list.txt' }, fetch: () => response }); page.run('initGfwModule()');
  const downloading = page.element('updateGfwBtn').click(); await page.flush();
  page.element('gfwUrlInput').value = 'https://second.example/list.txt';
  await page.element('saveGfwUrlBtn').click(); await page.flush();
  finishFetch({ ok: true, text: async () => '||proxy.example' }); await downloading; await page.flush();
  assert.equal(page.data.gfwlistUrl, 'https://second.example/list.txt'); assert.equal(page.data.gfwDomains, undefined);
  assert.equal(page.element('gfwUrlInput').value, 'https://second.example/list.txt');
  assert.equal(page.element('gfwOperationStatus').textContent, 'msgConfigurationChanged');
});

test('a download saves its source draft before fetching and only reports success after data commit', async () => {
  const page = harness({ fetch: async () => ({ ok: true, text: async () => '||proxy.example' }) }); page.run('initGfwModule()');
  page.element('gfwUrlInput').value = 'https://draft.example/list.txt';
  await page.element('updateGfwBtn').click(); await page.flush();
  assert.equal(page.data.gfwlistUrl, 'https://draft.example/list.txt'); assert.deepEqual(page.data.gfwDomains, ['proxy.example']);
  assert.equal(page.writes.length, 2); assert.equal(page.element('updateGfwBtn').disabled, false);
  assert.equal(page.element('gfwOperationStatus').textContent, 'msgUpdateSuccess');
});

test('language changes with no unsaved drafts reload after acknowledgement', async () => {
  const page = harness({ data: { appLanguage: 'en' } }); page.run('initGeneralModule()');
  const language = page.element('langSelect'); language.value = 'zh_CN'; language.onchange({ target: language });
  await page.flush();
  assert.equal(page.data.appLanguage, 'zh_CN'); assert.equal(page.stats.pageReloads, 1);
});

for (const draftKind of ['source', 'credentials', 'server', 'rule editor', 'new rule']) {
  test('language changes preserve unsaved ' + draftKind + ' drafts with an explicit refresh action', async () => {
    const page = harness({ confirm: false, data: { appLanguage: 'en' } }); page.run('initGeneralModule()');
    if (draftKind === 'source') { page.run('initGfwModule()'); page.element('gfwUrlInput').value = 'https://draft.example/list'; }
    if (draftKind === 'credentials') { page.run('initSyncModule()'); page.element('gitToken').value = 'unsaved-secret'; }
    if (draftKind === 'server') page.run('openServerEdit(null)');
    if (draftKind === 'rule editor') page.run('activeRuleEditor = {}');
    if (draftKind === 'new rule') page.element('ruleAddInput').value = 'draft.example';
    const language = page.element('langSelect'); language.value = 'zh_CN'; language.onchange({ target: language });
    await page.flush();
    assert.equal(page.data.appLanguage, 'zh_CN'); assert.equal(page.stats.pageReloads, 0); assert.deepEqual(page.confirms, []);
    const status = page.element('generalOperationStatus');
    assert.equal(status.textContent, 'msgLanguageSavedReload'); assert.equal(status.className, 'operation-status warning');
    assert.ok(status.children.some(child => child.className.includes('configuration-reload')));
    [...page.timers.values()].filter(timer => timer.delay === 3000).forEach(timer => timer.callback());
    assert.equal(status.hidden, false);
    status.children.find(child => child.className.includes('configuration-reload')).click();
    assert.deepEqual(page.confirms, ['msgDiscardDraftsConfirm']); assert.equal(page.stats.pageReloads, 0);
  });
}

test('drafts typed during language save are protected when the acknowledgement arrives', async () => {
  const page = harness({ hangWrite: true, data: { appLanguage: 'en' } }); page.run('initGfwModule(); initGeneralModule()');
  const language = page.element('langSelect'); language.value = 'zh_CN'; language.onchange({ target: language });
  page.element('gfwUrlInput').value = 'https://late-draft.example/list';
  page.writeCallbacks[0]({ success: true, items: { appLanguage: 'zh_CN' } }); await page.flush();
  assert.equal(page.stats.pageReloads, 0); assert.equal(page.element('gfwUrlInput').value, 'https://late-draft.example/list');
  assert.equal(page.element('generalOperationStatus').textContent, 'msgLanguageSavedReload');
});

test('a second language selection during its save is retained instead of erased by reload', async () => {
  const page = harness({ hangWrite: true, data: { appLanguage: 'en' } }); page.run('initGeneralModule()');
  const language = page.element('langSelect'); language.value = 'zh_CN'; language.onchange({ target: language });
  language.value = 'es'; language.onchange({ target: language });
  page.writeCallbacks[0]({ success: true, items: { appLanguage: 'zh_CN' } }); await page.flush();
  assert.equal(page.stats.pageReloads, 0); assert.equal(language.value, 'es'); assert.equal(page.run("isDraft('langSelect')"), true);
});

test('server form composition keys never save or dismiss unfinished input', async () => {
  const page = harness(); page.run('initServerModule(); openServerEdit(null)');
  for (const id of ['editName', 'editScheme', 'editHost', 'editPort']) {
    for (const key of ['Enter', 'Escape']) page.element(id).listeners.keydown({ key, isComposing: true, preventDefault() { throw new Error('IME key was intercepted'); } });
  }
  await page.flush(); assert.equal(page.writes.length, 0); assert.equal(page.element('serverForm').style.display, 'block');
  page.element('editName').listeners.keydown({ key: 'Enter', isComposing: false, preventDefault() {} }); await page.flush();
  assert.equal(page.writes.length, 1); assert.equal(page.element('serverForm').style.display, 'none');
});

test('backup settings are drafts on change and do not disable the next cloud action on blur', () => {
  const page = harness(); page.run('initSyncModule(); renderAll()');
  for (const id of ['gitToken', 'davUrl', 'davUser', 'davPass']) {
    const control = page.element(id); control.value = 'draft-' + id;
    control.onchange?.({ target: control });
  }
  page.element('syncProvider').value = 'webdav'; page.element('syncProvider').onchange();
  page.element('autoSync').checked = true; page.element('autoSync').onchange?.();
  assert.equal(page.writes.length, 0); assert.equal(page.element('cloudUploadBtn').disabled, false);
  assert.equal(page.element('cloudDownloadBtn').disabled, false); assert.equal(page.element('panelWebdav').style.display, 'block');
});

test('explicit backup save commits credentials and automatic-backup choice together without a cloud request', async () => {
  const page = harness(); page.run('initSyncModule(); renderAll()');
  page.element('davUrl').value = 'https://dav.example/'; page.element('davUser').value = 'draft-user';
  page.element('davPass').value = 'draft-password'; page.element('syncProvider').value = 'webdav'; page.element('autoSync').checked = true;
  await page.element('saveSyncSettingsBtn').click(); await page.flush();
  assert.deepEqual(page.writes, [{ syncProvider: 'webdav', autoSync: true, davUrl: 'https://dav.example/', davUser: 'draft-user', davPass: 'draft-password' }]);
  assert.deepEqual(page.calls.map(call => call.type), ['SAVE_CONFIGURATION']);
  assert.equal(page.run("isDraft('davUser')"), false); assert.equal(page.element('cloudOperationStatus').textContent, 'msgSaved');
  await page.element('saveSyncSettingsBtn').click(); await page.flush(); assert.equal(page.writes.length, 1);
});

test('one cloud click saves pending credentials then uploads without touching another section draft', async () => {
  const page = harness(); page.run('initSyncModule(); initGfwModule(); renderAll()');
  page.element('davUser').value = 'new-user'; page.element('gfwUrlInput').value = 'https://unsaved.example/list';
  await page.element('cloudUploadBtn').click(); await page.flush();
  assert.deepEqual(page.calls.map(call => call.type), ['SAVE_CONFIGURATION', 'MANUAL_SYNC_UPLOAD']);
  assert.equal(page.data.davUser, 'new-user'); assert.equal(page.element('gfwUrlInput').value, 'https://unsaved.example/list');
  assert.equal(page.element('cloudOperationStatus').textContent, 'msgUploadSuccess');
});

test('failed backup setting saves preserve credentials and never start upload', async () => {
  const page = harness({ failWrite: true }); page.run('initSyncModule(); renderAll()');
  page.element('davPass').value = 'unfinished-secret';
  await page.element('cloudUploadBtn').click(); await page.flush();
  assert.deepEqual(page.calls.map(call => call.type), ['SAVE_CONFIGURATION']);
  assert.equal(page.element('davPass').value, 'unfinished-secret'); assert.equal(page.run("isDraft('davPass')"), true);
  assert.equal(page.element('cloudOperationStatus').textContent, 'msgStorageWriteFailed'); assert.equal(page.element('cloudRetryBtn').hidden, false);
});

test('typing during explicit backup save remains an unsaved draft after late acknowledgement', async () => {
  const page = harness({ hangWrite: true }); page.run('initSyncModule(); renderAll()');
  page.element('davUser').value = 'first-user'; const saving = page.element('saveSyncSettingsBtn').click();
  page.element('davUser').value = 'second-user';
  page.writeCallbacks[0]({ success: true, items: { davUser: 'first-user' } }); await saving; await page.flush();
  assert.equal(page.element('davUser').value, 'second-user'); assert.equal(page.run("isDraft('davUser')"), true);
  assert.equal(page.run('configurationBaseline.davUser'), 'first-user');
});
