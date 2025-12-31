// js/options.js

const DEFAULT_GFWLIST_URL = 'https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt';
// 保持 HTTP 以避免证书问题，用于测试代理连通性
const LATENCY_TEST_URL = 'http://www.gstatic.com/generate_204';
const MAX_DISPLAY_RULES = 500;

let currentSection = 'server'; 
let currentRuleType = 'userRules'; 
let allData = {}; 
let editingServerId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

document.addEventListener('DOMContentLoaded', async () => {
  // --- 自动设置版本号 ---
  const manifest = chrome.runtime.getManifest();
  // 设置左下角的版本号
  const footerVerEl = document.getElementById('appVersion');
  if (footerVerEl) footerVerEl.textContent = `Version ${manifest.version}`;
  // 设置关于页面的版本号
  const aboutVerEl = document.getElementById('aboutVersion');
  if (aboutVerEl) aboutVerEl.textContent = `v${manifest.version}`;
  
  await loadAllData();
  applyTheme(allData.theme || 'system');
  
  initNav();
  initServerModule();
  initRuleModule();
  initGfwModule();
  initSyncModule();
  initGeneralModule();
  
  renderAll();
});

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
  
  // 刷新 GFWList 状态 (这里会显示保存的时间)
  updateGfwStatus(allData.ruleCount, allData.lastUpdate);
  
  if (allData.lastSyncTime) updateSyncUI(allData.lastSyncTime);
  
  // --- GFWList URL 回显逻辑 ---
  const gfwInput = $('#gfwUrlInput');
  if (gfwInput) {
    // 直接读取保存的 URL，如果没有则为空（让 placeholder 显示）
    gfwInput.value = allData.gfwlistUrl || '';
    gfwInput.style.display = 'block'; // 确保它是显示的
  }
  
  // 刷新同步配置
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

// --- 服务器模块 ---
function initServerModule() {
  $('#addServerBtn').onclick = () => openServerEdit(null);
  $('#cancelServerItemBtn').onclick = closeServerEdit;
  $('#saveServerItemBtn').onclick = saveServer;
  
  $('#testLatencyBtn').onclick = async () => {
    const config = await new Promise(r => chrome.proxy.settings.get({}, r));
    const mode = config.value.mode;
    
    if (mode === 'direct' || mode === 'system') {
      if (!confirm("⚠️ 警告：当前处于 [直连] 或 [系统代理] 模式。\n测试结果将反映本地网络连接速度，而非代理服务器速度。\n\n是否继续？")) {
        return;
      }
    }
    const resEl = $('#latencyResult');
    resEl.style.display = 'block';
    resEl.innerHTML = '<span style="color:var(--text-sub)">⏳ 正在连接测试服务器...</span>';
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
      
      resEl.innerHTML = `<span style="color:${color}; font-weight:bold;">✅ 连接成功 - 延迟: ${ms} ms</span>`;
    } catch (error) {
      const isTimeout = error.name === 'AbortError';
      const errorMsg = isTimeout ? "连接超时 (>5000ms)" : "连接失败 (请检查代理配置)";
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
        <div style="font-weight:bold; color:var(--primary)">${srv.name} ${srv.id === activeId ? ' (使用中)' : ''}</div>
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
    showToast("已切换服务器");
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
    $('#editName').value = "新服务器";
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
  const name = $('#editName').value.trim() || "未命名";
  
  // 1. 获取原始输入并去空格
  const rawHost = $('#editHost').value.trim();
  
  // 2. 【修复 Bug】检查地址是否为空
  if (!rawHost) {
    alert("❌ 服务器地址不能为空！(Host is required)");
    $('#editHost').focus(); // 聚焦回输入框让用户填
    return;
  }

  // 3. 清理协议头 (例如用户复制粘贴了 http://127.0.0.1)
  let host = rawHost.replace(/^https?:\/\//i, '').replace(/^socks[45]?:\/\//i, '');
  
  // 4. 【修复 Bug】再次检查清理后是否为空 (防止用户只输入了 "http://")
  if (!host) {
    alert("❌ 请输入有效的服务器地址！");
    $('#editHost').focus();
    return;
  }

  const portInput = $('#editPort').value.trim();
  let port = parseInt(portInput, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    alert("❌ 端口必须是 1 到 65535 之间的整数");
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
    showToast("✅ 服务器配置已保存");
    
    // 通知后台刷新代理设置
    chrome.runtime.sendMessage({type: 'REFRESH_PROXY'});
  });
}

function deleteServer(id) {
  if (!confirm("确定删除此服务器配置吗？")) return;
  let list = allData.serverList.filter(s => s.id !== id);
  if (list.length === 0) return alert("至少保留一个服务器");
  if (allData.activeServerId === id) allData.activeServerId = list[0].id;
  chrome.storage.local.set({ serverList: list, activeServerId: allData.activeServerId }, async () => {
    await loadAllData();
    renderServerList();
  });
}

// --- 规则模块 ---
function initRuleModule() {
  $('#ruleTypeSelect').onchange = (e) => { currentRuleType = e.target.value; renderRuleList(); };
  $('#ruleSearch').addEventListener('input', () => renderRuleList());
  $('#ruleAddBtn').onclick = addRuleFromInput;
  $('#ruleAddInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') addRuleFromInput(); });
  $('#ruleClearBtn').onclick = () => {
    if (confirm("确定清空当前列表所有规则吗？")) {
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
            await loadAllData(); renderRuleList(); showToast(`导入 ${data.length} 条规则`);
          });
        } else alert("JSON 格式错误");
      } catch(e) { alert("解析失败"); }
    };
    reader.readAsText(file); e.target.value = '';
  };
}

function checkConflict(domain) {
  const otherType = currentRuleType === 'userRules' ? 'userWhitelist' : 'userRules';
  const otherList = allData[otherType] || [];
  if (otherList.includes(domain)) {
    const typeName = otherType === 'userRules' ? '黑名单' : '白名单';
    return `⚠️ 注意：该域名已存在于【${typeName}】中，可能会导致规则冲突！`;
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
      span.title = '双击修改';      
      span.textContent = domain; 
      const actionDiv = document.createElement('div');
      actionDiv.style.cssText = "display:flex; align-items:center;";      
      actionDiv.innerHTML = `
        <span class="edit-hint" style="font-size:12px; color:#aaa; margin-right:10px; opacity:0; transition:0.2s;">双击修改</span>
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
    more.textContent = `... 已显示前 ${MAX_DISPLAY_RULES} 条，剩余 ${filtered.length - MAX_DISPLAY_RULES} 条请使用搜索查找 ...`;
    fragment.appendChild(more);
  }
  
  if (filtered.length === 0) container.innerHTML = '<div style="padding:40px; text-align:center; color:#999">暂无规则</div>';
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
        alert("域名已存在"); 
        renderRuleList(); 
      } else {
        const conflictMsg = checkConflict(newDomain);
        if (conflictMsg) alert(conflictMsg);
        const idx = list.indexOf(oldDomain);
        if (idx !== -1) {
          list[idx] = newDomain;
          chrome.storage.local.set({ [type]: list }, async () => { await loadAllData(); renderRuleList(); showToast("已修改"); });
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
    showToast("⚠️ 请输入域名");
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
    if (conflictMsg && !confirm(conflictMsg + "\n\n是否继续添加？")) return;
    list.push(val);
    chrome.storage.local.set({ [type]: list }, async () => { 
      await loadAllData(); 
      input.value = ''; 
      renderRuleList(); 
      showToast(`已添加规则: ${val}`); 
    });
  } else showToast("规则已存在");
}

function deleteRule(domain) {
  const type = currentRuleType;
  let list = allData[type] || [];
  list = list.filter(d => d !== domain);
  chrome.storage.local.set({ [type]: list }, async () => { await loadAllData(); renderRuleList(); });
}

// --- GFW 模块 ---
function initGfwModule() {
  
  // 1. 监听输入框变化，实时保存 (提升体验)
  $('#gfwUrlInput').addEventListener('input', (e) => {
    const val = e.target.value.trim();
    chrome.storage.local.set({ gfwlistUrl: val });
  });

  // 2. 回显保存的 URL
  // 如果没有保存过，留空，让 placeholder 提示用户
  if (allData.gfwlistUrl) {
    $('#gfwUrlInput').value = allData.gfwlistUrl;
  }
  
  // 更新状态显示
  updateGfwStatus(allData.ruleCount, allData.lastUpdate);

  // 3. 更新按钮逻辑
  $('#updateGfwBtn').onclick = async () => {
    // 直接获取输入框的值
    const targetUrl = $('#gfwUrlInput').value.trim();
    
    if (!targetUrl) {
      alert("请先填入有效的规则列表 URL (Please enter a valid URL first)");
      $('#gfwUrlInput').focus();
      return;
    }
    
    // 简单的 URL 格式校验
    if (!targetUrl.startsWith('http')) {
      alert("URL 必须以 http:// 或 https:// 开头");
      return;
    }
    
    const btn = $('#updateGfwBtn');
    const originalBtnText = btn.textContent;
    btn.textContent = "⏳ 下载并解析中..."; 
    btn.disabled = true;

    try {
      // Fetch user-provided URL
      const response = await fetch(targetUrl);
      if (!response.ok) {
        throw new Error(`Download failed with status: ${response.status}`);
      }
      
      const responseText = await response.text();
      
      // --- Safety Parsing Logic (User Input) ---
      // Attempts to decode Base64 if the user provided a Base64 source.
      // Fallback to plain text if decoding fails.
      let decodedText = "";
      try {
        const cleanBase64 = responseText.replace(/\s/g, '');
        decodedText = atob(cleanBase64);
      } catch (e) {
        decodedText = responseText;
      }
      
      // Regex parsing for domains (Strict whitelist approach)
      const lines = decodedText.split(/\r?\n/);
      const validDomains = new Set();
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('!') || line.startsWith('[') || line.startsWith('@')) continue;
        
        let cleanLine = line.replace(/^\|\|/, '').replace(/^\|/, '').replace(/^https?:\/\//, '').replace(/^\.+/, '');
        const domainMatch = cleanLine.match(/^([a-zA-Z0-9\-\.\_\u4e00-\u9fa5]+)/);
        
        if (domainMatch) {
          const extractedDomain = domainMatch[1];
          if (extractedDomain.includes('.') && !extractedDomain.includes('*')) {
            validDomains.add(extractedDomain);
          }
        }
      }
      
      const domainArray = Array.from(validDomains); 
      const updateTime = new Date().toLocaleString();
      
      if (domainArray.length === 0) {
        throw new Error("未能解析出有效域名，请检查 URL 是否正确");
      }

      chrome.storage.local.set({ 
        gfwDomains: domainArray, 
        ruleCount: domainArray.length, 
        lastUpdate: updateTime,
        gfwlistUrl: targetUrl // 确保保存成功的 URL
      }, async () => {
        await loadAllData(); 
        updateGfwStatus(domainArray.length, updateTime); 
        showToast(`更新成功: ${domainArray.length} 条规则`);
        btn.textContent = originalBtnText; 
        btn.disabled = false;
        chrome.runtime.sendMessage({type: 'REFRESH_PROXY'});
      });
      
    } catch(error) { 
      console.error("Update Error:", error);
      alert("更新失败: " + error.message); 
      btn.textContent = "❌ 更新失败"; 
      btn.disabled = false; 
      setTimeout(() => { btn.textContent = originalBtnText; }, 2000);
    }
  };

  // --- 【新增】预览折叠逻辑 ---
  const toggleBtn = $('#toggleGfwPreviewBtn');
  const previewArea = $('#gfwPreviewArea');
  const arrow = $('#gfwPreviewArrow');
  const textBox = $('#gfwContentBox');

  toggleBtn.onclick = () => {
    const isHidden = previewArea.style.display === 'none';
    
    if (isHidden) {
      // 展开
      previewArea.style.display = 'block';
      arrow.style.transform = 'rotate(180deg)';
      
      // 懒加载数据：只有当数据未填充或更新时间改变时才刷新内容
      if (!textBox.value || allData.lastUpdate !== textBox.dataset.lastVer) {
        const list = allData.gfwDomains || [];
        if (list.length > 0) {
          textBox.value = list.join('\n');
        } else {
          textBox.value = "（暂无数据，请点击更新按钮）";
        }
        textBox.dataset.lastVer = allData.lastUpdate;
      }
      
    } else {
      // 收起
      previewArea.style.display = 'none';
      arrow.style.transform = 'rotate(0deg)';
    }
  };
}

// 显示详细的更新时间
function updateGfwStatus(c, t) { 
    // t 变量就是保存的日期字符串，例如 "2025/12/23 20:30:00"
    $('#gfwStatus').textContent = c ? `✅ 已缓存 ${c} 条 (更新于 ${t})` : "⚠️ 未加载"; 
}

// --- 同步模块 ---
function initSyncModule() {
  $('#syncProvider').onchange = updateSyncPanel;
  $('#autoSync').onchange = () => chrome.storage.local.set({ autoSync: $('#autoSync').checked });
  $('#gitToken').onchange = () => chrome.storage.local.set({ gitToken: $('#gitToken').value });
  $('#davUrl').onchange = saveDav; $('#davUser').onchange = saveDav; $('#davPass').onchange = saveDav;
  
  $('#cloudUploadBtn').onclick = () => {
    showToast("后台上传中...");
    chrome.runtime.sendMessage({type: 'MANUAL_SYNC_UPLOAD'}, async (res) => {
       if (res && res.success) {
           await loadAllData();
           updateSyncUI(res.time);
           showToast("上传成功");
       } else showToast("上传失败: " + (res.error || "未知"));
    });
  };
  
  $('#cloudDownloadBtn').onclick = () => {
    if(!confirm("确定下载并覆盖本地吗？")) return;
    showToast("后台下载中...");
    chrome.runtime.sendMessage({type: 'MANUAL_SYNC_DOWNLOAD'}, async (res) => {
       if (res && res.success) {
           await loadAllData();
           renderAll(); // 重新渲染界面，这会包含 GFWList URL 的回显
           showToast("下载成功，配置已更新");
       } else showToast("下载失败: " + (res.error || "未知"));
    });
  };
}

function updateSyncUI(time) {
    const el = $('#syncStatusBadge');
    el.textContent = "上次: " + time;
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

// --- 通用 ---
function initGeneralModule() {
  $('#themeSelect').value = allData.theme || 'system';
  $('#themeSelect').onchange = (e) => { applyTheme(e.target.value); chrome.storage.local.set({ theme: e.target.value }); };
  $('#resetAppBtn').onclick = () => { if (confirm("⚠️ 危险：清空所有数据？")) chrome.storage.local.clear(() => chrome.runtime.reload()); };
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