'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const POPUP_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'popup.js'), 'utf8');
const UTILS_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'utils.js'), 'utf8');
const POPUP_HTML = fs.readFileSync(path.join(ROOT, 'html', 'popup.html'), 'utf8');
const MESSAGES = Object.fromEntries(['en', 'zh_CN', 'es'].map((locale) => [
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
  click() { if (!this.disabled) return this.onclick?.({ currentTarget: this, target: this }); }
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
      stack.at(-1).appendChild(element);
      if (!['img', 'br', 'input', 'meta', 'link', 'hr'].includes(tag) && !token.endsWith('/>')) stack.push(element);
    } else stack.at(-1).appendChild(new TextNode(token));
  }
}

function createDocument() {
  const document = {
    readyState: 'complete',
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
  const pendingFetches = [];
  const pendingProxyReads = [];
  const timers = new Map();
  const stats = { get: [], set: [], messages: [], proxySet: [], fetch: [], logs: [] };
  let now = 0;
  let timerId = 0;
  let failGet = false;
  let failSet = false;
  let hangGet = false;
  let hangSet = false;
  const chrome = {
    runtime: {
      lastError: null,
      getURL: (relative) => `chrome-extension://test/${relative}`,
      sendMessage(message, callback) {
        stats.messages.push(clone(message));
        if (!options.hangRefresh) queueMicrotask(() => callback(options.refreshReply || { success: true }));
      },
      connect() { return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }; },
      openOptionsPage() {},
    },
    i18n: { getMessage: (key) => MESSAGES.en[key]?.message || '', getUILanguage: () => 'en-US' },
    tabs: {
      query(_query, callback) { queueMicrotask(() => callback([{ id: 1, url: 'https://docs.example.co.uk/article', status: 'complete', ...options.tab }])); },
      reload() {},
    },
    proxy: { settings: {
      get(_query, callback) {
        const respond = () => callback({ value: { mode: options.mode || 'pac_script' } });
        if (options.deferProxyGet) pendingProxyReads.push(respond);
        else queueMicrotask(respond);
      },
      set(setting, callback) { stats.proxySet.push(clone(setting)); queueMicrotask(callback); },
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
          queueMicrotask(() => {
            chrome.runtime.lastError = failed ? { message: 'storage read failed' } : null;
            callback(failed ? undefined : result);
            chrome.runtime.lastError = null;
          });
        },
        set(items, callback) {
          stats.set.push(clone(items));
          if (hangSet) { hangSet = false; return; }
          const failed = failSet;
          failSet = false;
          if (!failed) {
            const changes = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { oldValue: clone(data[key]), newValue: clone(value) }]));
            Object.assign(data, clone(items));
            queueMicrotask(() => storageListeners.forEach((listener) => listener(changes, 'local')));
          }
          if (!callback) return failed ? Promise.reject(new Error('storage write failed')) : Promise.resolve();
          queueMicrotask(() => {
            chrome.runtime.lastError = failed ? { message: 'storage write failed' } : null;
            callback();
            chrome.runtime.lastError = null;
          });
        },
      },
    },
  };
  const sandbox = {
    chrome, document, URL, console, NodeFilter: { SHOW_TEXT: 4 },
    window: { addEventListener() {} }, navigator: { language: 'en-US' },
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
  vm.runInContext(POPUP_SOURCE, context, { filename: 'popup.js' });
  await flush();
  return {
    document, data, stats, context,
    element: (id) => document.getElementById(id),
    async click(id) { const button = document.getElementById(id); assert.ok(button, `missing #${id}`); button.click(); await flush(); },
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
    async resolveProxyMode() {
      assert.ok(pendingProxyReads.length, 'no pending proxy-mode request');
      pendingProxyReads.shift()();
      await flush();
    },
    failNextGet() { failGet = true; },
    failNextSet() { failSet = true; },
    hangNextGet() { hangGet = true; },
    hangNextSet() { hangSet = true; },
  };
}

function assertTranslation(popup, locale, statusKey = 'popStatusDirect') {
  assert.ok(popup.element('mode-pac').textContent.includes(MESSAGES[locale].popModeAuto.message));
  assert.equal(popup.element('mode-pac').getAttribute('title'), MESSAGES[locale].popTitleAuto.message);
  assert.equal(popup.element('serverSelect').options[0].textContent, MESSAGES[locale].popNoServer.message);
  assert.equal(popup.element('routingStatus').textContent, MESSAGES[locale][statusKey].message);
  assert.doesNotMatch(popup.document.body.textContent, /__MSG_/);
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
    assert.equal(popup.element('whitelistButtonLabel').textContent, MESSAGES.zh_CN.popBtnWhitelisted.message);
    assert.equal(popup.element('whitelistMessage').textContent, MESSAGES.zh_CN.popWhitelistSaved.message);
    assert.equal(popup.element('whitelistHint').textContent, MESSAGES.zh_CN.popWhitelistScope.message.replace('%DOMAIN%', 'docs.example.co.uk'));
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
  assert.equal(popup.element('routingStatus').textContent, MESSAGES.en.popStatusForceDirect.message);
  assert.notEqual(popup.element('removeWhitelistBtn').style.display, 'none');
  await popup.click('removeWhitelistBtn');
  assert.deepEqual(popup.data.userWhitelist, ['already.test']);
  assert.deepEqual(popup.data.userRules, initial.userRules);
  assert.deepEqual(popup.data.tempRules, initial.tempRules);
  assert.equal(popup.element('routingStatus').textContent, MESSAGES.en.popStatusForceProxy.message);
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
  assert.equal(popup.element('whitelistHint').textContent, MESSAGES.en.popWhitelistInherited.message.replace('%DOMAIN%', 'example.co.uk'));
  await popup.click('addWhitelistBtn');
  assert.deepEqual(popup.data.userWhitelist, ['example.co.uk', 'other.test']);
  assert.equal(popup.stats.set.length, 0);
});

test('undo only removes the exact current hostname, preserving parent direct rules', async () => {
  const popup = await createPopup({ storage: { userWhitelist: ['docs.example.co.uk', 'example.co.uk', 'other.test'] } });
  await popup.click('removeWhitelistBtn');
  assert.deepEqual(popup.data.userWhitelist, ['example.co.uk', 'other.test']);
  assert.equal(popup.element('routingStatus').textContent, MESSAGES.en.popStatusForceDirect.message);
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

test('whitelist storage timeouts recover all action buttons', async (t) => {
  for (const hang of ['hangNextGet', 'hangNextSet']) await t.test(hang, async () => {
    const popup = await createPopup();
    popup[hang]();
    await popup.click('addWhitelistBtn');
    assert.equal(popup.element('addWhitelistBtn').disabled, true);
    await popup.advance(3000);
    assert.deepEqual(popup.data.userWhitelist, []);
    for (const id of ['addWhitelistBtn', 'addRuleBtn', 'addTempRuleBtn', 'removeBtn']) assert.equal(popup.element(id).disabled, false);
    assert.ok(popup.element('whitelistMessage').classList.contains('error'));
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
    assert.equal(popup.element('routingStatus').textContent, MESSAGES.en[messageKey].message);
    assert.match(popup.element('whitelistHint').textContent, /auto/i);
  });
});
