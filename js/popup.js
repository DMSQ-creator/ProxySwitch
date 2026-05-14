// js/popup.js - ProxySwitch (i18n Version Fixed)

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
let customMessages = null;

// --- 核心：智能 i18n 函数 ---
const i18n = (key) => {
  if (customMessages && customMessages[key]) {
    return customMessages[key].message;
  }
  return chrome.i18n.getMessage(key) || "";
};

// --- 初始化流程 ---
(async function init() {
  await loadBaseConfig(); // 这里面会加载语言包
  localizeHtmlPage();     // 翻译
  analyzeCurrentTab();    // 逻辑
})();


// 监听配置变化
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    // 这里简单重新加载所有配置
    loadBaseConfig().then(() => {
        if (currentTabDomain) checkDomainStatusWrapper();
    });
  }
});

// --- 核心功能函数 ---

async function loadBaseConfig() {
  return new Promise(resolve => {
    // 🚀 优化：不再加载全量数据(null)，只加载 UI 必需字段
    chrome.storage.local.get(['serverList', 'activeServerId', 'theme', 'appLanguage'], async (items) => {
      // 1. 优先加载语言设置
      const userLang = items.appLanguage || 'auto';
      if (userLang !== 'auto') {
        try {
          const url = chrome.runtime.getURL(`_locales/${userLang}/messages.json`);
          const res = await fetch(url);
          customMessages = await res.json();
        } catch (e) {
          console.error("Popup failed to load language:", e);
        }
      }

      // 2. 应用主题
      const theme = items.theme || 'system';
      const doc = document.documentElement;
      if (theme === 'dark') doc.setAttribute('data-theme', 'dark');
      else if (theme === 'light') doc.setAttribute('data-theme', 'light');
      else doc.removeAttribute('data-theme');

      // 3. 渲染服务器列表
      const servers = items.serverList || [];
      const activeId = items.activeServerId;
      
      const currentOptions = Array.from(els.serverSelect.options).map(o => o.value + o.text).join('|');
      const newOptions = servers.map(s => s.id + s.name).join('|');
      
      if (currentOptions !== newOptions || els.serverSelect.innerHTML === '') {
        els.serverSelect.innerHTML = '';
        if (servers.length === 0) {
          const opt = document.createElement('option');
          opt.textContent = i18n("popNoServer");
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

      // 4. 获取当前代理模式
      chrome.proxy.settings.get({}, (d) => {
        if (d && d.value) {
          currentMode = d.value.mode;
          updateModeUI(currentMode);
        }
      });
      
      resolve();
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
  // 🚀 优化：只获取判断规则必需的字段，不再加载全量规则(null)
  chrome.storage.local.get(['userRules', 'tempRules', 'userWhitelist', 'gfwDomains'], (items) => {
    checkDomainStatus(items);
  });
}

function showInvalidPageUI() {
  currentTabDomain = ""; // 确保变量清空
  els.domain.textContent = i18n("popInvalidPage");
  els.domainArea.style.display = 'flex';
  els.status.textContent = i18n("popCannotSet");
  els.statusIcon.textContent = "🚫";
  
  const wrapper = document.querySelector('.domain-card');
  if (wrapper) {
    wrapper.className = 'domain-card status-fail';
  }
  
  if (els.addBtnGroup) els.addBtnGroup.style.display = 'none';
  if (els.removeBtn) els.removeBtn.style.display = 'none';
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
  
  let text = i18n("popStatusDirect");
  let icon = "🛡️";
  let isProxy = false;  // 用户规则命中
  let isWhite = false;  // 白名单命中
  let statusClass = "status-direct";

  // 优先级判断：白名单 > 临时 > 用户黑名单 > GFWList
  if (checkList(whitelist, currentTabDomain)) { 
    text = i18n("popStatusForceDirect"); 
    icon = "🛡️";
    isWhite = true; 
    statusClass = "status-direct";
  } 
  else if (checkList(tempRules, currentTabDomain)) { 
    text = i18n("popStatusTemp"); 
    icon = "⏱️";
    isProxy = true; 
    statusClass = "status-temp"; // 橙色
  }
  else if (checkList(userRules, currentTabDomain)) { 
    text = i18n("popStatusForceProxy"); 
    icon = "🚀";
    isProxy = true; 
    statusClass = "status-user"; // 紫色
  }
  else if (checkList(gfwRules, currentTabDomain)) { 
    text = i18n("popStatusGfw"); 
    icon = "🌏";
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

  const listSet = new Set(list.filter(Boolean));

  const tryMatch = (d) => {
    if (listSet.has(d)) return true;
    if (listSet.has('.' + d)) return true;
    if (listSet.has('*.' + d)) return true;
    return false;
  };

  const cleanDomain = domain.replace(/^www\./, '');
  if (tryMatch(domain) || tryMatch(cleanDomain)) return true;

  let p = domain.indexOf('.');
  while (p !== -1) {
    if (tryMatch(domain.substring(p + 1))) return true;
    p = domain.indexOf('.', p + 1);
  }

  for (const rule of listSet) {
    if (rule.startsWith('*.')) {
      const suffix = rule.substring(2);
      if (domain === suffix || domain.endsWith('.' + suffix)) return true;
    }
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
      } else alert(i18n("popErrPac"));
    });
  } else if (mode === 'fixed_servers') {
    chrome.storage.local.get(['serverList', 'activeServerId'], (i) => {
      const s = (i.serverList||[]).find(x => x.id === i.activeServerId);
      if (s) { 
        config.rules = { singleProxy: { scheme: s.scheme.toLowerCase(), host: s.host, port: parseInt(s.port || 80) } }; 
        applySetting(config, mode); 
      } else { alert(i18n("popErrAddServer")); chrome.runtime.openOptionsPage(); }
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

// --- 翻译辅助函数 (升级版) ---
function localizeHtmlPage() {
  // 1. 处理属性翻译
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

  // 2. 处理文本节点 (支持 HTML 标签)
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
    
    // 如果翻译内容包含 HTML 标签
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

els.goOptions.onclick = () => chrome.runtime.openOptionsPage();