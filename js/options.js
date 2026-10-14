// js/options.js

PSL.checkpoint('options', 'options.script_entered', { readyState: document.readyState });

const DEFAULT_GFWLIST_URL = 'https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt';
const LATENCY_TEST_URL = 'http://www.gstatic.com/generate_204';
const MAX_DISPLAY_RULES = 500;

let currentSection = 'server'; 
let currentRuleType = 'userRules'; 
let allData = {}; 
let configurationBaseline = {};
let allDataAvailable = true;
let diagnosticReadOnlyMode = false;
let editingServerId = null;
let serverEditGeneration = 0;
let customMessages = null; // 用于存储强制加载的语言包
let configurationWritePending = false;
let cloudOperationPending = false;
const controlLocks = new WeakMap();
const formDrafts = new Map();
let activeRuleEditor = null;
let ruleUndo = null;
let toastTimer = null;
let lastCloudAction = null;
const feedbackTimers = new Map();

// Draft fields remain editable during writes and never become the comparison
// baseline until the backend acknowledges that exact submitted value.
function bindDraft(id, key, checkbox = false) {
  const control = $('#' + id);
  if (!control) return;
  const read = () => checkbox ? !!control.checked : control.value;
  formDrafts.set(id, { key, read, rendered: read() });
}

function isDraft(id) {
  const draft = formDrafts.get(id);
  return !!draft && draft.read() !== draft.rendered;
}

function renderField(id, value, checkbox = false) {
  const control = $('#' + id);
  if (!control || isDraft(id)) return;
  if (checkbox) control.checked = !!value;
  else control.value = value || '';
  const draft = formDrafts.get(id);
  if (draft) draft.rendered = draft.read();
}

function acknowledgeDrafts(submitted) {
  formDrafts.forEach(draft => {
    if (Object.prototype.hasOwnProperty.call(submitted, draft.key) && draft.read() === submitted[draft.key]) draft.rendered = draft.read();
  });
}

function hasUnsavedConfigurationDrafts() {
  return [...formDrafts.keys()].some(isDraft) ||
    $('#serverForm').style.display === 'block' || !!activeRuleEditor ||
    !!$('#ruleAddInput').value.trim();
}

function setOperationStatus(id, message, kind = 'success') {
  const status = $('#' + id);
  if (!status) return;
  status.textContent = message;
  status.className = 'operation-status ' + kind;
  status.hidden = !message;
  status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}

function sectionStatusId(section = currentSection) {
  return ({ server: 'serverOperationStatus', rules: 'ruleOperationStatus', gfw: 'gfwOperationStatus', sync: 'cloudOperationStatus', about: 'generalOperationStatus' })[section];
}

function setButtonIcon(button, name, fallback = '') {
  if (typeof ProxySwitchUI !== 'undefined' && ProxySwitchUI.setIcon) ProxySwitchUI.setIcon(button, name);
  else button.textContent = fallback;
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const DIAGNOSTIC_CONTROL_IDS = new Set([
  'errorLogVerbose',
  'copyErrorLogsBtn',
  'clearErrorLogsBtn',
  'errorLogBox',
]);

// --- 核心：智能 i18n 函数 ---
// 如果加载了自定义语言包，优先使用；否则使用系统默认
const i18n = (key) => {
  if (customMessages && customMessages[key]) {
    return customMessages[key].message;
  }
  return chrome.i18n.getMessage(key) || "";
};

function enterDiagnosticReadOnlyMode(reason) {
  if (!diagnosticReadOnlyMode) {
    PSL.warn('options', 'Configuration locked: storage unavailable', reason || 'unknown');
  }
  diagnosticReadOnlyMode = true;
  allDataAvailable = false;

  document.body.classList.add('storage-readonly');
  const warning = $('#storageReadonlyWarning');
  if (warning) {
    warning.textContent = i18n('msgStorageReadOnlyMode') || 'Configuration storage is unavailable. Settings are locked to prevent data loss; only the diagnostic black box remains available.';
    warning.hidden = false;
  }

  $$('button, input, select, textarea').forEach((control) => {
    if (!DIAGNOSTIC_CONTROL_IDS.has(control.id)) {
      control.disabled = true;
      control.setAttribute('aria-disabled', 'true');
    }
  });

  $$('.menu-item').forEach((item) => {
    const isDiagnostics = item.dataset.target === 'about';
    item.classList.toggle('active', isDiagnostics);
    if (!isDiagnostics) item.setAttribute('aria-disabled', 'true');
  });
  $$('.section').forEach((section) => section.classList.toggle('active', section.id === 'section-about'));
  currentSection = 'about';
}

function writeConfiguration(items, callback, options = {}) {
  const statusId = options.statusId || sectionStatusId();
  if (diagnosticReadOnlyMode || !allDataAvailable) {
    PSL.warn('options', 'Configuration write blocked', Object.keys(items || {}).join(',') || 'unknown');
    showToast(i18n('msgStorageReadOnlyMode'), { kind: 'error', target: statusId });
    if (options.onFailure) options.onFailure({ code: 'storage_failed' });
    return false;
  }
  if (configurationWritePending) {
    showToast(i18n('msgConfigurationBusy'), { kind: 'error', target: statusId });
    if (options.onFailure) options.onFailure({ code: 'sync_busy' });
    return false;
  }
  configurationWritePending = true;
  // Keep an independent snapshot: some legacy callers construct edits by
  // mutating allData arrays, which must never change the comparison baseline.
  const submitted = cloneConfigurationValue(items);
  const expectedKeys = new Set(Object.keys(submitted));
  // Conflict checks and server selection depend on values we do not write.
  // Compare those dependencies inside the same backend mutation lease.
  if (expectedKeys.has('userRules')) expectedKeys.add('userWhitelist');
  if (expectedKeys.has('userWhitelist')) expectedKeys.add('userRules');
  if (expectedKeys.has('activeServerId')) expectedKeys.add('serverList');
  const expected = Object.fromEntries([...expectedKeys].map(key => [key,
    Object.prototype.hasOwnProperty.call(configurationBaseline, key)
      ? { exists: true, value: cloneConfigurationValue(configurationBaseline[key]) }
      : { exists: false },
  ]));
  const controls = lockControls(Array.from($$('button')).filter(control =>
    !control.dataset.target &&
    !['testLatencyBtn', 'toggleGfwPreviewBtn', 'ruleExportBtn', 'addServerBtn', 'cancelServerItemBtn'].includes(control.id) &&
    !control.classList.contains('btn-edit') && !control.classList.contains('rule-cancel')));
  let finished = false;
  const finish = (error, committed = submitted) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    configurationWritePending = false;
    unlockControls(controls);
    if (error) {
      PSL.error('options', 'Configuration write failed', error.code || 'storage_failed');
      showToast(i18n(error.code === 'config_changed' ? 'msgConfigurationChanged' : error.code === 'config_resetting' ? 'msgConfigurationBusy' : error.code === 'storage_timeout' ? 'msgStorageWriteTimeout' : 'msgStorageWriteFailed'), { kind: 'error', target: statusId });
      // A timed-out write may still commit. Lock further writes until reload.
      if (error.code === 'storage_timeout') enterDiagnosticReadOnlyMode('write timeout');
      if (error.code === 'config_changed') offerConfigurationReload(statusId);
      // Do not reload or render over an unsaved draft. A stale baseline keeps
      // rejecting writes safely until the user explicitly reloads this page.
      if (options.onFailure) options.onFailure(error);
      return;
    }
    Object.keys(submitted).forEach(key => {
      // The backend canonicalizes rules/server fields. Keep its acknowledged
      // values, never an unnormalized draft or unrelated response fields.
      const value = Object.prototype.hasOwnProperty.call(committed, key) ? committed[key] : submitted[key];
      allData[key] = cloneConfigurationValue(value);
      configurationBaseline[key] = cloneConfigurationValue(value);
    });
    acknowledgeDrafts(submitted);
    if (options.statusId) setOperationStatus(statusId, i18n('msgSaved'));
    if (callback) Promise.resolve().then(callback).catch(error => PSL.error('options', 'Configuration completion failed', error));
  };
  const timer = setTimeout(() => finish({ code: 'storage_timeout' }), 8000);
  try {
    chrome.runtime.sendMessage({ type: 'SAVE_CONFIGURATION', items: submitted, expected }, result => {
      // A broken response channel cannot prove that a dispatched write failed.
      // Lock further edits rather than issuing another potentially racing write.
      if (chrome.runtime.lastError || !result) finish({ code: 'storage_timeout' });
      else finish(result.success ? null : { code: result.error || 'storage_failed' }, result.items || submitted);
    });
  } catch (_) { finish({ code: 'storage_failed' }); }
  return true;
}

function commitConfiguration(items, statusId) {
  return new Promise(resolve => writeConfiguration(items, () => resolve(true), { statusId, onFailure: () => resolve(false) }));
}

function offerConfigurationReload(statusId) {
  const status = $('#' + statusId);
  if (!status) return;
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'btn btn-ghost btn-sm configuration-reload';
  button.textContent = i18n('btnRefreshSettings');
  button.onclick = () => { if (confirm(i18n('msgDiscardDraftsConfirm'))) window.location.reload(); };
  status.appendChild(button);
}

function cloneConfigurationValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function lockControls(controls) {
  const locked = [];
  controls.forEach(control => {
    if (DIAGNOSTIC_CONTROL_IDS.has(control.id)) return;
    const state = controlLocks.get(control) || { count: 0, disabled: !!control.disabled };
    state.count++;
    controlLocks.set(control, state);
    locked.push(control);
    control.disabled = true;
  });
  return locked;
}

function unlockControls(controls) {
  controls.forEach(control => {
    const state = controlLocks.get(control);
    if (!state || --state.count > 0) return;
    controlLocks.delete(control);
    if (!diagnosticReadOnlyMode) control.disabled = state.disabled;
  });
}

function releaseControlBusy(control) {
  // A network operation can finish while a storage write still owns the same
  // control. Update its eventual state rather than bypassing that write lock.
  const state = controlLocks.get(control);
  if (state) state.disabled = false;
  else if (!diagnosticReadOnlyMode) control.disabled = false;
}

function confirmConfiguration(title, lines, confirmKey = 'btnConfirmRestore') {
  const dialog = $('#configurationPreview');
  if (!dialog || typeof dialog.showModal !== 'function') return Promise.resolve(confirm(title + '\n\n' + lines.join('\n')));
  $('#configurationPreviewTitle').textContent = title;
  $('#configurationPreviewText').textContent = lines.join('\n');
  const approve = $('#configurationPreviewConfirm');
  const cancel = $('#configurationPreviewCancel');
  approve.textContent = i18n(confirmKey);
  return new Promise(resolve => {
    let done = false;
    const finish = accepted => {
      if (done) return;
      done = true;
      approve.onclick = null;
      cancel.onclick = null;
      dialog.oncancel = null;
      dialog.close();
      resolve(accepted);
    };
    approve.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    dialog.showModal();
    cancel.focus();
  });
}

window.addEventListener('error', (e) => {
  PSL.error('options', 'Uncaught error', e && e.error || {
    message: e && e.message,
    filename: e && e.filename,
    line: e && e.lineno,
    column: e && e.colno,
  });
});

window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  PSL.error('options', 'Unhandled rejection', r || String(e));
});

function sendMessageWithTimeout(message, timeoutMs, label, { recordPerformance = true } = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      PSL.warn('options', `${label} timeout`, `${timeoutMs}ms`);
      resolve({ timeout: true });
    }, timeoutMs);

    try { chrome.runtime.sendMessage(message, (res) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        PSL.error('options', `${label} sendMessage failed`, chrome.runtime.lastError.message);
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      if (recordPerformance) PSL.perf('options', label, t0, null, 300);
      resolve(res);
    }); } catch (_) {
      finished = true;
      clearTimeout(timer);
      resolve({ success: false, error: 'runtime_unavailable' });
    }
  });
}

// --- 初始化入口 ---
document.addEventListener('DOMContentLoaded', async () => {
  const initStartedAt = Date.now();
  PSL.checkpoint('options', 'options.dom_ready');
  // 1. 加载所有数据（包括语言设置）
  await loadAllData();
  
  // 2. 处理语言逻辑 (核心新增)
  const userLang = allData.appLanguage || 'auto';
  if (userLang !== 'auto') {
    try {
      // 强制去 _locales 目录加载对应的 json 文件
      const url = chrome.runtime.getURL(`_locales/${userLang}/messages.json`);
      const res = await fetch(url);
      customMessages = await res.json();
    } catch (e) {
      PSL.error('options', 'Failed to load language pack', e.message);
    }
  }

  // 3. 执行翻译 (现在会使用正确的语言)
  localizeHtmlPage();

  // 4. 自动设置版本号
  const manifest = chrome.runtime.getManifest();
  const footerVerEl = document.getElementById('appVersion');
  if (footerVerEl) footerVerEl.textContent = `v${manifest.version}`;
  const aboutVerEl = document.getElementById('aboutVersion');
  if (aboutVerEl) aboutVerEl.textContent = `v${manifest.version}`;
  
  // 5. 应用主题与初始化模块
  applyTheme(allData.theme || 'system');
  
  initNav();
  initLogModule();

  if (!allDataAvailable) {
    enterDiagnosticReadOnlyMode('initial storage read unavailable');
    PSL.checkpoint('options', 'options.init_done', {
      durationMs: Date.now() - initStartedAt,
      diagnosticReadOnly: true,
    });
    return;
  }

  initServerModule();
  initRuleModule();
  initGfwModule();
  initSyncModule();
  initGeneralModule(); // 这里会初始化语言下拉框
  
  renderAll();
  navigateToOptionsHash();
  window.addEventListener('hashchange', navigateToOptionsHash);
  PSL.checkpoint('options', 'options.init_done', { durationMs: Date.now() - initStartedAt });
});

// Diagnostics can link directly to rule management without changing any rules.
function navigateToOptionsHash() {
  const target = window.location.hash.slice(1);
  const item = Array.from($$('.menu-item')).find(entry => entry.dataset.target === target);
  if (item) item.click();
}

// --- 翻译函数 (保持之前的修复版) ---
function localizeHtmlPage() {
  if (document.title.includes('__MSG_')) {
    document.title = document.title.replace(/__MSG_(\w+)__/g, (m, key) => i18n(key) || m);
  }

  const attributes = ['placeholder', 'title', 'alt', 'value', 'aria-label'];
  const elements = document.querySelectorAll(attributes.map(attr => `[${attr}]`).join(','));
  elements.forEach(el => {
    attributes.forEach(attr => {
      const val = el.getAttribute(attr);
      if (val && val.includes('__MSG_')) {
        const newVal = val.replace(/__MSG_(\w+)__/g, (m, key) => i18n(key) || m);
        el.setAttribute(attr, newVal);
      }
    });
  });

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  let node;
  const nodesToReplace = [];
  
  while(node = walker.nextNode()) {
    if (node.nodeValue.includes('__MSG_')) {
      nodesToReplace.push(node);
    }
  }
  
  nodesToReplace.forEach(node => {
    const parent = node.parentNode;
    const translatedText = node.nodeValue.replace(/__MSG_(\w+)__/g, (m, key) => i18n(key) || m);
    
    if (translatedText.includes('<') && translatedText.includes('>')) {
       const temp = document.createElement('span');
       temp.innerHTML = translatedText;
       while (temp.firstChild) {
         parent.insertBefore(temp.firstChild, node);
       }
       parent.removeChild(node);
    } else {
       node.nodeValue = translatedText;
    }
  });
}

// --- 业务逻辑 ---

async function loadAllData() {
  return new Promise(resolve => {
    const t0 = Date.now();
    let finished = false;
    const finish = (items, available = true) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const protectedKeys = new Set([...formDrafts.values()].filter(draft => draft.read() !== draft.rendered).map(draft => draft.key));
      if ($('#serverForm')?.style.display === 'block') { protectedKeys.add('serverList'); protectedKeys.add('activeServerId'); }
      if (activeRuleEditor) protectedKeys.add(activeRuleEditor.type);
      const priorBaseline = configurationBaseline;
      allData = items || {};
      configurationBaseline = cloneConfigurationValue(allData);
      // A cloud restore may refresh committed values while another section has
      // a draft. Keep that draft's original expectation, never silently rebase it.
      protectedKeys.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(priorBaseline, key)) configurationBaseline[key] = cloneConfigurationValue(priorBaseline[key]);
        else delete configurationBaseline[key];
      });
      allDataAvailable = available;
      if (!available) enterDiagnosticReadOnlyMode('loadAllData');
      resolve(allData);
    };
    const timer = setTimeout(() => {
      PSL.warn('options', 'loadAllData timeout', '1500ms');
      finish({}, false);
    }, 1500);

    try {
      chrome.storage.local.get(null, (items) => {
        if (finished) return;
        if (chrome.runtime.lastError) {
          PSL.error('options', 'loadAllData failed', chrome.runtime.lastError.message);
          finish({}, false);
          return;
        }
        PSL.perf('options', 'loadAllData storage.get', t0, null, 500);
        finish(items);
      });
    } catch (error) {
      PSL.error('options', 'loadAllData API failed', error);
      finish({}, false);
    }
  });
}

function renderAll() {
  renderServerList();
  if (currentSection === 'rules') renderRuleList();
  
  updateGfwStatus(allData.ruleCount, allData.lastUpdate);
  if (allData.lastSyncTime) updateSyncUI(allData.lastSyncTime);
  
  const gfwInput = $('#gfwUrlInput');
  if (gfwInput) {
    renderField('gfwUrlInput', allData.gfwlistUrl || DEFAULT_GFWLIST_URL);
    gfwInput.style.display = 'block'; 
  }
  
  renderField('gitToken', allData.gitToken);
  renderField('davUrl', allData.davUrl);
  renderField('davUser', allData.davUser);
  renderField('davPass', allData.davPass);
  
  renderField('syncProvider', allData.syncProvider || 'github');
  renderField('autoSync', allData.autoSync || false, true);
  updateCloudUndoUI();
  switchSyncPanel();
}

function initNav() {
  $$('.menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const target = item.dataset.target;
      if (diagnosticReadOnlyMode && target !== 'about') {
        showToast(i18n('msgStorageReadOnlyMode'));
        return;
      }
      $$('.menu-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      $$('.menu-item').forEach(entry => entry.setAttribute('aria-current', entry === item ? 'page' : 'false'));
      $$('.section').forEach(sec => sec.classList.remove('active'));
      $(`#section-${target}`).classList.add('active');
      currentSection = target;
      if (target === 'rules') renderRuleList();
    });
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.click(); }
    });
  });
}

function initServerModule() {
  $('#addServerBtn').onclick = () => openServerEdit(null);
  $('#cancelServerItemBtn').onclick = closeServerEdit;
  $('#saveServerItemBtn').onclick = saveServer;
  ['editName', 'editScheme', 'editHost', 'editPort'].forEach(id => $('#' + id).addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); closeServerEdit(); }
    else if (event.key === 'Enter') { event.preventDefault(); saveServer(); }
  }));
  
  $('#testLatencyBtn').onclick = async () => {
    const testButton = $('#testLatencyBtn');
    if (testButton.disabled || diagnosticReadOnlyMode || !allDataAvailable) return;
    testButton.disabled = true;
    let config;
    try {
      config = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('proxy_timeout')), 5000);
        try {
          chrome.proxy.settings.get({}, details => {
            clearTimeout(timer);
            if (chrome.runtime.lastError || !details || !details.value) reject(new Error('proxy_unavailable'));
            else resolve(details);
          });
        } catch (error) { clearTimeout(timer); reject(error); }
      });
    } catch (_) {
      showToast(i18n('msgProxyStatusUnavailable'), { kind: 'error', target: 'serverOperationStatus' });
      releaseControlBusy(testButton);
      return;
    }
    const mode = config.value.mode;
    
    if (mode === 'direct' || mode === 'system') {
      if (!confirm(i18n("msgWarnDirect"))) { releaseControlBusy(testButton); return; }
    }
    const resEl = $('#latencyResult');
    resEl.style.display = 'block';
    resEl.style.color = 'var(--text-sub)';
    resEl.textContent = i18n('msgConnecting');
    $('#testLatencyBtn').disabled = true;

    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      await fetch(`${LATENCY_TEST_URL}?t=${Date.now()}`, { 
        mode: 'no-cors', 
        cache: 'no-store', 
        signal: controller.signal 
      });
      
      clearTimeout(timeoutId);
      const ms = Date.now() - start;
      let color = 'var(--success)'; 
      if (ms > 500) color = 'var(--warning)';
      if (ms > 1500) color = 'var(--danger)';
      resEl.style.color = color;
      resEl.textContent = i18n('msgSuccessLatency').replace('%MS%', ms);
    } catch (error) {
      PSL.error('options', 'Latency test failed', error.message);
      const isTimeout = error.name === 'AbortError';
      const errorMsg = isTimeout ? i18n("msgTimeout") : i18n("msgFail");
      resEl.style.color = 'var(--danger)';
      resEl.textContent = errorMsg;
    } finally {
      clearTimeout(timeoutId);
      releaseControlBusy(testButton);
    }
  };
}

function renderServerList() {
  const container = $('#serverListContainer');
  container.innerHTML = '';
  const servers = Array.isArray(allData.serverList) ? allData.serverList : [];
  const activeId = allData.activeServerId;

  if (servers.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'help-text';
    empty.textContent = i18n('msgNoServers');
    container.appendChild(empty);
  }

  servers.forEach(srv => {
    const el = document.createElement('div');
    el.className = `server-item ${srv.id === activeId ? 'active' : ''}`;
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'server-select';
    select.setAttribute('aria-pressed', String(srv.id === activeId));
    const name = document.createElement('span');
    name.className = 'server-name';
    name.textContent = String(srv.name || '') + (srv.id === activeId ? ' ' + i18n('msgUsing') : '');
    const address = document.createElement('span');
    address.className = 'server-address';
    address.textContent = `${srv.scheme}://${srv.host}:${srv.port}`;
    select.appendChild(name); select.appendChild(address);
    select.onclick = () => activateServer(srv.id);
    const actions = document.createElement('div');
    actions.className = 'server-actions';
    const edit = document.createElement('button');
    edit.type = 'button'; edit.className = 'btn btn-ghost btn-sm btn-icon btn-edit'; setButtonIcon(edit, 'pencil', i18n('btnEditRule'));
    edit.setAttribute('aria-label', i18n('btnEditServer').replace('%NAME%', String(srv.name || '')));
    edit.onclick = () => openServerEdit(srv.id);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'btn btn-ghost btn-sm btn-icon btn-del'; setButtonIcon(remove, 'trash', i18n('btnClearList'));
    remove.style.color = 'var(--danger)';
    remove.setAttribute('aria-label', i18n('btnDeleteServer').replace('%NAME%', String(srv.name || '')));
    remove.onclick = () => deleteServer(srv.id);
    actions.appendChild(edit); actions.appendChild(remove);
    el.appendChild(select); el.appendChild(actions);
    container.appendChild(el);
  });
}

function activateServer(id) {
  if (allData.activeServerId === id) return;
  writeConfiguration({ activeServerId: id }, () => {
    renderServerList();
    showToast(i18n('msgSwitchServer'), { target: 'serverOperationStatus' });
  }, { statusId: 'serverOperationStatus' });
}

function openServerEdit(id) {
  serverEditGeneration++;
  editingServerId = id;
  $('#serverForm').style.display = 'block';
  $('#addServerBtn').style.display = 'none';
  if (id) {
    const srv = allData.serverList.find(s => s.id === id);
    $('#editName').value = srv.name;
    $('#editScheme').value = srv.scheme;
    $('#editHost').value = srv.host;
    $('#editPort').value = srv.port;
  } else {
    $('#editName').value = i18n("msgNewServer");
    $('#editScheme').value = "SOCKS5";
    $('#editHost').value = "127.0.0.1";
    $('#editPort').value = "10808";
  }
  $('#editName').focus();
}

function closeServerEdit() {
  serverEditGeneration++;
  $('#serverForm').style.display = 'none';
  $('#addServerBtn').style.display = 'inline-flex';
}

function saveServer() {
  const name = $('#editName').value.trim() || "Unknown";
  const rawHost = $('#editHost').value.trim();
  
  if (!rawHost) {
    showToast(i18n('msgErrHost'), { kind: 'error', target: 'serverOperationStatus' });
    $('#editHost').focus();
    return;
  }

  let host = rawHost.replace(/^https?:\/\//i, '').replace(/^socks[45]?:\/\//i, '');
  if (!host) {
    showToast(i18n('msgErrValidHost'), { kind: 'error', target: 'serverOperationStatus' });
    $('#editHost').focus();
    return;
  }

  const portInput = $('#editPort').value.trim();
  let port = Number(portInput);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    showToast(i18n('msgErrPort'), { kind: 'error', target: 'serverOperationStatus' });
    $('#editPort').focus();
    return;
  }

  const scheme = $('#editScheme').value;
  let newSrv;
  try { newSrv = ProxySwitchConfiguration.validateServer({ id: editingServerId || generateUUID(), name, scheme, host, port }); }
  catch (_) { showToast(i18n('msgInvalidServer'), { kind: 'error', target: 'serverOperationStatus' }); return; }
  let list = [...(allData.serverList || [])];
  
  if (editingServerId) {
    const idx = list.findIndex(s => s.id === editingServerId);
    if (idx !== -1) list[idx] = newSrv;
  } else {
    list.push(newSrv);
  }
  
  const submittedForm = ['editName', 'editScheme', 'editHost', 'editPort'].map(id => $('#' + id).value);
  const submittedGeneration = serverEditGeneration;
  writeConfiguration({ serverList: list, activeServerId: allData.activeServerId || list[0]?.id || '' }, () => {
    // Typing may continue during the round-trip. Do not close over a newer edit.
    if (serverEditGeneration === submittedGeneration) {
      if (submittedForm.every((value, index) => value === $('#' + ['editName', 'editScheme', 'editHost', 'editPort'][index]).value)) closeServerEdit();
      else editingServerId = newSrv.id;
    }
    renderServerList();
    showToast(i18n('msgSaved'), { target: 'serverOperationStatus' });
    sendMessageWithTimeout({type: 'REFRESH_PROXY'}, 2000, 'REFRESH_PROXY').then(() => {});
  }, { statusId: 'serverOperationStatus' });
}

function deleteServer(id) {
  if (!confirm(i18n("msgConfirmDelServer"))) return;
  let list = allData.serverList.filter(s => s.id !== id);
  if (list.length === 0) return alert(i18n("msgKeepOne"));
  const activeServerId = allData.activeServerId === id ? list[0].id : allData.activeServerId;
  writeConfiguration({ serverList: list, activeServerId }, () => {
    renderServerList();
  }, { statusId: 'serverOperationStatus' });
}

function initRuleModule() {
  $('#ruleTypeSelect').onchange = (e) => {
    if (activeRuleEditor) { e.target.value = currentRuleType; showToast(i18n('msgDraftsUnsaved'), { kind: 'error', target: 'ruleOperationStatus' }); return; }
    currentRuleType = e.target.value; renderRuleList();
  };
  $('#ruleSearch').addEventListener('input', () => { if (!activeRuleEditor) renderRuleList(); });
  $('#ruleAddBtn').onclick = addRuleFromInput;
  $('#ruleAddInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addRuleFromInput(); } });
  $('#ruleClearBtn').onclick = () => {
    if (confirm(i18n("msgConfirmClearRules"))) {
      const type = currentRuleType;
      if (activeRuleEditor) { showToast(i18n('msgDraftsUnsaved'), { kind: 'error', target: 'ruleOperationStatus' }); return; }
      const previous = cloneConfigurationValue(allData[type] || []);
      if (!previous.length) return;
      writeConfiguration({ [type]: [] }, () => {
        registerRuleUndo(type, previous);
        renderRuleList(); showToast(i18n('msgRulesCleared'), { target: 'ruleOperationStatus' });
      }, { statusId: 'ruleOperationStatus' });
    }
  };
  const undo = $('#ruleUndoBtn');
  if (undo) undo.onclick = undoRuleRemoval;
  $('#ruleExportBtn').onclick = () => {
    const list = allData[currentRuleType] || [];
    const blob = new Blob([JSON.stringify(list, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `proxyswitch_${currentRuleType}.json`; a.click();
  };
  $('#ruleImportBtn').onclick = () => $('#ruleFile').click();
  $('#ruleFile').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        const type = currentRuleType;
        const rules = ProxySwitchConfiguration.validateRules(data, { allowWildcards: type === 'userRules' });
        const existing = ProxySwitchConfiguration.validateRules(allData[type] || [], { allowWildcards: type === 'userRules' });
        const otherType = type === 'userWhitelist' ? 'userRules' : 'userWhitelist';
        const opposite = new Set(allData[otherType] || []);
        const oppositeBefore = JSON.stringify(allData[otherType] || []);
        const additions = rules.filter(rule => !existing.includes(rule));
        const duplicateCount = data.length - additions.length;
        const conflicts = additions.filter(rule => opposite.has(rule)).length;
        const text = i18n('msgImportPreview').replace('%NEW%', additions.length).replace('%DUPLICATES%', duplicateCount).replace('%CONFLICTS%', conflicts);
        if (!(await confirmConfiguration(i18n('titleImportPreview'), [text, i18n('txtImportConflictHint')], 'btnConfirmImport'))) return;
        if (!additions.length) { showToast(i18n('msgImportNoChanges')); return; }
        // Re-read after confirmation; another extension page can edit rules meanwhile.
        const fresh = await readConfigurationSnapshot();
        if (!fresh) return;
        const latest = ProxySwitchConfiguration.validateRules(fresh[type] || [], { allowWildcards: type === 'userRules' });
        if (JSON.stringify(latest) !== JSON.stringify(existing) || JSON.stringify(fresh[otherType] || []) !== oppositeBefore) {
          showToast(i18n('msgImportPreviewStale'), { kind: 'error', target: 'ruleOperationStatus' });
          offerConfigurationReload('ruleOperationStatus');
          return;
        }
        const merged = [...new Set([...latest, ...rules])];
        writeConfiguration({ [type]: merged }, () => {
          renderRuleList(); showToast(i18n('msgImportCount').replace('%COUNT%', merged.length - latest.length), { target: 'ruleOperationStatus' });
        });
      } catch (e) {
        // JSON parser messages may echo fragments of the imported rule file.
        PSL.error('options', 'Rule import parse failed', {
          errorName: e && e.name ? e.name : 'Error',
          category: 'invalid-rule-json',
        });
        alert(i18n(e && e.code === 'invalid_rules' ? 'msgInvalidRules' : 'msgParseErr'));
      }
    };
    reader.onerror = () => {
      PSL.error('options', 'Rule file read failed', 'file_read_failed');
      alert(i18n('msgParseErr'));
    };
    reader.readAsText(file); e.target.value = '';
  };
}

function readConfigurationSnapshot() {
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { showToast(i18n('msgStorageReadOnlyMode'), { kind: 'error' }); finish(null); }, 1500);
    try { chrome.storage.local.get(null, value => {
      if (chrome.runtime.lastError) { showToast(i18n('msgStorageReadOnlyMode'), { kind: 'error' }); finish(null); }
      else finish(value || {});
    }); } catch (_) { finish(null); }
  });
}

function registerRuleUndo(type, previous) {
  ruleUndo = { type, previous: cloneConfigurationValue(previous), after: cloneConfigurationValue(configurationBaseline[type] || []) };
  const button = $('#ruleUndoBtn');
  if (button) button.hidden = false;
}

function undoRuleRemoval() {
  if (!ruleUndo || activeRuleEditor) return;
  const snapshot = ruleUndo;
  // The UI may have changed its own rules since deletion. Never restore an old
  // whole-list snapshot on top of those changes (or another page's changes).
  if (JSON.stringify(configurationBaseline[snapshot.type] || []) !== JSON.stringify(snapshot.after)) {
    showToast(i18n('msgRuleUndoUnavailable'), { kind: 'error', target: 'ruleOperationStatus' });
    return;
  }
  writeConfiguration({ [snapshot.type]: snapshot.previous }, () => {
    ruleUndo = null;
    $('#ruleUndoBtn').hidden = true;
    renderRuleList(); showToast(i18n('msgRuleUndoSuccess'), { target: 'ruleOperationStatus' });
  }, { statusId: 'ruleOperationStatus' });
}

function checkConflict(domain) {
  const otherType = currentRuleType === 'userRules' ? 'userWhitelist' : 'userRules';
  const otherList = allData[otherType] || [];
  if (otherList.includes(domain)) {
    const typeName = otherType === 'userRules' ? i18n("typeBlacklist") : i18n("typeWhitelist");
    return i18n("msgConflict").replace('%TYPE%', typeName);
  }
  return null;
}

function renderRuleList() {
  if (activeRuleEditor) return;
  const list = Array.isArray(allData[currentRuleType]) ? allData[currentRuleType].filter(rule => typeof rule === 'string') : [];
  const keyword = $('#ruleSearch').value.trim().toLowerCase();
  const filtered = list.filter(domain => domain.includes(keyword)).reverse();
  $('#currentRuleCount').textContent = list.length;
  const container = $('#ruleListContainer');
  container.innerHTML = '';
  const fragment = document.createDocumentFragment();
  filtered.slice(0, MAX_DISPLAY_RULES).forEach(domain => {
    const row = document.createElement('div'); row.className = 'rule-item';
    const text = document.createElement('span'); text.className = 'domain-text'; text.textContent = domain;
    const actions = document.createElement('div'); actions.className = 'rule-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'btn btn-ghost btn-sm btn-icon btn-edit';
    const editLabel = i18n('btnEditRule').replace('%RULE%', domain);
    edit.setAttribute('aria-label', editLabel); edit.title = editLabel;
    setButtonIcon(edit, 'pencil', i18n('btnEditRule'));
    edit.onclick = () => enableRuleEdit(row, domain);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-ghost btn-sm btn-icon btn-del btn-delete text-danger';
    const removeLabel = i18n('btnDeleteRule').replace('%RULE%', domain);
    remove.setAttribute('aria-label', removeLabel); remove.title = removeLabel;
    setButtonIcon(remove, 'trash', i18n('btnClearList'));
    remove.onclick = () => deleteRule(domain);
    actions.appendChild(edit); actions.appendChild(remove);
    row.appendChild(text); row.appendChild(actions); fragment.appendChild(row);
  });
  if (filtered.length > MAX_DISPLAY_RULES) {
    const more = document.createElement('p'); more.className = 'rule-more';
    more.textContent = i18n('msgMoreRules').replace('%SHOWN%', MAX_DISPLAY_RULES).replace('%REMAIN%', filtered.length - MAX_DISPLAY_RULES);
    fragment.appendChild(more);
  }
  if (!filtered.length) {
    const empty = document.createElement('p'); empty.className = 'rule-empty'; empty.textContent = i18n('msgNoRules');
    container.appendChild(empty);
  } else container.appendChild(fragment);
}

function normalizeEnteredRule(raw, type) {
  let domain = raw.trim().toLowerCase();
  try { domain = new URL(domain.includes('://') ? domain : 'http://' + domain).hostname; } catch (_) {}
  domain = domain.replace(/^\.+|\.+$/g, '');
  return ProxySwitchConfiguration.validateRules([domain], { allowWildcards: type === 'userRules' })[0];
}

function enableRuleEdit(row, oldDomain) {
  if (activeRuleEditor) { showToast(i18n('msgDraftsUnsaved'), { kind: 'error', target: 'ruleOperationStatus' }); return; }
  const type = currentRuleType;
  row.innerHTML = '';
  const input = document.createElement('input'); input.type = 'text'; input.className = 'rule-edit-input'; input.value = oldDomain;
  input.setAttribute('aria-label', i18n('btnEditRule').replace('%RULE%', oldDomain));
  input.spellcheck = false;
  const actions = document.createElement('div'); actions.className = 'rule-actions';
  const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'btn btn-primary btn-sm btn-icon rule-save';
  approve.setAttribute('aria-label', i18n('btnSave')); approve.title = i18n('btnSave'); setButtonIcon(approve, 'check', i18n('btnSave'));
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-ghost btn-sm btn-icon rule-cancel';
  cancel.setAttribute('aria-label', i18n('btnCancel')); cancel.title = i18n('btnCancel'); setButtonIcon(cancel, 'close', i18n('btnCancel'));
  const editor = { type, input, oldDomain };
  activeRuleEditor = editor;
  const close = () => { if (activeRuleEditor !== editor) return; activeRuleEditor = null; renderRuleList(); };
  const save = () => {
    let domain;
    try { domain = normalizeEnteredRule(input.value, type); }
    catch (_) { showToast(i18n('msgInvalidRules'), { kind: 'error', target: 'ruleOperationStatus' }); input.focus(); return; }
    if (domain === editor.oldDomain) { close(); return; }
    const list = [...(allData[type] || [])];
    if (list.includes(domain)) { showToast(i18n('msgDomainExist'), { kind: 'error', target: 'ruleOperationStatus' }); return; }
    const conflict = checkConflict(domain);
    if (conflict && !confirm(conflict + i18n('msgConfirmConflict'))) return;
    const index = list.indexOf(editor.oldDomain);
    if (index < 0) { showToast(i18n('msgConfigurationChanged'), { kind: 'error', target: 'ruleOperationStatus' }); return; }
    list[index] = domain;
    const submittedInput = input.value;
    writeConfiguration({ [type]: list }, () => {
      editor.oldDomain = domain;
      if (input.value === submittedInput) close();
      showToast(i18n('msgRuleModified'), { target: 'ruleOperationStatus' });
    }, { statusId: 'ruleOperationStatus' });
  };
  approve.onclick = save; cancel.onclick = close;
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); save(); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  actions.appendChild(approve); actions.appendChild(cancel);
  row.appendChild(input); row.appendChild(actions); input.focus();
}

function addRuleFromInput() {
  const input = $('#ruleAddInput');
  const raw = input.value;
  if (!raw.trim()) { showToast(i18n('msgEnterDomain'), { kind: 'error', target: 'ruleOperationStatus' }); return; }
  const type = currentRuleType;
  let domain;
  try { domain = normalizeEnteredRule(raw, type); }
  catch (_) { showToast(i18n('msgInvalidRules'), { kind: 'error', target: 'ruleOperationStatus' }); return; }
  const list = [...(allData[type] || [])];
  if (list.includes(domain)) { showToast(i18n('msgDomainExist'), { kind: 'error', target: 'ruleOperationStatus' }); return; }
  const conflict = checkConflict(domain);
  if (conflict && !confirm(conflict + i18n('msgConfirmConflict'))) return;
  list.push(domain);
  writeConfiguration({ [type]: list }, () => {
    if (input.value === raw) input.value = '';
    renderRuleList();
    showToast(i18n('msgRuleAdded').replace('%DOMAIN%', domain), { target: 'ruleOperationStatus' });
  }, { statusId: 'ruleOperationStatus' });
}

function deleteRule(domain) {
  if (activeRuleEditor) { showToast(i18n('msgDraftsUnsaved'), { kind: 'error', target: 'ruleOperationStatus' }); return; }
  const type = currentRuleType;
  const previous = cloneConfigurationValue(allData[type] || []);
  const list = previous.filter(rule => rule !== domain);
  if (list.length === previous.length) return;
  writeConfiguration({ [type]: list }, () => {
    registerRuleUndo(type, previous);
    renderRuleList();
    showToast(i18n('msgRuleDeleted').replace('%DOMAIN%', domain), { target: 'ruleOperationStatus' });
  }, { statusId: 'ruleOperationStatus' });
}

function initGfwModule() {
  $('#gfwUrlInput').value = allData.gfwlistUrl || DEFAULT_GFWLIST_URL;
  bindDraft('gfwUrlInput', 'gfwlistUrl');
  $('#saveGfwUrlBtn').onclick = async () => {
    if (await saveGfwSource()) showToast(i18n('msgSaved'), { target: 'gfwOperationStatus' });
  };
  $('#gfwUrlInput').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); $('#saveGfwUrlBtn').click(); }
  });

  // 镜像源快捷按钮
  $$('.gfw-mirror-btn').forEach(btn => {
    btn.onclick = () => {
      const url = btn.dataset.url;
      $('#gfwUrlInput').value = url;
      setOperationStatus('gfwOperationStatus', i18n('txtGfwDraftHint'), 'warning');
    };
  });

  updateGfwStatus(allData.ruleCount, allData.lastUpdate);

  $('#updateGfwBtn').onclick = async () => {
    const targetUrl = $('#gfwUrlInput').value.trim();
    if (!targetUrl) {
      showToast(i18n('msgErrUrl'), { kind: 'error', target: 'gfwOperationStatus' });
      $('#gfwUrlInput').focus();
      return;
    }
    try {
      const url = new URL(targetUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_url');
    } catch (_) {
      showToast(i18n('msgErrHttp'), { kind: 'error', target: 'gfwOperationStatus' });
      return;
    }
    
    const btn = $('#updateGfwBtn');
    const originalBtnHtml = btn.innerHTML;
    btn.textContent = i18n("msgDownloading"); 
    btn.disabled = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
      if (!(await saveGfwSource(targetUrl))) return;
      const downloadBaseline = cloneConfigurationValue(configurationBaseline);
      const response = await fetch(targetUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(`Status: ${response.status}`);
      const responseText = await response.text();
      let decodedText = "";
      try {
        const cleanBase64 = responseText.replace(/\s/g, '');
        decodedText = atob(cleanBase64);
      } catch (e) {
        decodedText = responseText;
      }
      
      const lines = decodedText.split(/\r?\n/);
      const validDomains = new Set();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('!') || line.startsWith('[') || line.startsWith('@')) continue;
        let cleanLine = line.replace(/^\|\|/, '').replace(/^\|/, '').replace(/^https?:\/\//, '').replace(/^\.+/, '');
        const domainMatch = cleanLine.match(/^([a-zA-Z0-9\-\.\_\u4e00-\u9fa5]+)/);
        if (domainMatch) {
          const extractedDomain = domainMatch[1];
          if (extractedDomain.includes('.') && !extractedDomain.includes('*')) validDomains.add(extractedDomain);
        }
      }
      
      const domainArray = ProxySwitchConfiguration.validateRules(Array.from(validDomains), { allowWildcards: false });
      const updateTime = new Date().toLocaleString();
      if (domainArray.length === 0) throw new Error("No domains parsed");

      if (['gfwlistUrl', 'gfwDomains', 'ruleCount', 'lastUpdate'].some(key =>
        JSON.stringify(configurationBaseline[key]) !== JSON.stringify(downloadBaseline[key]))) {
        showToast(i18n('msgConfigurationChanged'), { kind: 'error', target: 'gfwOperationStatus' });
        return;
      }

      const committed = await commitConfiguration({
        gfwDomains: domainArray,
        ruleCount: domainArray.length,
        lastUpdate: updateTime,
        gfwlistUrl: targetUrl
      }, 'gfwOperationStatus');
      if (committed) {
        updateGfwStatus(domainArray.length, updateTime);
        showToast(i18n('msgUpdateSuccess').replace('%COUNT%', domainArray.length), { target: 'gfwOperationStatus' });
        sendMessageWithTimeout({type: 'REFRESH_PROXY'}, 2000, 'REFRESH_PROXY').then(() => {});
      }

    } catch(error) {
      PSL.error('options', 'GFWList update failed', error.message);
      const isNetworkError = error.message.includes('Failed to fetch') || error.message.includes('NetworkError') || error.message.includes('Status: 404') || error.message.includes('Status: 403');
      const hint = isNetworkError ? '\n\n' + i18n("msgGfwNetworkHint") : '';
      showToast(i18n('msgUpdateFail') + ': ' + (error.name === 'AbortError' ? i18n('msgTimeout') : error.message) + hint, { kind: 'error', target: 'gfwOperationStatus' });
    } finally {
      clearTimeout(timer);
      btn.innerHTML = originalBtnHtml;
      releaseControlBusy(btn);
    }
  };

  const toggleBtn = $('#toggleGfwPreviewBtn');
  const previewArea = $('#gfwPreviewArea');
  const arrow = $('#gfwPreviewArrow');
  const textBox = $('#gfwContentBox');

  toggleBtn.onclick = () => {
    const isHidden = previewArea.style.display === 'none';
    toggleBtn.setAttribute('aria-expanded', String(isHidden));
    if (isHidden) {
      previewArea.style.display = 'block';
      arrow.style.transform = 'rotate(180deg)';
      if (!textBox.value || allData.lastUpdate !== textBox.dataset.lastVer) {
        const list = allData.gfwDomains || [];
        textBox.value = list.length > 0 ? list.join('\n') : `(${i18n("phGfwPreview")})`;
        textBox.dataset.lastVer = allData.lastUpdate;
      }
    } else {
      previewArea.style.display = 'none';
      arrow.style.transform = 'rotate(0deg)';
    }
  };
  // Native button handles Enter/Space; no synthetic second click.
}

async function saveGfwSource(value = $('#gfwUrlInput').value.trim()) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_url');
  } catch (_) {
    showToast(i18n('msgErrHttp'), { kind: 'error', target: 'gfwOperationStatus' });
    $('#gfwUrlInput').focus(); return false;
  }
  if (configurationBaseline.gfwlistUrl === value) return true;
  return commitConfiguration({ gfwlistUrl: value }, 'gfwOperationStatus');
}

function updateGfwStatus(c, t) { 
    $('#gfwStatus').textContent = c ? i18n("statusCached").replace('%COUNT%', c).replace('%TIME%', t) : i18n("statusNotLoaded"); 
}

function initSyncModule() {
  ['gitToken', 'davUrl', 'davUser', 'davPass', 'syncProvider'].forEach(id => bindDraft(id, id));
  bindDraft('autoSync', 'autoSync', true);
  $('#syncProvider').onchange = switchSyncPanel;
  // Blur must not start a save and disable the upload/restore button between
  // pointerdown and click. These fields remain drafts until explicit save or
  // the cloud action's existing guarded commit.
  $('#saveSyncSettingsBtn').onclick = async () => {
    if (cloudOperationPending || configurationWritePending) return;
    const drafts = readSyncDrafts();
    const saved = !Object.keys(drafts).length || await commitConfiguration(drafts, 'cloudOperationStatus');
    if (saved) showToast(i18n('msgSaved'), { target: 'cloudOperationStatus' });
  };
  
  const upload = () => runCloudOperation(async () => {
    showToast(i18n('msgUploading'));
    const result = await cloudRequest({ type: 'MANUAL_SYNC_UPLOAD' });
    if (!result) return;
    if (result.time) updateSyncUI(result.time);
    showToast(i18n('msgUploadSuccess'), { target: 'cloudOperationStatus' });
  });
  const restore = () => runCloudOperation(async () => {
    showToast(i18n('msgDownloadingBg'));
    const preview = await cloudRequest({ type: 'MANUAL_SYNC_PREVIEW' });
    if (!preview) return;
    const labels = { userRules: 'selUserRules', userWhitelist: 'selUserWhitelist', serverList: 'menuServer', activeServerId: 'lblActiveServer', gfwlistUrl: 'lblGfwUrl' };
    const lines = (preview.summary && preview.summary.fields || []).map(field => {
      let line = i18n(labels[field.key] || 'lblConfigurationField');
      if (typeof field.count === 'number') line += ': ' + (typeof field.previousCount === 'number' ? field.previousCount + ' → ' : '') + field.count;
      else line += ': ' + i18n('txtRestoreFieldReplace');
      if (field.clears) line += ' — ' + i18n('txtRestoreClears');
      return line;
    });
    lines.push('', i18n('txtRestoreScope'), i18n('txtRestoreUndoHint'));
    if (!(await confirmConfiguration(i18n('titleRestorePreview'), lines))) {
      setOperationStatus('cloudOperationStatus', i18n('msgCloudCanceled'), 'warning'); return;
    }
    const result = await cloudRequest({ type: 'MANUAL_SYNC_DOWNLOAD', previewId: preview.previewId });
    if (!result) return;
    await loadAllData(); renderAll();
    showToast(i18n(result.applyPending ? 'msgRestoreApplyPending' : 'msgDownloadSuccess'), { kind: result.applyPending ? 'warning' : 'success', target: 'cloudOperationStatus' });
  });
  const undo = $('#cloudUndoBtn');
  const undoRestore = () => runCloudOperation(async () => {
    if (!(await confirmConfiguration(i18n('titleRestoreUndo'), [i18n('txtRestoreUndoConfirm')], 'btnConfirmUndo'))) {
      setOperationStatus('cloudOperationStatus', i18n('msgCloudCanceled'), 'warning'); return;
    }
    const result = await cloudRequest({ type: 'MANUAL_SYNC_UNDO' });
    if (!result) return;
    await loadAllData(); renderAll();
    showToast(i18n(result.applyPending ? 'msgRestoreApplyPending' : 'msgRestoreUndoSuccess'), { kind: result.applyPending ? 'warning' : 'success', target: 'cloudOperationStatus' });
  });
  $('#cloudUploadBtn').onclick = () => startCloudAction(upload);
  $('#cloudDownloadBtn').onclick = () => startCloudAction(restore);
  if (undo) undo.onclick = () => startCloudAction(undoRestore);
  const retry = $('#cloudRetryBtn');
  if (retry) retry.onclick = () => lastCloudAction && lastCloudAction();
  chrome.storage.onChanged.addListener(refreshCloudMetadata);
}

function startCloudAction(action) {
  if (cloudOperationPending || configurationWritePending || diagnosticReadOnlyMode || !allDataAvailable) return;
  lastCloudAction = action;
  return action();
}

function refreshCloudMetadata(changes, area) {
  if (area !== 'local') return;
  // Never reload business fields here: doing so would silently replace the
  // optimistic comparison baseline while the user is editing another section.
  if (Object.prototype.hasOwnProperty.call(changes, 'lastSyncTime')) {
    const time = changes.lastSyncTime.newValue;
    if (time === undefined) delete allData.lastSyncTime;
    else allData.lastSyncTime = time;
    updateSyncUI(time || '');
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'cloudRestoreUndo')) {
    const value = changes.cloudRestoreUndo.newValue;
    if (value === undefined) delete allData.cloudRestoreUndo;
    else allData.cloudRestoreUndo = value;
    updateCloudUndoUI();
  }
}

function updateCloudUndoUI() {
  const undo = $('#cloudUndoBtn');
  if (!undo) return;
  const disabled = !allData.cloudRestoreUndo;
  const lock = controlLocks.get(undo);
  if (lock) { lock.disabled = disabled; undo.disabled = true; }
  else undo.disabled = disabled || cloudOperationPending || configurationWritePending || diagnosticReadOnlyMode;
}

async function runCloudOperation(operation) {
  if (cloudOperationPending || configurationWritePending || diagnosticReadOnlyMode || !allDataAvailable) return;
  cloudOperationPending = true;
  const controls = lockControls($$('#section-sync button'));
  const retry = $('#cloudRetryBtn');
  if (retry) retry.hidden = true;
  setOperationStatus('cloudOperationStatus', i18n('msgCloudWorking'), 'working');
  try {
    const drafts = readSyncDrafts();
    if (Object.keys(drafts).length && !(await commitConfiguration(drafts, 'cloudOperationStatus'))) {
      if (retry) retry.hidden = !lastCloudAction;
      return;
    }
    await operation();
  }
  catch (error) {
    PSL.error('options', 'Cloud operation failed', error.code || 'internal_error');
    showToast(i18n('msgCloudFailed'), { kind: 'error', target: 'cloudOperationStatus' });
    if (retry) retry.hidden = !lastCloudAction;
  }
  finally {
    cloudOperationPending = false;
    unlockControls(controls);
    updateCloudUndoUI();
  }
}

async function cloudRequest(message) {
  const startedAt = Date.now();
  // Cloud latency includes network and queue waits. Persist the outcome, but do
  // not classify a normal reply using the short local-operation slow threshold.
  const result = await sendMessageWithTimeout(message, 60000, message.type, { recordPerformance: false });
  const durationMs = Date.now() - startedAt;
  if (result && result.success) {
    PSL.info('options', `${message.type} ${durationMs}ms`,
      result.applyPending ? 'result=success proxyApply=pending' : 'result=success');
    return result;
  }
  const code = result && (result.timeout ? 'timeout' : result.error) || 'internal_error';
  const keys = {
    invalid_backup: 'msgInvalidBackup', unsupported_backup_version: 'msgUnsupportedBackupVersion',
    preview_expired: 'msgRestorePreviewExpired', restore_modified: 'msgRestorePreviewStale',
    undo_unavailable: 'msgRestoreUndoUnavailable', invalid_rules: 'msgInvalidRules', invalid_server: 'msgInvalidServer',
    network_timeout: 'msgCloudTimeout', timeout: 'msgCloudTimeout', sync_busy: 'msgCloudBusy',
    storage_failed: 'msgStorageWriteFailed', storage_timeout: 'msgStorageWriteTimeout',
    insecure_backup_url: 'msgInsecureBackupUrl', invalid_backup_url: 'msgInvalidBackupUrl',
    missing_credentials: 'msgMissingBackupCredentials', public_gist: 'msgPublicGistRejected',
    backup_not_found: 'msgBackupNotFound', backup_too_large: 'msgBackupTooLarge', gist_search_limit: 'msgGistSearchLimit',
  };
  PSL.error('options', `${message.type} failed ${durationMs}ms`, code);
  showToast(i18n(keys[code] || 'msgCloudFailed'), { kind: 'error', target: 'cloudOperationStatus' });
  const retry = $('#cloudRetryBtn');
  if (retry) retry.hidden = !lastCloudAction;
  return null;
}

function updateSyncUI(time) {
    const el = $('#syncStatusBadge');
    el.textContent = time ? i18n('msgStatusLast') + time : i18n('statusNotBacked');
    el.className = time ? 'server-tag synced' : 'server-tag';
    el.style.background = time ? 'var(--primary-light)' : 'var(--bg-body)';
    el.style.color = time ? 'var(--primary)' : 'var(--text-sub)';
}

function readSyncDrafts() {
  const fields = ['syncProvider', 'autoSync', 'gitToken', 'davUrl', 'davUser', 'davPass'];
  return Object.fromEntries(fields.filter(isDraft).map(id => [formDrafts.get(id).key, formDrafts.get(id).read()]));
}

function renderSyncPanel(mode) {
  $('#panelGithub').style.display = mode === 'github' ? 'block' : 'none';
  $('#panelWebdav').style.display = mode === 'webdav' ? 'block' : 'none';
}
function switchSyncPanel() { renderSyncPanel($('#syncProvider').value); }

function initGeneralModule() {
  $('#themeSelect').value = allData.theme || 'system';
  bindDraft('themeSelect', 'theme');
  $('#themeSelect').onchange = (e) => {
    const theme = e.target.value;
    writeConfiguration({ theme }, () => { applyTheme(theme); showToast(i18n('msgSaved'), { target: 'generalOperationStatus' }); }, { statusId: 'generalOperationStatus' });
  };
  
  // --- 语言选择逻辑 ---
  const langSelect = document.getElementById('langSelect');
  if (langSelect) {
    langSelect.value = allData.appLanguage || 'auto';
    bindDraft('langSelect', 'appLanguage');
    langSelect.onchange = (e) => {
      writeConfiguration({ appLanguage: e.target.value }, () => {
        // Check after acknowledgement: users can keep typing while the save is
        // pending. A language change must not silently discard those drafts.
        if (hasUnsavedConfigurationDrafts()) {
          showToast(i18n('msgLanguageSavedReload'), { kind: 'warning', target: 'generalOperationStatus' });
          offerConfigurationReload('generalOperationStatus');
          return;
        }
        window.location.reload();
      }, { statusId: 'generalOperationStatus' });
    };
  }

  $('#resetAppBtn').onclick = async () => {
    if (diagnosticReadOnlyMode || !allDataAvailable || configurationWritePending || cloudOperationPending) return;
    if (!confirm(i18n('msgConfirmReset'))) return;
    configurationWritePending = true;
    const controls = lockControls($$('button, input, select, textarea'));
    try {
      const result = await sendMessageWithTimeout({ type: 'RESET_CONFIGURATION' }, 8000, 'RESET_CONFIGURATION');
      if (!result || !result.success) {
        const code = result && result.error;
        showToast(i18n(code === 'config_resetting' ? 'msgConfigurationBusy' : result && result.timeout ? 'msgStorageWriteTimeout' : 'msgStorageWriteFailed'), { kind: 'error', target: 'generalOperationStatus' });
        if (!result || result.timeout || !['storage_failed', 'config_resetting'].includes(code)) enterDiagnosticReadOnlyMode('reset response unavailable');
        return;
      }
      // Clear page-side evidence only after the backend confirms the reset.
      PSL.clearPageDiagnostics();
      chrome.runtime.reload();
    } finally {
      configurationWritePending = false;
      unlockControls(controls);
    }
  };
}

function applyTheme(theme) {
  if (typeof ProxySwitchUI !== 'undefined' && ProxySwitchUI.applyTheme) { ProxySwitchUI.applyTheme(theme); return; }
  const doc = document.documentElement;
  if (theme === 'dark') doc.setAttribute('data-theme', 'dark');
  else if (theme === 'light') doc.setAttribute('data-theme', 'light');
  else doc.removeAttribute('data-theme');
}
function showToast(msg, { kind = 'success', target = sectionStatusId() } = {}) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); toastTimer = null; }, 3000);
  if (!target) return;
  if (feedbackTimers.has(target)) clearTimeout(feedbackTimers.get(target));
  feedbackTimers.delete(target);
  setOperationStatus(target, msg, kind);
  if (kind === 'success' && target !== 'cloudOperationStatus') {
    feedbackTimers.set(target, setTimeout(() => { setOperationStatus(target, ''); feedbackTimers.delete(target); }, 3000));
  }
}

function initLogModule() {
  const logBox = $('#errorLogBox');
  const verboseCb = $('#errorLogVerbose');
  if (!logBox || !verboseCb) return;
  let refreshTimer = null;
  let refreshRequestId = 0;
  let refreshChain = Promise.resolve();

  const refreshLogs = () => {
    const requestId = ++refreshRequestId;
    const task = refreshChain.then(async () => {
      if (requestId !== refreshRequestId) return;
      try {
        const report = await PSL.getDiagnosticReport();
        if (requestId === refreshRequestId) {
          logBox.value = report || i18n('phErrorLogEmpty');
        }
      } catch (error) {
        // Do not persist this failure: if diagnostic storage itself is unavailable,
        // logging here would trigger storage.onChanged and create a refresh loop.
        console.error('[ProxySwitch][blackbox] Report refresh failed', error);
        if (requestId === refreshRequestId) logBox.value = i18n('phErrorLogEmpty');
      }
    });
    refreshChain = task.catch(() => {});
    return task;
  };

  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshLogs();
    }, 120);
  };

  PSL.getVerbose().then((v) => { verboseCb.checked = v; });
  verboseCb.onchange = () => PSL.setVerbose(verboseCb.checked);

  $('#copyErrorLogsBtn').onclick = async () => {
    const requestId = ++refreshRequestId;
    let report;
    try {
      report = await PSL.getDiagnosticReport();
    } catch (error) {
      console.error('[ProxySwitch][blackbox] Report generation failed', error);
      showToast(i18n('msgLogsCopyFail'), { kind: 'error', target: 'generalOperationStatus' });
      return;
    }
    if (requestId === refreshRequestId) logBox.value = report || i18n('phErrorLogEmpty');

    try {
      await navigator.clipboard.writeText(report);
      showToast(i18n('msgLogsCopied'));
    } catch (e) {
      try {
        logBox.value = report;
        logBox.select();
        const ok = document.execCommand('copy');
        showToast(ok ? i18n('msgLogsCopied') : i18n('msgLogsCopyFail'), { kind: ok ? 'success' : 'error', target: 'generalOperationStatus' });
        if (requestId !== refreshRequestId) scheduleRefresh();
      } catch (e2) {
        showToast(i18n('msgLogsCopyFail'), { kind: 'error', target: 'generalOperationStatus' });
      }
    }
  };

  $('#clearErrorLogsBtn').onclick = async () => {
    if (!confirm(i18n('msgConfirmClearLogs'))) return;
    try {
      await PSL.clearLogs();
      await refreshLogs();
      showToast(i18n('msgLogsCleared'));
    } catch (error) {
      PSL.error('options', 'blackbox.clear_failed', error);
      showToast(i18n('msgLogsCopyFail'), { kind: 'error', target: 'generalOperationStatus' });
    }
  };

  refreshLogs();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && PSL.isDiagnosticStorageChange(changes)) scheduleRefresh();
  });
  window.addEventListener('storage', (event) => {
    if (PSL.isDiagnosticPageStorageKey(event.key)) scheduleRefresh();
  });
}
