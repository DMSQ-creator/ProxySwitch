'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/diagnostics.js'), 'utf8');
const translations = fs.readFileSync(path.join(__dirname, '../js/diagnostics-i18n.js'), 'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

// Deliberately small DOM: exercise the real inspector script without browser dependencies.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.childNodes = []; this.parentNode = null;
    this.attrs = {}; this.dataset = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.scrollTop = 0;
    this.classList = {
      contains: name => this.className.split(' ').includes(name),
      add: name => { this.className = [...new Set([...this.className.split(' '), name])].join(' '); },
      remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); },
    };
  }
  get className() { return this.attrs.class || ''; }
  set className(value) { this.attrs.class = value; }
  get textContent() { return (this._text || '') + this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get value() { return this._value === undefined && this.tagName === 'SELECT' ? (this.childNodes.find(child => child.selected) || this.childNodes[0])?.value : this._value; }
  set value(value) { this._value = String(value); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name]; }
  removeAttribute(name) { delete this.attrs[name]; }
  appendChild(node) { node.parentNode = this; this.childNodes.push(node); return node; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  replaceChildren(...nodes) { this.childNodes.forEach(node => { node.parentNode = null; }); this.childNodes = []; this._text = ''; this.append(...nodes); }
  contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); }
  matches(selector) {
    if (selector[0] === '.') return this.classList.contains(selector.slice(1));
    if (selector[0] === '#') return this.attrs.id === selector.slice(1);
    if (selector[0] === '[') {
      const attr = selector.slice(1, -1);
      return attr.startsWith('data-') ? Object.hasOwn(this.dataset, attr.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())) : Object.hasOwn(this.attrs, attr);
    }
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) { return this.childNodes.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  focus() { this.ownerDocument.activeElement = this; }
  emit(name) { const event = { target: this }; for (let node = this; node; node = node.parentNode) for (const listener of node.listeners[name] || []) listener(event); }
  click() { if (!this.disabled) this.emit('click'); }
}

const START = 1000000;
function defaultState() {
  return {
    session: { id: 'session-a', tabId: 8, hostname: 'reader.example.com', startedAt: START, captureUntil: 0, dropped: 0 },
    trial: null, permission: true, mode: 'pac_script', main: { host: 'reader.example.com', route: 'proxy', source: 'user', rule: 'reader.example.com' },
    rows: [
      { host: 'reader.example.com', route: 'proxy', source: 'user', rule: 'reader.example.com', count: 1, completed: 1, failed: 0, pending: 0, types: ['main_frame'], lastStatus: 200, conflictDirect: true },
      { host: 'challenges.cloudflare.com', route: 'direct', source: 'default', rule: '', count: 6, completed: 6, failed: 0, pending: 0, types: ['sub_frame', 'script'], lastStatus: 200 },
      { host: 'api.example.net', route: 'direct', source: 'default', rule: '', count: 1, completed: 0, failed: 1, pending: 0, types: ['xmlhttprequest'], error: 'net::ERR_TIMED_OUT' },
      { host: 'login.example.net', route: 'direct', source: 'whitelist', rule: 'example.net', count: 1, completed: 1, failed: 0, pending: 0, types: ['sub_frame'], lastStatus: 200, conflictProxy: true },
    ],
  };
}

function websocketState(overrides = {}) {
  const state = defaultState();
  state.rows = [{
    host: 'hatch.metaaivm.com', route: 'direct', source: 'default', rule: '',
    count: 1, completed: 0, failed: 0, httpErrors: 0, pending: 1, types: ['websocket'],
    ...overrides,
  }];
  return state;
}

function automaticState(overrides = {}) {
  const state = defaultState();
  state.session.auto = true;
  state.session.updatedAt = START;
  state.autoCapture = { enabled: true, permission: true, storage: 'session' };
  return { ...state, ...overrides };
}

function ruleReceipt(overrides = {}) {
  return { id: 'undo-a', actionId: 'action-a', sessionId: 'session-a', tabId: 8, hosts: ['challenges.cloudflare.com'], direction: 'proxy', expiresAt: START + 600000, pendingApply: false, undone: false, canUndo: true, ...overrides };
}

async function harness(options = {}) {
  const document = { hidden: false, activeElement: null, listeners: {}, createElement(tag) { return new Element(tag, this); }, createElementNS(_namespace, tag) { return new Element(tag, this); }, addEventListener(name, fn) { this.listeners[name] = fn; } };
  document.documentElement = document.createElement('html'); document.body = document.createElement('body'); document.documentElement.appendChild(document.body);
  document.querySelector = selector => document.documentElement.querySelector(selector);
  document.getElementById = id => document.querySelector('#' + id);
  const add = (id, tag = 'div', parent = document.body) => { const node = document.createElement(tag); node.setAttribute('id', id); parent.appendChild(node); return node; };
  const app = add('app');
  const entry = add('diagnosticsEntry', 'button', app); add('diagnosticsEntryTitle', 'span', entry); add('diagnosticsEntryHint', 'span', entry);
  add('diagnosticsHomeTrial', 'div', app); const root = add('diagnosticsRoot'); root.hidden = !options.fullPage;
  if (options.fullPage) document.body.classList.add('ps-diag-page');
  let now = START; let sequence = 0;
  const timers = new Map(); const pending = new Map(); const listeners = []; const tabListeners = [];
  const stats = { messages: [], permissions: [], writes: [], sessionWrites: [], tabs: [], confirms: [], closed: false };
  let state = clone(options.state === undefined ? defaultState() : options.state);
  const tab = { id: 8, windowId: 3, url: 'https://reader.example.com/', ...options.tab };
  const data = { appLanguage: options.language || 'zh_CN', ...options.storage };
  const sessionData = { ...options.sessionStorage };
  let permission = options.permission !== false;
  const chrome = {
    runtime: {
      lastError: null, getURL: value => 'chrome-extension://test/' + value,
      sendMessage(message, callback) {
        stats.messages.push(clone(message));
        if (options.hang && options.hang.includes(message.type)) { if (!pending.has(message.type)) pending.set(message.type, []); pending.get(message.type).push(callback); return; }
        let response;
        if (message.type === 'PS_DIAG_GET') response = { success: true, state: clone(state) };
        else if (options.failMutation) response = { success: false, error: options.failMutation, state: clone(state) };
        else {
          if (message.type === 'PS_DIAG_START') { state.session = { ...defaultState().session, id: 'session-new', tabId: message.tabId, captureUntil: now + 60000, ...(state.autoCapture?.enabled ? { auto: true, captureUntil: 0, updatedAt: now } : {}) }; state.rows = []; state.permission = true; }
          if (message.type === 'PS_DIAG_AUTO_ENABLE') { state.autoCapture = { enabled: true, permission: true, storage: state.autoCapture?.storage || 'session' }; state.permission = true; }
          if (message.type === 'PS_DIAG_AUTO_DISABLE') { state.autoCapture.enabled = false; state.session = null; state.rows = []; }
          if (message.type === 'PS_DIAG_APPLY') { state.trial = { id: 'trial-a', sessionId: message.sessionId, tabId: state.session.tabId, hosts: message.hosts, direction: message.direction, expiresAt: now + 600000 }; state.rows = []; state.session.captureUntil = now + 60000; }
          if (['PS_DIAG_UNDO', 'PS_DIAG_SAVE'].includes(message.type)) state.trial = null;
          if (message.type === 'PS_DIAG_ADD_RULES') {
            state.ruleUndo = { id: 'undo-a', actionId: message.actionId, sessionId: message.sessionId, tabId: state.session.tabId, hosts: message.hosts, direction: message.direction, expiresAt: now + 600000, pendingApply: false, undone: false, canUndo: true };
            state.session.captureUntil = 0; state.session.rulesChanged = true;
            for (const row of state.rows) { if (message.hosts.includes(row.host)) { row.route = message.direction; row.source = message.direction === 'proxy' ? 'user' : 'whitelist'; row.rule = row.host; } row.stale = true; }
          }
          if (message.type === 'PS_DIAG_UNDO_RULES') { state.ruleUndo.undone = true; state.ruleUndo.canUndo = false; state.ruleUndo.pendingApply = false; }
          if (message.type === 'PS_DIAG_RETRY_RULES') state.ruleUndo.pendingApply = false;
          if (message.type === 'PS_DIAG_STOP') state.session.captureUntil = 0;
          if (message.type === 'PS_DIAG_CLEAR') { if (!state.session?.auto) state.session = null; state.rows = []; }
          response = { success: true, state: clone(state) };
        }
        queueMicrotask(() => callback(response));
      },
    },
    i18n: { getUILanguage: () => 'en-US' },
    permissions: { request(value, callback) { stats.permissions.push(value); queueMicrotask(() => callback(permission)); } },
    tabs: {
      onUpdated: { addListener(fn) { tabListeners.push(fn); } },
      query(_query, callback) { if (!options.hangTabs) queueMicrotask(() => callback([clone(tab)])); },
      get(id, callback) { stats.tabs.push(['get', id]); queueMicrotask(() => callback(clone(tab))); },
      update(id, value, callback) { stats.tabs.push(['update', id, value]); queueMicrotask(() => callback(clone(tab))); },
      create(value, callback) { stats.tabs.push(['create', value]); queueMicrotask(callback); },
    },
    windows: { update(id, value, callback) { stats.tabs.push(['window', id, value]); queueMicrotask(callback); } },
    storage: {
      session: options.sessionUnavailable ? undefined : {
        get(keys, callback) { queueMicrotask(() => callback(Object.fromEntries(keys.map(key => [key, clone(sessionData[key])])))); },
        set(value, callback) { if (options.sessionFailed) throw new Error('session storage unavailable'); stats.sessionWrites.push(clone(value)); Object.assign(sessionData, clone(value)); if (callback) queueMicrotask(callback); },
        remove(key, callback) { delete sessionData[key]; if (callback) queueMicrotask(callback); },
      },
      local: {
        get(keys, callback) { queueMicrotask(() => callback(Object.fromEntries(keys.map(key => [key, clone(data[key])])))); },
        set(value, callback) { stats.writes.push(clone(value)); Object.assign(data, clone(value)); if (callback) queueMicrotask(callback); },
        remove(key, callback) { delete data[key]; if (callback) queueMicrotask(callback); },
      },
      onChanged: { addListener(fn) { listeners.push(fn); } },
    },
  };
  const windowListeners = {};
  const window = { addEventListener(name, callback) { windowListeners[name] = callback; }, close() { stats.closed = true; }, confirm(value) { stats.confirms.push(value); return options.confirm !== false; } };
  const context = vm.createContext({ document, window, chrome, URL, URLSearchParams, location: { search: options.search || '?tabId=8' }, console, Date: class extends Date { static now() { return now; } }, setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(translations, context); vm.runInContext(source, context); await flush();
  const find = (action, scope = root) => scope.querySelectorAll('button').find(node => node.dataset.action === action);
  return {
    root, entry, document, stats, data, sessionData, state: () => state,
    async open() { entry.click(); await flush(); },
    find,
    async click(action) { const node = find(action); assert.ok(node, `missing action ${action}`); node.click(); await flush(); },
    async select(host) { const node = root.querySelectorAll('input').find(input => input.dataset.host === host); assert.ok(node, `missing ${host}`); assert.equal(node.disabled, false); node.checked = !node.checked; node.emit('change'); await flush(); },
    async changeDirection(value) { const node = root.querySelector('select'); node.value = value; node.emit('change'); await flush(); },
    async filter(value) { root.querySelectorAll('button').find(node => node.dataset.filter === value).click(); await flush(); },
    async tick(duration) { const target = now + duration; while (true) { const candidate = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]; if (!candidate) break; timers.delete(candidate[0]); now = candidate[1].at; candidate[1].fn(); await flush(); } now = target; await flush(); },
    async setState(next) { state = clone(next); const retry = find('retry'); if (retry) retry.click(); else { document.hidden = false; document.listeners.visibilitychange(); await this.tick(1000); } await flush(); },
    async late(type, reply, index = -1) { assert.ok(pending.has(type)); pending.get(type).at(index)(reply); await flush(); },
    async language(value) { data.appLanguage = value; listeners.forEach(fn => fn({ appLanguage: { newValue: value } }, 'local')); await flush(); },
    async navigateTab(url) { tab.url = url; tabListeners.forEach(fn => fn(tab.id, { url }, clone(tab))); await flush(); },
    setPermission(value) { permission = value; },
    pagehide() { windowListeners.pagehide?.(); },
  };
}

test('always-visible entry and home are independent from an unresponsive worker', async () => {
  const app = await harness({ hang: ['PS_DIAG_GET'] });
  assert.equal(app.root.hidden, true);
  assert.match(app.entry.textContent, /页面请求/);
  await app.open(); await app.tick(2200);
  assert.match(app.root.textContent, /暂时无法读取/);
  assert.ok(app.find('retry'));
  await app.click('back'); assert.equal(app.root.hidden, true);
});

test('explicit capture requests permission, denial never starts capture, retry can start', async () => {
  const app = await harness({ state: { ...defaultState(), session: null, rows: [], permission: false }, permission: false });
  await app.open();
  assert.equal(app.stats.permissions.length, 0);
  await app.click('capture');
  assert.equal(app.stats.permissions.length, 1);
  assert.equal(app.stats.messages.filter(item => item.type === 'PS_DIAG_START').length, 0);
  assert.match(app.root.textContent, /未获.*权限/);
  app.setPermission(true); await app.click('capture');
  assert.equal(app.stats.messages.find(item => item.type === 'PS_DIAG_START').tabId, 8);
});

test('rule routes and request facts stay separate; no preselection and conflicts are disabled', async () => {
  const app = await harness(); await app.open();
  assert.equal(app.root.querySelectorAll('input').filter(input => input.checked).length, 0);
  assert.equal(app.find('review').disabled, true);
  const inputs = app.root.querySelectorAll('input');
  assert.equal(inputs.find(node => node.dataset.host === 'login.example.net').disabled, true);
  assert.match(app.root.textContent, /6 次已完成/);
  assert.match(app.root.textContent, /分流不同不代表故障/);
  await app.filter('failed');
  assert.equal(app.root.querySelectorAll('input').length, 1);
  assert.match(app.root.textContent, /api.example.net/);
  await app.filter('all'); assert.equal(app.root.querySelectorAll('input').length, 4);
});

test('HTTP 4xx/5xx responses and network errors have separate filters and counts', async () => {
  const state = defaultState();
  state.rows.push(
    { host: 'blocked.example.net', route: 'direct', source: 'default', rule: '', count: 2, completed: 2, failed: 0, pending: 0, httpErrors: 2, lastStatus: 403 },
    { host: 'recovered.example.net', route: 'direct', source: 'default', rule: '', count: 3, completed: 3, failed: 0, pending: 0, httpErrors: 1, lastStatus: 200 },
    { host: 'old.example.net', route: 'direct', source: 'default', rule: '', count: 1, completed: 1, failed: 0, pending: 0, lastStatus: 503 },
  );
  const app = await harness({ state }); await app.open();
  assert.match(app.root.textContent, /网络错误/);
  assert.match(app.root.textContent, /HTTP 异常/);
  assert.match(app.root.textContent, /HTTP 2xx.*不代表真人验证通过/);
  await app.filter('failed');
  assert.equal(app.root.querySelectorAll('input').length, 1);
  assert.match(app.root.textContent, /api.example.net/);
  assert.doesNotMatch(app.root.textContent, /blocked\.example\.net|recovered\.example\.net|old\.example\.net/);
  await app.filter('http');
  assert.equal(app.root.querySelectorAll('input').length, 3);
  assert.match(app.root.textContent, /blocked.example.net/);
  assert.match(app.root.textContent, /recovered.example.net/);
  assert.match(app.root.textContent, /old.example.net/);
  assert.doesNotMatch(app.root.textContent, /api\.example\.net/);
  assert.match(app.root.textContent, /2 次 HTTP 异常（4xx\/5xx）/);
  await app.tick(80);
  assert.equal(app.data.diagnosticUiState.filter, 'http');
});

test('HTTP filter restores and labels/caveats follow English and Chinese settings', async () => {
  const state = defaultState(); state.rows[1].httpErrors = 1; state.rows[1].lastStatus = 403;
  const storage = { diagnosticUiState: { sessionId: 'session-a', filter: 'http', selected: [], direction: 'proxy', expiresAt: START + 10000 } };
  const app = await harness({ state, storage }); await app.open();
  assert.equal(app.root.querySelectorAll('input').length, 1);
  assert.match(app.root.textContent, /HTTP 异常/);
  await app.language('en');
  assert.match(app.root.textContent, /Network errors/);
  assert.match(app.root.textContent, /HTTP errors/);
  assert.match(app.root.textContent, /HTTP 2xx response does not prove a challenge passed/);
  assert.doesNotMatch(app.root.textContent, /diag[A-Z]|真人验证/);
});

test('optional batch trial uses exact host preview and only explicit save writes permanent rules', async () => {
  const app = await harness(); await app.open();
  await app.select('challenges.cloudflare.com'); await app.select('api.example.net'); await app.click('review');
  assert.match(app.root.textContent, /子域名/); assert.match(app.root.textContent, /10 分钟/);
  assert.equal(app.stats.messages.filter(item => item.type === 'PS_DIAG_APPLY').length, 0);
  await app.click('apply');
  const sent = app.stats.messages.find(item => item.type === 'PS_DIAG_APPLY');
  assert.deepEqual(sent.hosts, ['challenges.cloudflare.com', 'api.example.net']);
  assert.equal(sent.direction, 'proxy'); assert.equal(sent.sessionId, 'session-a');
  assert.match(app.root.textContent, /正在试用/);
  assert.equal(app.stats.messages.filter(item => item.type === 'PS_DIAG_SAVE').length, 0);
  await app.click('save');
  assert.equal(app.find('confirm-save'), undefined);
  assert.equal(app.root.querySelectorAll('input').some(input => input.dataset.verified), false);
  assert.equal(app.stats.messages.find(item => item.type === 'PS_DIAG_SAVE').trialId, 'trial-a');
});

test('return to verification activates the saved source tab and window, never a new URL', async () => {
  const state = defaultState(); state.trial = { id: 't', tabId: 8, sessionId: 'session-a', hosts: ['challenges.cloudflare.com'], direction: 'proxy', expiresAt: START + 600000 };
  const app = await harness({ state }); await app.open(); await app.click('verify');
  assert.deepEqual(clone(app.stats.tabs[0]), ['update', 8, { active: true }]);
  assert.deepEqual(clone(app.stats.tabs[1]), ['window', 3, { focused: true }]); assert.equal(app.stats.closed, true);
});

test('other tab capture is never displayed as this page and replacement is explicit', async () => {
  const state = defaultState(); state.session.tabId = 77; state.session.hostname = 'other.example.com';
  const app = await harness({ state }); await app.open();
  assert.match(app.root.textContent, /另一个页面/);
  assert.doesNotMatch(app.root.textContent, /challenges.cloudflare.com/);
  await app.click('replace'); assert.equal(app.stats.confirms.length, 1);
  assert.deepEqual(app.stats.messages.find(item => item.type === 'PS_DIAG_START'), { type: 'PS_DIAG_START', tabId: 8, replace: true });
});

test('non-auto modes never offer an enabled trial or send a proxy mode change', async () => {
  const state = defaultState(); state.mode = 'system'; const app = await harness({ state }); await app.open();
  assert.match(app.root.textContent, /自动模式/);
  assert.ok(app.root.querySelectorAll('input').every(input => input.disabled));
  assert.equal(app.find('review').disabled, true);
  assert.ok(app.stats.messages.every(item => item.type === 'PS_DIAG_GET'));
});

test('mutations time out without false success or duplicate submissions and late reply recovers', async () => {
  const app = await harness({ hang: ['PS_DIAG_APPLY'] }); await app.open();
  await app.select('challenges.cloudflare.com'); await app.click('review'); await app.click('apply'); await app.tick(15000);
  assert.match(app.root.textContent, /未确认操作结果/);
  assert.equal(app.find('apply').disabled, true);
  app.find('apply').click();
  assert.equal(app.stats.messages.filter(item => item.type === 'PS_DIAG_APPLY').length, 1);
  await app.late('PS_DIAG_APPLY', { success: false, error: 'proxy_failed', state: app.state() });
  assert.equal(app.find('apply').disabled, false);
});

test('chosen domains and filter persist, custom language changes all diagnostic text', async () => {
  const app = await harness(); await app.open(); await app.filter('all'); await app.select('challenges.cloudflare.com'); await app.tick(80);
  assert.deepEqual(app.data.diagnosticUiState.selected, ['challenges.cloudflare.com']);
  const reopened = await harness({ storage: { diagnosticUiState: app.data.diagnosticUiState } }); await reopened.open();
  assert.equal(reopened.root.querySelectorAll('input').find(input => input.dataset.host === 'challenges.cloudflare.com').checked, true);
  await reopened.language('en'); assert.match(reopened.entry.textContent, /Page requests/);
  assert.match(reopened.root.textContent, /Temporary trial/); assert.doesNotMatch(reopened.root.textContent, /diag[A-Z]/);
});

test('stale observations cannot be mistaken for a verification of changed routes', async () => {
  const state = defaultState(); state.session.rulesChanged = true; state.rows.forEach(row => { row.stale = true; });
  const app = await harness({ state }); await app.open();
  assert.match(app.root.textContent, /规则已变更/); assert.match(app.root.textContent, /旧记录/);
  assert.doesNotMatch(app.root.textContent, /6 次已完成/);
});

test('network supplied text is rendered as text, not HTML', async () => {
  const state = defaultState(); state.rows[1].error = '<img src=x onerror=alert(1)>';
  const app = await harness({ state }); await app.open();
  const expand = app.root.querySelectorAll('button').find(node => node.dataset.action === 'expand' && node.dataset.host === 'challenges.cloudflare.com'); expand.click();
  assert.match(app.root.textContent, /<img src=x/);
  const images = app.root.querySelectorAll('img');
  assert.equal(images.length, 1, 'only the trusted original brand image is rendered');
  assert.equal(images[0].getAttribute('src'), 'chrome-extension://test/assets/icon.png');
  assert.equal(images[0].getAttribute('onerror'), undefined);
});

test('full page binds URL tabId and shows full domain list; incognito cannot capture', async () => {
  const app = await harness({ fullPage: true });
  assert.deepEqual(app.stats.tabs[0], ['get', 8]); assert.equal(app.root.querySelectorAll('input').length, 4);
  const incognito = await harness({ tab: { incognito: true }, state: { ...defaultState(), session: null, rows: [] } }); await incognito.open();
  assert.equal(incognito.find('capture'), undefined);
});

test('hung source-tab lookup is bounded and offers retry', async () => {
  const app = await harness({ hangTabs: true }); await app.open(); await app.tick(2200);
  assert.match(app.root.textContent, /暂时无法读取/); assert.ok(app.find('retry'));
});

test('direct trials disable opposite manual proxy rules without changing them', async () => {
  const app = await harness(); await app.open(); await app.filter('all'); await app.changeDirection('direct');
  const main = app.root.querySelectorAll('input').find(input => input.dataset.host === 'reader.example.com');
  assert.equal(main.disabled, true);
  assert.equal(app.find('review').disabled, true);
  assert.equal(app.stats.messages.filter(message => message.type !== 'PS_DIAG_GET').length, 0);
});

test('clearing records confirms scope, active trials disable clear, failed writes recover', async () => {
  const app = await harness({ failMutation: 'storage_failed' }); await app.open(); await app.click('clear');
  assert.equal(app.stats.confirms.length, 1); assert.match(app.root.textContent, /存储/); assert.equal(app.find('clear').disabled, false);
  const state = defaultState(); state.trial = { id: 'trial-a', sessionId: 'session-a', tabId: 8, hosts: ['api.example.net'], direction: 'proxy', expiresAt: START + 10000 };
  const trial = await harness({ state }); await trial.open(); assert.equal(trial.find('clear').disabled, true);
});

test('pending cleanup never presents an expired trial as active or permits new writes', async () => {
  const state = defaultState(); state.trial = { id: 'trial-a', sessionId: 'session-a', tabId: 8, hosts: ['api.example.net'], direction: 'proxy', expiresAt: 0, pendingCleanup: true };
  const app = await harness({ state }); await app.open();
  assert.match(app.root.textContent, /恢复原有分流/);
  assert.doesNotMatch(app.root.textContent, /个域名正在试用/);
  assert.equal(app.find('capture').disabled, true); assert.equal(app.find('clear').disabled, true);
  assert.ok(app.root.querySelectorAll('input').every(input => input.disabled));
});

test('stale stored selections from another capture never reappear', async () => {
  const app = await harness({ storage: { diagnosticUiState: { sessionId: 'old-session', selected: ['challenges.cloudflare.com'], filter: 'all', expiresAt: START + 10000 } } });
  await app.open(); assert.ok(app.root.querySelectorAll('input').every(input => !input.checked));
});

test('unchanged polling and bookkeeping timestamps preserve the exact live control nodes', async () => {
  const app = await harness(); await app.open(); await app.select('challenges.cloudflare.com');
  const review = app.find('review'); review.focus();
  await app.tick(3000);
  assert.equal(app.find('review'), review); assert.equal(app.document.activeElement, review);
  app.state().session.updatedAt = START + 3000;
  await app.tick(1000); assert.equal(app.find('review'), review);
});

test('delayed and pagehide writes never persist already-expired UI selections', async () => {
  const state = defaultState(); state.session.startedAt = START - 30 * 60 * 1000 + 20;
  const app = await harness({ state }); await app.open(); await app.select('challenges.cloudflare.com');
  await app.tick(25); app.pagehide(); await flush();
  assert.equal(app.stats.writes.filter(write => write.diagnosticUiState).length, 0);
  const delayed = await harness({ state }); await delayed.open(); await delayed.select('challenges.cloudflare.com'); await delayed.tick(100);
  assert.equal(delayed.stats.writes.filter(write => write.diagnosticUiState).length, 0);
});

test('WebSocket domains have a lightweight visible type label without changing ordinary HTTP rows', async () => {
  const state = defaultState(); state.rows.push(...websocketState().rows);
  const app = await harness({ state }); await app.open();
  const rows = app.root.querySelectorAll('.ps-diag-domain');
  const websocket = rows.find(row => row.textContent.includes('hatch.metaaivm.com'));
  assert.ok(websocket);
  assert.equal(websocket.querySelector('.ps-diag-host-line').textContent, 'hatch.metaaivm.comWebSocket');
  assert.equal(websocket.querySelector('.ps-diag-type').textContent, 'WebSocket');
  assert.equal(websocket.querySelector('.ps-diag-websocket-hint'), null, 'the handshake explanation is disclosed only in details');
  assert.equal(app.root.querySelectorAll('.ps-diag-type').length, 1);
  assert.ok(rows.filter(row => row !== websocket).every(row => !row.querySelector('.ps-diag-type')));
  const input = websocket.querySelector('input');
  assert.equal(input.getAttribute('aria-label'), '选择 hatch.metaaivm.com');
  assert.equal(input.disabled, false);
  assert.equal(input.checked, false);
});

test('pending WebSocket handshakes are not network or HTTP errors even after the capture ends', async () => {
  const app = await harness({ state: websocketState({ count: 2, pending: 2 }) }); await app.open();
  assert.match(app.root.querySelector('.ps-diag-domain').textContent, /2 次握手待响应/);
  assert.equal(app.root.querySelector('.ps-diag-domain').querySelector('.ps-diag-problem'), null);
  await app.tick(65000);
  assert.match(app.root.querySelector('.ps-diag-domain').textContent, /2 次握手待响应/);
  await app.filter('failed'); assert.equal(app.root.querySelectorAll('.ps-diag-domain').length, 0);
  await app.filter('http'); assert.equal(app.root.querySelectorAll('.ps-diag-domain').length, 0);
  await app.filter('all'); assert.equal(app.root.querySelectorAll('.ps-diag-domain').length, 1);
  assert.equal(app.stats.messages.filter(message => message.type !== 'PS_DIAG_GET').length, 0);
});

test('HTTP 101 reports a finished handshake, never application readiness or connection closure', async () => {
  const app = await harness({ state: websocketState({ completed: 1, pending: 0, lastStatus: 101 }) }); await app.open();
  assert.match(app.root.querySelector('.ps-diag-domain').textContent, /1 次握手已结束/);
  assert.equal(app.root.querySelector('.ps-diag-domain').querySelector('.ps-diag-problem'), null);
  await app.click('expand');
  const details = app.root.querySelector('.ps-diag-detail');
  assert.match(details.textContent, /资源类型WebSocket/);
  assert.match(details.textContent, /最近响应状态HTTP 101/);
  assert.match(details.textContent, /HTTP 101 表示协议切换，不代表应用已就绪/);
  assert.match(details.textContent, /已建立的连接长期保持不算故障/);
  assert.match(details.textContent, /采集开启前已有的连接，需要重新加载页面或重连/);
  assert.match(details.textContent, /不读取连接消息/);
  assert.doesNotMatch(app.root.querySelector('.ps-diag-meta').textContent, /已连接|连接成功|已关闭|失败/);
  await app.tick(65000);
  assert.equal(app.root.querySelector('.ps-diag-domain').querySelector('.ps-diag-problem'), null);
});

test('mixed HTTP and WebSocket counts remain aggregate and the latest HTTP status is not a socket verdict', async () => {
  const state = websocketState({ types: ['xmlhttprequest', 'websocket'], count: 5, completed: 3, pending: 2, httpErrors: 1, lastStatus: 403 });
  const app = await harness({ state }); await app.open();
  const summary = app.root.querySelector('.ps-diag-meta').textContent;
  assert.match(summary, /1 次 HTTP 异常（4xx\/5xx）/);
  assert.match(summary, /2 次请求\/握手未完成/);
  assert.match(summary, /3 次请求\/握手已结束/);
  assert.doesNotMatch(summary, /3 次握手已结束|WebSocket.*403|连接成功|已连接/);
  await app.click('expand');
  assert.match(app.root.querySelector('.ps-diag-detail').textContent, /资源类型xmlhttprequest, WebSocket/);
  assert.match(app.root.querySelector('.ps-diag-detail').textContent, /最近响应状态HTTP 403/);
  await app.filter('failed'); assert.equal(app.root.querySelectorAll('.ps-diag-domain').length, 0);
  await app.filter('http'); assert.equal(app.root.querySelectorAll('.ps-diag-domain').length, 1);
});

test('a WebSocket network error is filterable separately from its predicted rule route', async () => {
  const app = await harness({ state: websocketState({ pending: 0, failed: 1, error: 'net::ERR_CONNECTION_TIMED_OUT' }) }); await app.open();
  await app.filter('failed');
  const row = app.root.querySelector('.ps-diag-domain');
  assert.equal(row.querySelector('.ps-diag-type').textContent, 'WebSocket');
  assert.match(row.querySelector('.ps-diag-meta').textContent, /直连.*1 次网络错误/);
  await app.click('expand');
  assert.match(app.root.querySelector('.ps-diag-detail').textContent, /net::ERR_CONNECTION_TIMED_OUT/);
  await app.filter('http'); assert.equal(app.root.querySelectorAll('.ps-diag-domain').length, 0);
});

test('WebSocket domains retain an optional exact-host trial and HTTP 101 never auto-saves', async () => {
  const app = await harness({ state: websocketState() }); await app.open();
  assert.equal(app.find('save'), undefined);
  await app.select('hatch.metaaivm.com'); await app.click('review');
  assert.match(app.root.textContent, /hatch.metaaivm.com/);
  assert.match(app.root.textContent, /子域名/);
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_APPLY').length, 0);
  await app.click('apply');
  const apply = app.stats.messages.find(message => message.type === 'PS_DIAG_APPLY');
  assert.deepEqual(apply, { type: 'PS_DIAG_APPLY', sessionId: 'session-a', hosts: ['hatch.metaaivm.com'], direction: 'proxy' });
  assert.equal(app.find('undo').disabled, false);
  assert.equal(app.find('verify').disabled, false);
  await app.click('verify');
  assert.deepEqual(clone(app.stats.tabs[0]), ['update', 8, { active: true }]);
  const afterHandshake = app.state();
  afterHandshake.rows = websocketState({ completed: 1, pending: 0, lastStatus: 101, route: 'proxy', source: 'trial' }).rows;
  await app.setState(afterHandshake);
  assert.equal(app.stats.messages.some(message => message.type === 'PS_DIAG_SAVE'), false, 'HTTP 101 does not authorize permanent rules');
  await app.click('save');
  assert.equal(app.find('confirm-save'), undefined);
  assert.equal(app.stats.messages.find(message => message.type === 'PS_DIAG_SAVE').trialId, 'trial-a');
});

test('WebSocket trials remain reversible and parent manual-rule conflicts cannot be bypassed', async () => {
  const reversible = await harness({ state: websocketState() }); await reversible.open();
  await reversible.select('hatch.metaaivm.com'); await reversible.click('review'); await reversible.click('apply'); await reversible.click('undo');
  assert.equal(reversible.stats.messages.find(message => message.type === 'PS_DIAG_UNDO').trialId, 'trial-a');
  assert.equal(reversible.stats.messages.some(message => message.type === 'PS_DIAG_SAVE'), false);
  const conflict = await harness({ state: websocketState({ source: 'whitelist', rule: 'metaaivm.com', conflictProxy: true }) }); await conflict.open();
  const input = conflict.root.querySelector('input');
  assert.equal(input.disabled, true);
  assert.match(conflict.root.textContent, /相反的手动规则/);
  assert.equal(conflict.find('review').disabled, true);
  assert.ok(conflict.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
  const opposite = await harness({ state: websocketState({ route: 'proxy', source: 'user', rule: 'metaaivm.com', conflictDirect: true }) }); await opposite.open(); await opposite.filter('all'); await opposite.changeDirection('direct');
  assert.equal(opposite.root.querySelector('input').disabled, true);
  assert.equal(opposite.find('review').disabled, true);
});

test('WebSocket type and handshake caveats are complete in all four configured languages', async () => {
  for (const language of ['zh_CN', 'en', 'es', 'ru']) {
    const app = await harness({ language, state: websocketState({ completed: 1, pending: 0, lastStatus: 101 }) }); await app.open(); await app.click('expand');
    assert.equal(app.root.querySelector('.ps-diag-type').textContent, 'WebSocket');
    assert.match(app.root.querySelector('.ps-diag-websocket-hint').textContent, /HTTP 101/);
    assert.doesNotMatch(app.root.textContent, /diag[A-Z]|\{count\}|\{host\}/);
  }
});

test('checked domains can be added in one explicit action without a trial or confirmation', async () => {
  const app = await harness(); await app.open();
  assert.equal(app.find('add-rules').disabled, true);
  assert.equal(app.find('add-rules').textContent, '添加代理规则');
  assert.equal(app.find('review').classList.contains('ps-diag-link'), true);
  await app.select('challenges.cloudflare.com'); await app.select('api.example.net');
  assert.match(app.find('add-rules').getAttribute('aria-description'), /其他页面/);
  await app.click('add-rules');
  const writes = app.stats.messages.filter(message => message.type !== 'PS_DIAG_GET');
  assert.equal(writes.length, 1);
  assert.deepEqual({ ...writes[0], actionId: undefined }, { type: 'PS_DIAG_ADD_RULES', sessionId: 'session-a', hosts: ['challenges.cloudflare.com', 'api.example.net'], direction: 'proxy', actionId: undefined });
  assert.match(writes[0].actionId, /^rules-/);
  assert.equal(app.stats.confirms.length, 0);
  assert.equal(app.stats.tabs.length, 0, 'adding does not reload, navigate, or activate the source page');
  assert.match(app.root.querySelector('.ps-diag-message').textContent, /已添加规则.*撤销添加/);
  assert.equal(app.find('undo-rules').disabled, false);
  assert.equal(app.state().session.captureUntil, 0);
  assert.ok(app.state().rows.every(row => row.stale));
  assert.equal(app.find('confirm-save'), undefined);
});

test('direct rules use the same one-click action and each new addition gets a fresh identity', async () => {
  const state = defaultState();
  state.rows.push({ host: 'cdn.first.net', route: 'proxy', source: 'subscription', count: 1, pending: 0, completed: 1, failed: 0 });
  state.rows.push({ host: 'cdn.second.net', route: 'proxy', source: 'subscription', count: 1, pending: 0, completed: 1, failed: 0 });
  const app = await harness({ state }); await app.open(); await app.filter('all'); await app.changeDirection('direct');
  assert.equal(app.find('add-rules').textContent, '添加直连规则');
  await app.select('cdn.first.net'); await app.click('add-rules');
  await app.select('cdn.second.net'); await app.click('add-rules');
  const writes = app.stats.messages.filter(message => message.type === 'PS_DIAG_ADD_RULES');
  assert.equal(writes.length, 2); assert.ok(writes.every(message => message.direction === 'direct'));
  assert.notEqual(writes[0].actionId, writes[1].actionId);
  assert.equal(app.stats.confirms.length, 0);
});

test('direct addition of a WebSocket domain never infers readiness or saves without the click', async () => {
  const app = await harness({ state: websocketState({ completed: 1, pending: 0, lastStatus: 101 }) }); await app.open();
  await app.tick(3000);
  assert.equal(app.stats.messages.some(message => message.type !== 'PS_DIAG_GET'), false);
  await app.select('hatch.metaaivm.com'); await app.click('add-rules');
  const add = app.stats.messages.find(message => message.type === 'PS_DIAG_ADD_RULES');
  assert.deepEqual(add.hosts, ['hatch.metaaivm.com']);
  assert.equal(app.stats.messages.some(message => message.type === 'PS_DIAG_APPLY'), false);
  assert.doesNotMatch(app.root.querySelector('.ps-diag-message').textContent, /已连接|连接成功|应用已就绪/);
});

test('manual-rule conflicts, active trials, and non-auto modes block both permanent additions and trials', async () => {
  const conflict = await harness({ state: websocketState({ source: 'whitelist', rule: 'metaaivm.com', conflictProxy: true }) }); await conflict.open();
  assert.equal(conflict.find('add-rules').disabled, true);
  assert.equal(conflict.root.querySelector('input').disabled, true);
  for (const mode of ['system', 'direct', 'fixed_servers']) {
    const app = await harness({ state: { ...defaultState(), mode } }); await app.open();
    assert.equal(app.find('add-rules').disabled, true); assert.equal(app.find('review').disabled, true);
    assert.equal(app.root.querySelector('select').disabled, true);
    assert.ok(app.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
  }
  const trialState = defaultState(); trialState.trial = { id: 't', sessionId: 'session-a', tabId: 8, hosts: ['api.example.net'], direction: 'proxy', expiresAt: START + 600000 };
  const trial = await harness({ state: trialState }); await trial.open();
  assert.equal(trial.find('add-rules'), undefined); assert.equal(trial.find('review'), undefined);
  assert.ok(trial.root.querySelectorAll('input').every(input => input.disabled));
});

test('rule addition undo is one action, remains available in non-auto mode, and keeps trial undo separate', async () => {
  const state = defaultState(); state.ruleUndo = ruleReceipt(); state.mode = 'system';
  const app = await harness({ state }); await app.open();
  assert.equal(app.find('undo'), undefined);
  assert.equal(app.find('undo-rules').disabled, false);
  await app.click('undo-rules');
  assert.deepEqual(app.stats.messages.find(message => message.type === 'PS_DIAG_UNDO_RULES'), { type: 'PS_DIAG_UNDO_RULES', undoId: 'undo-a' });
  assert.equal(app.stats.confirms.length, 0);
  assert.match(app.root.querySelector('.ps-diag-message').textContent, /已撤销本次添加/);
  assert.equal(app.find('undo-rules'), undefined);
});

test('a closed source page can still undo the matching addition', async () => {
  const state = defaultState(); state.session.closed = true; state.ruleUndo = ruleReceipt();
  const app = await harness({ state }); await app.open();
  assert.match(app.root.textContent, /原标签页已关闭/);
  assert.equal(app.find('undo-rules').disabled, false);
  await app.click('undo-rules'); assert.ok(app.stats.messages.some(message => message.type === 'PS_DIAG_UNDO_RULES'));
});

test('an active trial temporarily disables old addition undo and retry without changing their history', async () => {
  for (const pendingApply of [false, true]) {
    const state = defaultState(); state.ruleUndo = ruleReceipt({ pendingApply });
    state.trial = { id: 't', sessionId: 'session-a', tabId: 8, hosts: ['api.example.net'], direction: 'proxy', expiresAt: START + 600000 };
    const app = await harness({ state }); await app.open();
    const undo = app.find('undo-rules');
    assert.equal(undo.disabled, true); assert.match(undo.getAttribute('title'), /已有进行中的试用.*撤销或保存/);
    await app.click('undo-rules');
    if (pendingApply) { assert.equal(app.find('retry-rules').disabled, true); await app.click('retry-rules'); }
    assert.ok(app.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
    assert.equal(app.state().ruleUndo.undone, false);
    assert.doesNotMatch(app.root.querySelector('.ps-diag-message').textContent, /已撤销本次添加/);
    state.trial = null; await app.setState(state);
    assert.equal(app.find('undo-rules').disabled, false);
    if (pendingApply) assert.equal(app.find('retry-rules').disabled, false);
  }
});

test('saved rules awaiting application show recovery, never false success, and stop new writes', async () => {
  const state = defaultState(); state.ruleUndo = ruleReceipt({ pendingApply: true });
  const app = await harness({ state }); await app.open();
  assert.match(app.root.querySelector('.ps-diag-message').textContent, /规则已保存.*尚未确认代理更新/);
  assert.equal(app.root.querySelector('.ps-diag-message').getAttribute('role'), 'alert');
  assert.doesNotMatch(app.root.querySelector('.ps-diag-message').textContent, /已添加规则/);
  assert.equal(app.find('add-rules').disabled, true); assert.equal(app.find('review').disabled, true);
  assert.equal(app.find('capture').disabled, true); assert.equal(app.find('clear').disabled, true);
  assert.ok(app.root.querySelectorAll('input').every(input => input.disabled));
  assert.equal(app.find('retry-rules').disabled, false); assert.equal(app.find('undo-rules').disabled, false);
  await app.click('retry-rules');
  assert.deepEqual(app.stats.messages.find(message => message.type === 'PS_DIAG_RETRY_RULES'), { type: 'PS_DIAG_RETRY_RULES', undoId: 'undo-a' });
  assert.match(app.root.querySelector('.ps-diag-message').textContent, /已添加规则/);
  assert.equal(app.find('retry-rules'), undefined);
});

test('pending undo is distinguished from a saved addition and offers only application retry', async () => {
  const state = defaultState(); state.ruleUndo = ruleReceipt({ pendingApply: true, undone: true, canUndo: false });
  const app = await harness({ state }); await app.open();
  assert.match(app.root.querySelector('.ps-diag-message').textContent, /已移除本次添加的规则.*尚未确认/);
  assert.equal(app.find('undo-rules'), undefined); assert.ok(app.find('retry-rules'));
  await app.click('retry-rules'); assert.match(app.root.querySelector('.ps-diag-message').textContent, /已撤销本次添加/);
});

test('receipts persist through language changes and reopening but are hidden from unrelated tabs and sessions', async () => {
  const state = defaultState(); state.ruleUndo = ruleReceipt();
  const app = await harness({ state }); await app.open(); await app.language('en');
  assert.match(app.root.querySelector('.ps-diag-message').textContent, /Rules added.*Undo addition/);
  const reopened = await harness({ state, fullPage: true }); assert.ok(reopened.find('undo-rules'));
  for (const receipt of [ruleReceipt({ tabId: 77 }), ruleReceipt({ sessionId: 'another-capture' })]) {
    const otherState = defaultState(); otherState.ruleUndo = receipt;
    const other = await harness({ state: otherState }); await other.open();
    assert.equal(other.find('undo-rules'), undefined);
    assert.doesNotMatch(other.root.textContent, /已添加规则/);
  }
});

test('an unrelated pending application blocks new changes without exposing its undo action', async () => {
  const state = defaultState(); state.ruleUndo = ruleReceipt({ tabId: 77, sessionId: 'other', pendingApply: true });
  const app = await harness({ state }); await app.open();
  assert.match(app.root.textContent, /有一项规则更新尚待应用/);
  assert.equal(app.find('undo-rules'), undefined); assert.equal(app.find('retry-rules'), undefined);
  assert.equal(app.find('add-rules').disabled, true);
});

test('expired or changed-rule receipts never permit unsafe undo', async () => {
  const state = defaultState(); state.ruleUndo = ruleReceipt({ canUndo: false });
  const changed = await harness({ state }); await changed.open();
  assert.equal(changed.find('undo-rules'), undefined);
  assert.match(changed.root.textContent, /规则已发生变化.*规则管理/);
  const activeState = defaultState(); activeState.ruleUndo = ruleReceipt({ expiresAt: START + 1500 });
  const expired = await harness({ state: activeState }); await expired.open(); assert.ok(expired.find('undo-rules'));
  await expired.tick(2000);
  assert.equal(expired.find('undo-rules'), undefined); assert.equal(expired.root.querySelector('.ps-diag-message').hidden, true);
});

test('a timed-out addition is stored by identity only and reopening polls instead of resubmitting', async () => {
  const app = await harness({ hang: ['PS_DIAG_ADD_RULES'] }); await app.open();
  await app.select('challenges.cloudflare.com'); await app.click('add-rules'); await app.tick(15000);
  assert.match(app.root.textContent, /未确认操作结果/);
  assert.equal(app.find('add-rules').disabled, true);
  await app.click('add-rules'); await app.click('retry');
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_ADD_RULES').length, 1);
  const sent = app.stats.messages.find(message => message.type === 'PS_DIAG_ADD_RULES');
  assert.deepEqual(app.data.diagnosticUiState.pendingMutation, { type: 'PS_DIAG_ADD_RULES', sessionId: 'session-a', actionId: sent.actionId });
  const reopened = await harness({ storage: { diagnosticUiState: app.data.diagnosticUiState }, hang: ['PS_DIAG_GET'] }); await reopened.open();
  await reopened.late('PS_DIAG_GET', { success: true, state: app.state() });
  await reopened.tick(1000);
  assert.match(reopened.root.textContent, /尚未确认本次操作完成/);
  assert.ok(reopened.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
  const waiting = await harness({ storage: { diagnosticUiState: app.data.diagnosticUiState }, hang: ['PS_DIAG_GET'] }); await waiting.open();
  const completed = app.state(); completed.ruleUndo = ruleReceipt({ actionId: sent.actionId });
  await waiting.late('PS_DIAG_GET', { success: true, state: completed });
  assert.equal(waiting.find('add-rules').disabled, false);
  assert.match(waiting.root.querySelector('.ps-diag-message').textContent, /已添加规则.*撤销添加/);
  await waiting.tick(80); assert.equal(waiting.data.diagnosticUiState.pendingMutation, undefined);
});

test('reopened pending additions without a receipt unlock after a successful authoritative GET and do not replay', async () => {
  const stored = { sessionId: 'session-a', direction: 'proxy', filter: 'all', selected: ['challenges.cloudflare.com'], pendingMutation: { type: 'PS_DIAG_ADD_RULES', sessionId: 'session-a', actionId: 'action-a' }, expiresAt: START + 10000 };
  const reopened = await harness({ storage: { diagnosticUiState: stored } }); await reopened.open();
  assert.equal(reopened.find('add-rules').disabled, false);
  assert.match(reopened.root.querySelector('.ps-diag-message').textContent, /尚未确认本次操作完成.*没有重复提交/);
  assert.ok(reopened.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
  await reopened.tick(80); assert.equal(reopened.data.diagnosticUiState.pendingMutation, undefined);
});

test('reopened pending additions remain blocked while authoritative records are unavailable', async () => {
  const stored = { sessionId: 'session-a', direction: 'proxy', filter: 'all', selected: ['challenges.cloudflare.com'], pendingMutation: { type: 'PS_DIAG_ADD_RULES', sessionId: 'session-a', actionId: 'action-a' }, expiresAt: START + 10000 };
  const reopened = await harness({ storage: { diagnosticUiState: stored }, hang: ['PS_DIAG_GET'] }); await reopened.open();
  await reopened.tick(2200);
  // Without a session read there are no writable controls to bypass recovery.
  assert.equal(reopened.find('add-rules'), undefined);
  assert.ok(reopened.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
});

test('a late response from an older addition cannot clear a newer in-flight addition', async () => {
  const app = await harness({ hang: ['PS_DIAG_ADD_RULES'] }); await app.open();
  await app.select('challenges.cloudflare.com'); await app.click('add-rules'); await app.tick(15000);
  const first = app.stats.messages.find(message => message.type === 'PS_DIAG_ADD_RULES');
  const completed = app.state(); completed.ruleUndo = ruleReceipt({ actionId: first.actionId }); await app.setState(completed);
  await app.select('challenges.cloudflare.com'); await app.select('api.example.net'); await app.click('add-rules');
  const additions = app.stats.messages.filter(message => message.type === 'PS_DIAG_ADD_RULES');
  assert.equal(additions.length, 2); assert.notEqual(additions[0].actionId, additions[1].actionId);
  await app.late('PS_DIAG_ADD_RULES', { success: false, error: 'proxy_failed', state: completed }, 0);
  assert.equal(app.find('add-rules').disabled, true);
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_ADD_RULES').length, 2);
});

test('an older ordinary callback after a GET acknowledgement cannot overwrite the newer operation', async () => {
  const app = await harness({ hang: ['PS_DIAG_ADD_RULES'] }); await app.open();
  await app.select('challenges.cloudflare.com'); await app.click('add-rules');
  const first = app.stats.messages.find(message => message.type === 'PS_DIAG_ADD_RULES');
  const completed = app.state(); completed.ruleUndo = ruleReceipt({ actionId: first.actionId }); await app.setState(completed);
  await app.select('challenges.cloudflare.com'); await app.select('api.example.net'); await app.click('add-rules');
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_ADD_RULES').length, 2);
  await app.late('PS_DIAG_ADD_RULES', { success: true, state: completed }, 0);
  assert.equal(app.find('add-rules').disabled, true);
  const nextAction = app.stats.messages.filter(message => message.type === 'PS_DIAG_ADD_RULES')[1];
  await app.tick(80);
  assert.equal(app.data.diagnosticUiState.pendingMutation.actionId, nextAction.actionId);
});

test('an authoritative pending-apply receipt settles the addition identity but not application success', async () => {
  const app = await harness({ hang: ['PS_DIAG_ADD_RULES'] }); await app.open(); await app.select('challenges.cloudflare.com'); await app.click('add-rules'); await app.tick(15000);
  const sent = app.stats.messages.find(message => message.type === 'PS_DIAG_ADD_RULES');
  const submitted = app.state(); submitted.ruleUndo = ruleReceipt({ actionId: sent.actionId, pendingApply: true }); await app.setState(submitted);
  assert.match(app.root.querySelector('.ps-diag-message').textContent, /规则已保存.*尚未确认代理更新/);
  assert.equal(app.find('add-rules').disabled, true); assert.equal(app.find('retry-rules').disabled, false);
  await app.late('PS_DIAG_ADD_RULES', { success: false, error: 'proxy_failed', state: submitted });
  assert.doesNotMatch(app.root.querySelector('.ps-diag-message').textContent, /已添加规则/);
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_ADD_RULES').length, 1);
});

test('a stale or unrelated stored pending identity cannot lock or replay this page', async () => {
  for (const pending of [{ type: 'PS_DIAG_ADD_RULES', sessionId: 'other', actionId: 'action-a' }, { type: 'PS_DIAG_SAVE', sessionId: 'session-a', trialId: 't' }]) {
    const app = await harness({ storage: { diagnosticUiState: { sessionId: 'session-a', direction: 'proxy', filter: 'all', selected: ['challenges.cloudflare.com'], pendingMutation: pending, expiresAt: START + 10000 } } }); await app.open();
    assert.equal(app.find('add-rules').disabled, false); assert.ok(app.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
  }
});

test('addition failures remain visible without confirmation dialogs or automatic retries', async () => {
  for (const [error, expected] of [['storage_failed', /本地存储/], ['rule_undo_conflict', /未执行撤销/], ['invalid_rules', /无法安全更新/]]) {
    const app = await harness({ failMutation: error }); await app.open(); await app.select('challenges.cloudflare.com'); await app.click('add-rules'); await app.tick(2000);
    assert.match(app.root.querySelector('.ps-diag-message').textContent, expected);
    assert.equal(app.find('add-rules').disabled, false);
    assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_ADD_RULES').length, 1);
    assert.equal(app.stats.confirms.length, 0);
  }
});

test('new primary actions and receipt controls are complete in every supported language', async () => {
  for (const language of ['zh_CN', 'en', 'es', 'ru']) {
    const state = defaultState(); state.ruleUndo = ruleReceipt({ pendingApply: true });
    const app = await harness({ state, language }); await app.open();
    for (const action of ['add-rules', 'review', 'undo-rules', 'retry-rules']) assert.ok(app.find(action));
    assert.doesNotMatch(app.root.textContent, /diag[A-Z]|\{count\}|\{host\}/);
    assert.equal(app.find('undo-rules').dataset.focus, 'undo-rules');
    assert.equal(app.find('retry-rules').dataset.focus, 'retry-rules');
  }
});

test('automatic recording starts with explicit opt-in and does not equate existing permission with consent', async () => {
  const state = automaticState({ session: null, rows: [], autoCapture: { enabled: false, permission: true, storage: 'session' } });
  const app = await harness({ state, language: 'en' }); await app.open();
  assert.match(app.root.textContent, /HTTP requests and WebSocket handshakes across normal tabs/);
  assert.match(app.root.textContent, /Full URLs, bodies, cookies and connection messages are not stored or uploaded/);
  assert.match(app.root.textContent, /Incognito tabs are excluded/);
  assert.ok(app.find('auto-enable')); assert.equal(app.find('capture'), undefined);
  assert.equal(app.find('auto-enable').dataset.focus, 'auto-enable');
  assert.ok(app.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
  assert.equal(app.stats.permissions.length, 0);
  await app.click('auto-enable');
  assert.deepEqual(app.stats.messages.find(message => message.type === 'PS_DIAG_AUTO_ENABLE'), { type: 'PS_DIAG_AUTO_ENABLE', consent: true, tabId: 8 });
  assert.equal(app.stats.permissions.length, 0);
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_START').length, 0);
  assert.match(app.root.textContent, /Recording automatically · 0 domains/);
  assert.equal(app.find('auto-enable'), undefined); assert.ok(app.find('auto-disable'));
});

test('automatic opt-in directly requests only optional observation permission and decline keeps it off', async () => {
  const state = automaticState({ session: null, rows: [], permission: false, autoCapture: { enabled: false, permission: false, storage: 'session' } });
  const app = await harness({ state, permission: false, language: 'en' }); await app.open();
  assert.equal(app.stats.permissions.length, 0);
  await app.click('auto-enable');
  assert.deepEqual(clone(app.stats.permissions), [{ permissions: ['webRequest'] }]);
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_AUTO_ENABLE').length, 0);
  assert.match(app.root.textContent, /Automatic recording is still off/);
  app.setPermission(true); await app.click('auto-enable');
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_AUTO_ENABLE').length, 1);
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_START').length, 0);
});

test('enabled automatic recording reopens without permission prompts, re-enabling, or forced reloads', async () => {
  const state = automaticState();
  for (const fullPage of [false, true]) {
    const app = await harness({ state, fullPage, language: 'en' }); if (!fullPage) await app.open();
    assert.match(app.root.textContent, /Recording automatically · 4 domains/);
    assert.match(app.entry.textContent, /1 domains with errors/);
    assert.equal(app.stats.permissions.length, 0);
    assert.ok(app.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
    assert.equal(app.find('stop'), undefined); assert.equal(app.find('capture'), undefined);
    assert.equal(app.find('auto-enable'), undefined);
    if (!fullPage) { await app.click('back'); await app.open(); }
    assert.equal(app.stats.permissions.length, 0);
    assert.ok(app.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
  }
});

test('empty enabled recording explains earlier requests and reload remains one explicit optional action', async () => {
  const state = automaticState({ session: null, rows: [], autoCapture: { enabled: true, permission: true, storage: 'memory' } });
  const app = await harness({ state, language: 'en' }); await app.open();
  assert.match(app.root.textContent, /No requests observed yet/);
  assert.match(app.root.textContent, /Earlier requests cannot be recovered/);
  assert.equal(app.root.querySelectorAll('.ps-diag-memory-note').length, 1);
  assert.equal(app.find('capture').textContent, 'Reload page');
  assert.equal(app.find('stop'), undefined);
  assert.ok(app.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
  await app.click('capture');
  assert.deepEqual(app.stats.messages.find(message => message.type === 'PS_DIAG_START'), { type: 'PS_DIAG_START', tabId: 8 });
  assert.equal(app.stats.permissions.length, 0);
  assert.equal(app.find('stop'), undefined);
});

test('automatic All view prioritizes confirmed failures and keeps unknown and aborted observations out of error filters', async () => {
  const state = automaticState();
  state.rows.push(
    { host: 'unknown.example.net', route: 'direct', types: ['websocket'], count: 1, pending: 0, completed: 0, failed: 0, unconfirmed: 1 },
    { host: 'aborted.example.net', route: 'direct', types: ['script'], count: 1, pending: 0, completed: 0, failed: 1, unconfirmed: 1, error: 'net::ERR_ABORTED' },
    { host: 'http.example.net', route: 'direct', types: ['xmlhttprequest'], count: 1, pending: 0, completed: 1, failed: 0, httpErrors: 1, lastStatus: 403 },
  );
  const app = await harness({ state, language: 'en' }); await app.open();
  assert.equal(app.root.querySelectorAll('input').length, 7);
  assert.equal(app.root.querySelectorAll('input')[0].dataset.host, 'api.example.net');
  assert.equal(app.root.querySelectorAll('input')[1].dataset.host, 'http.example.net');
  assert.equal(app.root.querySelectorAll('button').find(node => node.dataset.filter === 'all').getAttribute('aria-pressed'), 'true');
  const unknown = app.root.querySelectorAll('.ps-diag-domain').find(node => /unknown\.example/.test(node.textContent));
  assert.match(unknown.textContent, /WebSocket.*1 unconfirmed/);
  assert.equal(unknown.querySelector('.ps-diag-problem'), null);
  await app.filter('failed');
  assert.equal(app.root.querySelectorAll('input').length, 1); assert.match(app.root.textContent, /api.example.net/);
  assert.doesNotMatch(app.root.textContent, /unknown\.example|aborted\.example|http\.example/);
  await app.filter('http'); assert.equal(app.root.querySelectorAll('input').length, 1); assert.match(app.root.textContent, /http.example.net/);
  await app.filter('different'); assert.equal(app.root.querySelectorAll('input').length, 6);
  assert.ok(app.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
});

test('automatic clear empties this tab without reload and leaves recording and undo intact', async () => {
  const state = automaticState(); state.ruleUndo = ruleReceipt({ context: 'auto' });
  const app = await harness({ state, language: 'en' }); await app.open();
  assert.equal(app.find('clear').disabled, false);
  await app.click('clear');
  assert.deepEqual(app.stats.messages.find(message => message.type === 'PS_DIAG_CLEAR'), { type: 'PS_DIAG_CLEAR', sessionId: 'session-a', tabId: 8 });
  assert.equal(app.state().autoCapture.enabled, true); assert.equal(app.state().session.id, 'session-a');
  assert.equal(app.state().trial, null); assert.equal(app.state().ruleUndo.id, 'undo-a');
  assert.equal(app.state().rows.length, 0);
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_START').length, 0);
  assert.equal(app.find('undo-rules').disabled, false);
});

test('disable clears only automatic records and retains a safe matching addition undo without a session', async () => {
  const state = automaticState(); state.ruleUndo = ruleReceipt({ context: 'auto' });
  const app = await harness({ state, language: 'en' }); await app.open(); await app.click('auto-disable');
  assert.deepEqual(app.stats.messages.find(message => message.type === 'PS_DIAG_AUTO_DISABLE'), { type: 'PS_DIAG_AUTO_DISABLE', tabId: 8 });
  assert.equal(app.state().autoCapture.enabled, false); assert.equal(app.state().rows.length, 0);
  assert.equal(app.state().ruleUndo.id, 'undo-a'); assert.ok(app.find('undo-rules'));
  assert.doesNotMatch(app.root.textContent, /challenges\.cloudflare|api\.example\.net/);
  await app.click('undo-rules');
  assert.equal(app.state().ruleUndo.undone, true);
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_START').length, 0);
  for (const receipt of [ruleReceipt(), ruleReceipt({ context: 'auto', tabId: 77 }), ruleReceipt({ context: 'auto', expiresAt: START - 1 })]) {
    const other = await harness({ state: automaticState({ session: null, rows: [], autoCapture: { enabled: false, permission: true, storage: 'session' }, ruleUndo: receipt }) }); await other.open();
    assert.equal(other.find('undo-rules'), undefined);
  }
  const differentSession = await harness({ state: automaticState({ ruleUndo: ruleReceipt({ context: 'auto', sessionId: 'previous-page' }) }) }); await differentSession.open();
  assert.equal(differentSession.find('undo-rules'), undefined);
});

test('permission revocation removes automatic rows and presents opt-in without prompting or adding rules', async () => {
  const app = await harness({ state: automaticState(), language: 'en' }); await app.open();
  await app.setState(automaticState({ session: null, rows: [], permission: false, autoCapture: { enabled: false, permission: false, storage: 'session' } }));
  assert.match(app.root.textContent, /Capture permission was removed/);
  assert.ok(app.find('auto-enable')); assert.equal(app.find('add-rules'), undefined);
  assert.equal(app.stats.permissions.length, 0);
  assert.ok(app.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
});

test('foreground navigation immediately hides the old epoch and a fresh GET displays only the new page', async () => {
  for (const fullPage of [false, true]) {
    const app = await harness({ state: automaticState(), fullPage, language: 'en' }); if (!fullPage) await app.open();
    await app.navigateTab('https://next.example.org/article');
    assert.match(app.root.textContent, /next.example.org/);
    assert.doesNotMatch(app.root.textContent, /challenges\.cloudflare|api\.example\.net|reader\.example\.com/);
    const next = automaticState(); next.session.id = 'new-epoch'; next.session.hostname = 'next.example.org'; next.rows = [{ host: 'new.cdn.example.org', route: 'direct', types: ['script'], count: 1, completed: 1, failed: 0, pending: 0 }];
    await app.setState(next);
    assert.match(app.root.textContent, /new.cdn.example.org/);
    assert.doesNotMatch(app.root.textContent, /challenges\.cloudflare|api\.example\.net/);
    assert.ok(app.stats.messages.every(message => message.tabId === 8));
  }
});

test('same-host navigation also invalidates old rows, while live per-row stale markers allow newer observations', async () => {
  const app = await harness({ state: automaticState(), language: 'en' }); await app.open();
  await app.navigateTab('https://reader.example.com/another-document');
  assert.equal(app.root.querySelectorAll('input').length, 0);
  const next = automaticState(); next.session.id = 'same-host-epoch'; next.session.rulesChanged = true;
  next.rows[2].stale = true;
  await app.setState(next);
  assert.match(app.root.textContent, /Older records · capture again/);
  assert.doesNotMatch(app.root.textContent, /These requests were recorded before the change/);
  const stale = app.root.querySelectorAll('.ps-diag-domain').find(node => /api\.example/.test(node.textContent));
  assert.equal(stale.querySelector('.ps-diag-problem'), null);
  assert.notEqual(app.root.querySelectorAll('input')[0].dataset.host, 'api.example.net');
  assert.ok(app.find('auto-disable')); assert.equal(app.find('capture'), undefined);
});

test('automatic operation recovery uses enabled state in memory and never persists or replays consent', async () => {
  const state = automaticState({ autoCapture: { enabled: false, permission: true, storage: 'session' } });
  const app = await harness({ state, hang: ['PS_DIAG_AUTO_ENABLE'], language: 'en' }); await app.open(); await app.click('auto-enable');
  await app.click('auto-enable'); await app.tick(80);
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_AUTO_ENABLE').length, 1);
  assert.equal(app.sessionData.diagnosticAutoUiState.pendingMutation, undefined);
  await app.setState(automaticState());
  assert.ok(app.find('auto-disable')); assert.equal(app.find('auto-disable').disabled, false);
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_AUTO_ENABLE').length, 1);
  const reopened = await harness({ state: automaticState(), storage: app.data, sessionStorage: app.sessionData, language: 'en' }); await reopened.open();
  assert.ok(reopened.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
  assert.equal(reopened.stats.permissions.length, 0);
});

test('a stopped automatic observer is not a confirmed disable while the durable off write is recovering', async () => {
  const app = await harness({ state: automaticState(), hang: ['PS_DIAG_AUTO_DISABLE'], language: 'en' });
  await app.open(); await app.click('auto-disable');
  await app.setState(automaticState({ session: null, rows: [],
    autoCapture: { enabled: false, permission: true, storage: 'session', recovering: true } }));
  assert.equal(app.find('auto-enable').disabled, true);
  assert.match(app.root.textContent, /temporarily unavailable/);
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_AUTO_DISABLE').length, 1);
  await app.setState(automaticState({ session: null, rows: [],
    autoCapture: { enabled: false, permission: true, storage: 'session' } }));
  assert.equal(app.find('auto-enable').disabled, false);
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_AUTO_DISABLE').length, 1);
});

test('active automatic sessions retain UI choices beyond their creation time using recent activity', async () => {
  const state = automaticState(); state.session.startedAt = START - 31 * 60000;
  const app = await harness({ state }); await app.open(); await app.filter('different'); await app.select('challenges.cloudflare.com'); await app.tick(80);
  assert.ok(app.sessionData.diagnosticAutoUiState.expiresAt > START);
  assert.deepEqual(app.sessionData.diagnosticAutoUiState.selected, ['challenges.cloudflare.com']);
});

test('automatic opt-in and active controls are localized in all four languages and restricted tabs cannot enable', async () => {
  for (const language of ['zh_CN', 'en', 'es', 'ru']) {
    const off = await harness({ state: automaticState({ session: null, rows: [], autoCapture: { enabled: false, permission: false, storage: 'session' } }), language }); await off.open();
    assert.ok(off.find('auto-enable')); assert.doesNotMatch(off.root.textContent, /diag[A-Z]|\{\w+\}/);
    const on = await harness({ state: automaticState(), language }); await on.open();
    assert.ok(on.find('auto-disable')); assert.doesNotMatch(on.root.textContent, /diag[A-Z]|\{\w+\}/);
  }
  const incognito = await harness({ state: automaticState({ session: null, rows: [], autoCapture: { enabled: false, permission: false, storage: 'session' } }), tab: { incognito: true } }); await incognito.open();
  assert.equal(incognito.find('auto-enable').disabled, true); assert.equal(incognito.stats.permissions.length, 0);
});

test('explicit manual sessions remain usable while automatic recording is off without implying consent', async () => {
  const state = defaultState(); state.autoCapture = { enabled: false, permission: true, storage: 'session' };
  const app = await harness({ state, language: 'en' }); await app.open();
  assert.ok(app.find('auto-enable')); assert.ok(app.find('capture'));
  assert.equal(app.root.querySelectorAll('input').length, 3);
  assert.equal(app.root.querySelectorAll('button').find(node => node.dataset.filter === 'different').getAttribute('aria-pressed'), 'true');
  await app.select('challenges.cloudflare.com');
  assert.equal(app.find('add-rules').disabled, false);
  assert.equal(app.state().autoCapture.enabled, false); assert.equal(app.stats.permissions.length, 0);
  assert.ok(app.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
});

test('automatic preference read faults show a warning and require explicit fresh consent to recover', async () => {
  const state = automaticState({ session: null, rows: [], autoCapture: { enabled: false, permission: true, storage: 'session', error: 'storage_failed', recovering: true } });
  const app = await harness({ state, language: 'en' }); await app.open();
  assert.match(app.root.querySelector('.ps-diag-warning').textContent, /Background records are temporarily unavailable/);
  assert.equal(app.find('auto-enable').disabled, false);
  assert.doesNotMatch(app.root.textContent, /Recording automatically|No requests observed yet/);
  assert.ok(app.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
  assert.equal(app.stats.permissions.length, 0);
  await app.click('auto-enable');
  assert.deepEqual(app.stats.messages.find(message => message.type === 'PS_DIAG_AUTO_ENABLE'), { type: 'PS_DIAG_AUTO_ENABLE', consent: true, tabId: 8 });
  assert.equal(app.stats.permissions.length, 0);
  assert.match(app.root.textContent, /Recording automatically · 0 domains/);
  assert.equal(app.root.querySelector('.ps-diag-warning'), null);
});

test('automatic clear respects active trials and pending rules while disable still stops observation', async () => {
  for (const pendingRules of [false, true]) {
    const state = automaticState();
    if (pendingRules) state.ruleUndo = ruleReceipt({ context: 'auto', pendingApply: true });
    else state.trial = { id: 'trial-a', tabId: 8, sessionId: 'session-a', hosts: ['api.example.net'], direction: 'proxy', expiresAt: START + 600000 };
    const app = await harness({ state, language: 'en' }); await app.open();
    assert.equal(app.find('clear').disabled, true);
    await app.click('clear');
    assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_CLEAR').length, 0);
    assert.equal(app.find('auto-disable').disabled, false);
    await app.click('auto-disable');
    assert.equal(app.state().autoCapture.enabled, false);
    assert.deepEqual(app.state().trial, state.trial);
    assert.deepEqual(app.state().ruleUndo, state.ruleUndo);
    assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_AUTO_DISABLE').length, 1);
    assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_START').length, 0);
  }
});

test('automatic selected domains stay in session storage, including the final pagehide flush', async () => {
  const app = await harness({ state: automaticState(), language: 'en' }); await app.open();
  await app.filter('different'); await app.select('challenges.cloudflare.com'); await app.tick(80);
  assert.equal(app.data.diagnosticUiState, undefined);
  assert.equal(app.stats.writes.length, 0);
  assert.deepEqual(app.sessionData.diagnosticAutoUiState.selected, ['challenges.cloudflare.com']);
  await app.select('api.example.net'); app.pagehide();
  assert.equal(app.stats.writes.length, 0);
  assert.deepEqual(app.sessionData.diagnosticAutoUiState.selected, ['challenges.cloudflare.com', 'api.example.net']);
  const reopened = await harness({ state: automaticState(), storage: app.data, sessionStorage: app.sessionData, language: 'en' }); await reopened.open();
  assert.deepEqual(reopened.root.querySelectorAll('input').filter(node => node.checked).map(node => node.dataset.host), ['api.example.net', 'challenges.cloudflare.com']);
  assert.equal(reopened.stats.writes.length, 0);
});

test('automatic UI ignores local observed-domain metadata and validates the current session snapshot', async () => {
  const local = { sessionId: 'session-a', filter: 'http', direction: 'proxy', selected: ['challenges.cloudflare.com'], pendingMutation: { type: 'PS_DIAG_ADD_RULES', sessionId: 'session-a', actionId: 'old-local-action' }, expiresAt: START + 10000 };
  const valid = { sessionId: 'session-a', filter: 'all', direction: 'proxy', selected: ['api.example.net'], expiresAt: START + 10000 };
  const app = await harness({ state: automaticState(), storage: { diagnosticUiState: local }, sessionStorage: { diagnosticAutoUiState: valid } }); await app.open();
  assert.deepEqual(app.root.querySelectorAll('input').filter(node => node.checked).map(node => node.dataset.host), ['api.example.net']);
  assert.equal(app.find('add-rules').disabled, false);
  assert.ok(app.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
  assert.equal(app.stats.writes.length, 0);
  for (const snapshot of [{ ...valid, sessionId: 'older-epoch' }, { ...valid, expiresAt: START - 1 }]) {
    const stale = await harness({ state: automaticState(), storage: { diagnosticUiState: local }, sessionStorage: { diagnosticAutoUiState: snapshot } }); await stale.open();
    assert.equal(stale.root.querySelectorAll('input').filter(node => node.checked).length, 0);
    assert.equal(stale.root.querySelectorAll('input').length, 4);
    assert.doesNotMatch(stale.root.textContent, /后台仍未确认操作结果/);
  }
});

test('automatic pending rule identities recover from session storage without executable payloads or duplicate additions', async () => {
  const app = await harness({ state: automaticState(), hang: ['PS_DIAG_ADD_RULES'] }); await app.open();
  await app.select('challenges.cloudflare.com'); await app.click('add-rules'); await app.tick(15000);
  const sent = app.stats.messages.find(message => message.type === 'PS_DIAG_ADD_RULES');
  assert.deepEqual(app.sessionData.diagnosticAutoUiState.pendingMutation, { type: 'PS_DIAG_ADD_RULES', sessionId: 'session-a', actionId: sent.actionId });
  assert.equal(app.stats.writes.length, 0); assert.equal(app.data.diagnosticUiState, undefined);
  await app.click('add-rules');
  assert.equal(app.stats.messages.filter(message => message.type === 'PS_DIAG_ADD_RULES').length, 1);
  const reopened = await harness({ state: automaticState(), sessionStorage: app.sessionData }); await reopened.open();
  assert.equal(reopened.find('add-rules').disabled, false);
  assert.match(reopened.root.textContent, /尚未确认本次操作完成.*没有重复提交/);
  assert.ok(reopened.stats.messages.every(message => message.type === 'PS_DIAG_GET'));
  await reopened.tick(80);
  assert.equal(reopened.sessionData.diagnosticAutoUiState.pendingMutation, undefined);
  assert.equal(reopened.stats.writes.length, 0);
});

test('missing or failed session storage keeps automatic selections in memory and never falls back to local', async () => {
  for (const storageOptions of [{ sessionUnavailable: true }, { sessionFailed: true }]) {
    const state = automaticState({ autoCapture: { enabled: true, permission: true, storage: 'memory' } });
    const app = await harness({ state, ...storageOptions }); await app.open(); await app.select('challenges.cloudflare.com'); await app.tick(80);
    assert.equal(app.root.querySelectorAll('input').filter(node => node.checked).length, 1);
    await app.select('api.example.net'); app.pagehide();
    assert.equal(app.stats.writes.length, 0); assert.equal(app.stats.sessionWrites.length, 0);
    assert.equal(app.data.diagnosticUiState, undefined); assert.equal(app.sessionData.diagnosticAutoUiState, undefined);
    const reopened = await harness({ state, storage: app.data, ...storageOptions }); await reopened.open();
    assert.equal(reopened.root.querySelectorAll('input').filter(node => node.checked).length, 0);
    assert.equal(reopened.stats.writes.length, 0);
  }
});
