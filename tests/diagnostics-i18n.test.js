'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'diagnostics-i18n.js'), 'utf8');

function harness({ browser = 'en-US', stored, delayed = false, unavailable = false } = {}) {
  const timers = new Map();
  let nextTimer = 0;
  let storageRead;
  let storageChanged;
  const context = {
    module: { exports: {} },
    navigator: { language: browser },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch() { throw new Error('Diagnostics translations must not fetch anything'); },
    chrome: {
      runtime: {},
      i18n: { getUILanguage: () => browser },
      storage: {
        onChanged: { addListener(callback) { storageChanged = callback; } },
        local: {
          get(keys, callback) {
            if (unavailable) throw new Error('storage unavailable');
            storageRead = callback;
            if (!delayed) callback({ appLanguage: stored });
          }
        }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    ...context.module.exports,
    resolveRead(value) { storageRead({ appLanguage: value }); },
    change(value, area = 'local') { storageChanged({ appLanguage: { newValue: value } }, area); },
    expireTimers() { for (const callback of [...timers.values()]) callback(); },
    timers,
    context
  };
}

test('diagnostics dictionaries have identical complete keys and interpolation tokens', () => {
  const { dictionaries } = harness();
  const keys = Object.keys(dictionaries.en).sort();
  assert.ok(keys.length > 100);
  for (const locale of ['zh_CN', 'es', 'ru']) {
    assert.deepEqual(Object.keys(dictionaries[locale]).sort(), keys);
    for (const key of keys) {
      assert.ok(dictionaries[locale][key].trim(), `${locale}.${key} is empty`);
      const tokens = text => Array.from(text.matchAll(/\{\w+\}/g), match => match[0]).sort();
      assert.deepEqual(tokens(dictionaries[locale][key]), tokens(dictionaries.en[key]), `${locale}.${key}`);
    }
  }
});

test('every literal UI translation key is included in the bundled dictionary', () => {
  const { dictionaries } = harness();
  const ui = fs.readFileSync(path.join(__dirname, '..', 'js', 'diagnostics.js'), 'utf8');
  const keys = new Set(Array.from(ui.matchAll(/['"](diag[A-Z]\w+)['"]/g), match => match[1]));
  assert.ok(keys.size > 80);
  for (const key of keys) assert.ok(dictionaries.en[key], `Missing UI translation: ${key}`);
});

test('stored Simplified Chinese takes precedence over English Chrome', async () => {
  const { api, timers } = harness({ stored: 'zh_CN' });
  assert.equal(await api.ready, api);
  assert.equal(api.getLanguage(), 'zh_CN');
  assert.equal(api.t('diagEntry'), '当前页面请求');
  assert.equal(api.t('diagSelected', { count: 2 }), '已选 2 个域名');
  assert.equal(timers.size, 0);
});

test('auto uses browser locale and falls back to English for unsupported languages', async () => {
  for (const [browser, locale] of [['es-MX', 'es'], ['ru-RU', 'ru'], ['zh-CN', 'zh_CN'], ['de-DE', 'en']]) {
    const { api } = harness({ browser, stored: 'auto' });
    await api.ready;
    assert.equal(api.getLanguage(), locale);
    assert.notEqual(api.t('diagEntry'), 'diagEntry');
  }
});

test('language changes notify safely and auto/deletion restore browser language', async () => {
  const { api, change } = harness({ browser: 'en', stored: 'zh_CN' });
  await api.ready;
  const values = [];
  api.subscribe(() => { throw new Error('broken view'); });
  const unsubscribe = api.subscribe(locale => values.push(locale));
  change('es', 'sync');
  assert.equal(api.getLanguage(), 'zh_CN');
  change('es');
  change('es');
  change('auto');
  change('zh_CN');
  change(undefined);
  assert.deepEqual(values, ['es', 'en', 'zh_CN', 'en']);
  unsubscribe();
  change('ru');
  assert.deepEqual(values, ['es', 'en', 'zh_CN', 'en']);
});

test('slow initial language read cannot overwrite a newer user selection', async () => {
  const { api, change, resolveRead } = harness({ delayed: true });
  change('ru');
  resolveRead('zh_CN');
  await api.ready;
  assert.equal(api.getLanguage(), 'ru');
});

test('hung storage has bounded readiness and a late read still updates the language', async () => {
  const { api, expireTimers, resolveRead, timers } = harness({ delayed: true });
  assert.equal(api.t('diagEntry'), 'Current page requests');
  expireTimers();
  assert.equal(await api.ready, api);
  assert.equal(timers.size, 0);
  resolveRead('zh_CN');
  assert.equal(api.t('diagEntry'), '当前页面请求');
});

test('storage errors retain browser-language strings and do not block startup', async () => {
  const { api, timers } = harness({ unavailable: true, browser: 'ru' });
  await api.ready;
  assert.equal(api.getLanguage(), 'ru');
  assert.equal(timers.size, 0);
});

test('substitution treats values as literal text, including dollar signs and markup', () => {
  const { api } = harness();
  assert.equal(api.t('diagSelect', { host: '$&<example.test>' }), 'Select $&<example.test>');
  assert.equal(api.t('diagSelected'), '{count} domains selected');
  assert.equal(api.t('nonexistent'), 'nonexistent');
});
