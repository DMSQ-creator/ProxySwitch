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
    res.end('<!doctype html><title>Diagnostic fixture</title><p>Local diagnostic fixture</p><textarea id="draft" aria-label="Unsaved local page draft"></textarea><script>window.fixtureLoadId=Math.random();fetch("http://challenge.diag.example:'+origin.address().port+'/verify?token=must-not-be-recorded").catch(()=>{});fetch("http://api.diag.example:'+origin.address().port+'/failure").catch(()=>{});fetch("http://extra.diag.example:'+origin.address().port+'/extra").catch(()=>{});fetch("http://other.diag.example:'+origin.address().port+'/other").catch(()=>{});</script>');
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
async function moreActions(page) {
  const button = page.locator('#moreActionsBtn');
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  await until(async () => (await button.getAttribute('aria-expanded')) === 'true' &&
    await page.locator('#moreActions').isVisible(), 'popup More actions expanded');
}
let context;
(async () => {
  await Promise.all([listen(origin), listen(proxy)]);
  context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath: process.env.PROXYSWITCH_CHROMIUM,
    channel: process.env.PROXYSWITCH_CHROMIUM ? undefined : 'chromium',
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
    const items={
      serverList: [{id:'test',name:'Local test proxy',host:'127.0.0.1',port,scheme:'HTTP'}],
      activeServerId:'test',userRules:['main.diag.example'],userWhitelist:[],gfwDomains:[],tempRules:[],appLanguage:'zh_CN',theme:'light',
    };
    // First-install defaults can still be pending in a new profile. Join the
    // same worker queue used by production settings, with an explicit baseline.
    let saved;
    for(let attempt=0;attempt<10;attempt++){
      const current=await chrome.storage.local.get(Object.keys(items));
      const expected=Object.fromEntries(Object.keys(items).map(key=>[key,Object.prototype.hasOwnProperty.call(current,key)?{exists:true,value:current[key]}:{exists:false}]));
      saved=await new Promise(resolve=>chrome.runtime.sendMessage({type:'SAVE_CONFIGURATION',items,expected},resolve));
      if(saved.success||saved.error!=='config_changed')break;
    }
    if(!saved.success)throw new Error(JSON.stringify(saved));
    // Join the worker-owned write queue. A raw proxy.settings.set here could
    // race its storage-triggered apply and start the fixture before confirmation.
    const response = await new Promise(resolve => chrome.runtime.sendMessage({type:'SET_PROXY_MODE',mode:'pac_script'}, resolve));
    if (!response.success) throw new Error(JSON.stringify(response));
    const applied = await chrome.proxy.settings.get({});
    if (applied.value.mode !== 'pac_script') throw new Error('Diagnostic fixture proxy mode was not confirmed');
    if(!applied.value.pacScript.data.includes('127.0.0.1:'+port))throw new Error('Diagnostic fixture proxy server was not confirmed');
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
  // An active diagnostic trial is a consequential state, not a secondary
  // command. It must stay visible on the compact popup without opening More.
  await source.bringToFront();
  await ui.goto('chrome-extension://'+extensionId+'/html/popup.html');
  await until(async()=>await ui.locator('#diagnosticsHomeTrial').locator('[data-action="undo"]').isVisible(),'trial remains visible on popup home');
  assert.equal(await ui.locator('#moreActions').isVisible(),false,'trial does not require opening the secondary actions');
  await ui.locator('body').screenshot({path:path.join(scratch,'popup-active-trial.png')});
  await ui.goto('chrome-extension://'+extensionId+'/html/diagnostics.html?tabId='+tabId);
  await until(async()=>await ui.locator('[data-action="undo"]').isVisible(),'trial UI ready after popup visibility check');
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
  await until(async()=>!(await send({type:'PS_DIAG_GET',tabId})).state?.trial,'save from UI');
  assert.equal(await ui.locator('[data-action="confirm-save"]').count(),0,'a deliberate Save trial click does not open a second confirmation');
  assert.equal(await ui.locator('[data-verified]').count(),0,'no redundant verification checkbox');
  const stored=await ui.evaluate(()=>chrome.storage.local.get(['diagnosticSession','diagnosticTrial','userRules','userWhitelist']));
  assert.ok(stored.userRules.includes('challenge.diag.example'));
  assert.ok(!JSON.stringify(stored.diagnosticSession).includes('must-not-be-recorded'));
  assert.ok(!JSON.stringify(stored.diagnosticSession).includes('http://'));
  assert.ok(!stored.diagnosticTrial);
  // A user who already knows the target can add observed domains immediately.
  // The permanent rule path must not reload their page or replace their draft.
  response=await send({type:'PS_DIAG_START',tabId});
  assert.equal(response.success,true,JSON.stringify(response));
  const directCapture=await until(async()=>{
    const result=(await send({type:'PS_DIAG_GET',tabId})).state;
    return ['extra.diag.example','other.diag.example'].every(host=>result?.rows.some(row=>row.host===host&&row.completed>0))?result:null;
  },'fresh HTTP domains for direct permanent addition');
  await source.locator('#draft').fill('must keep this unsaved local draft');
  const loadId=await source.evaluate(()=>fixtureLoadId);
  const sourceUrl=source.url();
  const beforeRuleList=(await ui.evaluate(()=>chrome.storage.local.get('userRules'))).userRules;
  let automaticNavigations=0;
  source.on('framenavigated',frame=>{if(frame===source.mainFrame())automaticNavigations++;});
  const dialogs=[];
  ui.on('dialog',async dialog=>{dialogs.push(dialog.type());await dialog.dismiss();});
  await ui.goto('chrome-extension://'+extensionId+'/html/diagnostics.html?tabId='+tabId);
  await until(async()=>await ui.locator('input[data-host="extra.diag.example"]').count(),'direct add UI ready');
  await ui.evaluate(()=>{
    window.fixtureRuleMessages=[];
    const original=chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage=(message,...args)=>{
      if(['PS_DIAG_ADD_RULES','PS_DIAG_UNDO_RULES','PS_DIAG_RETRY_RULES'].includes(message?.type))window.fixtureRuleMessages.push(message);
      return original(message,...args);
    };
  });
  await ui.locator('input[data-host="extra.diag.example"]').check();
  await ui.locator('input[data-host="other.diag.example"]').check();
  await ui.locator('[data-action="add-rules"]').focus();
  await ui.keyboard.press('Enter');
  await ui.keyboard.press('Enter');
  const permanent=await until(async()=>{
    const result=(await send({type:'PS_DIAG_GET',tabId})).state;
    return result?.ruleUndo&&!result.ruleUndo.pendingApply?result:null;
  },'single-step permanent HTTP rules confirmed');
  assert.equal(permanent.trial,null,'direct addition never requires or creates a trial');
  assert.equal(permanent.ruleUndo.direction,'proxy');
  assert.deepEqual([...permanent.ruleUndo.hosts].sort(),['extra.diag.example','other.diag.example']);
  assert.equal(permanent.ruleUndo.canUndo,true);
  assert.equal(permanent.session.rulesChanged,true,'old network observations are marked stale instead of being presented as a new successful run');
  assert.ok(permanent.rows.every(row=>row.stale));
  assert.ok(!JSON.stringify(permanent.ruleUndo).includes('Digest'),'private integrity receipts are not exposed to UI');
  assert.equal(await ui.evaluate(()=>fixtureRuleMessages.filter(message=>message.type==='PS_DIAG_ADD_RULES').length),1,'rapid keyboard activation sends only one mutation');
  assert.deepEqual(dialogs,[],'normal permanent addition does not prompt a native confirmation');
  assert.equal(automaticNavigations,0,'adding rules does not automatically refresh the source page');
  assert.equal(source.url(),sourceUrl);
  assert.equal(await source.evaluate(()=>fixtureLoadId),loadId);
  assert.equal(await source.locator('#draft').inputValue(),'must keep this unsaved local draft');
  const immediatelyStored=(await ui.evaluate(()=>chrome.storage.local.get('userRules'))).userRules;
  assert.deepEqual(immediatelyStored,[...beforeRuleList,'extra.diag.example','other.diag.example']);
  const requestDomains=async()=>source.evaluate(async({hosts,port})=>{
    await Promise.all(hosts.map(host=>fetch('http://'+host+':'+port+'/verify-new-route?nonce='+Math.random()).then(response=>response.text())));
  },{hosts:['extra.diag.example','other.diag.example'],port:origin.address().port});
  const afterAddRequests=requests.length;
  await requestDomains();
  for(const host of ['extra.diag.example','other.diag.example'])assert.ok(requests.slice(afterAddRequests).some(item=>item.host===host&&item.viaProxy),host+': fresh requests use actual permanent PAC proxy route');
  await until(async()=>await ui.locator('[data-action="undo-rules"]').isVisible(),'permanent addition offers Undo in the UI');
  await ui.locator('[data-action="undo-rules"]').focus();
  await ui.keyboard.press('Enter');
  await until(async()=>{
    const result=(await send({type:'PS_DIAG_GET',tabId})).state;
    return result?.ruleUndo?.undone&&!result.ruleUndo.pendingApply;
  },'permanent HTTP addition undone');
  assert.deepEqual((await ui.evaluate(()=>chrome.storage.local.get('userRules'))).userRules,beforeRuleList,'Undo removes this batch only and keeps earlier manual/trial-saved rules');
  assert.equal(automaticNavigations,0,'Undo also preserves the current source page and draft');
  assert.equal(await source.locator('#draft').inputValue(),'must keep this unsaved local draft');
  const afterUndoRequests=requests.length;
  await requestDomains();
  for(const host of ['extra.diag.example','other.diag.example'])assert.ok(requests.slice(afterUndoRequests).some(item=>item.host===host&&!item.viaProxy),host+': fresh requests return to actual direct route after Undo');
  // The receipt guards against deleting a later edit from another settings tab.
  const secondAdd=await send({type:'PS_DIAG_ADD_RULES',sessionId:directCapture.session.id,hosts:['extra.diag.example'],direction:'proxy',actionId:'http-browser-foreign-edit'});
  assert.equal(secondAdd.success,true,JSON.stringify(secondAdd));
  await ui.evaluate(async()=>{
    const current=await chrome.storage.local.get('userRules');
    const saved=await new Promise(resolve=>chrome.runtime.sendMessage({type:'SAVE_CONFIGURATION',items:{userRules:[...current.userRules,'foreign.diag.example']},expected:{userRules:{exists:true,value:current.userRules}}},resolve));
    if(!saved.success)throw new Error(JSON.stringify(saved));
  });
  const refused=await send({type:'PS_DIAG_UNDO_RULES',undoId:secondAdd.state.ruleUndo.id});
  assert.equal(refused.success,false,'Undo must reject a later external configuration edit');
  assert.equal(refused.error,'rule_undo_conflict');
  const afterRefused=(await ui.evaluate(()=>chrome.storage.local.get('userRules'))).userRules;
  assert.ok(afterRefused.includes('extra.diag.example'));
  assert.ok(afterRefused.includes('foreign.diag.example'));
  assert.ok(beforeRuleList.every(host=>afterRefused.includes(host)));
  // Inject one controlled confirmation failure into the isolated worker. The
  // real storage commit remains visible and undoable, but the UI must never
  // claim the old PAC has changed until an actual retry is confirmed.
  await ui.reload();
  await until(async()=>await ui.locator('input[data-host="api.diag.example"]').count(),'failed application fixture ready');
  await worker.evaluate(()=>{
    globalThis.fixtureProxySettingsSet=chrome.proxy.settings.set;
    globalThis.fixtureRejectedProxyWrites=0;
    chrome.proxy.settings.set=()=>{fixtureRejectedProxyWrites++;throw new Error('isolated_test_application_failure');};
  });
  await ui.locator('input[data-host="api.diag.example"]').check();
  await ui.locator('[data-action="add-rules"]').click();
  const pendingApply=await until(async()=>{
    const result=(await send({type:'PS_DIAG_GET',tabId})).state;
    return result?.ruleUndo?.pendingApply&&result.ruleUndo.hosts.includes('api.diag.example')?result:null;
  },'failed permanent application retains pending receipt');
  assert.ok((await ui.evaluate(()=>chrome.storage.local.get('userRules'))).userRules.includes('api.diag.example'),'persisted rule is not discarded after a Chrome apply failure');
  await until(async()=>await ui.locator('[data-action="retry-rules"]').isVisible(),'pending rule offers explicit Retry');
  assert.equal(await ui.locator('.ps-diag-message').getAttribute('role'),'alert','pending application is shown as a problem, not false success');
  assert.equal(pendingApply.ruleUndo.canUndo,true,'failed application can still be undone');
  const beforeRetryPac=await ui.evaluate(()=>chrome.proxy.settings.get({}));
  assert.ok(await worker.evaluate(()=>fixtureRejectedProxyWrites>0),'the failure fixture really rejects the Chrome proxy application path');
  assert.ok(!beforeRetryPac.value.pacScript.data.includes('api.diag.example'),'old installed PAC is not mistaken for confirmed updated routing');
  assert.equal(await source.locator('#draft').inputValue(),'must keep this unsaved local draft');
  await worker.evaluate(()=>{chrome.proxy.settings.set=globalThis.fixtureProxySettingsSet;delete globalThis.fixtureProxySettingsSet;});
  await ui.locator('[data-action="retry-rules"]').click();
  await until(async()=>{
    const result=(await send({type:'PS_DIAG_GET',tabId})).state;
    return result?.ruleUndo?.id===pendingApply.ruleUndo.id&&!result.ruleUndo.pendingApply;
  },'retry confirms real current PAC without duplicating rules');
  const afterRetryRules=(await ui.evaluate(()=>chrome.storage.local.get('userRules'))).userRules;
  assert.equal(afterRetryRules.filter(host=>host==='api.diag.example').length,1,'retry applies existing configuration rather than adding again');
  const afterRetryRequests=requests.length;
  await source.evaluate(async port=>{await fetch('http://api.diag.example:'+port+'/failure').catch(()=>{});},origin.address().port);
  assert.ok(requests.slice(afterRetryRequests).some(item=>item.host==='api.diag.example'&&item.viaProxy),'retry really installs the new PAC route');
  await until(async()=>await ui.locator('[data-action="undo-rules"]').isVisible(),'retried rule retains Undo');
  await ui.locator('[data-action="undo-rules"]').click();
  await until(async()=>{
    const result=(await send({type:'PS_DIAG_GET',tabId})).state;
    return result?.ruleUndo?.undone&&!result.ruleUndo.pendingApply;
  },'retried failed application can be safely undone');
  assert.ok(!(await ui.evaluate(()=>chrome.storage.local.get('userRules'))).userRules.includes('api.diag.example'));
  assert.equal(await source.locator('#draft').inputValue(),'must keep this unsaved local draft');
  await ui.goto('chrome-extension://'+extensionId+'/html/diagnostics.html?tabId='+tabId);
  await until(async()=>/页面|请求|诊断/.test(await ui.locator('body').innerText()),'Chinese diagnostics');
  await ui.screenshot({path:path.join(scratch,'diagnostics-light.png'),fullPage:true});
  await ui.evaluate(()=>chrome.storage.local.set({theme:'dark'}));
  await new Promise(resolve=>setTimeout(resolve,300));
  await ui.screenshot({path:path.join(scratch,'diagnostics-dark.png'),fullPage:true});
  await ui.evaluate(()=>chrome.storage.local.set({appLanguage:'en'}));
  await until(async()=>/Page|Requests|diagnostics/i.test(await ui.locator('body').innerText()),'English diagnostics');
  await ui.evaluate(()=>chrome.storage.local.set({appLanguage:'zh_CN',theme:'light'}));
  // A fresh, explicit user capture yields a useful showcase: the new primary
  // operation with a selected dependency, not an old-result warning screenshot.
  response=await send({type:'PS_DIAG_START',tabId});
  assert.equal(response.success,true,JSON.stringify(response));
  await until(async()=>{
    const result=(await send({type:'PS_DIAG_GET',tabId})).state;
    return result?.rows.some(row=>row.host==='other.diag.example'&&row.completed>0)&&result.rows.some(row=>row.host==='api.diag.example'&&row.failed>0);
  },'fresh compact request showcase');
  await source.bringToFront();
  await ui.goto('chrome-extension://'+extensionId+'/html/popup.html');
  await until(async()=>/页面请求/.test(await ui.locator('#diagnosticsEntry').innerText()),'Chinese compact popup entry');
  await ui.locator('body').screenshot({path:path.join(scratch,'popup-home.png')});
  await ui.locator('#diagnosticsEntry').click();
  await until(async()=>ui.locator('input[data-host]').count(),'popup domain list');
  await ui.locator('[data-action="filter"][data-filter="different"]').click();
  await ui.locator('input[data-host="other.diag.example"]').check();
  await ui.evaluate(()=>{document.querySelector('.ps-diag-content').scrollTop=0;});
  const popupBounds=await ui.evaluate(()=>({height:document.body.scrollHeight,width:document.body.scrollWidth}));
  assert.ok(popupBounds.height<=600,JSON.stringify(popupBounds));
  assert.ok(popupBounds.width<=390,JSON.stringify(popupBounds));
  await ui.locator('body').screenshot({path:path.join(scratch,'popup-requests.png')});
  // Real popup controls exercise the worker-owned mode/write queues, not only
  // message mocks. All network requests remain on the isolated local fixtures.
  await ui.locator('[data-action="back"]').click();
  const actualMode=()=>ui.evaluate(()=>new Promise(resolve=>chrome.proxy.settings.get({},settings=>resolve(settings.value.mode))));
  await ui.locator('#mode-direct').focus();
  await ui.keyboard.press('Enter');
  await until(async()=>await actualMode()==='direct','keyboard mode change through worker');
  await until(async()=>await ui.locator('#mode-direct').getAttribute('aria-pressed')==='true','confirmed direct-mode highlight');
  await ui.locator('#mode-pac').click();
  await until(async()=>await actualMode()==='pac_script','Auto mode change through worker');
  await until(async()=>await ui.locator('#mode-pac').getAttribute('aria-pressed')==='true','confirmed Auto-mode highlight');
  await ui.locator('#addWhitelistBtn').click();
  await until(async()=>{
    const config=await ui.evaluate(()=>chrome.storage.local.get('userWhitelist'));
    return config.userWhitelist.includes('main.diag.example');
  },'popup whitelist saved through shared configuration gate');
  await until(async()=>!(await ui.locator('#removeWhitelistBtn').isDisabled()),'whitelist application confirmed');
  const beforeDirect=requests.length;
  await source.reload({waitUntil:'domcontentloaded'});
  assert.ok(requests.slice(beforeDirect).some(item=>item.host==='main.diag.example'&&!item.viaProxy),'whitelisted source actually reaches local origin directly');
  await moreActions(ui);
  await ui.locator('#removeWhitelistBtn').click();
  await until(async()=>!(await ui.locator('#addWhitelistBtn').isDisabled()),'whitelist undo confirmed');
  const afterUndo=await ui.evaluate(()=>chrome.storage.local.get(['userWhitelist','userRules']));
  assert.ok(!afterUndo.userWhitelist.includes('main.diag.example'));
  assert.ok(afterUndo.userRules.includes('main.diag.example'),'undo preserves the manual proxy rule');
  const beforeProxy=requests.length;
  await source.reload({waitUntil:'domcontentloaded'});
  assert.ok(requests.slice(beforeProxy).some(item=>item.host==='main.diag.example'&&item.viaProxy),'undo restores the actual local proxy route');
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
