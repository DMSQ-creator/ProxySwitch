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
  const timers = new Map(); const pending = new Map(); const listeners = [];
  const stats = { messages: [], permissions: [], writes: [], tabs: [], confirms: [], closed: false };
  let state = clone(options.state === undefined ? defaultState() : options.state);
  const tab = { id: 8, windowId: 3, url: 'https://reader.example.com/', ...options.tab };
  const data = { appLanguage: options.language || 'zh_CN', ...options.storage };
  let permission = options.permission !== false;
  const chrome = {
    runtime: {
      lastError: null, getURL: value => 'chrome-extension://test/' + value,
      sendMessage(message, callback) {
        stats.messages.push(clone(message));
        if (options.hang && options.hang.includes(message.type)) { pending.set(message.type, callback); return; }
        let response;
        if (message.type === 'PS_DIAG_GET') response = { success: true, state: clone(state) };
        else if (options.failMutation) response = { success: false, error: options.failMutation, state: clone(state) };
        else {
          if (message.type === 'PS_DIAG_START') { state.session = { ...defaultState().session, id: 'session-new', tabId: message.tabId, captureUntil: now + 60000 }; state.rows = []; state.permission = true; }
          if (message.type === 'PS_DIAG_APPLY') { state.trial = { id: 'trial-a', sessionId: message.sessionId, tabId: state.session.tabId, hosts: message.hosts, direction: message.direction, expiresAt: now + 600000 }; state.rows = []; state.session.captureUntil = now + 60000; }
          if (['PS_DIAG_UNDO', 'PS_DIAG_SAVE'].includes(message.type)) state.trial = null;
          if (message.type === 'PS_DIAG_STOP') state.session.captureUntil = 0;
          if (message.type === 'PS_DIAG_CLEAR') { state.session = null; state.rows = []; }
          response = { success: true, state: clone(state) };
        }
        queueMicrotask(() => callback(response));
      },
    },
    i18n: { getUILanguage: () => 'en-US' },
    permissions: { request(value, callback) { stats.permissions.push(value); queueMicrotask(() => callback(permission)); } },
    tabs: {
      query(_query, callback) { if (!options.hangTabs) queueMicrotask(() => callback([clone(tab)])); },
      get(id, callback) { stats.tabs.push(['get', id]); queueMicrotask(() => callback(clone(tab))); },
      update(id, value, callback) { stats.tabs.push(['update', id, value]); queueMicrotask(() => callback(clone(tab))); },
      create(value, callback) { stats.tabs.push(['create', value]); queueMicrotask(callback); },
    },
    windows: { update(id, value, callback) { stats.tabs.push(['window', id, value]); queueMicrotask(callback); } },
    storage: {
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
    root, entry, document, stats, data, state: () => state,
    async open() { entry.click(); await flush(); },
    find,
    async click(action) { const node = find(action); assert.ok(node, `missing action ${action}`); node.click(); await flush(); },
    async select(host) { const node = root.querySelectorAll('input').find(input => input.dataset.host === host); assert.ok(node, `missing ${host}`); assert.equal(node.disabled, false); node.checked = !node.checked; node.emit('change'); await flush(); },
    async changeDirection(value) { const node = root.querySelector('select'); node.value = value; node.emit('change'); await flush(); },
    async filter(value) { root.querySelectorAll('button').find(node => node.dataset.filter === value).click(); await flush(); },
    async tick(duration) { const target = now + duration; while (true) { const candidate = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]; if (!candidate) break; timers.delete(candidate[0]); now = candidate[1].at; candidate[1].fn(); await flush(); } now = target; await flush(); },
    async setState(next) { state = clone(next); const retry = find('retry'); if (retry) retry.click(); else { document.hidden = false; document.listeners.visibilitychange(); await this.tick(1000); } await flush(); },
    async late(type, reply) { assert.ok(pending.has(type)); pending.get(type)(reply); await flush(); },
    async language(value) { data.appLanguage = value; listeners.forEach(fn => fn({ appLanguage: { newValue: value } }, 'local')); await flush(); },
    setPermission(value) { permission = value; },
    pagehide() { windowListeners.pagehide?.(); },
  };
}

test('always-visible entry and home are independent from an unresponsive worker', async () => {
  const app = await harness({ hang: ['PS_DIAG_GET'] });
  assert.equal(app.root.hidden, true);
  assert.match(app.entry.textContent, /当前页面请求/);
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

test('batch trial uses explicit exact host preview and saving requires verification', async () => {
  const app = await harness(); await app.open();
  await app.select('challenges.cloudflare.com'); await app.select('api.example.net'); await app.click('review');
  assert.match(app.root.textContent, /子域名/); assert.match(app.root.textContent, /10 分钟/);
  assert.equal(app.stats.messages.filter(item => item.type === 'PS_DIAG_APPLY').length, 0);
  await app.click('apply');
  const sent = app.stats.messages.find(item => item.type === 'PS_DIAG_APPLY');
  assert.deepEqual(sent.hosts, ['challenges.cloudflare.com', 'api.example.net']);
  assert.equal(sent.direction, 'proxy'); assert.equal(sent.sessionId, 'session-a');
  assert.match(app.root.textContent, /正在试用/);
  await app.click('save'); assert.equal(app.find('confirm-save').disabled, true);
  const verify = app.root.querySelector('input'); verify.checked = true; verify.emit('change');
  assert.equal(app.find('confirm-save').disabled, false);
  await app.click('confirm-save');
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
  await reopened.language('en'); assert.match(reopened.entry.textContent, /Current page requests/);
  assert.match(reopened.root.textContent, /Try selected domains/); assert.doesNotMatch(reopened.root.textContent, /diag[A-Z]/);
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
  assert.match(app.root.textContent, /<img src=x/); assert.equal(app.root.querySelectorAll('img').length, 0);
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
