// Optional integration smoke test. Uses an isolated Chrome profile and local HTTP fixtures.
// Set PROXYSWITCH_PLAYWRIGHT (module path) and PROXYSWITCH_CHROMIUM (executable).
// The copied test manifest pre-grants webRequest; permission-denial UI is tested separately.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PROXYSWITCH_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyswitch-diagnostics-'));
const extension = path.join(scratch, 'extension');
fs.mkdirSync(extension);
for (const folder of ['js', 'html', 'assets', '_locales']) fs.cpSync(path.join(root, folder), path.join(extension, folder), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
manifest.permissions = [...new Set([...manifest.permissions, 'webRequest'])];
manifest.optional_permissions = [];
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const requests = [];
const handler = (viaProxy) => (req, res) => {
  const target = new URL(req.url, 'http://' + req.headers.host);
  requests.push({ host: target.hostname, path: target.pathname, viaProxy });
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (target.hostname === 'main.diag.example') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Diagnostic fixture</title><p>Local diagnostic fixture</p><script>fetch("http://challenge.diag.example:'+origin.address().port+'/verify?token=must-not-be-recorded").catch(()=>{});fetch("http://api.diag.example:'+origin.address().port+'/failure").catch(()=>{});</script>');
  } else if (target.pathname === '/failure') { req.socket.destroy(); }
  else { res.end('ok'); }
};
const origin = http.createServer(handler(false));
const proxy = http.createServer(handler(true));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function until(fn, label) {
  for (let count = 0; count < 60; count++) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}
let context;
(async () => {
  await Promise.all([listen(origin), listen(proxy)]);
  context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath: process.env.PROXYSWITCH_CHROMIUM,
    headless: true,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--host-resolver-rules=MAP *.diag.example 127.0.0.1', '--no-proxy-server'],
    viewport: { width: 1100, height: 900 },
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const ui = await context.newPage();
  const errors = [];
  ui.on('pageerror', error => errors.push(error.message));
  await ui.goto('chrome-extension://' + extensionId + '/html/popup.html');
  await ui.evaluate(async port => {
    await chrome.storage.local.set({
      serverList: [{id:'test',name:'Local test proxy',host:'127.0.0.1',port,scheme:'HTTP'}],
      activeServerId:'test',userRules:['main.diag.example'],userWhitelist:[],gfwDomains:[],tempRules:[],appLanguage:'zh_CN',theme:'light',
    });
    const response = await new Promise(resolve => chrome.runtime.sendMessage({type:'ENSURE_PAC'}, resolve));
    if (!response.success) throw new Error(JSON.stringify(response));
    await chrome.proxy.settings.set({value:{mode:'pac_script',pacScript:{data:response.pacScriptData}},scope:'regular'});
  }, proxy.address().port);
  const source = await context.newPage();
  await source.goto('http://main.diag.example:' + origin.address().port + '/', {waitUntil:'domcontentloaded'});
  const tabId = await ui.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url.includes('main.diag.example')).id);
  const send = message => ui.evaluate(message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve)), message);
  let response = await send({type:'PS_DIAG_START',tabId});
  assert.equal(response.success,true,JSON.stringify(response));
  const captured = await until(async () => {
    const result = await send({type:'PS_DIAG_GET',tabId});
    return result.state?.rows.some(row => row.host === 'challenge.diag.example' && row.completed > 0) ? result.state : null;
  }, 'cross-domain capture');
  assert.equal(captured.rows.find(row => row.host === 'challenge.diag.example').route,'direct');
  assert.equal(captured.main.route,'proxy');
  const sessionId = captured.session.id;
  // Exercise the real UI, not only the message API.
  await ui.goto('chrome-extension://'+extensionId+'/html/diagnostics.html?tabId='+tabId);
  await ui.locator('input[data-host="challenge.diag.example"]').check();
  await ui.locator('[data-action="review"]').click();
  assert.match(await ui.locator('body').innerText(),/其他页面|other pages/i);
  await ui.locator('[data-action="apply"]').click();
  const applied=await until(async()=>{
    const result=await send({type:'PS_DIAG_GET',tabId});return result.state?.trial || null;
  },'trial from UI');
  assert.equal(applied.hosts[0],'challenge.diag.example');
  const trialId=applied.id;
  await until(async()=>{
    const result=await send({type:'PS_DIAG_GET',tabId});
    return result.state.rows.some(row=>row.host==='challenge.diag.example'&&row.completed>0);
  },'trial round');
  assert.ok(requests.some(item=>item.host==='challenge.diag.example'&&item.viaProxy),'selected dependency actually reaches local proxy');
  await ui.locator('[data-action="undo"]').click();
  await until(async()=>!(await send({type:'PS_DIAG_GET',tabId})).state?.trial,'undo from UI');
  response=await send({type:'PS_DIAG_GET',tabId});
  assert.equal(response.success,true,JSON.stringify(response));
  assert.equal(response.state.trial,null);
  assert.equal(response.state.rows.find(row=>row.host==='challenge.diag.example').route,'direct');
  response=await send({type:'PS_DIAG_APPLY',sessionId,hosts:['challenge.diag.example'],direction:'proxy'});
  assert.equal(response.success,true,JSON.stringify(response));
  await until(async()=>ui.locator('[data-action="save"]').count(),'save trial action');
  await ui.locator('[data-action="save"]').click();
  assert.equal(await ui.locator('[data-action="confirm-save"]').isDisabled(),true);
  await ui.locator('[data-verified]').check();
  await ui.locator('[data-action="confirm-save"]').click();
  await until(async()=>!(await send({type:'PS_DIAG_GET',tabId})).state?.trial,'save from UI');
  const stored=await ui.evaluate(()=>chrome.storage.local.get(['diagnosticSession','diagnosticTrial','userRules','userWhitelist']));
  assert.ok(stored.userRules.includes('challenge.diag.example'));
  assert.ok(!JSON.stringify(stored.diagnosticSession).includes('must-not-be-recorded'));
  assert.ok(!JSON.stringify(stored.diagnosticSession).includes('http://'));
  assert.ok(!stored.diagnosticTrial);
  await ui.goto('chrome-extension://'+extensionId+'/html/diagnostics.html?tabId='+tabId);
  await until(async()=>/页面|请求|诊断/.test(await ui.locator('body').innerText()),'Chinese diagnostics');
  await ui.screenshot({path:path.join(scratch,'diagnostics-light.png'),fullPage:true});
  await ui.evaluate(()=>chrome.storage.local.set({theme:'dark'}));
  await new Promise(resolve=>setTimeout(resolve,300));
  await ui.screenshot({path:path.join(scratch,'diagnostics-dark.png'),fullPage:true});
  await ui.evaluate(()=>chrome.storage.local.set({appLanguage:'en'}));
  await until(async()=>/Page|Requests|diagnostics/i.test(await ui.locator('body').innerText()),'English diagnostics');
  await ui.evaluate(()=>chrome.storage.local.set({appLanguage:'zh_CN',theme:'light'}));
  await source.bringToFront();
  await ui.goto('chrome-extension://'+extensionId+'/html/popup.html');
  await until(async()=>/当前页面请求/.test(await ui.locator('body').innerText()),'Chinese popup entry');
  await ui.locator('body').screenshot({path:path.join(scratch,'popup-home.png')});
  await ui.locator('#diagnosticsEntry').click();
  await until(async()=>ui.locator('input[data-host]').count(),'popup domain list');
  const popupBounds=await ui.evaluate(()=>({height:document.body.scrollHeight,width:document.body.scrollWidth}));
  assert.ok(popupBounds.height<=600,JSON.stringify(popupBounds));
  assert.ok(popupBounds.width<=390,JSON.stringify(popupBounds));
  await ui.locator('body').screenshot({path:path.join(scratch,'popup-requests.png')});
  const sourceId = captured.session.tabId;
  await source.close();
  await until(async()=>{
    const result=await send({type:'PS_DIAG_GET',tabId:sourceId});
    return result.state.session?.closed;
  },'source tab closes');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,scratch,sourceId,rows:captured.rows.length,proxyRequests:requests.filter(item=>item.viaProxy).length,errors},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(context)await context.close();
  origin.closeAllConnections();proxy.closeAllConnections();origin.close();proxy.close();
});
