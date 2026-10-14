// Real Options workflows against a disposable, loopback-only WebDAV fixture.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PROXYSWITCH_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyswitch-reliability-'));
const extension = path.join(scratch, 'extension');
fs.mkdirSync(extension);
for (const folder of ['js', 'html', 'assets', '_locales']) fs.cpSync(path.join(root, folder), path.join(extension, folder), { recursive: true });
fs.copyFileSync(path.join(root, 'manifest.json'), path.join(extension, 'manifest.json'));
let remote = { backupVer: 5, userRules: [], userWhitelist: [] };
let readDelayMs = 1457;
const received = [];
const server = http.createServer((req, res) => {
  received.push(req.method);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET') setTimeout(() => res.end(JSON.stringify(remote)), readDelayMs);
  else if (req.method === 'MKCOL') { res.statusCode = 405; res.end('{}'); }
  else if (req.method === 'PUT') { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { remote = JSON.parse(body); res.end('{}'); }); }
  else { res.statusCode = 404; res.end('{}'); }
});
async function until(fn, label) {
  for (let count = 0; count < 100; count++) {
    const result = await fn(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}
let context;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath: process.env.PROXYSWITCH_CHROMIUM,
    channel: process.env.PROXYSWITCH_CHROMIUM ? undefined : 'chromium', headless: true,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--no-proxy-server'],
    viewport: { width: 1200, height: 900 },
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const page = await context.newPage(); const errors = []; const dialogs = []; const cloudWarnings = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (['warning', 'error'].includes(message.type()) && /MANUAL_SYNC_/.test(message.text())) cloudWarnings.push(message.text());
  });
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.goto('chrome-extension://' + extensionId + '/html/options.html');
  // Fixture seeding uses raw storage, not the UI's guarded mutation lease.
  // Let first-install defaults finish before writing the test configuration.
  await until(async () => {
    const items = await page.evaluate(() => chrome.storage.local.get('serverList'));
    return Array.isArray(items.serverList) && items.serverList.length > 0;
  }, 'installation defaults ready');
  await page.evaluate(async port => {
    await chrome.storage.local.set({ userRules: ['old.example'], userWhitelist: ['direct.example'],
      serverList: [{ id: 'fixture', name: 'Fixture proxy', scheme: 'HTTP', host: '127.0.0.1', port: 9 }],
      activeServerId: 'fixture', gfwDomains: [], tempRules: ['temporary.example'], gfwlistUrl: '',
      syncProvider: 'webdav', davUrl: 'http://127.0.0.1:' + port + '/dav/', davUser: 'fixture', davPass: 'fixture-password',
      appLanguage: 'zh_CN', theme: 'light', autoSync: false, errorLogVerbose: false });
  }, server.address().port);
  await page.reload();
  await until(async () => /Fixture proxy/.test(await page.locator('body').innerText()), 'configured server');
  await page.locator('[data-target="rules"]').focus(); await page.keyboard.press('Enter');
  await until(async () => page.locator('#section-rules').evaluate(el => el.classList.contains('active')), 'keyboard navigation');
  await page.locator('#ruleFile').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('[42]') });
  await until(() => dialogs.length, 'invalid import rejected');
  assert.deepEqual(await page.evaluate(async () => (await chrome.storage.local.get(['userRules'])).userRules), ['old.example']);
  await page.locator('#ruleFile').setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from('["new.example", "old.example"]') });
  await page.locator('#configurationPreview').waitFor({ state: 'visible' });
  assert.match(await page.locator('#configurationPreviewText').innerText(), /新增 1/);
  await page.locator('#configurationPreviewConfirm').click();
  await until(async () => (await page.evaluate(async () => (await chrome.storage.local.get(['userRules'])).userRules)).includes('new.example'), 'confirmed rule import');
  await until(async () => !(await page.locator('#ruleImportBtn').isDisabled()), 'import completes');
  await page.locator('[data-target="sync"]').click();
  await page.locator('#cloudDownloadBtn').click();
  await page.locator('#configurationPreview').waitFor({ state: 'visible' });
  assert.match(await page.locator('#configurationPreviewText').innerText(), /将清空/);
  const timing = await page.evaluate(async () => (await PSL.getLogs()).find(entry => /^MANUAL_SYNC_PREVIEW \d+ms$/.test(entry.message)));
  assert.equal(timing.level, 'info');
  assert.equal(timing.detail, 'result=success');
  assert.ok(Number(timing.message.match(/(\d+)ms$/)[1]) >= 1457, 'fixture must exercise a genuinely slow cloud reply');
  assert.deepEqual(cloudWarnings, [], 'normal cloud latency must not appear as a console warning');
  readDelayMs = 0;
  await page.screenshot({ path: path.join(scratch, 'restore-preview-zh.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await until(async () => !(await page.locator('#cloudDownloadBtn').isDisabled()), 'restore canceled');
  assert.equal((await page.evaluate(async () => (await chrome.storage.local.get(['userRules'])).userRules)).length, 2);
  await page.locator('#cloudDownloadBtn').click();
  await page.locator('#configurationPreview').waitFor({ state: 'visible' });
  await page.locator('#configurationPreviewConfirm').click();
  await until(async () => (await page.evaluate(async () => (await chrome.storage.local.get(['userRules'])).userRules)).length === 0, 'empty list restore');
  await until(async () => !(await page.locator('#cloudUndoBtn').isDisabled()), 'undo enabled');
  await page.locator('#cloudUndoBtn').click();
  await page.locator('#configurationPreview').waitFor({ state: 'visible' });
  await page.locator('#configurationPreviewConfirm').click();
  await until(async () => (await page.evaluate(async () => (await chrome.storage.local.get(['userRules'])).userRules)).includes('new.example'), 'restore undo');
  await until(async () => !(await page.locator('#cloudUploadBtn').isDisabled()), 'undo finishes');
  await page.locator('#cloudUploadBtn').click();
  await until(() => received.includes('PUT'), 'loopback backup upload');
  assert.deepEqual(remote.userRules, ['old.example', 'new.example']);
  assert.equal(remote.tempRules, undefined); assert.equal(remote.davPass, undefined); assert.equal(remote.cloudRestoreUndo, undefined);
  await until(async () => !(await page.locator('#cloudUploadBtn').isDisabled()), 'upload finishes');
  await page.evaluate(() => chrome.storage.local.set({ appLanguage: 'en', theme: 'dark' }));
  await page.reload(); await page.locator('[data-target="sync"]').click();
  await page.locator('#cloudDownloadBtn').click();
  await page.locator('#configurationPreview').waitFor({ state: 'visible' });
  assert.match(await page.locator('#configurationPreviewTitle').innerText(), /Cloud restore preview/);
  await page.screenshot({ path: path.join(scratch, 'restore-preview-en-dark.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await until(async () => !(await page.locator('#cloudDownloadBtn').isDisabled()), 'final preview canceled');
  const reset = await page.evaluate(async () => {
    await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: {
      data: 'function FindProxyForURL(url,host){return host==="old.example"?"PROXY 127.0.0.1:9; DIRECT":"DIRECT";}' } }, scope: 'regular' });
    const result = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'RESET_CONFIGURATION' }, resolve));
    const proxy = await new Promise(resolve => chrome.proxy.settings.get({}, resolve));
    const data = await chrome.storage.local.get(['userRules', 'userWhitelist', 'cloudRestoreUndo']);
    return { result, mode: proxy.value.mode, control: proxy.levelOfControl, data };
  });
  assert.equal(reset.result.success, true, JSON.stringify(reset.result));
  assert.notEqual(reset.control, 'controlled_by_this_extension', 'reset must release stale PAC, not just erase its source rules');
  assert.deepEqual(reset.data, {});
  assert.deepEqual(errors, []);
  assert.deepEqual(cloudWarnings, []);
  console.log(JSON.stringify({ passed: true, scratch, assertions: 'import, keyboard, slow cloud info persists without warnings, cancel, empty restore, undo, safe upload, reset releases PAC, zh/en, light/dark', errors }, null, 2));
})().catch(async error => {
  console.error(error); console.error('Reliability fixture artifacts: ' + scratch);
  if (context) await Promise.all(context.pages().map((page, index) => page.screenshot({
    path: path.join(scratch, 'failure-' + index + '.png'), fullPage: true, timeout: 5000,
  }).catch(() => {})));
  process.exitCode = 1;
}).finally(async () => {
  if (context) await context.close(); server.closeAllConnections(); server.close();
});
