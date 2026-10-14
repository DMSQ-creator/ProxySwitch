// Automatic recorder integration in a disposable Chromium profile. All fixture
// requests and proxy tunnels stay on loopback. The copied test manifest grants
// webRequest to prove an existing grant is not automatic-recording consent;
// production HTTP/HTTPS/WS/WSS host grants are preserved exactly.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PROXYSWITCH_PLAYWRIGHT || 'playwright');

const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyswitch-auto-recording-'));
const extension = path.join(scratch, 'extension');
fs.mkdirSync(extension);
for (const folder of ['js', 'html', 'assets', '_locales']) fs.cpSync(path.join(root, folder), path.join(extension, folder), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const productionHosts = [...manifest.host_permissions];
assert.deepEqual([...productionHosts].sort(), ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'].sort());
assert.ok(manifest.optional_permissions.includes('webRequest'), 'production observation permission remains optional');
assert.ok(!manifest.permissions.includes('webRequest'), 'production installation does not silently grant observation');
manifest.permissions = [...new Set([...manifest.permissions, 'webRequest'])];
manifest.optional_permissions = manifest.optional_permissions.filter(permission => permission !== 'webRequest');
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
assert.deepEqual(manifest.host_permissions, productionHosts);

const openssl = process.env.PROXYSWITCH_OPENSSL || (process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
const certPath = path.join(scratch, 'fixture-cert.pem');
const keyPath = path.join(scratch, 'fixture-key.pem');
const certificate = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=isolated.auto.test', '-keyout', keyPath, '-out', certPath], { encoding: 'utf8', windowsHide: true });
if (certificate.error || certificate.status !== 0) throw new Error('Could not generate isolated test certificate: ' + (certificate.error?.message || certificate.stderr));
const tlsOptions = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
const privateValues = ['private_auto_path_804a1f', 'private_auto_query_e91b03', 'private_auto_header_d1458a', 'private_auto_message_7c128e'];
const hosts = {
  first: 'first.auto.test', second: 'second.auto.test', moved: 'moved.auto.test',
  failedHttp: 'failed-http.auto.test', failedWs: 'failed-ws.auto.test', failedWss: 'failed-wss.auto.test',
  stable: 'stable.auto.test', secure: 'secure.auto.test', other: 'other-tab.auto.test',
  subscription: 'subscription.auto.test', httpError: 'http-error.auto.test',
  retry: 'retry.auto.test', late: 'late.auto.test', pending: 'pending.auto.test',
};
const records = [];
const sockets = new Set();
const pending = new Map();
function track(socket) { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); }
function urlOf(req) { return new URL(req.url, 'http://' + req.headers.host); }
function pageHTML(host) {
  const first = host !== hosts.second;
  const httpURL = (host, resource = '/' + privateValues[0]) => 'http://' + host + ':' + origin.address().port + resource + '?private=' + privateValues[1];
  const connections = first ? [
    [hosts.failedWs, 'ws://' + hosts.failedWs + ':' + origin.address().port + '/' + privateValues[0] + '?private=' + privateValues[1]],
    [hosts.failedWss, 'wss://' + hosts.failedWss + ':' + secureOrigin.address().port + '/' + privateValues[0] + '?private=' + privateValues[1]],
    [hosts.secure, 'wss://' + hosts.secure + ':' + secureOrigin.address().port + '/' + privateValues[0] + '?private=' + privateValues[1]],
  ] : [];
  const resources = first ? [httpURL(hosts.failedHttp), httpURL(hosts.stable), httpURL(hosts.subscription), httpURL(hosts.httpError, '/http-error'), httpURL(hosts.retry, '/okay'), httpURL(hosts.late, '/okay')] : [httpURL(hosts.other)];
  return '<!doctype html><meta charset="utf-8"><title>Isolated automatic recording fixture</title><p>Local automatic recording fixture</p><textarea id="draft" aria-label="Unsaved page draft"></textarea><script>' +
    'window.fixture={loadId:Math.random(),sockets:{},urls:Object.fromEntries(' + JSON.stringify(connections) + ')};' +
    'fixture.connect=host=>{fixture.sockets[host]?.close();const socket=new WebSocket(fixture.urls[host]);fixture.sockets[host]=socket;socket.onopen=()=>socket.send(' + JSON.stringify(privateValues[3]) + ');socket.onerror=()=>{};};' +
    JSON.stringify(connections) + '.forEach(([host])=>fixture.connect(host));' +
    JSON.stringify(resources) + '.forEach(url=>fetch(url).catch(()=>{}));</script>';
}
function handler(viaProxy) {
  return (req, res) => {
    const target = urlOf(req);
    records.push({ host: target.hostname, viaProxy, type: req.socket.encrypted ? 'https' : 'http', resource: target.pathname === '/late' ? 'late' : target.pathname === '/pending' ? 'pending' : 'normal' });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Fixture-Private', privateValues[2]);
    if (['/late', '/pending'].includes(target.pathname)) {
      if (!pending.has(target.hostname)) pending.set(target.hostname, new Set());
      pending.get(target.hostname).add(req.socket);
      req.socket.on('close', () => pending.get(target.hostname)?.delete(req.socket));
      return;
    }
    if ((target.hostname === hosts.failedHttp && !viaProxy) || target.pathname === '/retry-failure') { req.socket.destroy(); return; }
    if (target.pathname === '/http-error') res.statusCode = 503;
    res.setHeader('Content-Type', [hosts.first, hosts.second, hosts.moved].includes(target.hostname) ? 'text/html' : 'text/plain');
    res.end([hosts.first, hosts.second, hosts.moved].includes(target.hostname) ? pageHTML(target.hostname) : 'ok');
  };
}
function upgrade(req, socket, viaProxy) {
  const target = urlOf(req);
  records.push({ host: target.hostname, viaProxy, type: req.socket.encrypted ? 'wss' : 'ws' });
  if (!viaProxy && [hosts.failedWs, hosts.failedWss].includes(target.hostname)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nX-Fixture-Private: ' + privateValues[2] + '\r\n\r\n');
  const payload = Buffer.from(privateValues[3]);
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
}
const origin = http.createServer(handler(false));
const secureOrigin = https.createServer(tlsOptions, handler(false));
const secureRelay = https.createServer(tlsOptions, handler(true));
const proxy = http.createServer(handler(true));
for (const server of [origin, secureOrigin, secureRelay, proxy]) server.on('connection', track);
origin.on('upgrade', (req, socket) => upgrade(req, socket, false));
secureOrigin.on('upgrade', (req, socket) => upgrade(req, socket, false));
secureRelay.on('upgrade', (req, socket) => upgrade(req, socket, true));
proxy.on('upgrade', (req, socket) => upgrade(req, socket, true));
proxy.on('connect', (req, socket, head) => {
  const target = new URL('https://' + req.url);
  records.push({ host: target.hostname, viaProxy: true, type: 'connect' });
  const port = Number(target.port) === origin.address().port ? proxy.address().port : secureRelay.address().port;
  const upstream = net.connect(port, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream); upstream.pipe(socket);
  });
  track(upstream);
  upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function until(fn, label, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}
function row(state, host) { return state?.rows?.find(value => value.host === host); }
function assertReply(reply, label) { assert.equal(reply?.success, true, label + ': ' + JSON.stringify(reply)); return reply.state; }
async function privacy(page, label) {
  const stored = await page.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null), journal: globalThis.PSL?.getLogs ? await PSL.getLogs() : [], pageJournal: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])) }));
  const serialized = JSON.stringify(stored);
  for (const secret of privateValues) assert.ok(!serialized.includes(secret), label + ': private URL/header/frame value reached storage or the fault journal');
  const diagnostics = JSON.stringify(Object.fromEntries(Object.entries({ ...stored.local, ...stored.session }).filter(([key]) => /diagnostic|recorder|capture/i.test(key))));
  assert.ok(!/https?:\/\/|wss?:\/\//.test(diagnostics), label + ': diagnostic storage must contain domain aggregates, not complete URLs');
  return stored;
}
async function layout(page, label, compact) {
  const result = await page.evaluate(() => {
    const actions = [...document.querySelectorAll('.ps-diag-content button,.ps-diag-content select,.ps-diag-header button,.ps-diag-selection button,.ps-diag-selection select,.ps-diag-message button')].filter(node => {
      const rect = node.getBoundingClientRect(); return rect.width && rect.height;
    }).map(node => {
      const rect = node.getBoundingClientRect(); return { action: node.dataset.action, text: node.textContent.trim(), left: rect.left, right: rect.right, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
    });
    return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, bodyHeight: document.body.scrollHeight, theme: document.documentElement.getAttribute('data-theme'), untranslated: document.body.innerText.match(/diag[A-Z][A-Za-z]+/g), actions };
  });
  assert.equal(result.untranslated, null, label + ': untranslated diagnostic key');
  assert.ok(result.documentWidth <= result.width + 1 && result.bodyWidth <= result.width + 1, label + ': horizontal overflow ' + JSON.stringify(result));
  assert.ok(result.actions.every(action => action.left >= -1 && action.right <= (compact ? 360 : result.width) + 1 && action.scrollWidth <= action.clientWidth + 1), label + ': action text is clipped ' + JSON.stringify(result.actions));
  if (compact) assert.ok(result.bodyWidth <= 360 && result.bodyHeight <= 600, label + ': compact popup exceeds native bounds ' + JSON.stringify(result));
  return result;
}

let context;
let lastState;
const errors = [];
const layouts = [];
const stages = [];
(async () => {
  await Promise.all([listen(origin), listen(secureOrigin), listen(secureRelay), listen(proxy)]);
  context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath: process.env.PROXYSWITCH_CHROMIUM,
    channel: process.env.PROXYSWITCH_CHROMIUM ? undefined : 'chromium', headless: true,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--host-resolver-rules=MAP *.auto.test 127.0.0.1', '--ignore-certificate-errors', '--no-proxy-server'],
    viewport: { width: 1100, height: 900 },
  });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const extensionURL = name => 'chrome-extension://' + extensionId + '/html/' + name + '.html';
  const newUI = async (name, sourcePage) => {
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    // A popup is an extension document rather than an active browser tab.
    // Keep the intended source active when approximating it with a test tab.
    if (sourcePage) await sourcePage.bringToFront();
    await page.goto(extensionURL(name)); return page;
  };
  let ui = await newUI('popup');
  const send = message => ui.evaluate(message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve)), message);
  const state = async tabId => (lastState = assertReply(await send({ type: 'PS_DIAG_GET', tabId }), 'read current tab'));
  const tabIdOf = host => ui.evaluate(async host => (await chrome.tabs.query({})).find(tab => new URL(tab.url).hostname === host)?.id, host);
  await ui.evaluate(async ({ port, hosts }) => {
    const items = { serverList: [{ id: 'fixture', name: 'Local automatic recording proxy', host: '127.0.0.1', port, scheme: 'HTTP' }], activeServerId: 'fixture', userRules: [hosts.first], userWhitelist: [hosts.stable], gfwDomains: [hosts.subscription], tempRules: [], appLanguage: 'zh_CN', theme: 'light' };
    let saved;
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await chrome.storage.local.get(Object.keys(items));
      const expected = Object.fromEntries(Object.keys(items).map(key => [key, Object.prototype.hasOwnProperty.call(current, key) ? { exists: true, value: current[key] } : { exists: false }]));
      saved = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'SAVE_CONFIGURATION', items, expected }, resolve));
      if (saved.success || saved.error !== 'config_changed') break;
    }
    if (!saved.success) throw new Error(JSON.stringify(saved));
    const applied = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'SET_PROXY_MODE', mode: 'pac_script' }, resolve));
    if (!applied.success) throw new Error(JSON.stringify(applied));
  }, { port: proxy.address().port, hosts });
  const permissions = await ui.evaluate(() => chrome.permissions.getAll());
  assert.ok(permissions.permissions.includes('webRequest'));
  assert.deepEqual([...permissions.origins].sort(), [...productionHosts].sort());
  const configuration = await ui.evaluate(() => chrome.storage.local.get(['userRules', 'userWhitelist', 'gfwDomains', 'tempRules', 'serverList', 'activeServerId']));
  const pac = await ui.evaluate(() => chrome.proxy.settings.get({}));
  assert.ok(pac.value.pacScript.data.includes('127.0.0.1:' + proxy.address().port), 'real fixture PAC must be confirmed before navigation');
  const source = await context.newPage();
  await source.goto('http://' + hosts.first + ':' + origin.address().port + '/', { waitUntil: 'domcontentloaded' });
  const firstTabId = await tabIdOf(hosts.first);
  const off = await state(firstTabId);
  assert.equal(off.autoCapture.enabled, false, 'automatic recording is off even when observation permission was granted earlier');
  assert.equal(off.autoCapture.permission, true);
  assert.equal(off.session, null);
  assert.deepEqual(off.rows, []);
  const offStorage = await ui.evaluate(async () => ({ local: await chrome.storage.local.get(['diagnosticAutoCapture', 'diagnosticAutoRecords']), session: await chrome.storage.session.get('diagnosticAutoRecords') }));
  assert.notEqual(offStorage.local.diagnosticAutoCapture, true, 'an older optional permission grant does not create stored consent');
  assert.equal(offStorage.local.diagnosticAutoRecords, undefined, 'automatic domain records never enter persistent local storage');
  assert.equal(offStorage.session.diagnosticAutoRecords, undefined, 'there is no browsing cache before consent');
  const missingConsent = await send({ type: 'PS_DIAG_AUTO_ENABLE', tabId: firstTabId });
  assert.equal(missingConsent.success, false, 'grant alone cannot substitute for explicit recording consent');
  assert.equal((await state(firstTabId)).autoCapture.enabled, false);
  await until(() => records.some(record => record.host === hosts.failedWss), 'normal requests occurred while recording was off');
  await privacy(ui, 'off by default');
  stages.push('pre-granted permission remains off without consent');

  await source.locator('#draft').fill('keep this unsaved automatic recording draft');
  const pageBeforeEnable = await source.evaluate(() => ({ loadId: fixture.loadId, draft: document.querySelector('#draft').value }));
  let sourceNavigations = 0;
  source.on('framenavigated', frame => { if (frame === source.mainFrame()) sourceNavigations++; });
  await source.bringToFront();
  await ui.reload();
  await ui.locator('#diagnosticsEntry').click();
  await until(async () => await ui.locator('[data-action="auto-enable"]').isVisible(), 'visible automatic recording opt-in');
  await ui.evaluate(() => {
    window.fixtureMessages = [];
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...args) => { if (message?.type?.startsWith('PS_DIAG_')) fixtureMessages.push(message); return original(message, ...args); };
  });
  await layout(ui, 'Chinese opt-in popup', true);
  await ui.locator('body').screenshot({ path: path.join(scratch, 'auto-recording-popup-zh_CN-before.png'), animations: 'disabled' });
  await ui.locator('[data-action="auto-enable"]').focus();
  await ui.keyboard.press('Enter');
  await until(async () => (await state(firstTabId)).autoCapture.enabled, 'explicit opt-in recorded');
  const enableMessages = await ui.evaluate(() => fixtureMessages.filter(message => message.type === 'PS_DIAG_AUTO_ENABLE'));
  assert.equal(enableMessages.length, 1);
  assert.equal(enableMessages[0].consent, true);
  assert.equal(enableMessages[0].tabId, firstTabId);
  assert.equal(sourceNavigations, 0, 'enabling recording must not refresh the source');
  assert.deepEqual(await source.evaluate(() => ({ loadId: fixture.loadId, draft: document.querySelector('#draft').value })), pageBeforeEnable);
  assert.deepEqual(await ui.evaluate(keys => chrome.storage.local.get(keys), Object.keys(configuration)), configuration, 'enabling recording must not rewrite routing configuration');
  assert.deepEqual((await ui.evaluate(() => chrome.proxy.settings.get({}))).value, pac.value, 'enabling recording must not rewrite the applied PAC');
  await ui.close();
  ui = null;

  // No diagnostic or popup document exists during these independent navigations.
  await source.reload({ waitUntil: 'domcontentloaded' });
  const second = await context.newPage();
  await second.goto('http://' + hosts.second + ':' + origin.address().port + '/', { waitUntil: 'domcontentloaded' });
  const secondTabId = await worker.evaluate(async host => (await chrome.tabs.query({})).find(tab => new URL(tab.url).hostname === host)?.id, hosts.second);
  await until(async () => {
    const stored = await worker.evaluate(async () => ({ local: await chrome.storage.local.get(['diagnosticAutoCapture', 'diagnosticAutoRecords']), session: await chrome.storage.session.get('diagnosticAutoRecords') }));
    assert.equal(stored.local.diagnosticAutoCapture, true, 'only explicit consent enables automatic capture');
    assert.equal(stored.local.diagnosticAutoRecords, undefined, 'automatic aggregates remain outside persistent local storage');
    const serialized = JSON.stringify(stored.session);
    return serialized.includes(hosts.failedHttp) && serialized.includes(hosts.failedWss) && serialized.includes(hosts.other);
  }, 'both tab caches persisted before a popup is opened');
  await source.bringToFront();
  ui = await newUI('popup', source);
  const captured = await until(async () => {
    const result = await state(firstTabId);
    return row(result, hosts.failedHttp)?.failed > 0 && row(result, hosts.failedWs)?.failed > 0 && row(result, hosts.failedWss)?.failed > 0 && row(result, hosts.secure)?.completed > 0 && row(result, hosts.httpError)?.httpErrors > 0 ? result : null;
  }, 'background HTTP/WS/WSS observations visible immediately after opening popup');
  assert.equal(captured.session.auto, true);
  assert.equal(captured.session.tabId, firstTabId);
  assert.equal(captured.main.route, 'proxy');
  for (const host of [hosts.failedHttp, hosts.failedWs, hosts.failedWss]) assert.equal(row(captured, host).route, 'direct', host + ': does not inherit source page route');
  assert.equal(row(captured, hosts.secure).lastStatus, 101);
  assert.equal(row(captured, hosts.secure).pending, 0, 'an established WSS connection is a completed handshake, not unfinished traffic');
  assert.equal(await source.evaluate(host => fixture.sockets[host].readyState, hosts.secure), 1);
  assert.ok(row(captured, hosts.failedWs).types.includes('websocket'));
  assert.ok(row(captured, hosts.failedWss).types.includes('websocket'));
  assert.equal(row(captured, hosts.httpError).failed, 0, 'HTTP 503 is not a transport failure');
  assert.equal(row(captured, hosts.httpError).lastStatus, 503);
  const secondCaptured = await state(secondTabId);
  assert.equal(secondCaptured.session.auto, true);
  assert.ok(row(secondCaptured, hosts.other)?.completed > 0);
  assert.ok(!row(secondCaptured, hosts.failedHttp) && !row(captured, hosts.other), 'different tabs have independent request caches');
  await ui.locator('#diagnosticsEntry').click();
  await until(async () => await ui.locator('[data-action="auto-disable"]').isVisible(), 'auto-enabled state appears in actual compact UI');
  await ui.locator('body').screenshot({ path: path.join(scratch, 'auto-recording-popup-zh_CN-after.png'), animations: 'disabled' });
  stages.push('HTTP/WS/WSS captured for two tabs before popup open');

  // Adding a known failed background domain is a single deliberate action.
  await source.locator('#draft').fill('keep this draft while adding the failed domain');
  const originalPage = await source.evaluate(() => ({ loadId: fixture.loadId, draft: document.querySelector('#draft').value }));
  sourceNavigations = 0;
  await until(async () => await ui.locator('input[data-host="' + hosts.failedHttp + '"]').count(), 'known failed background host available for selection');
  await ui.locator('input[data-host="' + hosts.failedHttp + '"]').check();
  await ui.locator('[data-action="add-rules"]').focus();
  await ui.keyboard.press('Enter');
  const added = await until(async () => {
    const result = await state(firstTabId); return result.ruleUndo && !result.ruleUndo.pendingApply ? result : null;
  }, 'one-step permanent proxy rule from cached automatic observation');
  assert.equal(added.trial, null);
  assert.deepEqual(added.ruleUndo.hosts, [hosts.failedHttp]);
  assert.equal(added.ruleUndo.canUndo, true);
  assert.equal(sourceNavigations, 0);
  assert.deepEqual(await source.evaluate(() => ({ loadId: fixture.loadId, draft: document.querySelector('#draft').value })), originalPage);
  const routeBoundary = records.length;
  await source.evaluate(({ host, port }) => fetch('http://' + host + ':' + port + '/fresh-route?nonce=' + Math.random()).then(response => response.text()), { host: hosts.failedHttp, port: origin.address().port });
  assert.ok(records.slice(routeBoundary).some(record => record.host === hosts.failedHttp && record.viaProxy), 'fresh request really reaches the proxy after direct Add');
  await until(async () => await ui.locator('[data-action="undo-rules"]').isVisible(), 'safe Undo offered after proxy addition');
  await ui.locator('[data-action="undo-rules"]').click();
  await until(async () => (await state(firstTabId)).ruleUndo?.undone, 'proxy addition undone');
  assert.deepEqual(await ui.evaluate(() => chrome.storage.local.get(['userRules', 'userWhitelist'])), { userRules: configuration.userRules, userWhitelist: configuration.userWhitelist });
  const undoBoundary = records.length;
  await source.evaluate(({ host, port }) => fetch('http://' + host + ':' + port + '/fresh-undo?nonce=' + Math.random()).catch(() => {}), { host: hosts.failedHttp, port: origin.address().port });
  assert.ok(records.slice(undoBoundary).some(record => record.host === hosts.failedHttp && !record.viaProxy), 'fresh request returns to actual direct path after Undo');
  assert.equal(sourceNavigations, 0);
  assert.deepEqual(await source.evaluate(() => ({ loadId: fixture.loadId, draft: document.querySelector('#draft').value })), originalPage);

  // A subscription route can be overridden by a permanent direct rule and its
  // receipt removes only this addition, preserving preexisting direct entries.
  await ui.locator('select[data-direction]').selectOption('direct');
  await ui.locator('[data-action="filter"][data-filter="all"]').click();
  await ui.locator('input[data-host="' + hosts.subscription + '"]').check();
  await ui.locator('[data-action="add-rules"]').click();
  const white = await until(async () => {
    const result = await state(firstTabId); return result.ruleUndo?.direction === 'direct' && !result.ruleUndo.pendingApply && !result.ruleUndo.undone ? result : null;
  }, 'one-step permanent whitelist rule');
  assert.deepEqual(white.ruleUndo.hosts, [hosts.subscription]);
  const directBoundary = records.length;
  await source.evaluate(({ host, port }) => fetch('http://' + host + ':' + port + '/fresh-direct?nonce=' + Math.random()).then(response => response.text()), { host: hosts.subscription, port: origin.address().port });
  assert.ok(records.slice(directBoundary).some(record => record.host === hosts.subscription && !record.viaProxy), 'new request uses real whitelist direct route');
  await until(async () => await ui.locator('[data-action="undo-rules"]').isVisible(), 'direct addition Undo visible');
  await ui.locator('[data-action="undo-rules"]').click();
  await until(async () => (await state(firstTabId)).ruleUndo?.undone, 'direct addition undone');
  assert.deepEqual((await ui.evaluate(() => chrome.storage.local.get('userWhitelist'))).userWhitelist, configuration.userWhitelist);
  const restoredBoundary = records.length;
  await source.evaluate(({ host, port }) => fetch('http://' + host + ':' + port + '/fresh-subscription?nonce=' + Math.random()).then(response => response.text()), { host: hosts.subscription, port: origin.address().port });
  assert.ok(records.slice(restoredBoundary).some(record => record.host === hosts.subscription && record.viaProxy), 'Undo restores actual subscription proxy route');
  assert.equal(sourceNavigations, 0);
  assert.deepEqual(await source.evaluate(() => ({ loadId: fixture.loadId, draft: document.querySelector('#draft').value })), originalPage);
  stages.push('direct proxy/whitelist Add and safe Undo preserve page and draft');

  // Retry and same-host navigation are real requests. A keepalive request from
  // the preceding document must not report a late failure in the new epoch.
  await source.evaluate(({ host, port }) => fetch('http://' + host + ':' + port + '/retry-failure').catch(() => {}), { host: hosts.retry, port: origin.address().port });
  await until(async () => row(await state(firstTabId), hosts.retry)?.failed > 0, 'retry fixture real transport error');
  await source.evaluate(({ host, port }) => fetch('http://' + host + ':' + port + '/okay?retry=' + Math.random()).then(response => response.text()), { host: hosts.retry, port: origin.address().port });
  await until(async () => row(await state(firstTabId), hosts.retry)?.lastStatus === 200, 'retry success attributed to the same domain');
  await source.evaluate(({ host, port }) => { fetch('http://' + host + ':' + port + '/late', { keepalive: true }).catch(() => {}); }, { host: hosts.late, port: origin.address().port });
  await until(async () => row(await state(firstTabId), hosts.late)?.pending > 0 && pending.get(hosts.late)?.size > 0, 'old document has pending keepalive request');
  const epochBeforeReload = (await state(firstTabId)).session.id;
  await source.reload({ waitUntil: 'domcontentloaded' });
  const refreshed = await until(async () => {
    const result = await state(firstTabId); return result.session?.id !== epochBeforeReload && row(result, hosts.late)?.completed > 0 ? result : null;
  }, 'same-host refresh begins a fresh automatic epoch');
  for (const socket of pending.get(hosts.late) || []) socket.destroy();
  await until(async () => !pending.get(hosts.late)?.size, 'old request terminates after new epoch');
  const afterLate = await state(firstTabId);
  assert.equal(afterLate.session.id, refreshed.session.id);
  assert.equal(row(afterLate, hosts.late).failed, 0, 'late old-document failure cannot pollute same-host new epoch');
  assert.equal(row(afterLate, hosts.late).pending, 0);
  assert.equal(row(afterLate, hosts.retry).failed, 0, 'old retry history does not survive document refresh');
  stages.push('same-host navigation fences old request outcomes');

  // Clear is local to one tab and never refreshes it or resets the other cache.
  await source.locator('#draft').fill('preserve clear-records draft');
  const pageBeforeClear = await source.evaluate(() => ({ loadId: fixture.loadId, draft: document.querySelector('#draft').value }));
  sourceNavigations = 0;
  assertReply(await send({ type: 'PS_DIAG_CLEAR', tabId: firstTabId, sessionId: afterLate.session.id }), 'clear automatic tab cache');
  const cleared = await state(firstTabId);
  assert.equal(cleared.rows.length, 0);
  assert.equal(cleared.autoCapture.enabled, true);
  assert.ok(row(await state(secondTabId), hosts.other)?.completed > 0, 'clearing one tab preserves second tab records');
  assert.equal(sourceNavigations, 0);
  assert.deepEqual(await source.evaluate(() => ({ loadId: fixture.loadId, draft: document.querySelector('#draft').value })), pageBeforeClear);
  const startBoundary = sourceNavigations;
  assertReply(await send({ type: 'PS_DIAG_START', tabId: firstTabId }), 'explicit reload remains optional in automatic mode');
  await until(async () => sourceNavigations > startBoundary && row(await state(firstTabId), hosts.failedHttp)?.failed > 0, 'explicit Reload creates fresh automatic observations');
  assert.equal((await state(firstTabId)).session.auto, true);
  stages.push('Clear resets one cache without reload; explicit Reload still works');

  // Exercise all translated opt-in/disable controls and the compact permanent
  // primary action, including keyboard order and both actual themes.
  const dictionaries = require(path.join(root, 'js', 'diagnostics-i18n.js')).dictionaries;
  for (const language of ['zh_CN', 'en', 'es', 'ru']) {
    for (const theme of ['light', 'dark']) {
      await ui.evaluate(value => chrome.storage.local.set(value), { appLanguage: language, theme });
      await source.bringToFront();
      await ui.goto(extensionURL('popup'));
      await ui.locator('#diagnosticsEntry').click();
      await until(async () => await ui.locator('[data-action="auto-disable"]').isVisible(), language + '/' + theme + ': disable control');
      await ui.locator('input[data-host="' + hosts.failedHttp + '"]').check();
      const compact = await layout(ui, 'enabled ' + language + '/' + theme, true);
      assert.equal(compact.theme, theme);
      assert.equal((await ui.locator('[data-action="add-rules"]').innerText()).trim(), dictionaries[language].diagAddProxy);
      assert.ok(!await ui.locator('[data-action="add-rules"]').isDisabled(), 'primary permanent action remains available');
      await ui.locator('[data-action="review"]').focus();
      await ui.keyboard.press('Tab');
      assert.equal(await ui.evaluate(() => document.activeElement?.dataset.focus), 'direction');
      await ui.keyboard.press('Tab');
      assert.equal(await ui.evaluate(() => document.activeElement?.dataset.action), 'add-rules');
      await ui.locator('body').screenshot({ path: path.join(scratch, 'auto-recording-popup-' + language + '-' + theme + '.png'), animations: 'disabled' });
      const full = await context.newPage();
      full.on('pageerror', error => errors.push(error.message));
      await full.goto(extensionURL('diagnostics') + '?tabId=' + firstTabId);
      await until(async () => await full.locator('[data-action="auto-disable"]').isVisible(), language + '/' + theme + ': full disable control');
      const fullLayout = await layout(full, 'full ' + language + '/' + theme, false);
      assert.equal(fullLayout.theme, theme);
      await full.close();
      // The consent view is also translated. Disable and enable through the
      // actual UI, verifying no hidden reload even on subsequent activations.
      const beforeToggle = sourceNavigations;
      await ui.locator('[data-action="auto-disable"]').click();
      await until(async () => !(await state(firstTabId)).autoCapture.enabled, language + '/' + theme + ': disabled');
      await until(async () => await ui.locator('[data-action="auto-enable"]').isVisible(), language + '/' + theme + ': localized opt-in');
      const consentLayout = await layout(ui, 'opt-in ' + language + '/' + theme, true);
      const consentText = (await ui.locator('[data-action="auto-enable"]').innerText()).trim();
      const disableText = compact.actions.find(action => action.action === 'auto-disable')?.text;
      assert.equal(consentText, dictionaries[language].diagAutoEnable, 'localized explicit opt-in label');
      assert.equal(disableText, dictionaries[language].diagAutoDisable, 'localized disable label');
      assert.equal((await ui.locator('.ps-diag-auto-optin h2').innerText()).trim(), dictionaries[language].diagAutoTitle, 'localized opt-in heading');
      assert.ok((await ui.locator('.ps-diag-auto-optin').innerText()).includes(dictionaries[language].diagAutoScope), 'localized observation scope');
      assert.ok((await ui.locator('.ps-diag-auto-optin').innerText()).includes(dictionaries[language].diagAutoPrivacy), 'localized local retention/privacy text');
      await ui.locator('[data-action="auto-enable"]').click();
      await until(async () => (await state(firstTabId)).autoCapture.enabled, language + '/' + theme + ': re-enabled');
      assert.equal(sourceNavigations, beforeToggle, 'toggle recording does not reload ' + language + '/' + theme);
      await source.reload({ waitUntil: 'domcontentloaded' });
      await until(async () => row(await state(firstTabId), hosts.failedHttp)?.failed > 0, language + '/' + theme + ': fresh background observations');
      layouts.push({ language, theme, compact, full: fullLayout, consent: consentLayout, consentText, disableText });
    }
  }
  stages.push('four languages, two themes and compact primary-action geometry');

  // Stop the real extension worker with CDP, then wake it through the same GET
  // API used by a reopened popup. Persisted unfinished traffic must not hang.
  await source.evaluate(({ host, port }) => { fetch('http://' + host + ':' + port + '/pending').catch(() => {}); }, { host: hosts.pending, port: origin.address().port });
  await until(async () => row(await state(firstTabId), hosts.pending)?.pending > 0, 'unfinished request before worker termination');
  await until(async () => JSON.stringify(await worker.evaluate(() => chrome.storage.session.get('diagnosticAutoRecords'))).includes(hosts.pending), 'unfinished aggregate persisted before worker termination');
  await privacy(ui, 'before worker restart');
  const workerMarker = crypto.randomUUID();
  await worker.evaluate(marker => { globalThis.fixtureWorkerInstance = marker; }, workerMarker);
  await ui.close(); ui = null;
  const cdp = await context.newCDPSession(source);
  const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => updates.forEach(version => versions.set(version.versionId, version)));
  await cdp.send('ServiceWorker.enable');
  const version = await until(() => [...versions.values()].find(value => value.scriptURL === worker.url() && value.runningStatus === 'running'), 'extension service-worker CDP version');
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  // Playwright has a debugger session on the worker. Closing its actual target
  // also terminates inspected extension workers that ignore stopWorker alone.
  const targets = await cdp.send('Target.getTargets');
  const workerTarget = targets.targetInfos.find(target => target.type === 'service_worker' && target.url === worker.url());
  if (workerTarget) {
    const closed = await cdp.send('Target.closeTarget', { targetId: workerTarget.targetId });
    assert.equal(closed.success, true, 'CDP accepted closing the real extension worker target');
  }
  for (const socket of pending.get(hosts.pending) || []) socket.destroy();
  await source.bringToFront();
  ui = await newUI('popup', source);
  const recovered = await until(async () => {
    const result = await state(firstTabId); return result.session?.auto && row(result, hosts.pending)?.pending === 0 ? result : null;
  }, 'worker wakes with cached aggregate and no stuck unfinished request');
  assert.ok(row(recovered, hosts.failedHttp), 'completed cache survives worker termination');
  assert.equal(row(recovered, hosts.pending).failed, 0, 'unconfirmed request at worker boundary is not manufactured as a network failure');
  assert.ok(row(recovered, hosts.pending).unconfirmed > 0, 'worker boundary reports the unobserved outcome as unconfirmed');
  worker = context.serviceWorkers().find(value => new URL(value.url()).hostname === extensionId) || await context.waitForEvent('serviceworker');
  assert.notEqual(await worker.evaluate(() => globalThis.fixtureWorkerInstance), workerMarker, 'awakened worker has a new global instance after actual CDP termination');
  await cdp.detach();
  const wakeBoundary = records.length;
  await source.evaluate(({ host, port }) => fetch('http://' + host + ':' + port + '/after-wake?nonce=' + Math.random()).then(response => response.text()), { host: hosts.stable, port: origin.address().port });
  await until(async () => row(await state(firstTabId), hosts.stable)?.completed > row(recovered, hosts.stable)?.completed, 'awakened worker records later traffic');
  assert.ok(records.slice(wakeBoundary).some(record => record.host === hosts.stable && !record.viaProxy));
  stages.push('real worker stop/wake preserves aggregates without stuck pending');

  // Restricted navigation and closing a tab discard that tab only. A global
  // disable deletes automatic caches; later traffic stays unrecorded until a
  // fresh explicit opt-in.
  await second.reload({ waitUntil: 'domcontentloaded' });
  await until(async () => row(await state(secondTabId), hosts.other)?.completed > 0, 'second cache restored after earlier disable cycles');
  const moveEpoch = (await state(firstTabId)).session.id;
  await source.goto('http://' + hosts.moved + ':' + origin.address().port + '/', { waitUntil: 'domcontentloaded' });
  await until(async () => {
    const result = await state(firstTabId); return result.session?.hostname === hosts.moved && result.session.id !== moveEpoch;
  }, 'cross-host navigation begins the current tab new epoch');
  await source.goto('about:blank');
  await until(async () => !(await state(firstTabId)).session, 'restricted source navigation discards old cache');
  assert.ok(row(await state(secondTabId), hosts.other), 'restricted navigation preserves other tab cache');
  await second.close();
  await until(async () => {
    const result = await send({ type: 'PS_DIAG_GET', tabId: secondTabId }); return !result.state?.session && !result.state?.rows?.length;
  }, 'closed tab cannot return old automatic cache');
  await source.goto('http://' + hosts.first + ':' + origin.address().port + '/', { waitUntil: 'domcontentloaded' });
  await until(async () => row(await state(firstTabId), hosts.failedHttp)?.failed > 0, 'normal source navigation records after restricted page');
  await source.bringToFront();
  await ui.goto(extensionURL('popup'));
  await ui.locator('#diagnosticsEntry').click();
  await until(async () => await ui.locator('[data-action="auto-disable"]').isVisible(), 'final disable visible');
  const pageBeforeDisable = await source.evaluate(() => fixture.loadId);
  sourceNavigations = 0;
  await ui.locator('[data-action="auto-disable"]').click();
  await until(async () => !(await state(firstTabId)).autoCapture.enabled, 'recording disabled');
  assert.equal((await state(firstTabId)).session, null);
  assert.deepEqual((await state(firstTabId)).rows, []);
  assert.equal(sourceNavigations, 0);
  assert.equal(await source.evaluate(() => fixture.loadId), pageBeforeDisable);
  await source.reload({ waitUntil: 'domcontentloaded' });
  assert.equal((await state(firstTabId)).session, null, 'later navigation cannot restart recording after disable');
  assert.deepEqual((await state(firstTabId)).rows, []);
  const stored = await privacy(ui, 'after disable and all browser checks');
  assert.equal(stored.local.diagnosticAutoCapture, false, 'disable persists the explicit off preference');
  assert.equal(stored.local.diagnosticAutoRecords, undefined);
  assert.equal(stored.session.diagnosticAutoRecords, undefined, 'disable deletes automatic domain summaries');
  assert.deepEqual(await ui.evaluate(keys => chrome.storage.local.get(keys), Object.keys(configuration)), configuration, 'recording checks and safe Undo preserve original routing configuration');
  stages.push('restricted navigation, close and disable clear caches');

  // Reset the actual disposable profile only after proving normal recording and
  // Undo preserved its configuration. Automatic UI state contains observed
  // domains too, and must share the recorder's session-only retention boundary.
  await source.bringToFront();
  await ui.goto(extensionURL('popup'));
  await ui.locator('#diagnosticsEntry').click();
  await until(async () => await ui.locator('[data-action="auto-enable"]').isVisible(), 'explicit opt-in before configuration reset');
  await ui.locator('[data-action="auto-enable"]').click();
  await until(async () => (await state(firstTabId)).autoCapture.enabled, 'recording deliberately re-enabled before reset');
  await source.reload({ waitUntil: 'domcontentloaded' });
  await until(async () => row(await state(firstTabId), hosts.failedHttp)?.failed > 0, 'fresh background record before reset');
  await until(async () => await ui.locator('input[data-host="' + hosts.failedHttp + '"]').isVisible(), 'fresh automatic record in reset fixture UI');
  await ui.locator('input[data-host="' + hosts.failedHttp + '"]').check();
  const uiStorage = await until(async () => {
    const value = await ui.evaluate(async () => ({ local: await chrome.storage.local.get(['diagnosticUiState', 'diagnosticAutoUiState']), session: await chrome.storage.session.get('diagnosticAutoUiState') }));
    return value.session.diagnosticAutoUiState?.selected?.includes(hosts.failedHttp) ? value : null;
  }, 'automatic selection stored in session storage');
  assert.equal(uiStorage.local.diagnosticUiState, undefined, 'automatic selection never uses the legacy persistent UI key');
  assert.equal(uiStorage.local.diagnosticAutoUiState, undefined, 'automatic UI state never falls back to persistent local storage');
  assert.equal(uiStorage.session.diagnosticAutoUiState.sessionId, (await state(firstTabId)).session.id);
  const pageBeforeReset = await source.evaluate(() => fixture.loadId);
  sourceNavigations = 0;
  const reset = await send({ type: 'RESET_CONFIGURATION' });
  assert.equal(reset.success, true, 'real configuration reset: ' + JSON.stringify(reset));
  const resetState = await state(firstTabId);
  assert.equal(resetState.autoCapture.enabled, false, 'configuration reset immediately disables the automatic observer');
  assert.equal(resetState.session, null);
  assert.deepEqual(resetState.rows, []);
  assert.equal(sourceNavigations, 0, 'configuration reset leaves the source page intact');
  assert.equal(await source.evaluate(() => fixture.loadId), pageBeforeReset);
  const releasedProxy = await ui.evaluate(() => chrome.proxy.settings.get({}));
  assert.notEqual(releasedProxy.levelOfControl, 'controlled_by_this_extension', 'configuration reset releases the actual applied PAC');
  assert.deepEqual(await ui.evaluate(() => chrome.storage.local.get(['userRules', 'userWhitelist', 'serverList', 'activeServerId', 'gfwDomains', 'tempRules', 'diagnosticRuleUndo', 'diagnosticTrial'])), {}, 'configuration reset erases fixture rules and diagnostic mutation receipts');
  await until(async () => await ui.locator('[data-action="auto-enable"]').isVisible(), 'reset UI returns to explicit opt-in');
  const resetStorage = await privacy(ui, 'immediately after actual configuration reset');
  assert.notEqual(resetStorage.local.diagnosticAutoCapture, true);
  for (const key of ['diagnosticAutoRecords', 'diagnosticAutoUiState']) {
    assert.equal(resetStorage.local[key], undefined, key + ': no persistent automatic cache after reset');
    assert.equal(resetStorage.session[key], undefined, key + ': session cache removed by reset');
  }
  assert.equal(resetStorage.local.diagnosticUiState, undefined, 'reset removes any persistent legacy UI state');

  // A genuine worker restart cannot recover the deleted consent or UI snapshot.
  // Prove termination by an ephemeral global marker, as in the earlier live-
  // cache recovery check, then navigate normally with recording still off.
  const resetWorkerMarker = crypto.randomUUID();
  await worker.evaluate(marker => { globalThis.fixtureResetWorkerInstance = marker; }, resetWorkerMarker);
  await ui.close(); ui = null;
  const resetCdp = await context.newCDPSession(source);
  const resetVersions = new Map();
  resetCdp.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => updates.forEach(version => resetVersions.set(version.versionId, version)));
  await resetCdp.send('ServiceWorker.enable');
  const resetVersion = await until(() => [...resetVersions.values()].find(value => value.scriptURL === worker.url() && value.runningStatus === 'running'), 'post-reset worker CDP version');
  await resetCdp.send('ServiceWorker.stopWorker', { versionId: resetVersion.versionId });
  const resetTargets = await resetCdp.send('Target.getTargets');
  const resetWorkerTarget = resetTargets.targetInfos.find(target => target.type === 'service_worker' && target.url === worker.url());
  if (resetWorkerTarget) assert.equal((await resetCdp.send('Target.closeTarget', { targetId: resetWorkerTarget.targetId })).success, true, 'CDP closes the post-reset worker target');
  ui = await newUI('popup', source);
  const resetWoke = await state(firstTabId);
  assert.equal(resetWoke.autoCapture.enabled, false);
  assert.equal(resetWoke.session, null);
  assert.deepEqual(resetWoke.rows, []);
  worker = context.serviceWorkers().find(value => new URL(value.url()).hostname === extensionId) || await context.waitForEvent('serviceworker');
  assert.notEqual(await worker.evaluate(() => globalThis.fixtureResetWorkerInstance), resetWorkerMarker, 'post-reset GET wakes a fresh background global');
  await resetCdp.detach();
  assert.notEqual((await ui.evaluate(() => chrome.proxy.settings.get({}))).levelOfControl, 'controlled_by_this_extension', 'post-reset worker wake does not reinstall the removed PAC');
  const resetReloadBoundary = records.length;
  await source.reload({ waitUntil: 'domcontentloaded' });
  const afterResetReload = await state(firstTabId);
  assert.equal(afterResetReload.autoCapture.enabled, false, 'ordinary navigation after reset requires fresh explicit consent');
  assert.equal(afterResetReload.session, null);
  assert.deepEqual(afterResetReload.rows, []);
  assert.ok(records.slice(resetReloadBoundary).some(record => record.host === hosts.first && !record.viaProxy && record.type === 'http'), 'new source request reaches the actual direct fixture after reset and wake');
  const afterResetStorage = await privacy(ui, 'after configuration reset, worker wake and source reload');
  for (const key of ['diagnosticAutoRecords', 'diagnosticAutoUiState']) {
    assert.equal(afterResetStorage.local[key], undefined);
    assert.equal(afterResetStorage.session[key], undefined, key + ': no cache resurrection after reset wake-up or navigation');
  }
  assert.notEqual(afterResetStorage.local.diagnosticAutoCapture, true);
  assert.deepEqual(errors, []);
  stages.push('actual Reset clears consent, session-only UI/cache and PAC; wake cannot resume recording');
  const layoutSummary = layouts.map(({ language, theme, compact, full, consentText, disableText }) => ({ language, theme, popup: { width: compact.bodyWidth, height: compact.bodyHeight }, fullWidth: full.documentWidth, consentText, disableText }));
  console.log(JSON.stringify({ passed: true, scratch, stages, unchangedHostPermissions: productionHosts, originalRows: captured.rows.length, fixtureRequests: records.length, storageArea: recovered.autoCapture.storage, layouts: layoutSummary, errors, persistedDiagnosticKeys: { local: Object.keys(afterResetStorage.local).filter(key => /diagnostic/i.test(key)), session: Object.keys(afterResetStorage.session).filter(key => /diagnostic/i.test(key)) } }, null, 2));
})().catch(error => { console.error(error); console.error(JSON.stringify({ scratch, stages, recentRecords: records.slice(-30), lastState }, null, 2)); process.exitCode = 1; }).finally(async () => {
  if (context) await context.close();
  for (const socket of sockets) socket.destroy();
  for (const server of [origin, secureOrigin, secureRelay, proxy]) { server.closeAllConnections(); server.close(); }
});
