// js/options.js

const DEFAULT_GFWLIST_URL = 'https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt';
const LATENCY_TEST_URL = 'http://www.gstatic.com/generate_204';
const MAX_DISPLAY_RULES = 500;

let currentSection = 'server'; 
let currentRuleType = 'userRules'; 
let allData = {}; 
let editingServerId = null;
let customMessages = null; // 用于存储强制加载的语言包

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// --- 核心：智能 i18n 函数 ---
// 如果加载了自定义语言包，优先使用；否则使用系统默认
const i18n = (key) => {
  if (customMessages && customMessages[key]) {
    return customMessages[key].message;
  }
  return chrome.i18n.getMessage(key) || "";
};

// --- 初始化入口 ---
document.addEventListener('DOMContentLoaded', async () => {
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
      console.error("Failed to load language:", e);
    }
  }

  // 3. 执行翻译 (现在会使用正确的语言)
  localizeHtmlPage();

  // 4. 自动设置版本号
  const manifest = chrome.runtime.getManifest();
  const footerVerEl = document.getElementById('appVersion');
  if (footerVerEl) footerVerEl.textContent = `Version ${manifest.version}`;
  const aboutVerEl = document.getElementById('aboutVersion');
  if (aboutVerEl) aboutVerEl.textContent = `v${manifest.version}`;
  
  // 5. 应用主题与初始化模块
  applyTheme(allData.theme || 'system');
  
  initNav();
  initServerModule();
  initRuleModule();
  initGfwModule();
  initSyncModule();
  initGeneralModule(); // 这里会初始化语言下拉框
  
  renderAll();
});

// --- 翻译函数 (保持之前的修复版) ---
function localizeHtmlPage() {
  if (document.title.includes('__MSG_')) {
    document.title = document.title.replace(/__MSG_(\w+)__/g, (m, key) => i18n(key) || m);
  }

  const attributes = ['placeholder', 'title', 'alt', 'value'];
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
    chrome.storage.local.get(null, (items) => {
      allData = items;
      resolve(items);
    });
  });
}

function renderAll() {
  renderServerList();
  if (currentSection === 'rules') renderRuleList();
  
  updateGfwStatus(allData.ruleCount, allData.lastUpdate);
  if (allData.lastSyncTime) updateSyncUI(allData.lastSyncTime);
  
  const gfwInput = $('#gfwUrlInput');
  if (gfwInput) {
    gfwInput.value = allData.gfwlistUrl || '';
    gfwInput.style.display = 'block'; 
  }
  
  $('#gitToken').value = allData.gitToken || '';
  $('#davUrl').value = allData.davUrl || '';
  $('#davUser').value = allData.davUser || '';
  $('#davPass').value = allData.davPass || '';
  
  $('#syncProvider').value = allData.syncProvider || 'github';
  $('#autoSync').checked = allData.autoSync || false;
  switchSyncPanel();
}

function initNav() {
  $$('.menu-item').forEach(item => {
    item.addEventListener('click', () => {
      $$('.menu-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const target = item.dataset.target;
      $$('.section').forEach(sec => sec.classList.remove('active'));
      $(`#section-${target}`).classList.add('active');
      currentSection = target;
      if (target === 'rules') renderRuleList();
    });
  });
}

function initServerModule() {
  $('#addServerBtn').onclick = () => openServerEdit(null);
  $('#cancelServerItemBtn').onclick = closeServerEdit;
  $('#saveServerItemBtn').onclick = saveServer;
  
  $('#testLatencyBtn').onclick = async () => {
    const config = await new Promise(r => chrome.proxy.settings.get({}, r));
    const mode = config.value.mode;
    
    if (mode === 'direct' || mode === 'system') {
      if (!confirm(i18n("msgWarnDirect"))) return;
    }
    const resEl = $('#latencyResult');
    resEl.style.display = 'block';
    resEl.innerHTML = `<span style="color:var(--text-sub)">${i18n("msgConnecting")}</span>`;
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
      resEl.innerHTML = `<span style="color:${color}; font-weight:bold;">${i18n("msgSuccessLatency").replace('%MS%', ms)}</span>`;
    } catch (error) {
      const isTimeout = error.name === 'AbortError';
      const errorMsg = isTimeout ? i18n("msgTimeout") : i18n("msgFail");
      resEl.innerHTML = `<span style="color:var(--danger); font-weight:bold;">❌ ${errorMsg}</span>`;
    } finally {
      $('#testLatencyBtn').disabled = false;
    }
  };
}

function renderServerList() {
  const container = $('#serverListContainer');
  container.innerHTML = '';
  const servers = allData.serverList || [];
  const activeId = allData.activeServerId;

  if (servers.length === 0) {
    const def = { id: 'default', name: 'Default', scheme: 'SOCKS5', host: '127.0.0.1', port: 10808 };
    allData.serverList = [def];
    allData.activeServerId = 'default';
    chrome.storage.local.set({ serverList: [def], activeServerId: 'default' });
    return renderServerList();
  }

  servers.forEach(srv => {
    const el = document.createElement('div');
    el.className = `server-item ${srv.id === activeId ? 'active' : ''}`;
    el.innerHTML = `
      <div>
        <div style="font-weight:bold; color:var(--primary)">${srv.name} ${srv.id === activeId ? i18n("msgUsing") : ''}</div>
        <div style="font-family:monospace; font-size:12px; color:var(--text-sub)">${srv.scheme}://${srv.host}:${srv.port}</div>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-ghost btn-sm btn-edit">✏️</button>
        <button class="btn btn-ghost btn-sm btn-del" style="color:var(--danger)">🗑️</button>
      </div>
    `;
    el.onclick = (e) => { if (!e.target.closest('button')) activateServer(srv.id); };
    el.querySelector('.btn-edit').onclick = () => openServerEdit(srv.id);
    el.querySelector('.btn-del').onclick = () => deleteServer(srv.id);
    container.appendChild(el);
  });
}

function activateServer(id) {
  if (allData.activeServerId === id) return;
  allData.activeServerId = id;
  chrome.storage.local.set({ activeServerId: id }, () => {
    renderServerList();
    showToast(i18n("msgSwitchServer"));
  });
}

function openServerEdit(id) {
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
}

function closeServerEdit() {
  $('#serverForm').style.display = 'none';
  $('#addServerBtn').style.display = 'inline-flex';
}

function saveServer() {
  const name = $('#editName').value.trim() || "Unknown";
  const rawHost = $('#editHost').value.trim();
  
  if (!rawHost) {
    alert(i18n("msgErrHost"));
    $('#editHost').focus();
    return;
  }

  let host = rawHost.replace(/^https?:\/\//i, '').replace(/^socks[45]?:\/\//i, '');
  if (!host) {
    alert(i18n("msgErrValidHost"));
    $('#editHost').focus();
    return;
  }

  const portInput = $('#editPort').value.trim();
  let port = parseInt(portInput, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    alert(i18n("msgErrPort"));
    $('#editPort').focus();
    return;
  }

  const scheme = $('#editScheme').value;
  const newSrv = { id: editingServerId || crypto.randomUUID(), name, scheme, host, port };
  let list = allData.serverList || [];
  
  if (editingServerId) {
    const idx = list.findIndex(s => s.id === editingServerId);
    if (idx !== -1) list[idx] = newSrv;
  } else {
    list.push(newSrv);
  }
  
  chrome.storage.local.set({ serverList: list }, async () => {
    await loadAllData(); 
    closeServerEdit();
    renderServerList();
    showToast(i18n("msgSaved"));
    chrome.runtime.sendMessage({type: 'REFRESH_PROXY'});
  });
}

function deleteServer(id) {
  if (!confirm(i18n("msgConfirmDelServer"))) return;
  let list = allData.serverList.filter(s => s.id !== id);
  if (list.length === 0) return alert(i18n("msgKeepOne"));
  if (allData.activeServerId === id) allData.activeServerId = list[0].id;
  chrome.storage.local.set({ serverList: list, activeServerId: allData.activeServerId }, async () => {
    await loadAllData();
    renderServerList();
  });
}

function initRuleModule() {
  $('#ruleTypeSelect').onchange = (e) => { currentRuleType = e.target.value; renderRuleList(); };
  $('#ruleSearch').addEventListener('input', () => renderRuleList());
  $('#ruleAddBtn').onclick = addRuleFromInput;
  $('#ruleAddInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') addRuleFromInput(); });
  $('#ruleClearBtn').onclick = () => {
    if (confirm(i18n("msgConfirmClearRules"))) {
      const type = currentRuleType;
      chrome.storage.local.set({ [type]: [] }, async () => { await loadAllData(); renderRuleList(); });
    }
  };
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
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (Array.isArray(data)) {
          const type = currentRuleType;
          const merged = [...new Set([...(allData[type]||[]), ...data])];
          chrome.storage.local.set({ [type]: merged }, async () => {
            await loadAllData(); renderRuleList(); showToast(i18n("msgImportCount").replace('%COUNT%', data.length));
          });
        } else alert(i18n("msgJsonErr"));
      } catch(e) { alert(i18n("msgParseErr")); }
    };
    reader.readAsText(file); e.target.value = '';
  };
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
  const list = allData[currentRuleType] || [];
  const keyword = $('#ruleSearch').value.trim().toLowerCase();
  const filtered = list.filter(d => d.includes(keyword)).reverse();
  $('#currentRuleCount').textContent = list.length;
  
  const container = $('#ruleListContainer');
  container.innerHTML = '';
  
  const displayList = filtered.slice(0, MAX_DISPLAY_RULES);
  const fragment = document.createDocumentFragment();

  displayList.forEach(domain => {
      const div = document.createElement('div');
      div.className = 'rule-item';      
      const span = document.createElement('span');
      span.className = 'domain-text';
      span.title = i18n("hintDoubleEdit");      
      span.textContent = domain; 
      const actionDiv = document.createElement('div');
      actionDiv.style.cssText = "display:flex; align-items:center;";      
      actionDiv.innerHTML = `
        <span class="edit-hint" style="font-size:12px; color:#aaa; margin-right:10px; opacity:0; transition:0.2s;">${i18n("hintDoubleEdit")}</span>
        <button class="btn btn-ghost btn-sm btn-del" style="border:none; padding:2px 6px;">✕</button>
      `;
      div.appendChild(span);
      div.appendChild(actionDiv);
      div.onmouseenter = () => actionDiv.querySelector('.edit-hint').style.opacity = '1';
      div.onmouseleave = () => actionDiv.querySelector('.edit-hint').style.opacity = '0';      
      div.ondblclick = () => enableRuleEdit(div, domain);      
      actionDiv.querySelector('.btn-del').onclick = (e) => { 
        e.stopPropagation(); 
        deleteRule(domain); 
      };
      fragment.appendChild(div);
  });
  
  if (filtered.length > MAX_DISPLAY_RULES) {
    const more = document.createElement('div');
    more.style.padding = '10px'; more.style.textAlign = 'center'; more.style.color = '#999';
    more.textContent = i18n("msgMoreRules").replace('%SHOWN%', MAX_DISPLAY_RULES).replace('%REMAIN%', filtered.length - MAX_DISPLAY_RULES);
    fragment.appendChild(more);
  }
  
  if (filtered.length === 0) container.innerHTML = `<div style="padding:40px; text-align:center; color:#999">${i18n("msgNoRules")}</div>`;
  else container.appendChild(fragment);
}

function enableRuleEdit(div, oldDomain) {
  const span = div.querySelector('.domain-text');
  div.ondblclick = null; 
  const input = document.createElement('input');
  input.type = 'text'; input.value = oldDomain; input.style.width = '300px'; input.style.fontFamily = 'monospace';
  span.replaceWith(input); input.focus();
  
  const save = () => {
    let rawInput = input.value.trim().toLowerCase();
    
    let newDomain = rawInput;
    try {
      const urlObj = new URL(rawInput.includes('://') ? rawInput : 'http://' + rawInput);
      newDomain = decodeURIComponent(urlObj.hostname);
    } catch (e) {}
    newDomain = newDomain.replace(/^\.+|\.+$/g, '');

    if (newDomain && newDomain !== oldDomain) {
      const type = currentRuleType;
      let list = allData[type] || [];
      if (list.includes(newDomain)) { 
        alert(i18n("msgDomainExist")); 
        renderRuleList(); 
      } else {
        const conflictMsg = checkConflict(newDomain);
        if (conflictMsg && !confirm(conflictMsg + i18n("msgConfirmConflict"))) {
          renderRuleList();
          return;
        }
        const idx = list.indexOf(oldDomain);
        if (idx !== -1) {
          list[idx] = newDomain;
          chrome.storage.local.set({ [type]: list }, async () => { await loadAllData(); renderRuleList(); showToast(i18n("msgRuleModified")); });
        }
      }
    } else renderRuleList();
  };
  input.onblur = save; input.onkeypress = (e) => { if(e.key==='Enter') input.blur(); };
}

function addRuleFromInput() {
  const input = $('#ruleAddInput');
  let rawVal = input.value.trim().toLowerCase();
  if (!rawVal) {
    showToast(i18n("msgEnterDomain"));
    return;
  }

  let val = rawVal;
  try {
    const urlObj = new URL(rawVal.includes('://') ? rawVal : 'http://' + rawVal);
    val = decodeURIComponent(urlObj.hostname);
  } catch (e) {}

  val = val.replace(/^\.+|\.+$/g, ''); 
  const type = currentRuleType;
  let list = allData[type] || [];
  
  if (!list.includes(val)) {
    const conflictMsg = checkConflict(val);
    if (conflictMsg && !confirm(conflictMsg + i18n("msgConfirmConflict"))) return;
    list.push(val);
    chrome.storage.local.set({ [type]: list }, async () => { 
      await loadAllData(); 
      input.value = ''; 
      renderRuleList(); 
      showToast(i18n("msgRuleAdded").replace('%DOMAIN%', val)); 
    });
  } else showToast(i18n("msgDomainExist"));
}

function deleteRule(domain) {
  const type = currentRuleType;
  let list = allData[type] || [];
  list = list.filter(d => d !== domain);
  chrome.storage.local.set({ [type]: list }, async () => { await loadAllData(); renderRuleList(); });
}

function initGfwModule() {
  $('#gfwUrlInput').addEventListener('input', (e) => {
    chrome.storage.local.set({ gfwlistUrl: e.target.value.trim() });
  });

  if (allData.gfwlistUrl) {
    $('#gfwUrlInput').value = allData.gfwlistUrl;
  } else {
    $('#gfwUrlInput').value = DEFAULT_GFWLIST_URL;
  }

  // 镜像源快捷按钮
  $$('.gfw-mirror-btn').forEach(btn => {
    btn.onclick = () => {
      const url = btn.dataset.url;
      $('#gfwUrlInput').value = url;
      chrome.storage.local.set({ gfwlistUrl: url });
    };
  });

  updateGfwStatus(allData.ruleCount, allData.lastUpdate);

  $('#updateGfwBtn').onclick = async () => {
    const targetUrl = $('#gfwUrlInput').value.trim();
    if (!targetUrl) {
      alert(i18n("msgErrUrl"));
      $('#gfwUrlInput').focus();
      return;
    }
    if (!targetUrl.startsWith('http')) {
      alert(i18n("msgErrHttp"));
      return;
    }
    
    const btn = $('#updateGfwBtn');
    const originalBtnText = btn.textContent;
    btn.textContent = i18n("msgDownloading"); 
    btn.disabled = true;

    try {
      const response = await fetch(targetUrl);
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
      
      const domainArray = Array.from(validDomains); 
      const updateTime = new Date().toLocaleString();
      if (domainArray.length === 0) throw new Error("No domains parsed");

      chrome.storage.local.set({
        gfwDomains: domainArray,
        ruleCount: domainArray.length,
        lastUpdate: updateTime,
        gfwlistUrl: targetUrl
      }, async () => {
        await loadAllData();
        updateGfwStatus(domainArray.length, updateTime);
        showToast(i18n("msgUpdateSuccess").replace('%COUNT%', domainArray.length));
        chrome.runtime.sendMessage({type: 'REFRESH_PROXY'});
      });

    } catch(error) {
      console.error("Update Error:", error);
      const isNetworkError = error.message.includes('Failed to fetch') || error.message.includes('NetworkError') || error.message.includes('Status: 404') || error.message.includes('Status: 403');
      const hint = isNetworkError ? '\n\n' + i18n("msgGfwNetworkHint") : '';
      alert(i18n("msgUpdateFail") + ": " + error.message + hint);
      setTimeout(() => { btn.textContent = originalBtnText; }, 2000);
    } finally {
      btn.textContent = originalBtnText;
      btn.disabled = false;
    }
  };

  const toggleBtn = $('#toggleGfwPreviewBtn');
  const previewArea = $('#gfwPreviewArea');
  const arrow = $('#gfwPreviewArrow');
  const textBox = $('#gfwContentBox');

  toggleBtn.onclick = () => {
    const isHidden = previewArea.style.display === 'none';
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
}

function updateGfwStatus(c, t) { 
    $('#gfwStatus').textContent = c ? i18n("statusCached").replace('%COUNT%', c).replace('%TIME%', t) : i18n("statusNotLoaded"); 
}

function initSyncModule() {
  $('#syncProvider').onchange = updateSyncPanel;
  $('#autoSync').onchange = () => chrome.storage.local.set({ autoSync: $('#autoSync').checked });
  $('#gitToken').onchange = () => chrome.storage.local.set({ gitToken: $('#gitToken').value });
  $('#davUrl').onchange = saveDav; $('#davUser').onchange = saveDav; $('#davPass').onchange = saveDav;
  
  $('#cloudUploadBtn').onclick = () => {
    showToast(i18n("msgUploading"));
    chrome.runtime.sendMessage({type: 'MANUAL_SYNC_UPLOAD'}, async (res) => {
       if (res && res.success) {
           await loadAllData();
           updateSyncUI(res.time);
           showToast(i18n("msgUploadSuccess"));
       } else showToast(i18n("msgUploadFail").replace('%ERR%', res.error || "Unknown"));
    });
  };
  
  $('#cloudDownloadBtn').onclick = () => {
    if(!confirm(i18n("msgConfirmDownload"))) return;
    showToast(i18n("msgDownloadingBg"));
    chrome.runtime.sendMessage({type: 'MANUAL_SYNC_DOWNLOAD'}, async (res) => {
       if (res && res.success) {
           await loadAllData();
           renderAll(); 
           showToast(i18n("msgDownloadSuccess"));
       } else showToast(i18n("msgDownloadFail").replace('%ERR%', res.error || "Unknown"));
    });
  };
}

function updateSyncUI(time) {
    const el = $('#syncStatusBadge');
    el.textContent = i18n("msgStatusLast") + time;
    el.className = "status-badge synced";
}

function updateSyncPanel() {
  const mode = $('#syncProvider').value;
  $('#panelGithub').style.display = mode === 'github' ? 'block' : 'none';
  $('#panelWebdav').style.display = mode === 'webdav' ? 'block' : 'none';
  chrome.storage.local.set({ syncProvider: mode });
}
function saveDav() { chrome.storage.local.set({ davUrl: $('#davUrl').value, davUser: $('#davUser').value, davPass: $('#davPass').value }); }

function switchSyncPanel() { updateSyncPanel(); } 

function initGeneralModule() {
  $('#themeSelect').value = allData.theme || 'system';
  $('#themeSelect').onchange = (e) => { applyTheme(e.target.value); chrome.storage.local.set({ theme: e.target.value }); };
  
  // --- 语言选择逻辑 ---
  const langSelect = document.getElementById('langSelect');
  if (langSelect) {
    langSelect.value = allData.appLanguage || 'auto';
    langSelect.onchange = (e) => {
      chrome.storage.local.set({ appLanguage: e.target.value }, () => {
        // 重新加载页面以应用新语言
        window.location.reload();
      });
    };
  }

  $('#resetAppBtn').onclick = () => { if (confirm(i18n("msgConfirmReset"))) chrome.storage.local.clear(() => chrome.runtime.reload()); };
}

function applyTheme(theme) {
  const doc = document.documentElement;
  if (theme === 'dark') doc.setAttribute('data-theme', 'dark');
  else if (theme === 'light') doc.setAttribute('data-theme', 'light');
  else doc.removeAttribute('data-theme');
}
function showToast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}