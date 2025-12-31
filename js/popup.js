// js/popup.js - ProxySwitch (Fixed Version)

const els = {
  serverSelect: document.getElementById('serverSelect'),
  
  // 状态显示区域
  domain: document.getElementById('currentDomain'),
  status: document.getElementById('routingStatus'),
  statusIcon: document.getElementById('statusIcon'),
  domainArea: document.getElementById('domainArea'),
  
  // 模式切换按钮
  modePac: document.getElementById('mode-pac'),
  modeFixed: document.getElementById('mode-fixed'),
  modeDirect: document.getElementById('mode-direct'),
  modeSystem: document.getElementById('mode-system'),
  
  // 操作按钮
  actionArea: document.getElementById('actionArea'), // 包含按钮的父容器
  addBtnGroup: document.getElementById('addBtnGroup'),
  addRuleBtn: document.getElementById('addRuleBtn'),
  addTempRuleBtn: document.getElementById('addTempRuleBtn'),
  removeBtn: document.getElementById('removeBtn'),
  
  goOptions: document.getElementById('openSettings')
};

let currentTabDomain = '';
let currentMode = 'direct';

// 初始化
loadBaseConfig();
analyzeCurrentTab();

// 监听配置变化
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    loadBaseConfig(); 
    if (currentTabDomain) checkDomainStatusWrapper();
  }
});

function loadBaseConfig() {
  chrome.storage.local.get(null, (items) => {
    // 1. 应用主题
    const theme = items.theme || 'system';
    const doc = document.documentElement;
    if (theme === 'dark') doc.setAttribute('data-theme', 'dark');
    else if (theme === 'light') doc.setAttribute('data-theme', 'light');
    else doc.removeAttribute('data-theme');

    // 2. 渲染服务器列表
    const servers = items.serverList || [];
    const activeId = items.activeServerId;
    
    const currentOptions = Array.from(els.serverSelect.options).map(o => o.value + o.text).join('|');
    const newOptions = servers.map(s => s.id + s.name).join('|');
    
    if (currentOptions !== newOptions || els.serverSelect.innerHTML === '') {
      els.serverSelect.innerHTML = '';
      if (servers.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = "无服务器";
        els.serverSelect.appendChild(opt);
        els.serverSelect.disabled = true;
      } else {
        els.serverSelect.disabled = false;
        servers.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.name;
          if (s.id === activeId) opt.selected = true;
          els.serverSelect.appendChild(opt);
        });
      }
    } else {
      els.serverSelect.value = activeId;
    }

    // 3. 获取当前代理模式
    chrome.proxy.settings.get({}, (d) => {
      if (d && d.value) {
        currentMode = d.value.mode;
        updateModeUI(currentMode);
      }
    });
  });
}

function analyzeCurrentTab() {
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    const tab = tabs[0];
    
    // 【修复 1】严格校验 URL 协议
    // 只有 http 或 https 页面才显示添加按钮，chrome:// 或 file:// 等页面不显示
    if (tab && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
      try {
        const url = new URL(tab.url);
        currentTabDomain = url.hostname.toLowerCase();
        
        // 再次校验非空
        if (!currentTabDomain) throw new Error("Empty hostname");

        els.domain.textContent = currentTabDomain;
        els.domainArea.style.display = 'flex'; 
        
        // 默认先显示操作区，具体显示哪个按钮由 checkDomainStatus 决定
        if (els.actionArea) els.actionArea.style.display = 'block';

        checkDomainStatusWrapper();
      } catch (e) {
        showInvalidPageUI();
      }
    } else {
      showInvalidPageUI();
    }
  });
}

function checkDomainStatusWrapper() {
  // 如果域名为空，不要去查 storage，直接显示无效 UI
  if (!currentTabDomain) {
    showInvalidPageUI();
    return;
  }
  chrome.storage.local.get(null, (items) => {
    checkDomainStatus(items);
  });
}

function showInvalidPageUI() {
  currentTabDomain = ""; // 确保变量清空
  els.domain.textContent = "当前页面无效";
  els.domainArea.style.display = 'flex';
  els.status.textContent = "无法设置规则";
  els.statusIcon.textContent = "🚫";
  
  const wrapper = document.querySelector('.domain-card');
  if (wrapper) {
    wrapper.className = 'domain-card status-fail';
  }
  
  // 【修复 2】关键：在无效页面（如新标签页），彻底隐藏所有操作按钮
  // 这样用户就无法点击，也不会报错了
  if (els.addBtnGroup) els.addBtnGroup.style.display = 'none';
  if (els.removeBtn) els.removeBtn.style.display = 'none';
  // 也可以隐藏整个底部区域
  // if (els.actionArea) els.actionArea.style.display = 'none';
}

// 核心状态判断逻辑
function checkDomainStatus(items) {
  // 双重保险
  if (!currentTabDomain) {
    showInvalidPageUI();
    return;
  }

  const userRules = items.userRules || [];
  const tempRules = items.tempRules || [];
  const whitelist = items.userWhitelist || [];
  const gfwRules = items.gfwDomains || [];
  
  let text = "未匹配 (直连)";
  let icon = "🛡️";
  let isProxy = false;  // 用户规则命中
  let isWhite = false;  // 白名单命中
  let statusClass = "status-direct";

  // 优先级判断：白名单 > 临时 > 用户黑名单 > GFWList
  if (checkList(whitelist, currentTabDomain)) { 
    text = "强制直连 (白名单)"; 
    icon = "🛡️";
    isWhite = true; 
    statusClass = "status-direct";
  } 
  else if (checkList(tempRules, currentTabDomain)) { 
    text = "临时代理 (本次)"; 
    icon = "⏱️";
    isProxy = true; 
    statusClass = "status-temp"; // 橙色
  }
  else if (checkList(userRules, currentTabDomain)) { 
    text = "强制代理 (黑名单)"; 
    icon = "🚀";
    isProxy = true; 
    statusClass = "status-user"; // 紫色
  }
  else if (checkList(gfwRules, currentTabDomain)) { 
    text = "匹配 GFWList (自动)"; 
    icon = "🌏";
    // GFWList 属于自动规则，不算作用户手动强制，所以 bottom button 依然显示 "加入"
    statusClass = "status-proxy"; // 绿色
  } 

  els.status.textContent = text;
  els.statusIcon.textContent = icon;

  const wrapper = document.querySelector('.domain-card');
  if (wrapper) {
    wrapper.className = `domain-card ${statusClass}`;
  }
  
  // 底部按钮逻辑
  if (isProxy || isWhite) {
    // 已在手动规则中 -> 显示移除
    els.removeBtn.style.display = 'flex'; 
    els.addBtnGroup.style.display = 'none';
    els.removeBtn.onclick = () => removeDomainRule();
  } else {
    // 未在手动规则中 -> 显示添加组
    els.removeBtn.style.display = 'none'; 
    els.addBtnGroup.style.display = 'flex';
    
    // 绑定事件
    els.addRuleBtn.onclick = () => addRule('userRules');
    els.addTempRuleBtn.onclick = () => addRule('tempRules');
  }
}

function checkList(list, domain) {
  if (!list || list.length === 0) return false;
  const cleanDomain = domain.replace(/^www\./, '');
  for (let rule of list) {
    if (!rule) continue;
    if (rule.startsWith('*.')) rule = rule.substring(2);
    else if (rule.startsWith('.')) rule = rule.substring(1);
    if (domain === rule || cleanDomain === rule || domain.endsWith('.' + rule)) return true;
  }
  return false;
}

// 事件绑定
els.serverSelect.onchange = () => {
  const id = els.serverSelect.value;
  chrome.storage.local.set({ activeServerId: id }, () => {
    chrome.runtime.sendMessage({type: 'REFRESH_PROXY'});
  });
};

// 模式切换
els.modePac.onclick = () => setMode('pac_script');
els.modeFixed.onclick = () => setMode('fixed_servers');
els.modeDirect.onclick = () => setMode('direct');
els.modeSystem.onclick = () => setMode('system');

function setMode(mode) {
  const config = { mode: mode };
  if (mode === 'pac_script') {
    chrome.storage.local.get(['pacScriptData'], (i) => {
      if (i.pacScriptData) { 
        config.pacScript = { data: i.pacScriptData }; 
        applySetting(config, mode); 
      } else alert("PAC 未就绪，请先在设置页更新规则");
    });
  } else if (mode === 'fixed_servers') {
    chrome.storage.local.get(['serverList', 'activeServerId'], (i) => {
      const s = (i.serverList||[]).find(x => x.id === i.activeServerId);
      if (s) { 
        config.rules = { singleProxy: { scheme: s.scheme.toLowerCase(), host: s.host, port: parseInt(s.port || 80) } }; 
        applySetting(config, mode); 
      } else { alert("请先添加服务器"); chrome.runtime.openOptionsPage(); }
    });
  } else {
    // direct or system
    applySetting(config, mode);
  }
}

function applySetting(c, m) { 
  chrome.proxy.settings.set({ value: c, scope: 'regular' }, () => { 
    currentMode = m; 
    updateModeUI(m); 
    // 刷新状态
    if (currentTabDomain) checkDomainStatusWrapper();
    chrome.runtime.sendMessage({type: 'REFRESH_PROXY'});
  }); 
}

function updateModeUI(m) {
  [els.modePac, els.modeFixed, els.modeDirect, els.modeSystem].forEach(e => e.classList.remove('active'));
  if (m === 'pac_script') els.modePac.classList.add('active');
  else if (m === 'fixed_servers') els.modeFixed.classList.add('active');
  else if (m === 'direct') els.modeDirect.classList.add('active');
  else if (m === 'system') els.modeSystem.classList.add('active');
}

function getRootDomain(hostname) {
  if (!hostname) return null; // 防御
  
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (last.length === 2 && ['com','co','net','org','edu','gov'].includes(secondLast)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function addRule(key) {
  // 【修复 3】核心防御：如果当前域名为空（尚未获取到或无效页面），直接终止
  // 这能防止即使按钮显示了，点击也不会报错
  if (!currentTabDomain) {
    console.warn("当前域名为空，无法添加规则");
    return;
  }

  const root = getRootDomain(currentTabDomain);
  if (!root) return;

  chrome.storage.local.get([key], (i) => {
    const list = i[key] || []; 
    if (!list.includes(root)) {
      list.push(root);
      // 保存数据
      chrome.storage.local.set({ [key]: list }, () => {
        // 保存成功后，立即通知后台刷新 PAC 和图标
        chrome.runtime.sendMessage({type: 'REFRESH_PROXY'});
        // 同时刷新 popup 自身的 UI 状态
        checkDomainStatusWrapper();
      });
    }
  });
}

function removeDomainRule() {
  if (!currentTabDomain) return; // 防御

  chrome.storage.local.get(['userRules', 'tempRules', 'userWhitelist'], (i) => {
    const root = getRootDomain(currentTabDomain);
    const filterFn = d => d !== currentTabDomain && d !== root && d !== currentTabDomain.replace(/^www\./, '');
    
    // 保存数据
    chrome.storage.local.set({
      tempRules: (i.tempRules||[]).filter(filterFn),
      userWhitelist: (i.userWhitelist||[]).filter(filterFn),
      userRules: (i.userRules||[]).filter(filterFn)
    }, () => {
      // 保存成功后，立即通知后台刷新 PAC 和图标
      chrome.runtime.sendMessage({type: 'REFRESH_PROXY'});
      // 同时刷新 popup 自身的 UI 状态
      checkDomainStatusWrapper();
    });
  });
}

els.goOptions.onclick = () => chrome.runtime.openOptionsPage();