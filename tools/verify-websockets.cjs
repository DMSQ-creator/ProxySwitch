// Real WS/WSS regression checks in a disposable Chromium profile. No accounts,
// user browser profiles or external traffic are used. Only the copied test
// manifest pre-grants optional webRequest; production host permissions stay
// unchanged. The short-lived self-signed certificate and TLS bypass are test
// fixtures, never extension code or system/user certificate-store changes.
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
const diagnosticMessages = require(path.join(root, 'js', 'diagnostics-i18n.js')).dictionaries;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyswitch-websockets-'));
const extension = path.join(scratch, 'extension');
fs.mkdirSync(extension);
for (const folder of ['js', 'html', 'assets', '_locales']) fs.cpSync(path.join(root, folder), path.join(extension, folder), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const productionHosts = [...manifest.host_permissions];
manifest.permissions = [...new Set([...manifest.permissions, 'webRequest'])];
manifest.optional_permissions = [];
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
assert.deepEqual(manifest.host_permissions, productionHosts);

const openssl = process.env.PROXYSWITCH_OPENSSL || (process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
const certPath = path.join(scratch, 'fixture-cert.pem');
const keyPath = path.join(scratch, 'fixture-key.pem');
const certificate = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=isolated.websocket.test', '-keyout', keyPath, '-out', certPath], { encoding: 'utf8', windowsHide: true });
if (certificate.error || certificate.status !== 0) throw new Error('Could not generate isolated test certificate: ' + (certificate.error?.message || certificate.stderr));
const tlsOptions = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
const privateValues = ['private_socket_path_9ad437', 'private_query_6b42a1', 'private_header_8e5102', 'private_payload_cfe147'];
const sourceHost = 'main.websocket.test';
const backendWs = 'hatch.backend.test';
const backendWss = 'secure.backend.test';
const mixedHost = 'mixed.backend.test';
const stableHost = 'stable.stream.test';
const failedHost = 'failed.stream.test';
const deniedHost = 'denied.stream.test';
const records = [];
const connections = new Set();
function track(socket) { connections.add(socket); socket.on('error', () => {}); socket.on('close', () => connections.delete(socket)); }
function routeURL(req) { return new URL(req.url, 'http://' + req.headers.host); }
function respondUpgrade(req, socket, viaProxy) {
  const target = routeURL(req);
  records.push({ host: target.hostname, viaProxy, type: req.socket.encrypted ? 'wss' : 'ws' });
  if (target.hostname === failedHost) { socket.destroy(); return; }
  if (target.hostname === deniedHost || (!viaProxy && [backendWs, backendWss].includes(target.hostname))) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\nX-Fixture-Private: ' + privateValues[2] + '\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nX-Fixture-Private: ' + privateValues[2] + '\r\n\r\n');
  // Keep established connections alive. The extension must observe only the
  // handshake, not frame contents or the application-level connection result.
  const payload = Buffer.from(privateValues[3]);
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
}
function pageHTML() {
  const ws = host => 'ws://' + host + ':' + origin.address().port + '/' + privateValues[0] + '?secret=' + privateValues[1];
  const wss = host => 'wss://' + host + ':' + secureOrigin.address().port + '/' + privateValues[0] + '?secret=' + privateValues[1];
  const urls = [[backendWs, ws(backendWs)], [backendWss, wss(backendWss)], [mixedHost, ws(mixedHost)], [stableHost, wss(stableHost)], [failedHost, ws(failedHost)], [deniedHost, wss(deniedHost)]];
  return '<!doctype html><title>Isolated WS/WSS diagnostic fixture</title><p>Local WS/WSS diagnostic fixture</p><textarea id="draft" aria-label="Unsaved local page draft"></textarea><script>' +
    'window.fixture={sockets:{},opened:{},urls:Object.fromEntries(' + JSON.stringify(urls) + '),loadId:Math.random()};' +
    'fixture.connect=(host)=>{const previous=fixture.sockets[host];if(previous)previous.close();delete fixture.opened[host];const socket=new WebSocket(fixture.urls[host]);fixture.sockets[host]=socket;socket.onopen=()=>{fixture.opened[host]=true;socket.send(' + JSON.stringify(privateValues[3]) + ');};socket.onerror=()=>{};};' +
    JSON.stringify(urls) + '.forEach(([host])=>fixture.connect(host));' +
    'fetch(' + JSON.stringify('http://' + mixedHost + ':' + origin.address().port + '/mixed-http') + ').catch(()=>{});</script>';
}
function handler(viaProxy) {
  return (req, res) => {
    const target = routeURL(req);
    records.push({ host: target.hostname, viaProxy, type: 'http' });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', target.hostname === sourceHost ? 'text/html' : 'text/plain');
    res.end(target.hostname === sourceHost ? pageHTML() : 'ok');
  };
}
const origin = http.createServer(handler(false));
const secureOrigin = https.createServer(tlsOptions, handler(false));
const secureRelay = https.createServer(tlsOptions, handler(true));
const proxy = http.createServer(handler(true));
for (const server of [origin, secureOrigin, secureRelay, proxy]) server.on('connection', track);
origin.on('upgrade', (req, socket) => respondUpgrade(req, socket, false));
secureOrigin.on('upgrade', (req, socket) => respondUpgrade(req, socket, false));
secureRelay.on('upgrade', (req, socket) => respondUpgrade(req, socket, true));
proxy.on('upgrade', (req, socket) => respondUpgrade(req, socket, true));
proxy.on('connect', (req, socket, head) => {
  const target = new URL('https://' + req.url);
  records.push({ host: target.hostname, viaProxy: true, type: 'connect' });
  // Chromium can tunnel plain WS through an HTTP proxy too. Relay its clear
  // handshake to the plain proxy fixture, and WSS to the TLS-only fixture.
  const relayPort = Number(target.port) === origin.address().port ? proxy.address().port : secureRelay.address().port;
  const upstream = net.connect(relayPort, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream); upstream.pipe(socket);
  });
  track(upstream);
  upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function until(fn, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}
async function assertPrivate(ui, label) {
  const stored = await ui.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null), pageJournal: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])) }));
  const value = JSON.stringify(stored);
  for (const secret of privateValues) assert.ok(!value.includes(secret), label + ': private request/frame data leaked to storage or fault journal');
  return stored;
}
let context;
let lastState;
(async () => {
  await Promise.all([listen(origin), listen(secureOrigin), listen(secureRelay), listen(proxy)]);
  context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath: process.env.PROXYSWITCH_CHROMIUM,
    channel: process.env.PROXYSWITCH_CHROMIUM ? undefined : 'chromium',
    headless: true,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--host-resolver-rules=MAP *.test 127.0.0.1', '--ignore-certificate-errors', '--no-proxy-server'],
    viewport: { width: 1100, height: 900 },
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const ui = await context.newPage();
  const errors = [];
  ui.on('pageerror', error => errors.push(error.message));
  await ui.goto('chrome-extension://' + extensionId + '/html/popup.html');
  await ui.evaluate(async ({ port, sourceHost }) => {
    // Use the worker configuration queue instead of a raw storage write that
    // could race the copied extension's asynchronous first-install defaults.
    const items = { serverList: [{ id: 'fixture', name: 'Isolated HTTP proxy', host: '127.0.0.1', port, scheme: 'HTTP' }], activeServerId: 'fixture', userRules: [sourceHost], userWhitelist: ['stable.stream.test'], gfwDomains: [], tempRules: [], appLanguage: 'zh_CN', theme: 'light' };
    let saved;
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await chrome.storage.local.get(Object.keys(items));
      const expected = Object.fromEntries(Object.keys(items).map(key => [key, Object.prototype.hasOwnProperty.call(current, key) ? { exists: true, value: current[key] } : { exists: false }]));
      saved = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'SAVE_CONFIGURATION', items, expected }, resolve));
      if (saved.success || saved.error !== 'config_changed') break;
    }
    if (!saved.success) throw new Error(JSON.stringify(saved));
    const result = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'SET_PROXY_MODE', mode: 'pac_script' }, resolve));
    if (!result.success) throw new Error(JSON.stringify(result));
  }, { port: proxy.address().port, sourceHost });
  const confirmedProxy = await ui.evaluate(() => chrome.proxy.settings.get({}));
  assert.ok(confirmedProxy.value.pacScript.data.includes('127.0.0.1:' + proxy.address().port), 'fixture proxy configuration must be confirmed before requests start');
  const permissions = await ui.evaluate(async () => ({ all: await chrome.permissions.getAll(), ws: await chrome.permissions.contains({ origins: ['ws://*/*', 'wss://*/*'] }) }));
  assert.deepEqual([...permissions.all.origins].sort(), [...productionHosts].sort(), 'copied production host grants really apply');
  assert.equal(permissions.ws, true, 'explicit WS/WSS host grants really apply');
  console.log(JSON.stringify({ stage: 'fixture-permissions', permissions }));
  const source = await context.newPage();
  await source.goto('http://' + sourceHost + ':' + origin.address().port + '/', { waitUntil: 'domcontentloaded' });
  const tabId = await ui.evaluate(async host => (await chrome.tabs.query({})).find(tab => tab.url.includes(host)).id, sourceHost);
  const send = message => ui.evaluate(message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve)), message);
  const state = async () => (lastState = (await send({ type: 'PS_DIAG_GET', tabId })).state);
  const start = await send({ type: 'PS_DIAG_START', tabId });
  assert.equal(start.success, true, JSON.stringify(start));
  const captured = await until(async () => {
    const result = await state();
    return result?.rows.find(row => row.host === stableHost && row.completed > 0) && result.rows.find(row => row.host === deniedHost && row.failed > 0) && result.rows.find(row => row.host === failedHost && row.failed > 0) ? result : null;
  }, 'WS and WSS handshakes captured with unchanged production host permissions');
  assert.equal(captured.main.route, 'proxy');
  for (const host of [backendWs, backendWss, mixedHost, stableHost, failedHost, deniedHost]) {
    const row = captured.rows.find(row => row.host === host);
    assert.ok(row, 'missing WebSocket dependency ' + host);
    assert.ok(row.types.includes('websocket'), host + ': wrong resource type');
    assert.equal(row.route, 'direct', host + ': must not inherit source-page proxy rule');
  }
  const stable = captured.rows.find(row => row.host === stableHost);
  assert.equal(stable.lastStatus, 101);
  assert.equal(stable.pending, 0, 'onCompleted terminates a successful handshake while the socket remains open');
  assert.equal(stable.failed, 0);
  assert.equal(await source.evaluate(host => fixture.sockets[host].readyState, stableHost), 1, 'success socket remains open');
  const mixed = captured.rows.find(row => row.host === mixedHost);
  assert.ok(mixed.types.includes('xmlhttprequest'));
  assert.ok(mixed.completed >= 2, 'HTTP and WS aggregate by domain');
  // Chromium may expose a rejected WebSocket upgrade only as ERR_FAILED and
  // omit the HTTP rejection status. Assert actual available evidence, never
  // manufacture a 403 or mislabel successful/pending connections as failures.
  const denied = captured.rows.find(row => row.host === deniedHost);
  assert.ok(denied.failed > 0);
  if (denied.lastStatus !== null) assert.equal(denied.lastStatus, 403);
  assert.match(captured.rows.find(row => row.host === failedHost).error, /^net::ERR_/);
  console.log(JSON.stringify({ stage: 'real-handshakes', permissions: manifest.host_permissions, stable, failed: captured.rows.find(row => row.host === failedHost), denied: captured.rows.find(row => row.host === deniedHost) }, null, 2));
  await assertPrivate(ui, 'before trial');

  await ui.goto('chrome-extension://' + extensionId + '/html/diagnostics.html?tabId=' + tabId);
  await until(async () => await ui.locator('input[data-host="' + backendWss + '"]').count(), 'WSS appears in actual diagnostic UI');
  const domainRow = host => ui.locator('.ps-diag-domain').filter({ has: ui.locator('input[data-host="' + host + '"]') });
  assert.equal(await domainRow(backendWss).locator('.ps-diag-type').innerText(), 'WebSocket');
  const selectWs = ui.locator('input[data-host="' + backendWs + '"]');
  await selectWs.focus(); await ui.keyboard.press('Space');
  assert.equal(await selectWs.isChecked(), true, 'keyboard selects WS dependency');
  await ui.locator('input[data-host="' + backendWss + '"]').check();
  await domainRow(deniedHost).locator('[data-action="expand"]').click();
  assert.match(await domainRow(deniedHost).locator('.ps-diag-detail').innerText(), /net::ERR_/);
  await ui.locator('[data-action="review"]').focus(); await ui.keyboard.press('Enter');
  assert.ok(await ui.locator('[data-action="apply"]').isVisible());
  await ui.locator('[data-action="apply"]').click();
  await until(async () => (await state())?.trial, 'trial created from WebSocket UI selection');
  const afterTrial = await until(async () => {
    const result = await state();
    return [backendWs, backendWss].every(host => result?.rows.some(row => row.host === host && row.lastStatus === 101 && row.completed > 0)) ? result : null;
  }, 'both WS and WSS truly handshake through the proxy');
  for (const host of [backendWs, backendWss]) {
    assert.equal(afterTrial.rows.find(row => row.host === host).route, 'proxy');
    assert.equal(afterTrial.rows.find(row => row.host === host).source, 'trial');
    assert.ok(records.some(record => record.host === host && record.viaProxy && ['ws', 'wss'].includes(record.type)), host + ': no real proxied handshake');
    assert.equal(await source.evaluate(host => fixture.sockets[host].readyState, host), 1);
  }
  assert.ok(records.some(record => record.host === backendWss && record.type === 'connect'), 'WSS used a real HTTP CONNECT tunnel');
  await assertPrivate(ui, 'during trial');
  await until(async () => await ui.locator('[data-action="undo"]').isVisible(), 'Undo trial UI');
  await ui.locator('[data-action="undo"]').click();
  await until(async () => !(await state())?.trial, 'trial undone');
  await source.reload({ waitUntil: 'domcontentloaded' });
  await until(async () => records.filter(record => record.host === backendWss && !record.viaProxy).length >= 3, 'undo restores direct WSS handshake path');
  assert.equal((await state()).rows.find(row => row.host === backendWss).route, 'direct');
  assert.equal(await source.evaluate(host => fixture.sockets[host].readyState, backendWss), 3, 'unreachable dependency closes again after undo');

  const restarted = await send({ type: 'PS_DIAG_START', tabId });
  assert.equal(restarted.success, true, JSON.stringify(restarted));
  await until(async () => (await state())?.rows.some(row => row.host === backendWss && row.failed > 0), 'fresh direct failure capture');
  await ui.reload();
  await until(async () => await ui.locator('input[data-host="' + backendWss + '"]').count(), 'fresh WSS selection');
  await ui.locator('input[data-host="' + backendWs + '"]').check();
  await ui.locator('input[data-host="' + backendWss + '"]').check();
  await source.locator('#draft').fill('keep my unsaved WebSocket page draft');
  const originalPage=await source.evaluate(()=>({loadId:fixture.loadId,ws:fixture.sockets['hatch.backend.test'].readyState,wss:fixture.sockets['secure.backend.test'].readyState}));
  const originalRules=await ui.evaluate(()=>chrome.storage.local.get(['userRules','userWhitelist']));
  let navigations=0;
  source.on('framenavigated',frame=>{if(frame===source.mainFrame())navigations++;});
  const dialogs=[];
  ui.on('dialog',async dialog=>{dialogs.push(dialog.type());await dialog.dismiss();});
  await ui.locator('[data-action="add-rules"]').focus();await ui.keyboard.press('Enter');
  const directAdd=await until(async()=>{
    const result=await state();return result?.ruleUndo&&!result.ruleUndo.pendingApply?result:null;
  },'WebSocket rules added directly without trial or second confirmation');
  assert.equal(directAdd.trial,null);
  assert.deepEqual([...directAdd.ruleUndo.hosts].sort(),[backendWs,backendWss].sort());
  assert.equal(directAdd.ruleUndo.canUndo,true);
  assert.equal(directAdd.session.rulesChanged,true);
  assert.ok(directAdd.rows.every(row=>row.stale),'previous handshake evidence is marked stale, not misreported as newly verified');
  assert.deepEqual(dialogs,[]);
  assert.equal(navigations,0,'direct addition preserves the source page');
  assert.equal(await source.locator('#draft').inputValue(),'keep my unsaved WebSocket page draft');
  assert.deepEqual(await source.evaluate(()=>({loadId:fixture.loadId,ws:fixture.sockets['hatch.backend.test'].readyState,wss:fixture.sockets['secure.backend.test'].readyState})),originalPage,'permanent addition does not pretend existing sockets have reconnected');
  assert.equal(await ui.locator('[data-action="confirm-save"]').count(),0,'one-step permanent addition does not show another review');
  assert.equal(await ui.locator('[data-verified]').count(), 0, 'no redundant verification checkbox');
  const newConnections=records.length;
  await source.evaluate(hosts=>hosts.forEach(host=>fixture.connect(host)),[backendWs,backendWss]);
  await until(async()=>await source.evaluate(hosts=>hosts.every(host=>fixture.sockets[host].readyState===1),[backendWs,backendWss]),'fresh WS and WSS connections use permanent proxy rules');
  for(const host of [backendWs,backendWss])assert.ok(records.slice(newConnections).some(record=>record.host===host&&record.viaProxy&&['ws','wss'].includes(record.type)),host+': direct add must really route a new handshake through PAC');
  assert.ok(records.slice(newConnections).some(record=>record.host===backendWss&&record.type==='connect'),'fresh WSS really uses CONNECT after direct add');
  await until(async()=>await ui.locator('[data-action="undo-rules"]').isVisible(),'direct addition Undo is shown');
  await ui.locator('[data-action="undo-rules"]').click();
  await until(async()=>{
    const result=await state();return result?.ruleUndo?.undone&&!result.ruleUndo.pendingApply;
  },'direct WebSocket rules undone');
  assert.deepEqual(await ui.evaluate(()=>chrome.storage.local.get(['userRules','userWhitelist'])),originalRules,'Undo keeps preexisting manual proxy and direct rules');
  const restoredConnections=records.length;
  await source.evaluate(hosts=>hosts.forEach(host=>fixture.connect(host)),[backendWs,backendWss]);
  await until(async()=>await source.evaluate(hosts=>hosts.every(host=>fixture.sockets[host].readyState===3),[backendWs,backendWss]),'Undo restores failing direct WS/WSS handshakes');
  for(const host of [backendWs,backendWss])assert.ok(records.slice(restoredConnections).some(record=>record.host===host&&!record.viaProxy&&['ws','wss'].includes(record.type)),host+': new handshake returns to direct after Undo');
  assert.equal(navigations,0);
  assert.equal(await source.locator('#draft').inputValue(),'keep my unsaved WebSocket page draft');
  const savedAgain=await send({type:'PS_DIAG_ADD_RULES',sessionId:directAdd.session.id,hosts:[backendWs,backendWss,sourceHost],direction:'proxy',actionId:'ws-browser-keep-existing'});
  assert.equal(savedAgain.success,true,JSON.stringify(savedAgain));
  assert.deepEqual([...savedAgain.state.ruleUndo.hosts].sort(),[backendWs,backendWss].sort(),'receipt contains the new delta only, not an already-existing source rule');
  assert.ok(!JSON.stringify(savedAgain.state.ruleUndo).includes('afterDigest'));
  const savedRepeat=await send({type:'PS_DIAG_ADD_RULES',sessionId:directAdd.session.id,hosts:[backendWs,backendWss,sourceHost],direction:'proxy',actionId:'ws-browser-keep-existing'});
  assert.equal(savedRepeat.success,true,JSON.stringify(savedRepeat));
  assert.equal(savedRepeat.state.ruleUndo.id,savedAgain.state.ruleUndo.id,'retrying the same action id uses the receipt, never adds twice');
  await source.evaluate(hosts=>hosts.forEach(host=>fixture.connect(host)),[backendWs,backendWss]);
  await until(async()=>await source.evaluate(hosts=>hosts.every(host=>fixture.sockets[host].readyState===1),[backendWs,backendWss]),'saved permanent routes are usable after API retry');
  const stored = await assertPrivate(ui, 'after permanent save');
  assert.ok(stored.local.userRules.includes(backendWs));
  assert.ok(stored.local.userRules.includes(backendWss));
  assert.ok(stored.local.userRules.every(rule => !/[:/?]/.test(rule)), 'only domains saved, never WSS URLs/paths');
  assert.ok(!stored.local.diagnosticTrial);

  // Subscription routes can also be made direct with one action. A preexisting
  // whitelist entry is retained on Undo instead of rolling back a whole list.
  await ui.evaluate(async host=>{
    const current=await chrome.storage.local.get('gfwDomains');
    const expected={gfwDomains:Object.prototype.hasOwnProperty.call(current,'gfwDomains')?{exists:true,value:current.gfwDomains}:{exists:false}};
    const reply=await new Promise(resolve=>chrome.runtime.sendMessage({type:'SAVE_CONFIGURATION',items:{gfwDomains:[host]},expected},resolve));
    if(!reply.success)throw new Error(JSON.stringify(reply));
  },mixedHost);
  const directRound=await send({type:'PS_DIAG_START',tabId});
  assert.equal(directRound.success,true,JSON.stringify(directRound));
  await until(async()=>{
    const result=await state();return result?.rows.some(row=>row.host===mixedHost&&row.route==='proxy'&&row.source==='subscription');
  },'subscription WebSocket proxy route captured');
  await ui.reload();
  await until(async()=>await ui.locator('select[data-direction]').count(),'direct direction selector');
  await ui.locator('select[data-direction]').selectOption('direct');
  await ui.locator('input[data-host="'+mixedHost+'"]').check();
  await ui.locator('[data-action="add-rules"]').click();
  const directWhitelist=await until(async()=>{
    const result=await state();return result?.ruleUndo?.direction==='direct'&&!result.ruleUndo.pendingApply?result:null;
  },'permanent direct rule confirmed');
  assert.equal(directWhitelist.trial,null);
  assert.ok((await ui.evaluate(()=>chrome.storage.local.get('userWhitelist'))).userWhitelist.includes(mixedHost));
  const whitelistConnections=records.length;
  await source.evaluate(host=>fixture.connect(host),mixedHost);
  await until(async()=>await source.evaluate(host=>fixture.sockets[host].readyState===1,mixedHost),'fresh mixed-domain direct handshake');
  assert.ok(records.slice(whitelistConnections).some(record=>record.host===mixedHost&&!record.viaProxy&&record.type==='ws'),'whitelist has a real direct route');
  await until(async()=>await ui.locator('[data-action="undo-rules"]').isVisible(),'direct rule offers Undo');
  await ui.locator('[data-action="undo-rules"]').click();
  await until(async()=>{
    const result=await state();return result?.ruleUndo?.undone&&!result.ruleUndo.pendingApply;
  },'whitelist addition undone');
  assert.deepEqual((await ui.evaluate(()=>chrome.storage.local.get('userWhitelist'))).userWhitelist,originalRules.userWhitelist,'Undo removes only the newly added direct domain');
  const subscriptionConnections=records.length;
  await source.evaluate(host=>fixture.connect(host),mixedHost);
  await until(async()=>await source.evaluate(host=>fixture.sockets[host].readyState===1,mixedHost),'subscription handshake is usable after whitelist Undo');
  assert.ok(records.slice(subscriptionConnections).some(record=>record.host===mixedHost&&record.viaProxy&&record.type==='ws'),'Undo restores actual subscription proxy route');
  const visibleUndo=await send({type:'PS_DIAG_ADD_RULES',sessionId:directWhitelist.session.id,hosts:[mixedHost],direction:'direct',actionId:'ws-browser-layout-undo'});
  assert.equal(visibleUndo.success,true,JSON.stringify(visibleUndo));
  await ui.locator('select[data-direction]').selectOption('proxy');

  const layouts = [];
  const popup = await context.newPage();
  popup.on('pageerror',error=>errors.push(error.message));
  for (const language of ['zh_CN', 'en', 'es', 'ru']) {
    for (const theme of ['light', 'dark']) {
      await ui.evaluate(async value => chrome.storage.local.set(value), { appLanguage: language, theme });
      await ui.reload();
      await until(async () => await domainRow(backendWss).locator('.ps-diag-type').count(), language + '/' + theme + ': WebSocket tag visible');
      await domainRow(stableHost).locator('[data-action="expand"]').click();
      const detail = await domainRow(stableHost).locator('.ps-diag-detail').innerText();
      assert.match(detail, /HTTP 101/);
      assert.match(detail, /WebSocket/);
      const layout = await ui.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, theme: document.documentElement.getAttribute('data-theme'), untranslated: document.body.innerText.match(/diag[A-Z][A-Za-z]+/g) }));
      assert.ok(layout.documentWidth <= layout.width + 1, 'horizontal overflow ' + language + '/' + theme);
      assert.equal(layout.untranslated, null);
      assert.equal(layout.theme, theme, 'actual requested theme applies');
      const actionGeometry=await ui.evaluate(()=>[...document.querySelectorAll('.ps-diag-selection-summary button,.ps-diag-selection-actions button,.ps-diag-selection-actions select,.ps-diag-message button')].map(node=>{
        const rect=node.getBoundingClientRect();return {text:node.textContent.trim(),left:rect.left,right:rect.right,width:rect.width,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth};
      }));
      assert.ok(actionGeometry.every(node=>node.left>=0&&node.right<=layout.width+1&&node.scrollWidth<=node.clientWidth+1),'translated add/trial/undo actions fit '+language+'/'+theme+': '+JSON.stringify(actionGeometry));
      await ui.screenshot({ path: path.join(scratch, 'websockets-' + language + '-' + theme + '.png'), fullPage: true });
      await source.bringToFront();
      await popup.goto('chrome-extension://'+extensionId+'/html/popup.html');
      await until(async()=>await popup.locator('#diagnosticsEntry').isVisible(),'popup entry '+language+'/'+theme);
      await popup.locator('#diagnosticsEntry').click();
      await until(async()=>await popup.locator('select[data-direction]').count(),'compact primary and optional action controls '+language+'/'+theme);
      await popup.locator('[data-action="filter"][data-filter="all"]').click();
      await popup.locator('input[data-host="'+failedHost+'"]').check();
      await until(async()=>await popup.locator('[data-action="undo-rules"]').isVisible(),'compact receipt remains visible '+language+'/'+theme);
      const compactLayout=await popup.evaluate(()=>({width:document.body.scrollWidth,height:document.body.scrollHeight,actions:[...document.querySelectorAll('.ps-diag-selection button,.ps-diag-selection select,.ps-diag-message button')].map(node=>{
        const rect=node.getBoundingClientRect();return {text:node.textContent.trim(),left:rect.left,right:rect.right,width:rect.width,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth};
      })}));
      assert.ok(compactLayout.width<=390&&compactLayout.height<=600,'compact dimensions '+language+'/'+theme+': '+JSON.stringify(compactLayout));
      assert.ok(compactLayout.actions.every(node=>node.left>=0&&node.right<=390&&node.scrollWidth<=node.clientWidth+1),'compact translated controls fit '+language+'/'+theme+': '+JSON.stringify(compactLayout.actions));
      const messages=diagnosticMessages[language];
      const selectedSummary=popup.locator('.ps-diag-selection-summary > .ps-diag-muted');
      assert.equal((await selectedSummary.innerText()).trim(),messages.diagSelected.replace('{count}','1'),'selected summary visibly communicates subdomain scope');
      assert.equal((await popup.locator('[data-action="review"]').innerText()).trim(),messages.diagReview,'temporary trial stays a lightweight optional action');
      assert.equal((await popup.locator('[data-action="add-rules"]').innerText()).trim(),messages.diagAddProxy,'selected direction has a clear primary permanent action');
      assert.equal((await popup.locator('[data-action="undo-rules"]').innerText()).trim(),messages.diagUndoRules,'localized receipt Undo label');
      // Stress only the isolated rendered text, then restore the real selected
      // count. The fixture does not manufacture 200 domains or save any rules.
      const maximumSummary=await popup.evaluate(text=>{
        const node=document.querySelector('.ps-diag-selection-summary > .ps-diag-muted');
        const original=node.textContent;
        const font=getComputedStyle(node).fontSize;
        node.textContent=text;
        const rect=node.getBoundingClientRect();
        const trial=document.querySelector('[data-action="review"]').getBoundingClientRect();
        const value={text:node.textContent,left:rect.left,right:rect.right,height:rect.height,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,font:getComputedStyle(node).fontSize,originalFont:font,trialLeft:trial.left,bodyWidth:document.body.scrollWidth,bodyHeight:document.body.scrollHeight};
        node.textContent=original;
        return value;
      },messages.diagSelected.replace('{count}','200'));
      assert.ok(maximumSummary.right<=maximumSummary.trialLeft-1&&maximumSummary.scrollWidth<=maximumSummary.clientWidth+1,'200 selected scope wraps without colliding with optional trial '+language+'/'+theme+': '+JSON.stringify(maximumSummary));
      assert.equal(maximumSummary.font,maximumSummary.originalFont,'long selected summary does not shrink font');
      assert.ok(maximumSummary.bodyWidth<=390&&maximumSummary.bodyHeight<=600,'long translated scope does not push popup beyond native bounds');
      await popup.locator('[data-action="review"]').focus();
      // No mutation: merely reaching controls with Tab verifies the compact
      // overlay remains navigable without accidental save/review dispatches.
      await popup.keyboard.press('Tab');
      assert.equal(await popup.evaluate(()=>document.activeElement?.dataset.focus),'direction','Tab from optional trial reaches direction selection');
      await popup.keyboard.press('Tab');
      assert.equal(await popup.evaluate(()=>document.activeElement?.dataset.action),'add-rules','Tab reaches primary action without opening another screen');
      await popup.evaluate(()=>{document.querySelector('.ps-diag-content').scrollTop=0;});
      await popup.locator('body').screenshot({path:path.join(scratch,'websockets-popup-'+language+'-'+theme+'.png')});
      layouts.push({ language, theme, ...layout,actionGeometry,compactLayout,maximumSummary });
    }
  }
  await popup.locator('body').screenshot({ path: path.join(scratch, 'websockets-popup.png') });
  const popupLayout = await popup.evaluate(() => ({ width: document.body.scrollWidth, height: document.body.scrollHeight }));
  assert.ok(popupLayout.width <= 390, 'compact popup horizontal overflow');
  assert.ok(popupLayout.height <= 600, 'compact popup exceeds native height');
  await assertPrivate(ui, 'after all UI checks');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, scratch, unchangedHostPermissions: productionHosts, rows: captured.rows.length, realProxyWebsockets: records.filter(record => record.viaProxy && ['ws', 'wss'].includes(record.type)).length, layouts, popupLayout, errors }, null, 2));
})().catch(error => { console.error(error); console.error(JSON.stringify({ scratch, records, lastState }, null, 2)); process.exitCode = 1; }).finally(async () => {
  if (context) await context.close();
  for (const socket of connections) socket.destroy();
  for (const server of [origin, secureOrigin, secureRelay, proxy]) { server.closeAllConnections(); server.close(); }
});
