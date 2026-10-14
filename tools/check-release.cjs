'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
assert.equal(pkg.version, manifest.version, 'Package and extension versions differ');
assert.match(read('CHANGELOG.md'), new RegExp('^## v' + manifest.version.replace(/\./g, '\\.') + ' — ', 'm'), 'Missing bilingual release notes');
const messages = ['en','zh_CN','es','ru'].map(lang => JSON.parse(read('_locales/' + lang + '/messages.json')));
const keys = Object.keys(messages[0]).sort();
for (const dictionary of messages) {
  assert.deepEqual(Object.keys(dictionary).sort(), keys, 'Language keys differ');
  for (const key of keys) {
    assert.ok(dictionary[key].message, 'Empty translation: ' + key);
    const tokens = value => (value.match(/%[A-Z_]+%|\$[A-Z_]+\$/g) || []).sort();
    assert.deepEqual(tokens(dictionary[key].message), tokens(messages[0][key].message), 'Translation placeholders differ: ' + key);
  }
}
for (const folder of ['js','html']) for (const file of fs.readdirSync(path.join(root, folder))) {
  const source = read(folder + '/' + file);
  if (folder === 'html') {
    for (const match of source.matchAll(/__MSG_([a-zA-Z0-9_]+)__/g)) assert.ok(messages[0][match[1]], 'Unknown message: ' + match[1]);
    for (const match of source.matchAll(/(?:src|href)=["'](\.\.\/[^"'#]+)["']/g)) {
      assert.ok(fs.existsSync(path.resolve(root, folder, match[1])), 'Missing page asset: ' + match[1]);
    }
  }
  for (const match of source.matchAll(/\bi18n\(\s*['"]([a-zA-Z0-9_]+)['"]/g)) assert.ok(messages[0][match[1]], 'Unknown message: ' + match[1]);
  for (const match of source.matchAll(/importScripts\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    assert.ok(fs.existsSync(path.join(root, 'js', match[1])), 'Missing worker module: ' + match[1]);
  }
}
for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page, 'Privacy.md']) {
  assert.ok(fs.existsSync(path.join(root, file)), 'Missing release file: ' + file);
}
assert.deepEqual(manifest.optional_permissions, ['webRequest']);
assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'], 'Only HTTP(S)/WebSocket host access is required; do not broaden to all protocols');
assert.equal(manifest.minimum_chrome_version, '95');
console.log('Release metadata, language keys, placeholders and referenced files verified for v' + manifest.version);
