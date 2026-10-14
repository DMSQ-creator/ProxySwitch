'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const POPUP_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'popup.js'), 'utf8');
const UTILS_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'utils.js'), 'utf8');
const ROUTING_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'routing.js'), 'utf8');
const UI_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
const DIAGNOSTICS_I18N_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'diagnostics-i18n.js'), 'utf8');
const POPUP_HTML = fs.readFileSync(path.join(ROOT, 'html', 'popup.html'), 'utf8');
const MESSAGES = Object.fromEntries(['en', 'zh_CN', 'es', 'ru'].map((locale) => [
  locale, JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', locale, 'messages.json'), 'utf8')),
]));
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = async () => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
};

// A small DOM implementation for this popup's real HTML; no browser or npm install required.
class TextNode {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = value;
    this.parentNode = null;
  }
  get textContent() { return this.nodeValue; }
  set textContent(value) { this.nodeValue = String(value); }
  get parentElement() { return this.parentNode; }
  get isConnected() { return !!this.parentNode?.isConnected; }
}

class Element {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.attrs = new Map();
    this.style = {};
    this.dataset = {};
    this.disabled = false;
    this.selected = false;
    this.hidden = false;
    this.classList = {
      add: (...names) => this.setAttribute('class', [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' ')),
      remove: (...names) => this.setAttribute('class', this.className.split(/\s+/).filter((name) => !names.includes(name)).join(' ')),
      contains: (name) => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !this.classList.contains(name) : force;
        this.classList[shouldAdd ? 'add' : 'remove'](name);
        return shouldAdd;
      },
    };
  }
  get id() { return this.getAttribute('id') || ''; }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get attributes() { return Array.from(this.attrs, ([name, value]) => ({ name, value })); }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(''); }
  set textContent(value) {
    this.replaceChildren();
    this.appendChild(new TextNode(String(value)));
  }
  get text() { return this.textContent; }
  get options() { return this.childNodes.filter((node) => node.tagName === 'OPTION'); }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') return (this.options.find((option) => option.selected) || this.options[0])?.value || '';
    return this.getAttribute('value') || (this.tagName === 'OPTION' ? this.textContent : '');
  }
  set value(value) { this._value = String(value); }
  get innerHTML() { return this.childNodes.length ? this.textContent : ''; }
  set innerHTML(value) {
    this.replaceChildren();
    if (value) parseFragment(String(value), this, this.ownerDocument);
  }
  get firstChild() { return this.childNodes[0] || null; }
  get parentElement() { return this.parentNode; }
  get isConnected() { return this === this.ownerDocument.documentElement || !!this.parentNode?.isConnected; }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    if (name === 'style') {
      for (const declaration of String(value).split(';')) {
        const [key, ...parts] = declaration.split(':');
        if (key?.trim()) this.style[key.trim()] = parts.join(':').trim();
      }
    }
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_all, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node, sibling) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(sibling), 0, node);
    return node;
  }
  removeChild(node) {
    this.childNodes.splice(this.childNodes.indexOf(node), 1);
    node.parentNode = null;
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    for (const node of nodes) this.appendChild(typeof node === 'string' ? new TextNode(node) : node);
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map((part) => part.trim());
    return descend(this).filter((element) => element.nodeType === 1 && selectors.some((part) => {
      if (part === '*') return true;
      if (part.startsWith('#')) return element.id === part.slice(1);
      if (part.startsWith('.')) return element.classList.contains(part.slice(1));
      const attr = part.match(/^\[([^\]=]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
      if (attr) return attr[2] === undefined ? element.hasAttribute(attr[1]) : element.getAttribute(attr[1]) === attr[2];
      return element.tagName === part.toUpperCase();
    }));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, callback) { this[`on${type}`] = callback; }
  contains(node) { return node === this || descend(this).includes(node); }
  focus() { if (!this.disabled) this.ownerDocument.activeElement = this; }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    this[`on${event.type}`]?.(event);
    if (event.bubbles) this.ownerDocument.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  click() { if (!this.disabled) return this.dispatchEvent({ type: 'click', target: this, bubbles: true }); }
}

function descend(root) {
  return root.childNodes.flatMap((node) => [node, ...node.childNodes ? descend(node) : []]);
}

function parseFragment(html, parent, document) {
  const stack = [parent];
  const tokens = html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) { stack.pop(); continue; }
    if (token.startsWith('<')) {
      const tag = token.match(/^<([\w-]+)/)?.[1];
      if (!tag) continue;
      const element = document.createElement(tag);
      for (const match of token.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) element.setAttribute(match[1], match[2] ?? match[3]);
      // HTML boolean attributes must have the same initial effect as in a real
      // DOM, including the disclosure panels' bare `hidden` attributes.
      const bareAttributes = token.replace(/([\w:-]+)\s*=\s*(?:"[^"]*"|'[^']*')/g, '');
      for (const name of ['hidden', 'disabled', 'selected']) {
        if (new RegExp(`\\s${name}(?=\\s|/?>)`).test(bareAttributes)) {
          element.setAttribute(name, '');
          if (name !== 'hidden') element[name] = true;
        }
      }
      stack.at(-1).appendChild(element);
      if (!['img', 'br', 'input', 'meta', 'link', 'hr'].includes(tag) && !token.endsWith('/>')) stack.push(element);
    } else stack.at(-1).appendChild(new TextNode(token));
  }
}

function createDocument() {
  const listeners = new Map();
  const document = {
    readyState: 'complete',
    activeElement: null,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    dispatchEvent(event) {
      if (!event.target) event.target = this.activeElement || this.body;
      for (const callback of listeners.get(event.type) || []) callback(event);
      return !event.defaultPrevented;
    },
    createElement(tag) { return new Element(tag, this); },
    createTextNode(value) { return new TextNode(String(value)); },
    createTreeWalker(root) {
      const nodes = descend(root).filter((node) => node.nodeType === 3);
      let index = 0;
      return { nextNode() { return nodes[index++] || null; } };
    },
    querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); },
    querySelector(selector) { return this.documentElement.querySelector(selector); },
    getElementById(id) { return this.querySelector(`#${id}`); },
  };
  document.documentElement = document.createElement('html');
  document.body = document.createElement('body');
  document.documentElement.appendChild(document.body);
  parseFragment(POPUP_HTML.match(/<body>([\s\S]*?)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, ''), document.body, document);
  return document;
}

function pickStorage(data, keys) {
  if (keys == null) return clone(data);
  if (typeof keys === 'string') return { [keys]: clone(data[keys]) };
  if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, clone(data[key])]));
  return { ...clone(keys), ...Object.fromEntries(Object.keys(keys).filter((key) => key in data).map((key) => [key, clone(data[key])])) };
}

async function createPopup(options = {}) {
  const document = createDocument();
  const data = clone({ appLanguage: 'auto', serverList: [], userWhitelist: [], userRules: [], tempRules: [], gfwDomains: [], ...options.storage });
  const storageListeners = [];
  const tabUpdateListeners = [];
  const mediaListeners = [];
  const windowListeners = {};
  const media = { matches: !!options.systemDark, addEventListener(_event, listener) { mediaListeners.push(listener); } };
  const pendingFetches = [];
  const pendingProxyReads = [];
  const pendingProxyWrites = [];
  const pendingStorageReads = [];
  const pendingStorageWrites = [];
  const timers = new Map();
  const stats = { get: [], set: [], messages: [], saves: [], proxySet: [], proxyGet: [], fetch: [], logs: [], tabs: [], tabQueries: 0 };
  let now = 0;
  let timerId = 0;
  let failGet = false;
  let failSet = false;
  let hangGet = false;
  let deferGet = false;
  let hangSet = false;
  let proxyMode = options.mode || 'pac_script';
  let proxyLevel = options.levelOfControl || 'controlled_by_this_extension';
  let failProxySet = false;
  let hangProxySet = false;
  let deferProxySet = false;
  let failProxyGet = false;
  let hangProxyGet = false;
  let nextSaveChange = null;
  const chrome = {
    runtime: {
      lastError: null,
      getURL: (relative) => `chrome-extension://test/${relative}`,
      sendMessage(message, callback) {
        if (message.type === 'SAVE_CONFIGURATION') {
          stats.saves.push(clone(message));
          if (nextSaveChange) { Object.assign(data, clone(nextSaveChange)); nextSaveChange = null; }
          if (options.saveReply) { queueMicrotask(() => callback(clone(options.saveReply))); return; }
          const stale = Object.keys(message.expected).some(key => {
            const baseline = message.expected[key];
            const exists = Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined;
            return !baseline || baseline.exists !== exists || exists && JSON.stringify(baseline.value) !== JSON.stringify(data[key]);
          });
          if (stale) { queueMicrotask(() => callback({ success: false, error: 'config_changed' })); return; }
          chrome.storage.local.set(message.items, () => {
            const error = chrome.runtime.lastError;
            chrome.runtime.lastError = null;
            callback(error ? { success: false, error: 'storage_failed' } : { success: true, items: clone(message.items) });
          });
          return;
        }
        stats.messages.push(clone(message));
        if (message.type === 'SET_PROXY_MODE') {
          if (options.modeReply) { queueMicrotask(() => callback(clone(options.modeReply))); return; }
          if (proxyLevel === 'not_controllable' || proxyLevel === 'controlled_by_other_extensions') {
            queueMicrotask(() => callback({ success: false, error: 'proxy_uncontrolled' })); return;
          }
          const server = data.serverList.find(server => server.id === data.activeServerId);
          if (['pac_script', 'fixed_servers'].includes(message.mode) && !server) {
            queueMicrotask(() => callback({ success: false, error: 'no_server' })); return;
          }
          chrome.proxy.settings.set({ value: { mode: message.mode }, scope: 'regular' }, () => {
            const error = chrome.runtime.lastError;
            // This callback models the worker's sanitized reply, not a popup
            // lastError from chrome.runtime.sendMessage itself.
            chrome.runtime.lastError = null;
            callback(error ? { success: false, error: 'proxy_failed' } : { success: true, mode: proxyMode, levelOfControl: proxyLevel });
          });
          return;
        }
        if (!options.hangRefresh) queueMicrotask(() => callback(options.refreshReply || { success: true }));
      },
      connect() { return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }; },
      openOptionsPage() {},
    },
    i18n: { getMessage: (key) => MESSAGES.en[key]?.message || '', getUILanguage: () => 'en-US' },
    tabs: {
      query(_query, callback) { stats.tabQueries++; queueMicrotask(() => callback([{ id: 1, url: 'https://docs.example.co.uk/article', status: 'complete', ...options.tab }])); },
      onUpdated: { addListener(listener) { tabUpdateListeners.push(listener); }, removeListener(listener) { const index = tabUpdateListeners.indexOf(listener); if (index >= 0) tabUpdateListeners.splice(index, 1); } },
      reload() {},
      create(config) { stats.tabs.push(clone(config)); },
    },
    proxy: { settings: {
      get(_query, callback) {
        stats.proxyGet.push(clone(_query));
        if (hangProxyGet) { hangProxyGet = false; return; }
        const failed = failProxyGet;
        failProxyGet = false;
        const snapshot = { value: { mode: proxyMode }, levelOfControl: proxyLevel };
        const respond = () => {
          chrome.runtime.lastError = failed ? { message: 'proxy read failed' } : null;
          callback(failed ? undefined : snapshot);
          chrome.runtime.lastError = null;
        };
        if (options.deferProxyGet) pendingProxyReads.push(respond);
        else queueMicrotask(respond);
      },
      set(setting, callback) {
        stats.proxySet.push(clone(setting));
        if (hangProxySet) { hangProxySet = false; return; }
        const failed = failProxySet;
        failProxySet = false;
        const respond = () => {
          if (!failed) proxyMode = options.readbackMode || setting.value.mode;
          chrome.runtime.lastError = failed ? { message: 'proxy write failed' } : null;
          callback();
          chrome.runtime.lastError = null;
        };
        if (deferProxySet) { deferProxySet = false; pendingProxyWrites.push(respond); }
        else queueMicrotask(respond);
      },
    } },
    storage: {
      onChanged: { addListener(listener) { storageListeners.push(listener); } },
      local: {
        get(keys, callback) {
          stats.get.push(clone(keys));
          if (hangGet) { hangGet = false; return; }
          const failed = failGet;
          failGet = false;
          const result = pickStorage(data, keys);
          if (!callback) return failed ? Promise.reject(new Error('storage read failed')) : Promise.resolve(result);
          const respond = () => {
            chrome.runtime.lastError = failed ? { message: 'storage read failed' } : null;
            callback(failed ? undefined : result);
            chrome.runtime.lastError = null;
          };
          if (deferGet) { deferGet = false; pendingStorageReads.push(respond); }
          else queueMicrotask(respond);
        },
        set(items, callback) {
          stats.set.push(clone(items));
          const failed = failSet;
          failSet = false;
          const respond = () => {
            if (!failed) {
              const changes = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { oldValue: clone(data[key]), newValue: clone(value) }]));
              Object.assign(data, clone(items));
              queueMicrotask(() => storageListeners.forEach((listener) => listener(changes, 'local')));
            }
            chrome.runtime.lastError = failed ? { message: 'storage write failed' } : null;
            if (callback) callback();
            chrome.runtime.lastError = null;
          };
          if (hangSet) { hangSet = false; pendingStorageWrites.push(respond); return; }
          if (!callback) { if (failed) return Promise.reject(new Error('storage write failed')); respond(); return Promise.resolve(); }
          queueMicrotask(respond);
        },
      },
    },
  };
  const sandbox = {
    chrome, document, URL, console, NodeFilter: { SHOW_TEXT: 4 },
    window: { addEventListener(event, listener) { windowListeners[event] = listener; } }, navigator: { language: 'en-US' },
    matchMedia: () => media,
    PSL: Object.fromEntries(['checkpoint', 'warn', 'error', 'perf', 'getContextId'].map((name) => [name, (...args) => { stats.logs.push([name, ...args]); return 'test-popup'; }])),
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { queueMicrotask(callback); },
    alert(message) { stats.logs.push(['alert', message]); },
    fetch(url) {
      const locale = url.match(/_locales\/([^/]+)\//)?.[1];
      stats.fetch.push(locale);
      const response = { ok: true, json: async () => clone(MESSAGES[locale]) };
      if (!options.deferFetch) return Promise.resolve(response);
      return new Promise((resolve, reject) => pendingFetches.push({ locale, resolve: () => resolve(response), reject }));
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(UTILS_SOURCE, context, { filename: 'utils.js' });
  vm.runInContext(ROUTING_SOURCE, context, { filename: 'routing.js' });
  vm.runInContext(DIAGNOSTICS_I18N_SOURCE, context, { filename: 'diagnostics-i18n.js' });
  vm.runInContext(UI_SOURCE, context, { filename: 'ui.js' });
  vm.runInContext(POPUP_SOURCE, context, { filename: 'popup.js' });
  await flush();
  return {
    document, data, stats, context,
    element: (id) => document.getElementById(id),
    async click(id) { const button = document.getElementById(id); assert.ok(button, `missing #${id}`); button.click(); await flush(); },
    async key(key, target = document.activeElement || document.body) {
      const event = { type: 'keydown', key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      document.dispatchEvent(event);
      await flush();
      return event;
    },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const entry = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!entry) break;
        now = entry[1].due;
        timers.delete(entry[0]);
        entry[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
    async change(items, area = 'local') {
      const changes = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { oldValue: clone(data[key]), newValue: clone(value) }]));
      if (area === 'local') Object.assign(data, clone(items));
      storageListeners.forEach((listener) => listener(changes, area));
      await flush();
    },
    async updateTab(tabId, changeInfo, tab = {}) { tabUpdateListeners.forEach(listener => listener(tabId, clone(changeInfo), clone(tab))); await flush(); },
    async systemTheme(dark) { media.matches = dark; mediaListeners.forEach(listener => listener({ matches: dark })); await flush(); },
    close() { windowListeners.pagehide?.(); },
    tabListenerCount: () => tabUpdateListeners.length,
    async resolveLanguage(locale) {
      const index = pendingFetches.findIndex((request) => request.locale === locale);
      assert.notEqual(index, -1, `no pending ${locale} language request`);
      pendingFetches.splice(index, 1)[0].resolve();
      await flush();
    },
    async rejectLanguage(locale) {
      const index = pendingFetches.findIndex((request) => request.locale === locale);
      assert.notEqual(index, -1, `no pending ${locale} language request`);
      pendingFetches.splice(index, 1)[0].reject(new Error('language pack unavailable'));
      await flush();
    },
    async resolveProxyMode(index = 0) {
      assert.ok(pendingProxyReads.length, 'no pending proxy-mode request');
      pendingProxyReads.splice(index, 1)[0]();
      await flush();
    },
    async resolveProxyWrite() {
      assert.ok(pendingProxyWrites.length, 'no pending proxy write');
      pendingProxyWrites.shift()();
      await flush();
    },
    async resolveStorageWrite() {
      assert.ok(pendingStorageWrites.length, 'no pending storage write');
      pendingStorageWrites.shift()();
      await flush();
    },
    async resolveStorageRead() {
      assert.ok(pendingStorageReads.length, 'no pending storage read');
      pendingStorageReads.shift()();
      await flush();
    },
    changeDuringNextSave(items) { nextSaveChange = items; },
    async chooseServer(id) {
      const select = document.getElementById('serverSelect');
      select.value = id;
      select.onchange();
      await flush();
    },
    failNextProxySet() { failProxySet = true; },
    hangNextProxySet() { hangProxySet = true; },
    deferNextProxySet() { deferProxySet = true; },
    failNextProxyGet() { failProxyGet = true; },
    hangNextProxyGet() { hangProxyGet = true; },
    setProxyControl(level) { proxyLevel = level; },
    failNextGet() { failGet = true; },
    failNextSet() { failSet = true; },
    hangNextGet() { hangGet = true; },
    deferNextGet() { deferGet = true; },
    hangNextSet() { hangSet = true; },
  };
}

function assertTranslation(popup, locale, statusKey = 'popStatusDirect') {
  assert.ok(popup.element('mode-pac').textContent.includes(MESSAGES[locale].popModeAuto.message));
  assert.equal(popup.element('mode-pac').getAttribute('title'), MESSAGES[locale].popTitleAuto.message);
  assert.equal(popup.element('serverSelect').options[0].textContent, MESSAGES[locale].popNoServer.message);
  assertRouting(popup, locale, statusKey);
  assert.doesNotMatch(popup.document.body.textContent, /__MSG_/);
}

function assertRouting(popup, locale, detailKey) {
  assert.equal(popup.element('routingDetailsText').textContent, MESSAGES[locale][detailKey].message);
  const shortKey = ['popStatusForceProxy', 'popStatusTemp', 'popStatusGfw'].includes(detailKey) ? 'popRouteExpectedProxy'
    : ['popStatusDirect', 'popStatusForceDirect'].includes(detailKey) ? 'popRouteExpectedDirect'
    : detailKey === 'statusNotLoaded' ? 'popRoutePending' : detailKey;
  const status = popup.element('routingStatus');
  assert.equal(status.textContent, MESSAGES[locale][shortKey].message);
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.getAttribute('aria-atomic'), 'true');
  assert.equal(popup.element('domainArea').getAttribute('aria-describedby'), status.id);
  if (status.classList.contains('sr-only')) {
    const descriptions = [popup.element('currentDomain').textContent, MESSAGES[locale][shortKey].message, MESSAGES[locale][detailKey].message];
    assert.equal(popup.element('currentDomain').getAttribute('title'), [...new Set(descriptions)].join('\n'));
    assert.equal(status.hidden, false, 'visual hiding must not remove the accessible rule description');
    assert.equal(status.getAttribute('aria-hidden'), null);
  } else {
    assert.equal(status.classList.contains('unavailable-state'), true);
    assert.equal(popup.element('currentDomain').getAttribute('title'), null, 'an unsupported page must not retain the previous hostname tooltip');
  }
}

function assertRouteVisual(popup, iconKey) {
  const heading = popup.element('domainHeading');
  assert.ok(heading, 'the route icon, hostname and info control share a single compact heading');
  assert.equal(popup.element('domainArea').getAttribute('data-icon-key'), iconKey);
  assert.equal(popup.document.querySelector('.route-status'), null, 'the duplicate visual rule badge is removed');
  assert.deepEqual(heading.childNodes.filter(node => node.nodeType === 1).map(node => node.id), ['statusIcon', 'currentDomain', 'routingDetailsBtn']);
  assert.equal(popup.element('statusIcon').getAttribute('aria-hidden'), 'true');
  assert.equal(popup.element('statusIcon').querySelectorAll('svg').length, 1);
  assert.notEqual(popup.element('routingStatus').textContent.trim(), '', 'accessible text and the info disclosure must describe the color');
  assert.equal(popup.element('routingStatus').parentElement, popup.element('domainArea'));
  if (popup.element('routingStatus').classList.contains('sr-only')) {
    assert.equal(isExposed(popup.element('routingStatus')), false);
    assert.equal(popup.element('routingStatus').getAttribute('aria-hidden'), null);
  }
}

// This checks actual DOM disclosure/style state, not simulated CSS layout.
// Real-browser integration checks remain responsible for visual geometry.
function isExposed(element) {
  assert.ok(element && element.nodeType === 1, 'visibility assertions require a real DOM element');
  for (let node = element; node?.nodeType === 1; node = node.parentElement) {
    if (node.hidden || node.style.display === 'none' || node.classList.contains('sr-only')) return false;
  }
  return true;
}

test('English Chrome respects Simplified Chinese for popup text, tooltips and dynamic labels', async () => {
  const popup = await createPopup({ storage: { appLanguage: 'zh_CN' } });
  assertTranslation(popup, 'zh_CN');
});

test('a late language pack retranslates already-rendered text, titles and dynamic state', async () => {
  const popup = await createPopup({ storage: { appLanguage: 'zh_CN', userRules: ['example.co.uk'] }, deferFetch: true });
  await popup.advance(3000);
  assertTranslation(popup, 'en', 'popStatusForceProxy');
  await popup.resolveLanguage('zh_CN');
  assertTranslation(popup, 'zh_CN', 'popStatusForceProxy');
});

test('changing language back to auto restores browser language without reopening the popup', async () => {
  const popup = await createPopup({ storage: { appLanguage: 'zh_CN' } });
  await popup.change({ appLanguage: 'auto' });
  await popup.advance(120);
  assertTranslation(popup, 'en');
});

test('a stale language response cannot overwrite a newer language selection', async () => {
  const popup = await createPopup({ storage: { appLanguage: 'zh_CN' }, deferFetch: true });
  await popup.advance(3000);
  await popup.change({ appLanguage: 'es' });
  await popup.advance(120);
  await popup.resolveLanguage('es');
  assertTranslation(popup, 'es');
  await popup.resolveLanguage('zh_CN');
  assertTranslation(popup, 'es');
});

test('switching to auto while a language pack is pending invalidates that response', async () => {
  const popup = await createPopup({ storage: { appLanguage: 'zh_CN' }, deferFetch: true });
  await popup.advance(3000);
  await popup.change({ appLanguage: 'auto' });
  await popup.advance(120);
  await popup.resolveLanguage('zh_CN');
  assertTranslation(popup, 'en');
});

test('failed language changes fall back consistently to the browser language', async () => {
  const popup = await createPopup({ storage: { appLanguage: 'zh_CN' }, deferFetch: true });
  await popup.resolveLanguage('zh_CN');
  assertTranslation(popup, 'zh_CN');
  await popup.change({ appLanguage: 'es' });
  await popup.advance(120);
  await popup.rejectLanguage('es');
  assertTranslation(popup, 'en');
});

test('late translations cover invalid-page state and whitelist operation feedback', async (t) => {
  await t.test('invalid page', async () => {
    const popup = await createPopup({ storage: { appLanguage: 'zh_CN' }, tab: { url: 'chrome://extensions/' }, deferFetch: true });
    await popup.resolveLanguage('zh_CN');
    assertTranslation(popup, 'zh_CN', 'popCannotSet');
    assert.equal(popup.element('currentDomain').textContent, MESSAGES.zh_CN.popInvalidPage.message);
  });
  await t.test('whitelist feedback', async () => {
    const popup = await createPopup({ storage: { appLanguage: 'zh_CN' }, deferFetch: true });
    await popup.advance(3000);
    await popup.click('addWhitelistBtn');
    await popup.resolveLanguage('zh_CN');
    assertTranslation(popup, 'zh_CN', 'popStatusForceDirect');
    assert.equal(popup.element('whitelistButtonLabel').textContent, MESSAGES.zh_CN.popBtnSiteDirectSaved.message);
    assert.equal(popup.element('whitelistMessage').textContent, MESSAGES.zh_CN.popWhitelistSaved.message);
    assert.equal(popup.element('whitelistHint').style.display, 'none');
    assert.equal(popup.element('routingScopeText').textContent, MESSAGES.zh_CN.popRuleScope.message.replace('%DOMAIN%', 'docs.example.co.uk'));
  });
});

test('ordinary configuration updates reuse the selected language pack', async () => {
  const popup = await createPopup({ storage: { appLanguage: 'zh_CN' } });
  await popup.change({ userRules: ['example.co.uk'] });
  await popup.advance(120);
  assertTranslation(popup, 'zh_CN', 'popStatusForceProxy');
  assert.deepEqual(popup.stats.fetch, ['zh_CN']);
});

test('a later configuration read failure preserves saved language, server and theme', async (t) => {
  for (const deferFetch of [false, true]) await t.test(deferFetch ? 'language pack still pending' : 'language pack already loaded', async () => {
    const popup = await createPopup({
      deferFetch,
      storage: {
        appLanguage: 'zh_CN',
        theme: 'dark',
        serverList: [{ id: 'saved-server', name: 'Saved proxy' }],
        activeServerId: 'saved-server',
      },
    });
    popup.failNextGet();
    await popup.change({ userRules: ['example.co.uk'] });
    await popup.advance(120);
    assert.equal(popup.document.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(popup.element('serverSelect').options.length, 1);
    assert.equal(popup.element('serverSelect').options[0].textContent, 'Saved proxy');
    assert.equal(popup.element('serverSelect').value, 'saved-server');
    assert.equal(popup.element('serverSelect').disabled, false);
    if (deferFetch) await popup.resolveLanguage('zh_CN');
    assert.ok(popup.element('mode-pac').textContent.includes(MESSAGES.zh_CN.popModeAuto.message));
    assert.equal(popup.element('mode-pac').getAttribute('title'), MESSAGES.zh_CN.popTitleAuto.message);
    assert.deepEqual(popup.stats.fetch, ['zh_CN']);
  });
});

test('diagnostic storage writes and non-local changes do not reload popup configuration', async () => {
  const popup = await createPopup({ storage: { appLanguage: 'zh_CN' } });
  const getCount = popup.stats.get.length;
  const fetchCount = popup.stats.fetch.length;
  await popup.change({ '__psl_log_v2__:test': { message: 'noise' }, __psl_log_generation_v2: 'new' });
  await popup.change({ appLanguage: 'auto' }, 'sync');
  await popup.advance(120);
  assert.equal(popup.stats.get.length, getCount);
  assert.equal(popup.stats.fetch.length, fetchCount);
  assertTranslation(popup, 'zh_CN');
});

test('whitelisting stores the current hostname, preserves existing rules and can be undone', async () => {
  const initial = { userRules: ['example.co.uk'], tempRules: ['other.test'], gfwDomains: ['example.co.uk'], userWhitelist: ['already.test'] };
  const popup = await createPopup({ storage: initial });
  assert.notEqual(popup.element('whitelistArea').style.display, 'none');
  assert.equal(popup.element('addWhitelistBtn').disabled, false);
  await popup.click('addWhitelistBtn');
  assert.deepEqual(popup.data.userWhitelist, ['already.test', 'docs.example.co.uk']);
  assert.deepEqual(popup.data.userRules, initial.userRules);
  assert.deepEqual(popup.data.tempRules, initial.tempRules);
  assert.deepEqual(popup.data.gfwDomains, initial.gfwDomains);
  assertRouting(popup, 'en', 'popStatusForceDirect');
  assert.notEqual(popup.element('removeWhitelistBtn').style.display, 'none');
  await popup.click('removeWhitelistBtn');
  assert.deepEqual(popup.data.userWhitelist, ['already.test']);
  assert.deepEqual(popup.data.userRules, initial.userRules);
  assert.deepEqual(popup.data.tempRules, initial.tempRules);
  assertRouting(popup, 'en', 'popStatusForceProxy');
});

test('whitelist action is available for temporary/GFW rules and loading pages', async (t) => {
  for (const options of [
    { storage: { tempRules: ['example.co.uk'] } },
    { storage: { gfwDomains: ['example.co.uk'] } },
    { tab: { status: 'loading' } },
    { tab: { status: 'loading', url: '', pendingUrl: 'https://docs.example.co.uk/loading' } },
  ]) await t.test(JSON.stringify(options), async () => {
    const popup = await createPopup(options);
    assert.notEqual(popup.element('whitelistArea').style.display, 'none');
    assert.equal(popup.element('addWhitelistBtn').disabled, false);
    await popup.click('addWhitelistBtn');
    assert.deepEqual(popup.data.userWhitelist, ['docs.example.co.uk']);
  });
});

test('whitelisting never broadens hostnames on shared domains or IP addresses', async (t) => {
  for (const hostname of ['tenant.github.io', '127.0.0.1', '[::1]', '例子.中国']) await t.test(hostname, async () => {
    const popup = await createPopup({ tab: { url: `https://${hostname}/` } });
    await popup.click('addWhitelistBtn');
    assert.deepEqual(popup.data.userWhitelist, [new URL(`https://${hostname}/`).hostname]);
  });
});

test('inherited direct rules are explained without permitting a broad undo', async () => {
  const popup = await createPopup({ storage: { userWhitelist: ['example.co.uk', 'other.test'] } });
  assert.equal(popup.element('addWhitelistBtn').disabled, true);
  assert.equal(popup.element('removeWhitelistBtn').style.display, 'none');
  assert.equal(popup.element('whitelistHint').textContent, MESSAGES.en.popParentDirectCompact.message.replace('%DOMAIN%', 'example.co.uk'));
  await popup.click('addWhitelistBtn');
  assert.deepEqual(popup.data.userWhitelist, ['example.co.uk', 'other.test']);
  assert.equal(popup.stats.set.length, 0);
});

test('undo only removes the exact current hostname, preserving parent direct rules', async () => {
  const popup = await createPopup({ storage: { userWhitelist: ['docs.example.co.uk', 'example.co.uk', 'other.test'] } });
  await popup.click('removeWhitelistBtn');
  assert.deepEqual(popup.data.userWhitelist, ['example.co.uk', 'other.test']);
  assertRouting(popup, 'en', 'popStatusForceDirect');
  assert.equal(popup.element('removeWhitelistBtn').style.display, 'none');
});

test('a www-only or child-host whitelist does not cover its parent hostname', async (t) => {
  for (const rule of ['www.example.co.uk', 'child.example.co.uk']) await t.test(rule, async () => {
    const popup = await createPopup({ tab: { url: 'https://example.co.uk/' }, storage: { userWhitelist: [rule] } });
    assert.equal(popup.element('addWhitelistBtn').disabled, false);
    await popup.click('addWhitelistBtn');
    assert.deepEqual(popup.data.userWhitelist, [rule, 'example.co.uk']);
  });
});

test('an existing Unicode hostname is recognized and can be undone exactly', async () => {
  const popup = await createPopup({ tab: { url: 'https://例子.中国/' }, storage: { userWhitelist: ['例子.中国', 'other.test'] } });
  assert.equal(popup.element('addWhitelistBtn').disabled, true);
  assert.notEqual(popup.element('removeWhitelistBtn').style.display, 'none');
  await popup.click('removeWhitelistBtn');
  assert.deepEqual(popup.data.userWhitelist, ['other.test']);
});

test('repeated clicks do not duplicate a whitelist entry or write twice', async () => {
  const popup = await createPopup();
  popup.element('addWhitelistBtn').click();
  popup.element('addWhitelistBtn').click();
  await flush();
  await popup.click('addWhitelistBtn');
  assert.deepEqual(popup.data.userWhitelist, ['docs.example.co.uk']);
  assert.equal(popup.stats.set.length, 1);
});

test('restricted pages cannot add a whitelist rule', async (t) => {
  for (const url of ['chrome://extensions/', 'chrome-extension://other/page.html', 'about:blank', 'file:///private.txt']) await t.test(url, async () => {
    const popup = await createPopup({ tab: { url } });
    assert.equal(popup.element('whitelistArea').style.display, 'none');
    await popup.click('addWhitelistBtn');
    assert.deepEqual(popup.data.userWhitelist, []);
    assert.equal(popup.stats.set.length, 0);
  });
});

test('whitelist storage failures display an error, restore the button and permit retry', async (t) => {
  for (const failure of ['failNextGet', 'failNextSet']) await t.test(failure, async () => {
    const popup = await createPopup();
    popup[failure]();
    await popup.click('addWhitelistBtn');
    assert.deepEqual(popup.data.userWhitelist, []);
    assert.equal(popup.element('addWhitelistBtn').disabled, false);
    assert.ok(popup.element('whitelistMessage').classList.contains('error'));
    assert.notEqual(popup.element('whitelistMessage').style.display, 'none');
    assert.equal(popup.stats.messages.length, 0, 'failed saves must not report or request successful application');
    await popup.click('addWhitelistBtn');
    assert.deepEqual(popup.data.userWhitelist, ['docs.example.co.uk']);
    assert.ok(!popup.element('whitelistMessage').classList.contains('error'));
  });
});

test('whitelist read timeouts recover; unconfirmed writes lock configuration until a late reply', async (t) => {
  for (const hang of ['hangNextGet', 'hangNextSet']) await t.test(hang, async () => {
    const popup = await createPopup();
    popup[hang]();
    await popup.click('addWhitelistBtn');
    assert.equal(popup.element('addWhitelistBtn').disabled, true);
    await popup.advance(hang === 'hangNextSet' ? 10000 : 3000);
    assert.deepEqual(popup.data.userWhitelist, []);
    for (const id of ['addWhitelistBtn', 'addRuleBtn', 'addTempRuleBtn', 'removeBtn']) assert.equal(popup.element(id).disabled, hang === 'hangNextSet');
    assert.equal(popup.element('mode-direct').disabled, false, 'recovery modes are not blocked by an unknown configuration write');
    assert.ok(popup.element('whitelistMessage').classList.contains('error'));
    if (hang === 'hangNextSet') {
      const count = popup.stats.saves.length;
      await popup.click('addWhitelistBtn');
      assert.equal(popup.stats.saves.length, count);
      await popup.resolveStorageWrite();
      assert.equal(popup.element('whitelistMessage').classList.contains('error'), false);
      assert.equal(popup.element('removeWhitelistBtn').disabled, false);
    }
    await popup.click('addWhitelistBtn');
    assert.deepEqual(popup.data.userWhitelist, ['docs.example.co.uk']);
  });
});

test('unconfirmed proxy refresh reports saved-but-pending without losing the whitelist', async (t) => {
  for (const options of [{ refreshReply: { error: 'worker unavailable' } }, { hangRefresh: true }]) await t.test(JSON.stringify(options), async () => {
    const popup = await createPopup(options);
    await popup.click('addWhitelistBtn');
    await popup.advance(2500);
    assert.deepEqual(popup.data.userWhitelist, ['docs.example.co.uk']);
    assert.equal(popup.element('whitelistMessage').textContent, MESSAGES.en.popWhitelistApplyPending.message);
    assert.equal(popup.element('removeWhitelistBtn').disabled, false);
  });
});

test('global and system modes save whitelist rules without changing the selected mode', async (t) => {
  for (const mode of ['fixed_servers', 'system']) await t.test(mode, async () => {
    const popup = await createPopup({ mode });
    await popup.click('addWhitelistBtn');
    assert.deepEqual(popup.data.userWhitelist, ['docs.example.co.uk']);
    assert.equal(popup.stats.proxySet.length, 0);
    assert.deepEqual(popup.stats.messages, [{ type: 'REFRESH_PROXY', applyIfPac: true }]);
    assert.ok(popup.element(mode === 'system' ? 'mode-system' : 'mode-fixed').classList.contains('active'));
    assert.match(popup.element('whitelistHint').textContent + popup.element('whitelistMessage').textContent, /auto/i);
  });
});

test('late proxy-mode reads replace Auto-only whitelist status with the actual routing mode', async (t) => {
  for (const [mode, messageKey] of [['system', 'popTitleSystem'], ['fixed_servers', 'popTitleGlobal'], ['direct', 'popTitleDirect']]) await t.test(mode, async () => {
    const popup = await createPopup({ mode, deferProxyGet: true, storage: { userWhitelist: ['docs.example.co.uk'] } });
    await popup.resolveProxyMode();
    assertRouting(popup, 'en', messageKey);
    assert.match(popup.element('whitelistHint').textContent, /auto/i);
  });
});

test('mode and settings entry use keyboard-accessible native buttons', async () => {
  const popup = await createPopup();
  for (const id of ['mode-pac', 'mode-fixed', 'mode-direct', 'mode-system', 'openSettings']) {
    assert.equal(popup.element(id).tagName, 'BUTTON');
    assert.equal(popup.element(id).getAttribute('type'), 'button');
  }
  assert.equal(popup.element('mode-pac').getAttribute('aria-pressed'), 'true');
  assert.equal(popup.element('mode-direct').getAttribute('aria-pressed'), 'false');
});

test('one-click permanent and temporary proxy rules keep shared-domain and IP scope exact', async (t) => {
  for (const [id, key] of [['addRuleBtn', 'userRules'], ['addTempRuleBtn', 'tempRules']]) {
    for (const host of ['tenant.github.io', 'tenant.blogspot.com', '127.0.0.1', '[::1]', '例子.中国']) {
      await t.test(`${key} ${host}`, async () => {
        const popup = await createPopup({ tab: { url: `https://${host}/` } });
        await popup.click(id);
        assert.deepEqual(popup.data[key], [new URL(`https://${host}/`).hostname]);
        assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popRuleSaved.message);
        assert.deepEqual(popup.stats.messages, [{ type: 'REFRESH_PROXY', applyIfPac: true }]);
      });
    }
  }
});

test('inherited proxy rules open management instead of deleting a shared parent', async (t) => {
  for (const storage of [{ userRules: ['example.co.uk'] }, { userRules: ['*.example.co.uk'] }, { tempRules: ['example.co.uk'] }]) {
    await t.test(JSON.stringify(storage), async () => {
      const popup = await createPopup({ storage });
      assert.equal(popup.element('removeBtn').textContent, MESSAGES.en.popBtnManageRule.message);
      assert.equal(popup.element('ruleScopeHint').textContent, MESSAGES.en.popInheritedProxyCompact.message + ' · ' + (storage.userRules?.[0] || storage.tempRules[0]));
      await popup.click('removeBtn');
      assert.equal(popup.stats.set.length, 0);
      assert.deepEqual(popup.stats.tabs, [{ url: 'chrome-extension://test/html/options.html#rules' }]);
    });
  }
});

test('removing current-host proxy rules preserves parent, sibling and direct rules', async () => {
  const popup = await createPopup({ storage: {
    userRules: ['docs.example.co.uk', '*.docs.example.co.uk', 'example.co.uk', '*.example.co.uk', 'sibling.example.co.uk'],
    tempRules: ['docs.example.co.uk', 'example.co.uk', 'other.test'], userWhitelist: ['unrelated.test'],
  } });
  await popup.click('removeBtn');
  assert.deepEqual(popup.data.userRules, ['example.co.uk', '*.example.co.uk', 'sibling.example.co.uk']);
  assert.deepEqual(popup.data.tempRules, ['example.co.uk', 'other.test']);
  assert.deepEqual(popup.data.userWhitelist, ['unrelated.test']);
  assert.equal(popup.element('removeBtn').textContent, MESSAGES.en.popBtnManageRule.message);
  assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popRuleRemoved.message);
});

test('legacy rule actions handle failed reads and writes without reporting saved state', async (t) => {
  for (const id of ['addRuleBtn', 'addTempRuleBtn', 'removeBtn']) {
    for (const failure of ['failNextGet', 'failNextSet']) await t.test(`${id} ${failure}`, async () => {
      const storage = id === 'removeBtn' ? { userRules: ['docs.example.co.uk'] } : {};
      const popup = await createPopup({ storage });
      popup[failure](); await popup.click(id);
      assert.deepEqual(popup.data.userRules, storage.userRules || []);
      assert.deepEqual(popup.data.tempRules, []);
      assert.equal(popup.stats.messages.length, 0);
      assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popErrOperation.message);
      assert.equal(popup.element(id).disabled, false);
      await popup.click(id);
      assert.equal(popup.element('operationMessage').classList.contains('error'), false);
    });
  }
});

test('legacy read timeouts unlock controls; unconfirmed writes prevent duplicate submissions', async (t) => {
  for (const hang of ['hangNextGet', 'hangNextSet']) await t.test(hang, async () => {
    const popup = await createPopup(); popup[hang](); await popup.click('addRuleBtn');
    assert.equal(popup.element('mode-direct').disabled, true);
    await popup.advance(hang === 'hangNextSet' ? 10000 : 3000);
    assert.deepEqual(popup.data.userRules, []);
    assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popErrOperation.message);
    assert.equal(popup.element('mode-direct').disabled, false);
    if (hang === 'hangNextSet') {
      assert.equal(popup.element('addRuleBtn').disabled, true);
      const count = popup.stats.saves.length; await popup.click('addRuleBtn');
      assert.equal(popup.stats.saves.length, count);
      await popup.resolveStorageWrite();
      assert.equal(popup.element('addRuleBtn').disabled, true); // Already saved, not still holding the lease.
      assert.equal(popup.element('addWhitelistBtn').disabled, false);
      assert.equal(vm.runInContext('pendingConfigurationSave', popup.context), null);
    }
    await popup.click('addRuleBtn');
    assert.deepEqual(popup.data.userRules, ['docs.example.co.uk']);
  });
});

test('unconfirmed proxy application retains saved proxy rules and reports pending, not success', async (t) => {
  for (const options of [{ refreshReply: { error: 'worker unavailable' } }, { hangRefresh: true }]) await t.test(JSON.stringify(options), async () => {
    const popup = await createPopup(options); await popup.click('addRuleBtn'); await popup.advance(2500);
    assert.deepEqual(popup.data.userRules, ['docs.example.co.uk']);
    assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popRuleApplyPending.message);
    assert.equal(popup.element('mode-direct').disabled, false);
  });
});

test('failed proxy mode writes retain actual mode and restore controls', async () => {
  const popup = await createPopup(); popup.failNextProxySet(); await popup.click('mode-direct');
  assert.equal(popup.element('mode-pac').classList.contains('active'), true);
  assert.equal(popup.element('mode-direct').classList.contains('active'), false);
  assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popErrProxyApply.message);
  assert.equal(popup.element('mode-direct').disabled, false);
  await popup.click('mode-direct');
  assert.equal(popup.element('mode-direct').classList.contains('active'), true);
  assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popModeApplied.message);
});

test('mode write timeouts and unavailable read-back report unconfirmed outcomes', async (t) => {
  await t.test('write timeout', async () => {
    const popup = await createPopup(); popup.hangNextProxySet(); await popup.click('mode-direct');
    await popup.advance(10000);
    assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popModeApplyPending.message);
    assert.equal(popup.element('mode-pac').classList.contains('active'), true);
    assert.equal(popup.element('mode-direct').disabled, false);
  });
  await t.test('failed read-back after accepted write', async () => {
    const popup = await createPopup(); popup.deferNextProxySet(); await popup.click('mode-direct');
    popup.failNextProxyGet(); await popup.resolveProxyWrite();
    assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popModeApplyPending.message);
    assert.equal(popup.element('mode-pac').classList.contains('active'), true);
  });
});

test('mode selection reads the browser result instead of highlighting the requested mode', async () => {
  const popup = await createPopup({ readbackMode: 'system' }); await popup.click('mode-direct');
  assert.equal(popup.element('mode-system').classList.contains('active'), true);
  assert.equal(popup.element('mode-direct').classList.contains('active'), false);
  assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popModeApplyPending.message);
});

test('continuous mode clicks are serialized and cannot queue competing settings writes', async () => {
  const popup = await createPopup(); popup.deferNextProxySet();
  await popup.click('mode-direct'); await popup.click('mode-system');
  assert.equal(popup.stats.proxySet.length, 1);
  assert.equal(popup.element('mode-pac').classList.contains('active'), true);
  await popup.resolveProxyWrite();
  assert.equal(popup.element('mode-direct').classList.contains('active'), true);
  await popup.click('mode-system');
  assert.equal(popup.stats.proxySet.length, 2);
  assert.equal(popup.element('mode-system').classList.contains('active'), true);
});

test('a late initial mode read cannot overwrite a newly confirmed selection', async () => {
  const popup = await createPopup({ deferProxyGet: true }); await popup.click('mode-direct');
  await popup.resolveProxyMode(1); // Read back the completed direct-mode write while initial read remains pending.
  assert.equal(popup.element('mode-direct').classList.contains('active'), true);
  await popup.resolveProxyMode();
  assert.equal(popup.element('mode-direct').classList.contains('active'), true);
});

test('another extension or browser policy is explained without attempting a proxy write', async (t) => {
  for (const levelOfControl of ['not_controllable', 'controlled_by_other_extensions']) await t.test(levelOfControl, async () => {
    const popup = await createPopup({ levelOfControl }); await popup.click('mode-direct');
    assert.equal(popup.stats.proxySet.length, 0);
    assert.equal(popup.element('proxyControlMessage').textContent, MESSAGES.en.popErrProxyControl.message);
    assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popErrProxyControl.message);
  });
});

test('server selection failures restore the previous selection and pending application keeps saved choice', async (t) => {
  const storage = { serverList: [{ id: 'a', name: 'First' }, { id: 'b', name: 'Second' }], activeServerId: 'a' };
  for (const failure of ['failNextGet', 'failNextSet']) await t.test(failure, async () => {
    const popup = await createPopup({ storage }); popup[failure](); await popup.chooseServer('b');
    assert.equal(popup.data.activeServerId, 'a');
    assert.equal(popup.element('serverSelect').value, 'a');
    assert.equal(popup.element('serverSelect').disabled, false);
    assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popErrOperation.message);
  });
  await t.test('application pending', async () => {
    const popup = await createPopup({ storage, refreshReply: { error: 'proxy failed' } }); await popup.chooseServer('b');
    assert.equal(popup.data.activeServerId, 'b');
    assert.equal(popup.element('serverSelect').value, 'b');
    assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popServerApplyPending.message);
  });
});

test('proxy action feedback and inherited-rule hints use the chosen locale', async (t) => {
  for (const locale of ['en', 'zh_CN', 'es', 'ru']) await t.test(locale, async () => {
    const popup = await createPopup({ storage: { appLanguage: locale, userRules: ['example.co.uk'] } });
    assert.equal(popup.element('ruleScopeHint').textContent, MESSAGES[locale].popInheritedProxyCompact.message + ' · example.co.uk');
    popup.failNextProxySet(); await popup.click('mode-direct');
    assert.equal(popup.element('operationMessage').textContent, MESSAGES[locale].popErrProxyApply.message);
    assert.doesNotMatch(popup.document.body.textContent, /__MSG_/);
  });
});

test('popup delegates all mode writes to the worker and never submits a cached PAC', async () => {
  const storage = { serverList: [{ id: 'a', name: 'Proxy', host: '127.0.0.1', port: 7890, scheme: 'HTTP' }], activeServerId: 'a', pacScriptData: 'stale cached PAC' };
  const popup = await createPopup({ mode: 'direct', storage });
  await popup.click('mode-pac');
  assert.deepEqual(popup.stats.messages, [{ type: 'SET_PROXY_MODE', mode: 'pac_script' }]);
  assert.doesNotMatch(POPUP_SOURCE, /chrome\.proxy\.settings\.set/);
  assert.equal(popup.element('mode-pac').getAttribute('aria-pressed'), 'true');
});

test('worker timeout and message failures show an unconfirmed mode rather than claiming rollback', async (t) => {
  for (const error of ['proxy_timeout', 'worker unavailable']) await t.test(error, async () => {
    const popup = await createPopup({ modeReply: { success: false, error } }); await popup.click('mode-direct');
    assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popModeApplyPending.message);
    assert.equal(popup.element('mode-pac').classList.contains('active'), true);
    assert.equal(popup.element('mode-direct').disabled, false);
  });
});

test('direct and system recovery do not read configuration before requesting a mode change', async (t) => {
  for (const mode of ['direct', 'system']) await t.test(mode, async () => {
    const popup = await createPopup(); const count = popup.stats.get.length;
    await popup.click('mode-' + mode);
    assert.equal(popup.stats.get.slice(count).some(keys => keys.includes('pacScriptData') || keys.includes('serverList')), false);
    assert.deepEqual(popup.stats.messages, [{ type: 'SET_PROXY_MODE', mode }]);
    assert.equal(popup.element('mode-' + mode).getAttribute('aria-pressed'), 'true');
  });
});

test('runtime proxy errors appear only for the actual proxy mode and never display error details', async () => {
  const status = { mode: 'pac_script', levelOfControl: 'controlled_by_this_extension', error: { message: 'net::ERR_PROXY_CONNECTION_FAILED https://private.test/?token=secret', fatal: true, at: 1 } };
  const popup = await createPopup({ storage: { proxyRuntimeStatus: status } });
  assert.equal(popup.element('proxyControlMessage').textContent, MESSAGES.en.popProxyRuntimeError.message);
  assert.doesNotMatch(popup.document.body.textContent, /private\.test|token=secret|ERR_PROXY_CONNECTION_FAILED/);
  await popup.click('mode-direct');
  assert.equal(popup.element('proxyControlMessage').style.display, 'none');
});

test('all popup configuration writes use optimistic read baselines through the worker gate', async () => {
  const popup = await createPopup({ storage: { userRules: ['other.test'] } }); await popup.click('addRuleBtn');
  assert.doesNotMatch(POPUP_SOURCE, /chrome\.storage\.local\.set/);
  assert.deepEqual(popup.stats.saves, [{
    type: 'SAVE_CONFIGURATION', items: { userRules: ['other.test', 'docs.example.co.uk'] },
    expected: { userRules: { exists: true, value: ['other.test'] }, userWhitelist: { exists: true, value: [] } },
  }]);
});

test('mutating a returned storage list cannot mutate its deep read baseline', async () => {
  const popup = await createPopup({ storage: { userRules: ['before.test'] } });
  await vm.runInContext("popupStorageCall('get', ['userRules']).then(items => { items.userRules.push('after.test'); return popupStorageCall('set', { userRules: items.userRules }); })", popup.context);
  assert.deepEqual(popup.stats.saves[0].expected, { userRules: { exists: true, value: ['before.test'] } });
  assert.deepEqual(popup.data.userRules, ['before.test', 'after.test']);
});

test('server selection also guards the server-list generation, not just the selected id', async () => {
  const popup = await createPopup({ storage: { serverList: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], activeServerId: 'a' } });
  popup.changeDuringNextSave({ serverList: [{ id: 'a', name: 'A' }, { id: 'b', name: 'Changed' }] });
  await popup.chooseServer('b');
  assert.equal(popup.data.activeServerId, 'a');
  assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popErrConfigChanged.message);
  assert.equal(popup.stats.set.length, 0);
});

test('concurrent configuration edits never get overwritten by a stale whitelist, proxy list or server selection', async (t) => {
  const examples = [
    { id: 'addWhitelistBtn', storage: { userWhitelist: ['first.test'] }, change: { userWhitelist: ['newer.test'] }, field: 'userWhitelist', message: 'whitelistMessage' },
    { id: 'addRuleBtn', storage: { userRules: ['first.test'] }, change: { userRules: ['newer.test'] }, field: 'userRules', message: 'operationMessage' },
    { id: 'addTempRuleBtn', storage: { tempRules: ['first.test'] }, change: { tempRules: ['newer.test'] }, field: 'tempRules', message: 'operationMessage' },
    { server: 'b', storage: { serverList: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], activeServerId: 'a' }, change: { activeServerId: 'b' }, field: 'activeServerId', message: 'operationMessage' },
  ];
  for (const example of examples) await t.test(example.id || 'serverSelect', async () => {
    const popup = await createPopup({ storage: example.storage }); popup.changeDuringNextSave(example.change);
    if (example.server) await popup.chooseServer(example.server); else await popup.click(example.id);
    assert.deepEqual(popup.data[example.field], example.change[example.field]);
    assert.equal(popup.stats.set.length, 0);
    assert.equal(popup.stats.messages.length, 0);
    assert.equal(popup.element(example.message).textContent, MESSAGES.en.popErrConfigChanged.message);
  });
});

test('missing storage fields are guarded as absent, not silently assumed to exist', async () => {
  const popup = await createPopup({ storage: { userRules: undefined } }); await popup.click('addRuleBtn');
  assert.deepEqual(popup.stats.saves[0].expected, { userRules: { exists: false }, userWhitelist: { exists: true, value: [] } });
  assert.deepEqual(popup.data.userRules, ['docs.example.co.uk']);
});

test('normal rule badges share PAC precedence and local-address bypass', async (t) => {
  await t.test('manual rule wins over temporary rule', async () => {
    const popup = await createPopup({ storage: { userRules: ['example.co.uk'], tempRules: ['example.co.uk'] } });
    assertRouting(popup, 'en', 'popStatusForceProxy');
  });
  await t.test('local address stays direct despite a stored proxy rule', async () => {
    const popup = await createPopup({ tab: { url: 'http://127.0.0.1/' }, storage: { userRules: ['127.0.0.1'] } });
    assertRouting(popup, 'en', 'popStatusDirect');
    assert.equal(popup.element('ruleScopeHint').textContent, MESSAGES.en.popLocalDirectCompact.message);
    await popup.click('removeBtn'); assert.deepEqual(popup.data.userRules, []);
  });
  await t.test('existing internationalized manual rule matches its actual hostname', async () => {
    const popup = await createPopup({ tab: { url: 'https://例子.中国/' }, storage: { userRules: ['例子.中国'] } });
    assertRouting(popup, 'en', 'popStatusForceProxy');
    await popup.click('removeBtn'); assert.deepEqual(popup.data.userRules, []);
  });
});

test('compact popup preserves the original Logo and bundles its shared theme and SVG UI', async () => {
  const popup = await createPopup();
  assert.match(POPUP_HTML, /src="\.\.\/assets\/icon\.png"/);
  assert.match(POPUP_HTML, /href="\.\.\/assets\/theme\.css"/);
  assert.match(POPUP_HTML, /href="\.\.\/assets\/popup\.css"/);
  assert.match(POPUP_HTML, /src="\.\.\/js\/ui\.js"/);
  assert.doesNotMatch(POPUP_HTML, /[\u{1F300}-\u{1FAFF}]/u);
  assert.equal(popup.element('statusIcon').querySelectorAll('svg').length, 1);
  assert.equal(popup.element('addRuleBtn').getAttribute('type'), 'button');
  assert.equal(popup.element('addWhitelistBtn').getAttribute('type'), 'button');
  assert.equal(popup.element('manageRulesBtn').getAttribute('type'), 'button');
});

test('loading pages retain paired proxy/direct actions without reading or matching the full subscription list', async (t) => {
  for (const action of ['addRuleBtn', 'addWhitelistBtn', 'addTempRuleBtn']) await t.test(action, async () => {
    const popup = await createPopup({ tab: { status: 'loading' }, storage: { gfwDomains: ['docs.example.co.uk'] } });
    assert.equal(popup.element('addRuleBtn').disabled, false);
    assert.equal(popup.element('addWhitelistBtn').disabled, false);
    assert.notEqual(popup.element('actionArea').style.display, 'none');
    assert.notEqual(popup.element('addBtnGroup').style.display, 'none');
    assertRouting(popup, 'en', 'statusNotLoaded');
    assert.equal(popup.element('pageLoadingState').style.display, 'block');
    assert.equal(popup.stats.get.some(keys => keys.includes('gfwDomains') || keys.includes('pacScriptData')), false);
    await popup.click(action);
    assert.equal(popup.data[action === 'addWhitelistBtn' ? 'userWhitelist' : action === 'addTempRuleBtn' ? 'tempRules' : 'userRules'].includes('docs.example.co.uk'), true);
    assert.equal(popup.stats.get.some(keys => keys.includes('gfwDomains') || keys.includes('pacScriptData')), false);
  });
});

test('manual routing during loading follows shared PAC precedence and keeps inherited rule management available', async () => {
  const popup = await createPopup({ tab: { status: 'loading' }, storage: { userRules: ['example.co.uk'], tempRules: ['example.co.uk'] } });
  assertRouting(popup, 'en', 'popStatusForceProxy');
  assert.equal(popup.element('removeRuleLabel').textContent, MESSAGES.en.popBtnManageRule.message);
  assert.notEqual(popup.element('removeBtn').style.display, 'none');
  assert.equal(popup.element('addWhitelistBtn').disabled, false);
  await popup.click('removeBtn');
  assert.deepEqual(popup.stats.tabs, [{ url: 'chrome-extension://test/html/options.html#rules' }]);
  assert.equal(popup.stats.set.length, 0);
});

test('page completion updates the original tab without reopening and preserves operation feedback', async () => {
  const popup = await createPopup({ tab: { status: 'loading' } });
  await popup.click('addRuleBtn');
  const message = popup.element('operationMessage').textContent;
  await popup.updateTab(1, { status: 'complete' }, { id: 1, url: 'https://docs.example.co.uk/article', status: 'complete' });
  assertRouting(popup, 'en', 'popStatusForceProxy');
  assert.equal(popup.element('pageLoadingState').style.display, 'none');
  assert.equal(popup.element('operationMessage').textContent, message);
  assert.equal(popup.stats.tabQueries, 1);
});

test('tab updates ignore other tabs and mismatched payloads; navigation uses the pending target while loading', async () => {
  const popup = await createPopup();
  const reads = popup.stats.get.length;
  await popup.updateTab(99, { url: 'chrome-extension://test/html/options.html', status: 'complete' }, { id: 99 });
  await popup.updateTab(1, { url: 'https://wrong.test/' }, { id: 99 });
  assert.equal(popup.element('currentDomain').textContent, 'docs.example.co.uk');
  assert.equal(popup.stats.get.length, reads);
  await popup.updateTab(1, { status: 'loading' }, { id: 1, url: 'https://docs.example.co.uk/article', pendingUrl: 'https://new.example.test/loading', status: 'loading' });
  assert.equal(popup.element('currentDomain').textContent, 'new.example.test');
  const loadingReads = popup.stats.get.slice(reads);
  assert.equal(loadingReads.some(keys => keys.includes('gfwDomains')), false);
  await popup.updateTab(1, { url: 'https://new.example.test/done', status: 'complete' }, { id: 1, url: 'https://new.example.test/done', status: 'complete' });
  assert.equal(popup.element('currentDomain').textContent, 'new.example.test');
  assertRouting(popup, 'en', 'popStatusDirect');
  assert.equal(popup.stats.tabQueries, 1);
});

test('error feedback survives background refresh and page-status redraw, then clears only on another operation', async () => {
  const popup = await createPopup({ tab: { status: 'loading' } });
  popup.failNextSet(); await popup.click('addRuleBtn');
  const message = popup.element('operationMessage').textContent;
  await popup.change({ tempRules: ['other.test'] }); await popup.advance(120);
  await popup.updateTab(1, { status: 'complete' }, { id: 1, url: 'https://docs.example.co.uk/' });
  assert.equal(popup.element('operationMessage').textContent, message);
  assert.equal(popup.element('operationMessage').classList.contains('error'), true);
  await popup.click('mode-direct');
  assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popModeApplied.message);
  assert.equal(popup.element('operationMessage').classList.contains('error'), false);
});

test('site direct rules never silently delete underlying proxy rules and always offer the safe management path', async () => {
  const popup = await createPopup({ storage: { userRules: ['docs.example.co.uk'], userWhitelist: ['example.co.uk'] } });
  assert.equal(popup.element('addRuleBtn').disabled, true);
  assert.equal(popup.element('addWhitelistBtn').disabled, true);
  assert.equal(popup.element('removeWhitelistBtn').style.display, 'none');
  assert.notEqual(popup.element('manageRulesBtn').style.display, 'none');
  await popup.click('manageRulesBtn');
  assert.deepEqual(popup.data.userRules, ['docs.example.co.uk']);
  assert.deepEqual(popup.data.userWhitelist, ['example.co.uk']);
  assert.equal(popup.stats.set.length, 0);
  assert.deepEqual(popup.stats.tabs, [{ url: 'chrome-extension://test/html/options.html#rules' }]);
});

test('popup follows system theme live but keeps explicit theme choice', async () => {
  const popup = await createPopup({ storage: { theme: 'system' } });
  assert.equal(popup.document.documentElement.getAttribute('data-theme'), 'light');
  await popup.systemTheme(true);
  assert.equal(popup.document.documentElement.getAttribute('data-theme'), 'dark');
  await popup.change({ theme: 'light' }); await popup.advance(120);
  await popup.systemTheme(true);
  assert.equal(popup.document.documentElement.getAttribute('data-theme'), 'light');
});

test('popup removes its scoped tab listener when the page closes', async () => {
  const popup = await createPopup();
  assert.equal(popup.tabListenerCount(), 1);
  popup.close();
  assert.equal(popup.tabListenerCount(), 0);
});

test('selected server tooltip retains the full name and follows confirmed selection or failed save', async () => {
  const storage = { serverList: [{ id: 'a', name: 'A long server name that does not fit in the compact header' }, { id: 'b', name: 'Another full name' }], activeServerId: 'a' };
  const popup = await createPopup({ storage });
  assert.equal(popup.element('serverSelect').getAttribute('title'), storage.serverList[0].name);
  popup.failNextSet(); await popup.chooseServer('b');
  assert.equal(popup.element('serverSelect').getAttribute('title'), storage.serverList[0].name);
  await popup.chooseServer('b');
  assert.equal(popup.element('serverSelect').getAttribute('title'), storage.serverList[1].name);
});

test('an exact site direct rule switches to permanent proxy with one atomic guarded save', async () => {
  const popup = await createPopup({ storage: { userRules: ['other.test'], userWhitelist: ['docs.example.co.uk', 'unrelated.test'], tempRules: ['session.test'] } });
  assert.equal(popup.element('addRuleBtn').disabled, false);
  assert.equal(popup.element('addTempRuleBtn').disabled, true);
  await popup.click('addRuleBtn');
  assert.deepEqual(popup.data.userRules, ['other.test', 'docs.example.co.uk']);
  assert.deepEqual(popup.data.userWhitelist, ['unrelated.test']);
  assert.deepEqual(popup.data.tempRules, ['session.test']);
  assert.equal(popup.stats.saves.length, 1);
  assert.deepEqual(popup.stats.saves[0], {
    type: 'SAVE_CONFIGURATION', items: { userRules: ['other.test', 'docs.example.co.uk'], userWhitelist: ['unrelated.test'] },
    expected: { userRules: { exists: true, value: ['other.test'] }, userWhitelist: { exists: true, value: ['docs.example.co.uk', 'unrelated.test'] } },
  });
  assertRouting(popup, 'en', 'popStatusForceProxy');
  assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popRuleSaved.message);
});

test('direct-to-proxy preserves an existing underlying proxy rule without duplicating it', async () => {
  const popup = await createPopup({ storage: { userRules: ['docs.example.co.uk', 'other.test'], userWhitelist: ['docs.example.co.uk'] } });
  assert.equal(popup.element('addRuleBtn').disabled, false);
  await popup.click('addRuleBtn');
  assert.deepEqual(popup.data.userRules, ['docs.example.co.uk', 'other.test']);
  assert.deepEqual(popup.data.userWhitelist, []);
  assert.equal(popup.stats.saves.length, 1);
});

test('direct-to-proxy never removes a parent whitelist even when an exact entry also exists', async () => {
  const popup = await createPopup({ storage: { userWhitelist: ['docs.example.co.uk', 'example.co.uk'] } });
  assert.equal(popup.element('addRuleBtn').disabled, true);
  assert.equal(popup.element('manageRulesLabel').textContent, MESSAGES.en.popBtnManageDirectRule.message);
  assert.equal(popup.element('whitelistHint').textContent, MESSAGES.en.popParentDirectCompact.message.replace('%DOMAIN%', 'example.co.uk'));
  await popup.click('addRuleBtn');
  assert.equal(popup.stats.saves.length, 0);
  assert.deepEqual(popup.data.userWhitelist, ['docs.example.co.uk', 'example.co.uk']);
  await popup.click('manageRulesBtn');
  assert.deepEqual(popup.stats.tabs, [{ url: 'chrome-extension://test/html/options.html#rules' }]);
});

test('concurrent whitelist or proxy changes reject the entire exact direct-to-proxy switch', async (t) => {
  for (const change of [{ userWhitelist: ['docs.example.co.uk', 'newer.test'] }, { userRules: ['newer.test'] }]) await t.test(JSON.stringify(change), async () => {
    const popup = await createPopup({ storage: { userWhitelist: ['docs.example.co.uk'], userRules: ['first.test'] } });
    popup.changeDuringNextSave(change);
    await popup.click('addRuleBtn');
    assert.equal(popup.stats.set.length, 0);
    assert.deepEqual(popup.data.userWhitelist, change.userWhitelist || ['docs.example.co.uk']);
    assert.deepEqual(popup.data.userRules, change.userRules || ['first.test']);
    assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popErrConfigChanged.message);
  });
});

test('late exact direct-to-proxy confirmation retains its write lease and reports proxy saved', async () => {
  const popup = await createPopup({ storage: { userWhitelist: ['docs.example.co.uk'] } });
  popup.hangNextSet(); await popup.click('addRuleBtn'); await popup.advance(10000);
  assert.deepEqual(popup.data.userWhitelist, ['docs.example.co.uk']);
  assert.deepEqual(popup.data.userRules, []);
  assert.equal(popup.element('addRuleBtn').disabled, true);
  await popup.resolveStorageWrite();
  assert.deepEqual(popup.data.userWhitelist, []);
  assert.deepEqual(popup.data.userRules, ['docs.example.co.uk']);
  assert.equal(vm.runInContext('pendingConfigurationSave', popup.context), null);
  assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popRuleSaved.message);
  assert.equal(popup.element('whitelistMessage').style.display, 'none');
});

test('a new navigation never retains the old hostname disabled buttons while its small rules read is pending', async () => {
  const popup = await createPopup({ storage: { userRules: ['docs.example.co.uk'] } });
  assert.equal(popup.element('addRuleBtn').disabled, true);
  popup.hangNextGet();
  await popup.updateTab(1, { url: 'https://new.example.test/', status: 'loading' }, { id: 1 });
  assert.equal(popup.element('currentDomain').textContent, 'new.example.test');
  assert.equal(popup.element('addRuleBtn').disabled, false);
  assert.equal(popup.element('removeBtn').style.display, 'none');
  assert.equal(popup.element('pageLoadingState').style.display, 'block');
});

test('new user operations replace previous feedback but redraws do not remove current results', async () => {
  const popup = await createPopup();
  await popup.click('addWhitelistBtn');
  assert.equal(popup.element('whitelistMessage').style.display, 'block');
  await popup.click('addRuleBtn');
  assert.equal(popup.element('whitelistMessage').style.display, 'none');
  assert.equal(popup.element('operationMessage').style.display, 'block');
  await popup.updateTab(1, { status: 'loading' }, { id: 1 });
  assert.equal(popup.element('operationMessage').style.display, 'block');
});

test('proxy adds and removals guard comparison-only whitelist dependencies without rewriting them', async (t) => {
  for (const action of ['addRuleBtn', 'addTempRuleBtn', 'removeBtn']) await t.test(action, async () => {
    const userRules = action === 'removeBtn' ? ['docs.example.co.uk', 'other.test'] : ['other.test'];
    const popup = await createPopup({ storage: { userRules, userWhitelist: ['unrelated.test'] } });
    await popup.click(action);
    assert.equal(popup.stats.saves.length, 1);
    assert.deepEqual(popup.stats.saves[0].expected.userWhitelist, { exists: true, value: ['unrelated.test'] });
    assert.equal(Object.prototype.hasOwnProperty.call(popup.stats.saves[0].items, 'userWhitelist'), false);
    assert.equal(popup.stats.set.some(items => Object.prototype.hasOwnProperty.call(items, 'userWhitelist')), false);
    assert.deepEqual(popup.data.userWhitelist, ['unrelated.test']);
  });
});

test('a concurrent parent direct rule rejects the complete proxy add, temporary add or removal', async (t) => {
  for (const action of ['addRuleBtn', 'addTempRuleBtn', 'removeBtn']) await t.test(action, async () => {
    const userRules = action === 'removeBtn' ? ['docs.example.co.uk'] : [];
    const popup = await createPopup({ storage: { userRules, userWhitelist: [] } });
    popup.changeDuringNextSave({ userWhitelist: ['example.co.uk'] });
    await popup.click(action);
    assert.equal(popup.stats.set.length, 0);
    assert.deepEqual(popup.data.userRules, userRules);
    assert.deepEqual(popup.data.tempRules, []);
    assert.deepEqual(popup.data.userWhitelist, ['example.co.uk']);
    assert.deepEqual(popup.stats.saves[0].expected.userWhitelist, { exists: true, value: [] });
    assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popErrConfigChanged.message);
    assert.equal(popup.stats.messages.length, 0);
  });
});

test('an absent whitelist dependency is guarded as absent on permanent and temporary proxy adds', async (t) => {
  for (const action of ['addRuleBtn', 'addTempRuleBtn']) await t.test(action, async () => {
    const popup = await createPopup({ storage: { userWhitelist: undefined } });
    popup.changeDuringNextSave({ userWhitelist: ['example.co.uk'] });
    await popup.click(action);
    assert.equal(popup.stats.set.length, 0);
    assert.deepEqual(popup.stats.saves[0].expected.userWhitelist, { exists: false });
    assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popErrConfigChanged.message);
  });
});

test('fresh direct rules stop stale temporary or removal controls before submitting a write', async (t) => {
  for (const action of ['addTempRuleBtn', 'removeBtn']) await t.test(action, async () => {
    const userRules = action === 'removeBtn' ? ['docs.example.co.uk'] : [];
    const popup = await createPopup({ storage: { userRules } });
    popup.data.userWhitelist.push('docs.example.co.uk'); // Simulate another UI before its storage event arrives.
    await popup.click(action);
    assert.equal(popup.stats.saves.length, 0);
    assert.deepEqual(popup.data.userRules, userRules);
    assert.deepEqual(popup.data.tempRules, []);
    assert.deepEqual(popup.data.userWhitelist, ['docs.example.co.uk']);
    assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popErrConfigChanged.message);
  });
});

test('simple popup exposes only the main site actions and keeps detailed text behind real disclosures', async () => {
  const popup = await createPopup();
  for (const [button, panel] of [['routingDetailsBtn', 'routingDetails'], ['moreActionsBtn', 'moreActions']]) {
    assert.equal(popup.element(button).tagName, 'BUTTON');
    assert.equal(popup.element(button).getAttribute('type'), 'button');
    assert.equal(popup.element(button).getAttribute('aria-controls'), panel);
    assert.equal(popup.element(button).getAttribute('aria-expanded'), 'false');
    assert.equal(popup.element(panel).hidden, true);
  }
  for (const id of ['statusIcon', 'currentDomain', 'routingDetailsBtn', 'addRuleBtn', 'addWhitelistBtn', 'moreActionsBtn', 'diagnosticsEntry', 'openSettings']) {
    assert.equal(isExposed(popup.element(id)), true, `#${id} should be exposed`);
  }
  for (const id of ['routingStatus', 'routingDetailsText', 'routingScopeText', 'addTempRuleBtn', 'manageRulesBtn', 'exceptionManageRulesBtn', 'whitelistHint', 'ruleScopeHint']) {
    assert.equal(isExposed(popup.element(id)), false, `#${id} should not compete with the main actions`);
  }
  assert.equal(popup.element('currentDomain').textContent, 'docs.example.co.uk');
  assert.equal(popup.element('siteRulesLabel').textContent, MESSAGES.en.popSiteRulesLabel.message);
  assert.equal(popup.document.querySelector('.scope-caption').textContent, MESSAGES.en.popSiteScopeCompact.message);
  assert.equal(popup.element('diagnosticsEntry').parentElement, popup.element('openSettings').parentElement);
  assert.equal(popup.element('diagnosticsHomeTrial').hidden, false, 'a diagnostic trial must not be hidden by the simplified footer');
});

test('routing disclosure reveals complete localized source, disclaimer and exact host scope without a write', async (t) => {
  for (const locale of ['en', 'zh_CN', 'es', 'ru']) await t.test(locale, async () => {
    const popup = await createPopup({ storage: { appLanguage: locale, userRules: ['example.co.uk'] } });
    assertRouting(popup, locale, 'popStatusForceProxy');
    assert.equal(isExposed(popup.element('routingDetailsText')), false);
    await popup.click('routingDetailsBtn');
    assert.equal(popup.element('routingDetailsBtn').getAttribute('aria-expanded'), 'true');
    assert.equal(popup.element('routingDetails').hidden, false);
    assert.equal(isExposed(popup.element('routingDetailsText')), true);
    assert.equal(popup.document.querySelector('.route-disclaimer').textContent, MESSAGES[locale].popExpectedRoutingHint.message);
    assert.equal(popup.element('routingScopeText').textContent, MESSAGES[locale].popRuleScope.message.replace('%DOMAIN%', 'docs.example.co.uk'));
    assert.equal(popup.stats.saves.length, 0);
    assert.equal(popup.stats.messages.length, 0);
    await popup.click('routingDetailsBtn');
    assert.equal(popup.element('routingDetails').hidden, true);
    assert.equal(popup.element('routingDetailsBtn').getAttribute('aria-expanded'), 'false');
  });
});

test('advanced actions become reachable after expanding More and retain guarded write semantics', async (t) => {
  const examples = [
    { id: 'addTempRuleBtn', field: 'tempRules', storage: { tempRules: ['other.test'] }, expected: ['other.test', 'docs.example.co.uk'] },
    { id: 'removeBtn', field: 'userRules', storage: { userRules: ['docs.example.co.uk', 'example.co.uk', 'other.test'] }, expected: ['example.co.uk', 'other.test'] },
    { id: 'removeWhitelistBtn', field: 'userWhitelist', storage: { userWhitelist: ['docs.example.co.uk', 'other.test'] }, expected: ['other.test'] },
    { id: 'manageRulesBtn', storage: {} },
  ];
  for (const example of examples) await t.test(example.id, async () => {
    const popup = await createPopup({ storage: example.storage });
    assert.equal(isExposed(popup.element(example.id)), false);
    await popup.click('moreActionsBtn');
    assert.equal(popup.element('moreActionsBtn').getAttribute('aria-expanded'), 'true');
    assert.equal(popup.element('moreActions').hidden, false);
    assert.equal(isExposed(popup.element(example.id)), true);
    assert.equal(popup.element(example.id).disabled, false);
    await popup.click(example.id);
    if (example.field) {
      assert.deepEqual(popup.data[example.field], example.expected);
      assert.equal(popup.stats.saves.length, 1);
      assert.ok(popup.stats.saves[0].expected[example.field], 'configuration changes still require a read baseline');
    } else {
      assert.deepEqual(popup.stats.tabs, [{ url: 'chrome-extension://test/html/options.html#rules' }]);
      assert.equal(popup.stats.set.length, 0);
    }
  });
});

test('inherited rule exceptions retain a visible safe management action while More is collapsed', async (t) => {
  for (const storage of [
    { userWhitelist: ['example.co.uk'] },
    { userWhitelist: ['docs.example.co.uk', 'example.co.uk'] },
    { userRules: ['example.co.uk'] },
    { userRules: ['*.example.co.uk'] },
    { tempRules: ['example.co.uk'] },
  ]) await t.test(JSON.stringify(storage), async () => {
    const popup = await createPopup({ storage });
    assert.equal(popup.element('moreActions').hidden, true);
    assert.equal(isExposed(popup.element('exceptionManageRulesBtn')), true);
    assert.equal(popup.element('exceptionManageRulesBtn').textContent, MESSAGES.en.popManageRuleCompact.message);
    assert.equal(isExposed(popup.element(storage.userWhitelist ? 'whitelistHint' : 'ruleScopeHint')), true);
    await popup.click('exceptionManageRulesBtn');
    assert.deepEqual(popup.stats.tabs, [{ url: 'chrome-extension://test/html/options.html#rules' }]);
    assert.equal(popup.stats.set.length, 0);
    for (const [field, rules] of Object.entries(storage)) assert.deepEqual(popup.data[field], rules);
  });
});

test('non-Auto mode and local bypass exceptions remain visible without opening details', async (t) => {
  for (const mode of ['system', 'fixed_servers', 'direct']) await t.test(mode, async () => {
    const popup = await createPopup({ mode });
    assert.equal(popup.element('routingDetails').hidden, true);
    assert.equal(isExposed(popup.element('whitelistHint')), true);
    assert.equal(popup.element('whitelistHint').textContent, MESSAGES.en.popSiteAutoOnlyCompact.message);
  });
  await t.test('local address bypass', async () => {
    const popup = await createPopup({ tab: { url: 'http://127.0.0.1/' }, storage: { userRules: ['127.0.0.1'] } });
    assert.equal(isExposed(popup.element('ruleScopeHint')), true);
    assert.equal(popup.element('ruleScopeHint').textContent, MESSAGES.en.popLocalDirectCompact.message);
    assertRouting(popup, 'en', 'popStatusDirect');
  });
});

test('Escape closes only the focused disclosure and returns focus without trapping unrelated controls', async () => {
  const popup = await createPopup({ storage: { serverList: [{ id: 'a', name: 'Proxy A' }], activeServerId: 'a' } });
  await popup.click('routingDetailsBtn');
  await popup.click('moreActionsBtn');
  popup.element('addTempRuleBtn').focus();
  const moreEscape = await popup.key('Escape');
  assert.equal(moreEscape.defaultPrevented, true);
  assert.equal(popup.element('moreActions').hidden, true);
  assert.equal(popup.element('moreActionsBtn').getAttribute('aria-expanded'), 'false');
  assert.equal(popup.document.activeElement.id, 'moreActionsBtn');
  assert.equal(popup.element('routingDetails').hidden, false);
  popup.element('routingDetailsBtn').focus();
  const detailsEscape = await popup.key('Escape');
  assert.equal(detailsEscape.defaultPrevented, true);
  assert.equal(popup.element('routingDetails').hidden, true);
  assert.equal(popup.element('routingDetailsBtn').getAttribute('aria-expanded'), 'false');
  assert.equal(popup.document.activeElement.id, 'routingDetailsBtn');
  await popup.click('moreActionsBtn');
  popup.element('serverSelect').focus();
  const unrelatedEscape = await popup.key('Escape');
  assert.equal(unrelatedEscape.defaultPrevented, false);
  assert.equal(popup.element('moreActions').hidden, false);
  assert.equal(popup.document.activeElement.id, 'serverSelect');
  const unrelatedKey = await popup.key('ArrowDown');
  assert.equal(unrelatedKey.defaultPrevented, false);
});

test('new host navigation closes details and More, restores focus and never retains old-host explanations', async () => {
  const popup = await createPopup({ storage: { userRules: ['example.co.uk'] } });
  await popup.click('routingDetailsBtn');
  await popup.click('moreActionsBtn');
  popup.element('removeBtn').focus();
  await popup.updateTab(1, { url: 'https://new.example.test/', status: 'loading' }, { id: 1 });
  assert.equal(popup.element('moreActions').hidden, true);
  assert.equal(popup.element('routingDetails').hidden, true);
  assert.equal(popup.document.activeElement.id, 'moreActionsBtn');
  assert.equal(popup.element('currentDomain').textContent, 'new.example.test');
  assert.equal(popup.element('routingScopeText').textContent, MESSAGES.en.popRuleScope.message.replace('%DOMAIN%', 'new.example.test'));
  assert.equal(isExposed(popup.element('exceptionManageRulesBtn')), false);
  assert.equal(isExposed(popup.element('ruleScopeHint')), false);
  assertRouting(popup, 'en', 'statusNotLoaded');
});

test('disclosure reads remain available during an unconfirmed write and hiding More never hides error feedback', async () => {
  const popup = await createPopup();
  popup.hangNextSet(); await popup.click('addRuleBtn'); await popup.advance(10000);
  const error = popup.element('operationMessage').textContent;
  assert.equal(popup.element('operationMessage').classList.contains('error'), true);
  await popup.click('moreActionsBtn');
  await popup.click('routingDetailsBtn');
  assert.equal(popup.element('moreActions').hidden, false);
  assert.equal(popup.element('routingDetails').hidden, false);
  assert.equal(popup.element('addTempRuleBtn').disabled, true);
  assert.equal(popup.element('mode-direct').disabled, false);
  await popup.click('moreActionsBtn');
  assert.equal(popup.element('operationMessage').textContent, error);
  assert.equal(isExposed(popup.element('operationMessage')), true);
  assert.equal(popup.stats.saves.length, 1);
  await popup.resolveStorageWrite();
  assert.deepEqual(popup.data.userRules, ['docs.example.co.uk']);
  assert.equal(popup.element('operationMessage').textContent, MESSAGES.en.popRuleSaved.message);
  assert.equal(isExposed(popup.element('operationMessage')), true);
});

test('pending rule reads on a new hostname clear the previous source and scope but preserve the actual non-Auto mode', async (t) => {
  for (const [mode, detailKey] of [
    ['pac_script', 'statusNotLoaded'], ['system', 'popTitleSystem'],
    ['fixed_servers', 'popTitleGlobal'], ['direct', 'popTitleDirect'],
  ]) await t.test(mode, async () => {
    const popup = await createPopup({ mode, storage: { userRules: ['example.co.uk'] } });
    assert.equal(isExposed(popup.element('ruleScopeHint')), true);
    popup.hangNextGet();
    await popup.updateTab(1, { url: 'https://pending.example.test/', status: 'loading' }, { id: 1 });
    assert.equal(popup.element('currentDomain').textContent, 'pending.example.test');
    assertRouting(popup, 'en', detailKey);
    assert.equal(popup.element('routingScopeText').textContent, MESSAGES.en.popRuleScope.message.replace('%DOMAIN%', 'pending.example.test'));
    assert.equal(popup.element('addRuleBtn').disabled, false);
    assert.equal(isExposed(popup.element('removeBtn')), false);
    assert.equal(isExposed(popup.element('exceptionManageRulesBtn')), false);
    assert.equal(isExposed(popup.element('ruleScopeHint')), false);
    assert.equal(popup.element('ruleScopeHint').textContent, '');
    assert.equal(popup.element('pageLoadingState').textContent, MESSAGES.en.popPageLoadingCompact.message);
    assert.equal(isExposed(popup.element('pageLoadingState')), true);
  });
});

test('restricted-page navigation closes disclosures and moves focus out of the hidden site actions', async () => {
  const popup = await createPopup();
  await popup.click('moreActionsBtn');
  await popup.click('routingDetailsBtn');
  popup.element('addTempRuleBtn').focus();
  await popup.updateTab(1, { url: 'chrome://extensions/', status: 'complete' }, { id: 1 });
  assert.equal(popup.element('moreActions').hidden, true);
  assert.equal(popup.element('routingDetails').hidden, true);
  assert.equal(popup.element('actionArea').style.display, 'none');
  assert.equal(popup.document.activeElement.id, 'routingDetailsBtn');
  assert.equal(isExposed(popup.document.activeElement), true);
  assert.equal(popup.element('currentDomain').textContent, MESSAGES.en.popInvalidPage.message);
  assertRouting(popup, 'en', 'popCannotSet');
  assert.equal(popup.element('routingScopeText').textContent, '');
  assert.equal(isExposed(popup.element('exceptionManageRulesBtn')), false);
  assert.equal(popup.stats.saves.length, 0);
});

test('route status colors identify the matching toolbar source without changing route precedence', async (t) => {
  const examples = [
    { name: 'default direct', storage: {}, iconKey: 'pac_gray', detailKey: 'popStatusDirect' },
    { name: 'subscription proxy', storage: { gfwDomains: ['example.co.uk'] }, iconKey: 'pac_green', detailKey: 'popStatusGfw' },
    { name: 'manual proxy', storage: { userRules: ['example.co.uk'] }, iconKey: 'pac_purp', detailKey: 'popStatusForceProxy' },
    { name: 'temporary proxy', storage: { tempRules: ['example.co.uk'] }, iconKey: 'pac_org', detailKey: 'popStatusTemp' },
    { name: 'explicit direct', storage: { userWhitelist: ['example.co.uk'] }, iconKey: 'pac_blue', detailKey: 'popStatusForceDirect' },
    { name: 'direct wins over proxy sources', storage: { userWhitelist: ['example.co.uk'], userRules: ['example.co.uk'], tempRules: ['example.co.uk'], gfwDomains: ['example.co.uk'] }, iconKey: 'pac_blue', detailKey: 'popStatusForceDirect' },
    { name: 'manual wins over temporary and subscription', storage: { userRules: ['example.co.uk'], tempRules: ['example.co.uk'], gfwDomains: ['example.co.uk'] }, iconKey: 'pac_purp', detailKey: 'popStatusForceProxy' },
    { name: 'temporary wins over subscription', storage: { tempRules: ['example.co.uk'], gfwDomains: ['example.co.uk'] }, iconKey: 'pac_org', detailKey: 'popStatusTemp' },
    { name: 'local bypass wins over a saved proxy rule', tab: { url: 'http://127.0.0.1/' }, storage: { userRules: ['127.0.0.1'] }, iconKey: 'pac_blue', detailKey: 'popStatusDirect' },
  ];
  for (const example of examples) await t.test(example.name, async () => {
    const popup = await createPopup(example);
    assertRouteVisual(popup, example.iconKey);
    assertRouting(popup, 'en', example.detailKey);
    assert.equal(popup.stats.saves.length, 0);
  });
});

test('loading and unknown mode use neutral color while known manual and mode routes stay identifiable', async (t) => {
  const examples = [
    { name: 'unmatched loading page', tab: { status: 'loading' }, storage: { gfwDomains: ['example.co.uk'] }, iconKey: 'pac_gray', detailKey: 'statusNotLoaded' },
    { name: 'loading manual proxy', tab: { status: 'loading' }, storage: { userRules: ['example.co.uk'] }, iconKey: 'pac_purp', detailKey: 'popStatusForceProxy' },
    { name: 'loading direct rule', tab: { status: 'loading' }, storage: { userWhitelist: ['example.co.uk'] }, iconKey: 'pac_blue', detailKey: 'popStatusForceDirect' },
    { name: 'Global mode overrides direct rule color', mode: 'fixed_servers', storage: { userWhitelist: ['example.co.uk'] }, iconKey: 'fixed', detailKey: 'popTitleGlobal' },
    { name: 'Direct mode overrides proxy rule color', mode: 'direct', storage: { userRules: ['example.co.uk'] }, iconKey: 'direct', detailKey: 'popTitleDirect' },
    { name: 'System mode overrides proxy rule color', mode: 'system', storage: { userRules: ['example.co.uk'] }, iconKey: 'system', detailKey: 'popTitleSystem' },
  ];
  for (const example of examples) await t.test(example.name, async () => {
    const popup = await createPopup(example);
    assertRouteVisual(popup, example.iconKey);
    assertRouting(popup, 'en', example.detailKey);
  });
  await t.test('unknown mode cannot imply the saved proxy color', async () => {
    const popup = await createPopup({ storage: { userRules: ['example.co.uk'] }, deferProxyGet: true });
    assertRouteVisual(popup, 'pac_gray');
    assert.equal(popup.element('routingStatus').textContent, MESSAGES.en.popRoutePending.message);
    await popup.resolveProxyMode();
    assertRouteVisual(popup, 'pac_purp');
    assertRouting(popup, 'en', 'popStatusForceProxy');
  });
});

test('active diagnostic trials distinguish proxy from direct colors and keep explicit rules first', async (t) => {
  for (const direction of ['proxy', 'direct']) await t.test(direction, async () => {
    const trial = { hosts: ['example.co.uk'], direction, expiresAt: Date.now() + 60000 };
    const popup = await createPopup({ storage: { diagnosticTrial: trial, tempRules: ['example.co.uk'], gfwDomains: ['example.co.uk'] } });
    assertRouteVisual(popup, direction === 'proxy' ? 'pac_org' : 'pac_blue');
    assert.equal(popup.element('routingStatus').textContent, MESSAGES.en[direction === 'proxy' ? 'popRouteExpectedProxy' : 'popRouteExpectedDirect'].message);
    assert.equal(popup.element('addRuleBtn').disabled, true);
    assert.equal(popup.element('addTempRuleBtn').style.display, 'none');
    await popup.change({ userRules: ['example.co.uk'] }); await popup.advance(120);
    assertRouteVisual(popup, 'pac_purp');
    assertRouting(popup, 'en', 'popStatusForceProxy');
    await popup.change({ userWhitelist: ['example.co.uk'] }); await popup.advance(120);
    assertRouteVisual(popup, 'pac_blue');
    assertRouting(popup, 'en', 'popStatusForceDirect');
  });
  await t.test('expired trial contributes no proxy color', async () => {
    const popup = await createPopup({ storage: { diagnosticTrial: { hosts: ['example.co.uk'], direction: 'proxy', expiresAt: Date.now() - 1 } } });
    assertRouteVisual(popup, 'pac_gray');
    assertRouting(popup, 'en', 'popStatusDirect');
  });
});

test('live configuration, theme, locale and mode changes never leave a stale route color', async () => {
  const popup = await createPopup({ storage: { serverList: [{ id: 'a', name: 'Proxy A' }], activeServerId: 'a', gfwDomains: ['example.co.uk'] } });
  assertRouteVisual(popup, 'pac_green');
  for (const [change, iconKey, detailKey] of [
    [{ tempRules: ['example.co.uk'] }, 'pac_org', 'popStatusTemp'],
    [{ userRules: ['example.co.uk'] }, 'pac_purp', 'popStatusForceProxy'],
    [{ userWhitelist: ['example.co.uk'] }, 'pac_blue', 'popStatusForceDirect'],
    [{ userWhitelist: [], userRules: [], tempRules: [], gfwDomains: [] }, 'pac_gray', 'popStatusDirect'],
  ]) {
    await popup.change(change); await popup.advance(120);
    assertRouteVisual(popup, iconKey);
    assertRouting(popup, 'en', detailKey);
  }
  await popup.change({ userRules: ['example.co.uk'], theme: 'dark', appLanguage: 'zh_CN' }); await popup.advance(120);
  assertRouteVisual(popup, 'pac_purp');
  assertRouting(popup, 'zh_CN', 'popStatusForceProxy');
  for (const [button, iconKey, detailKey] of [
    ['mode-system', 'system', 'popTitleSystem'], ['mode-direct', 'direct', 'popTitleDirect'],
    ['mode-fixed', 'fixed', 'popTitleGlobal'], ['mode-pac', 'pac_purp', 'popStatusForceProxy'],
  ]) {
    await popup.click(button);
    assertRouteVisual(popup, iconKey);
    assertRouting(popup, 'zh_CN', detailKey);
  }
  assert.equal(popup.stats.saves.length, 0, 'presentation changes and mode operations cannot rewrite rules');
});

test('new host and restricted-page navigation immediately remove the previous source color', async () => {
  const popup = await createPopup({ storage: { userRules: ['example.co.uk'] } });
  assertRouteVisual(popup, 'pac_purp');
  popup.hangNextGet();
  await popup.updateTab(1, { url: 'https://other.example.test/', status: 'loading' }, { id: 1 });
  assertRouteVisual(popup, 'pac_gray');
  assertRouting(popup, 'en', 'statusNotLoaded');
  await popup.updateTab(1, { url: 'chrome://extensions/', status: 'complete' }, { id: 1 });
  assertRouteVisual(popup, 'pac_gray');
  assertRouting(popup, 'en', 'popCannotSet');
  assert.equal(popup.stats.saves.length, 0);
});

test('route icon precedes the hostname and info follows it without a separate visible status badge', async () => {
  const popup = await createPopup({ storage: { userRules: ['example.co.uk'] } });
  const heading = popup.document.querySelector('.domain-heading');
  const info = popup.element('routingDetailsBtn');
  assert.ok(heading);
  assert.equal(popup.element('currentDomain').parentElement, heading);
  assert.equal(info.parentElement, heading);
  assert.equal(popup.document.querySelector('.route-status'), null);
  assert.equal(popup.element('statusIcon').parentElement, heading);
  assert.equal(info.getAttribute('aria-label'), MESSAGES.en.popRoutingDetails.message);
  const headingElements = heading.childNodes.filter(node => node.nodeType === 1);
  assert.deepEqual(headingElements.map(node => node.id), ['statusIcon', 'currentDomain', 'routingDetailsBtn']);
  info.focus();
  await popup.click('routingDetailsBtn');
  assert.equal(popup.element('routingDetails').hidden, false);
  assert.equal(popup.document.activeElement, info);
  const event = await popup.key('Escape');
  assert.equal(event.defaultPrevented, true);
  assert.equal(popup.element('routingDetails').hidden, true);
  assert.equal(popup.document.activeElement, info);
  assert.equal(popup.stats.saves.length, 0);
  assert.equal(popup.stats.messages.length, 0);
});

test('compact More lives beside the site heading and exposes ordinary safe action buttons', async () => {
  const popup = await createPopup();
  const heading = popup.document.querySelector('.section-heading');
  const more = popup.element('moreActionsBtn');
  assert.ok(heading.contains(popup.element('siteRulesLabel')));
  assert.ok(heading.contains(popup.document.querySelector('.scope-caption')));
  assert.equal(more.parentElement, heading);
  assert.equal(more.textContent.trim(), MESSAGES.en.popMoreActions.message);
  assert.equal(more.getAttribute('aria-controls'), 'moreActions');
  assert.equal(more.getAttribute('aria-haspopup'), null, 'this is a disclosure, not an ARIA menu');
  assert.equal(popup.element('moreActions').getAttribute('role'), null);
  for (const id of ['addTempRuleBtn', 'removeBtn', 'removeWhitelistBtn', 'manageRulesBtn']) {
    assert.equal(popup.element(id).tagName, 'BUTTON');
    assert.equal(popup.element(id).getAttribute('role'), null);
    assert.equal(popup.element(id).getAttribute('type'), 'button');
  }
  await popup.click('moreActionsBtn');
  assert.equal(isExposed(popup.element('addTempRuleBtn')), true);
  assert.equal(isExposed(popup.element('manageRulesBtn')), true);
  await popup.click('moreActionsBtn');
  assert.equal(isExposed(popup.element('addTempRuleBtn')), false);
  assert.equal(popup.stats.saves.length, 0);
  assert.equal(popup.stats.messages.length, 0);
  assert.equal(popup.element('moreActions').contains(popup.element('whitelistHint')), false);
  assert.equal(popup.element('moreActions').contains(popup.element('ruleScopeHint')), false);
  assert.equal(popup.element('moreActions').contains(popup.element('exceptionManageRulesBtn')), false);
  assert.equal(popup.element('moreActions').contains(popup.element('operationMessage')), false);
});

test('expanding header More focuses the first available secondary action and Escape returns to its trigger', async (t) => {
  const examples = [
    { name: 'default', storage: {}, first: 'addTempRuleBtn' },
    { name: 'exact proxy rule', storage: { userRules: ['docs.example.co.uk'] }, first: 'removeBtn' },
    { name: 'exact direct rule', storage: { userWhitelist: ['docs.example.co.uk'] }, first: 'removeWhitelistBtn' },
    { name: 'parent direct rule', storage: { userWhitelist: ['example.co.uk'] }, first: 'manageRulesBtn' },
  ];
  for (const example of examples) await t.test(example.name, async () => {
    const popup = await createPopup(example);
    popup.element('moreActionsBtn').focus();
    await popup.click('moreActionsBtn');
    assert.equal(popup.document.activeElement.id, example.first);
    assert.equal(isExposed(popup.document.activeElement), true);
    assert.equal(popup.document.activeElement.disabled, false);
    assert.equal(popup.stats.saves.length, 0);
    assert.equal(popup.stats.tabs.length, 0);
    const event = await popup.key('Escape');
    assert.equal(event.defaultPrevented, true);
    assert.equal(popup.element('moreActions').hidden, true);
    assert.equal(popup.document.activeElement.id, 'moreActionsBtn');
  });
  await t.test('an unconfirmed write skips disabled mutation buttons', async () => {
    const popup = await createPopup();
    popup.hangNextSet(); await popup.click('addRuleBtn'); await popup.advance(10000);
    popup.element('moreActionsBtn').focus();
    await popup.click('moreActionsBtn');
    assert.equal(popup.element('addTempRuleBtn').disabled, true);
    assert.equal(popup.document.activeElement.id, 'manageRulesBtn');
    assert.equal(popup.stats.saves.length, 1);
    assert.equal(isExposed(popup.element('operationMessage')), true);
    await popup.key('Escape');
    assert.equal(popup.document.activeElement.id, 'moreActionsBtn');
    assert.equal(isExposed(popup.element('operationMessage')), true);
  });
});

test('subscription route color resolves only after page completion without a popup reopen', async () => {
  const popup = await createPopup({ tab: { status: 'loading' }, storage: { gfwDomains: ['example.co.uk'] } });
  assertRouteVisual(popup, 'pac_gray');
  assertRouting(popup, 'en', 'statusNotLoaded');
  assert.equal(popup.stats.get.some(keys => keys.includes('gfwDomains')), false);
  await popup.updateTab(1, { status: 'complete' }, { id: 1, url: 'https://docs.example.co.uk/article', status: 'complete' });
  assertRouteVisual(popup, 'pac_green');
  assertRouting(popup, 'en', 'popStatusGfw');
  assert.equal(popup.stats.get.some(keys => keys.includes('gfwDomains')), true);
  assert.equal(popup.stats.tabQueries, 1);
  assert.equal(popup.stats.saves.length, 0);
});

test('all popup languages retain a localized accessible route and complete source tooltip in the inline heading', async (t) => {
  for (const locale of ['en', 'zh_CN', 'es', 'ru']) await t.test(locale, async () => {
    const popup = await createPopup({ storage: { appLanguage: locale } });
    let previousTitle = popup.element('currentDomain').getAttribute('title');
    const rules = { userRules: [], tempRules: [], userWhitelist: [], gfwDomains: [] };
    for (const [change, key, detailKey, icon] of [
      [{ gfwDomains: ['example.co.uk'] }, 'pac_green', 'popStatusGfw', 'globe'],
      [{ tempRules: ['example.co.uk'] }, 'pac_org', 'popStatusTemp', 'clock'],
      [{ userRules: ['example.co.uk'] }, 'pac_purp', 'popStatusForceProxy', 'route'],
      [{ userWhitelist: ['example.co.uk'] }, 'pac_blue', 'popStatusForceDirect', 'arrow-up-right'],
      [{}, 'pac_gray', 'popStatusDirect', 'arrow-up-right'],
    ]) {
      await popup.change({ ...rules, ...change }); await popup.advance(120);
      assertRouteVisual(popup, key);
      assertRouting(popup, locale, detailKey);
      assert.equal(popup.element('routingStatus').classList.contains('sr-only'), true);
      assert.equal(popup.element('statusIcon').getAttribute('data-icon'), icon, 'shape provides a second route cue beside color');
      assert.equal(popup.element('routingDetailsBtn').getAttribute('aria-label'), MESSAGES[locale].popRoutingDetails.message);
      assert.notEqual(popup.element('currentDomain').getAttribute('title'), previousTitle, 'source transitions must refresh the tooltip even if proxy/direct stays the same');
      previousTitle = popup.element('currentDomain').getAttribute('title');
    }
    assert.equal(popup.stats.saves.length, 0);
    assert.equal(popup.stats.messages.length, 0);
  });
});

test('a visually shortened long hostname stays complete in its text, tooltip and disclosure after navigation', async () => {
  const host = `${Array(8).fill('long-hostname-part').join('.')}.example.test`;
  const nextHost = `${Array(7).fill('different-host-part').join('.')}.example.test`;
  const popup = await createPopup({ tab: { url: `https://${host}/article` }, storage: { userRules: [host] } });
  assertRouteVisual(popup, 'pac_purp');
  assertRouting(popup, 'en', 'popStatusForceProxy');
  assert.equal(popup.element('currentDomain').textContent, host, 'ellipsis belongs to CSS and must not truncate the actual hostname');
  assert.ok(popup.element('currentDomain').getAttribute('title').startsWith(`${host}\n`));
  await popup.click('routingDetailsBtn');
  assert.equal(popup.element('routingScopeText').textContent, MESSAGES.en.popRuleScope.message.replace('%DOMAIN%', host));
  popup.hangNextGet();
  await popup.updateTab(1, { url: `https://${nextHost}/`, status: 'loading' }, { id: 1 });
  assertRouteVisual(popup, 'pac_gray');
  assertRouting(popup, 'en', 'statusNotLoaded');
  assert.equal(popup.element('currentDomain').textContent, nextHost);
  assert.ok(popup.element('currentDomain').getAttribute('title').startsWith(`${nextHost}\n`));
  assert.equal(popup.element('currentDomain').getAttribute('title').includes(MESSAGES.en.popStatusForceProxy.message), false);
  assert.equal(popup.element('routingDetails').hidden, true);
  assert.equal(isExposed(popup.element('pageLoadingState')), true, 'the inline route must not hide a loading warning');
  await popup.updateTab(1, { status: 'complete' }, { id: 1, url: `https://${nextHost}/`, status: 'complete' });
  assertRouting(popup, 'en', 'popStatusDirect');
  await popup.click('routingDetailsBtn');
  assert.equal(popup.element('routingScopeText').textContent, MESSAGES.en.popRuleScope.message.replace('%DOMAIN%', nextHost));
  assert.deepEqual(popup.data.userRules, [host]);
  assert.equal(popup.stats.saves.length, 0);
});

test('unsupported pages visibly explain unavailable rules and never inherit an old hostname or proxy color', async (t) => {
  for (const locale of ['en', 'zh_CN', 'es', 'ru']) await t.test(locale, async () => {
    const popup = await createPopup({ mode: 'fixed_servers', storage: { appLanguage: locale, userRules: ['example.co.uk'] } });
    assertRouteVisual(popup, 'fixed');
    assertRouting(popup, locale, 'popTitleGlobal');
    await popup.updateTab(1, { url: 'chrome://extensions/', status: 'complete' }, { id: 1 });
    assertRouteVisual(popup, 'pac_gray');
    assertRouting(popup, locale, 'popCannotSet');
    assert.equal(popup.element('currentDomain').textContent, MESSAGES[locale].popInvalidPage.message);
    assert.equal(popup.element('routingStatus').classList.contains('sr-only'), false);
    assert.equal(isExposed(popup.element('routingStatus')), true, 'an unavailable page needs visible explanatory text');
    assert.equal(popup.element('statusIcon').getAttribute('data-icon'), 'info');
    assert.equal(popup.element('routingScopeText').textContent, '');
    assert.equal(isExposed(popup.element('actionArea')), false);
    await popup.updateTab(1, { url: 'https://new.example.test/', status: 'complete' }, { id: 1 });
    assertRouteVisual(popup, 'fixed');
    assertRouting(popup, locale, 'popTitleGlobal');
    assert.equal(popup.element('routingStatus').classList.contains('sr-only'), true);
    assert.equal(isExposed(popup.element('routingStatus')), false);
    assert.equal(popup.stats.saves.length, 0);
  });
});

test('leaving an unsupported page clears its failure styling before stalled rule reads and rejects obsolete navigation callbacks', async (t) => {
  for (const [mode, pendingKey, modeDetail] of [
    ['pac_script', 'pac_gray', 'statusNotLoaded'],
    ['fixed_servers', 'fixed', 'popTitleGlobal'],
    ['direct', 'direct', 'popTitleDirect'],
    ['system', 'system', 'popTitleSystem'],
  ]) for (const failure of ['hangNextGet', 'failNextGet']) await t.test(`${mode} ${failure}`, async () => {
    const popup = await createPopup({ mode, tab: { url: 'chrome://extensions/' }, storage: { userRules: ['stale.example.test', 'latest.example.test'] } });
    assert.equal(popup.element('domainArea').classList.contains('status-fail'), true);
    assertRouteVisual(popup, 'pac_gray');
    assertRouting(popup, 'en', 'popCannotSet');
    popup[failure]();
    await popup.updateTab(1, { url: 'https://first.example.test/', status: 'loading' }, { id: 1 });
    assert.equal(popup.element('domainArea').classList.contains('status-fail'), false, 'the unavailable-page style must be cleared before storage responds');
    assertRouteVisual(popup, pendingKey);
    assertRouting(popup, 'en', modeDetail);
    assert.equal(popup.element('currentDomain').textContent, 'first.example.test');
    assert.equal(popup.element('routingStatus').classList.contains('sr-only'), true);
    assert.equal(isExposed(popup.element('pageLoadingState')), true);
    popup.deferNextGet();
    await popup.updateTab(1, { url: 'https://stale.example.test/', status: 'loading' }, { id: 1 });
    assertRouteVisual(popup, pendingKey);
    assertRouting(popup, 'en', modeDetail);
    popup.data.userRules = []; // The newer navigation reads a newer snapshot before the old callback arrives.
    await popup.updateTab(1, { url: 'https://latest.example.test/', status: 'complete' }, { id: 1 });
    const finalDetail = mode === 'pac_script' ? 'popStatusDirect' : modeDetail;
    assertRouteVisual(popup, pendingKey);
    assertRouting(popup, 'en', finalDetail);
    assert.equal(popup.element('currentDomain').textContent, 'latest.example.test');
    const title = popup.element('currentDomain').getAttribute('title');
    await popup.resolveStorageRead();
    assertRouteVisual(popup, pendingKey);
    assertRouting(popup, 'en', finalDetail);
    assert.equal(popup.element('domainArea').classList.contains('status-fail'), false);
    assert.equal(popup.element('currentDomain').textContent, 'latest.example.test');
    assert.equal(popup.element('currentDomain').getAttribute('title'), title);
    assert.equal(isExposed(popup.element('pageLoadingState')), false);
    assert.equal(popup.stats.saves.length, 0);
  });
});
