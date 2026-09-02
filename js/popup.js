// js/popup.js - ProxySwitch (i18n Version Fixed)

PSL.checkpoint('popup', 'popup.script_entered', { readyState: document.readyState });

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
let currentMode = null; // 🔥 Fix: 初始为 null 避免 UI 闪烁显示错误的"直连"高亮
let customMessages = null;
let currentTabLoading = false;
let currentTabUrlKind = 'none';
let popupPort = null;
let initDone = false;
let popupReloadTimer = null;
let frameProbeScheduled = false;

// --- 核心：智能 i18n 函数 ---
const i18n = (key) => {
  if (customMessages && customMessages[key]) {
    return customMessages[key].message;
  }
  return chrome.i18n.getMessage(key) || "";
};

window.addEventListener('error', (e) => {
  PSL.error('popup', 'Uncaught error', e && e.error || {
    message: e && e.message,
    filename: e && e.filename,
    line: e && e.lineno,
    column: e && e.colno,
  });
});

window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  PSL.error('popup', 'Unhandled rejection', r || String(e));
});

window.addEventListener('pagehide', () => {
  PSL.checkpoint('popup', 'popup.pagehide');
});

function sendMessageWithTimeout(message, timeoutMs, label) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      PSL.warn('popup', `${label} timeout`, `${timeoutMs}ms`);
      resolve({ timeout: true });
    }, timeoutMs);

    chrome.runtime.sendMessage(message, (res) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        PSL.error('popup', `${label} sendMessage failed`, chrome.runtime.lastError.message);
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      PSL.perf('popup', label, t0, null, 300);
      resolve(res);
    });
  });
}

// --- 初始化流程 ---
(async function init() {
  const t0 = Date.now();
  PSL.checkpoint('popup', 'popup.init_started');
  const configPromise = loadBaseConfig();
  const timeoutPromise = new Promise(resolve => {
    setTimeout(() => resolve('timeout'), 3000);
  });
  const configOutcome = await Promise.race([
    configPromise.then(() => 'loaded'),
    timeoutPromise,
  ]);
  PSL.checkpoint('popup', 'popup.config_race_done', { outcome: configOutcome });
  if (!initDone) {
    initDone = true;
    localizeHtmlPage();
    analyzeCurrentTab();
  }
  PSL.checkpoint('popup', 'popup.bootstrap_dispatched', { durationMs: Date.now() - t0 });
})();


// 监听配置变化（仅监听与 UI 相关的键，忽略黑匣子等诊断写入）
const POPUP_RELEVANT_KEYS = ['serverList', 'activeServerId', 'userRules', 'tempRules', 'userWhitelist', 'gfwDomains', 'pacScriptData'];
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const changedKeys = Object.keys(changes);
  if (!changedKeys.some(key => POPUP_RELEVANT_KEYS.includes(key))) return;
  if (popupReloadTimer) clearTimeout(popupReloadTimer);
  popupReloadTimer = setTimeout(() => {
    popupReloadTimer = null;
    loadBaseConfig().then(() => {
      if (currentTabDomain) checkDomainStatusWrapper(currentTabLoading);
    });
  }, 120);
});

// --- 核心功能函数 ---

async function loadBaseConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(['serverList', 'activeServerId', 'theme', 'appLanguage', 'pacScriptData'], async (items) => {
      if (chrome.runtime.lastError) {
        PSL.error('popup', 'base config storage.get failed', chrome.runtime.lastError.message);
        items = {};
      } else {
        items = items || {};
      }
      const userLang = items.appLanguage || 'auto';
      if (userLang !== 'auto') {
        loadLanguagePack(userLang);
      }

      const theme = items.theme || 'system';
      const doc = document.documentElement;
      if (theme === 'dark') doc.setAttribute('data-theme', 'dark');
      else if (theme === 'light') doc.setAttribute('data-theme', 'light');
      else doc.removeAttribute('data-theme');

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

      chrome.proxy.settings.get({}, (d) => {
        if (d && d.value) {
          currentMode = d.value.mode;
          updateModeUI(currentMode);
        }
      });

      if (!initDone) {
        initDone = true;
        localizeHtmlPage();
        analyzeCurrentTab();
      }
      resolve();
    });
  });
}

async function loadLanguagePack(lang) {
  try {
    const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
    const res = await fetch(url);
    customMessages = await res.json();
    localizeHtmlPage();
  } catch (e) {
    PSL.error('popup', 'Failed to load language pack', e.message);
  }
}

function classifyTabUrl(tab) {
  const raw = tab && (tab.url || tab.pendingUrl);
  if (!raw) return 'none';
  try {
    const protocol = new URL(raw).protocol;
    if (protocol === 'http:' || protocol === 'https:') return protocol.slice(0, -1);
    if (protocol === 'chrome-extension:') return 'extension';
    return 'restricted-or-other';
  } catch (_) {
    return 'invalid';
  }
}

function recordPopupUiState(pageKind) {
  PSL.checkpoint('popup', 'popup.ui_state_applied', { pageKind: pageKind || currentTabUrlKind });
  if (frameProbeScheduled || typeof requestAnimationFrame !== 'function') return;
  frameProbeScheduled = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      PSL.checkpoint('popup', 'popup.frame_callback');
    });
  });
}

function analyzeCurrentTab() {
  PSL.checkpoint('popup', 'popup.tabs_query_started');
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    if (chrome.runtime.lastError) {
      PSL.error('popup', 'tabs.query failed', chrome.runtime.lastError.message);
      showInvalidPageUI();
      recordPopupUiState('tabs-query-error');
      return;
    }
    const tab = tabs && tabs[0];
    currentTabLoading = !!(tab && tab.status === 'loading');
    const tabUrlKind = classifyTabUrl(tab);
    currentTabUrlKind = tabUrlKind;
    PSL.checkpoint('popup', 'popup.tabs_query_done', {
      loading: currentTabLoading,
      tabUrlKind,
    });
    if (!popupPort) {
      try {
        popupPort = chrome.runtime.connect({ name: 'popup' });
        PSL.checkpoint('popup', 'popup.port_connected');
        popupPort.onMessage.addListener((message) => {
          if (!message || message.type !== 'POPUP_ACK') return;
          PSL.checkpoint('popup', 'popup.background_ack', {
            workerBootId: message.bootId ? String(message.bootId).slice(0, 12) : '',
            workerReady: !!message.ready,
          });
        });
        popupPort.onDisconnect.addListener(() => {
          const lastError = chrome.runtime.lastError;
          PSL.checkpoint('popup', 'popup.port_disconnected', {
            reason: lastError ? lastError.message : 'normal-or-page-close',
          });
          popupPort = null;
        });
      } catch (e) {
        PSL.warn('popup', 'connect failed', e && e.message);
      }
    }
    if (popupPort) {
      try {
        popupPort.postMessage({
          type: 'POPUP_OPEN',
          loading: currentTabLoading,
          tabUrlKind,
          contextId: PSL.getContextId(),
        });
        PSL.checkpoint('popup', 'popup.open_posted', { loading: currentTabLoading, tabUrlKind });
      } catch (error) {
        PSL.error('popup', 'popup.open_send_failed', error);
      }
    }
    
    let effectiveUrl = null;
    if (tab && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
      effectiveUrl = tab.url;
    } else if (tab && tab.pendingUrl && (tab.pendingUrl.startsWith('http://') || tab.pendingUrl.startsWith('https://'))) {
      effectiveUrl = tab.pendingUrl;
    }

    if (effectiveUrl) {
      try {
        const url = new URL(effectiveUrl);
        currentTabDomain = url.hostname.toLowerCase();

        if (!currentTabDomain) throw new Error("Empty hostname");

        els.domain.textContent = currentTabDomain;
        els.domainArea.style.display = 'flex'; 

        if (els.actionArea) els.actionArea.style.display = 'block';

        checkDomainStatusWrapper(currentTabLoading);
      } catch (e) {
        showInvalidPageUI();
        recordPopupUiState('invalid');
      }
    } else {
      showInvalidPageUI();
      recordPopupUiState(tabUrlKind);
    }
  });
}

function checkDomainStatusWrapper(isLoading) {
  // 如果域名为空，不要去查 storage，直接显示无效 UI
  if (!currentTabDomain) {
    showInvalidPageUI();
    recordPopupUiState('invalid');
    return;
  }
  if (isLoading) {
    els.status.textContent = i18n("statusNotLoaded");
    els.statusIcon.textContent = "⏳";
    const wrapper = document.querySelector('.domain-card');
    if (wrapper) {
      wrapper.className = 'domain-card status-direct';
    }
    if (els.addBtnGroup) els.addBtnGroup.style.display = 'none';
    if (els.removeBtn) els.removeBtn.style.display = 'none';
    recordPopupUiState(currentTabUrlKind);
    return;
  }
  chrome.storage.local.get(['userRules', 'tempRules', 'userWhitelist', 'gfwDomains'], (items) => {
    if (chrome.runtime.lastError) {
      PSL.error('popup', 'domain status storage.get failed', chrome.runtime.lastError.message);
      showInvalidPageUI();
      recordPopupUiState('storage-error');
      return;
    }
    checkDomainStatus(items || {}, { loading: false });
    recordPopupUiState(currentTabUrlKind);
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
function checkDomainStatus(items, opts) {
  if (!currentTabDomain) {
    showInvalidPageUI();
    return;
  }

  const isLoading = !!(opts && opts.loading);
  const userRules = items.userRules || [];
  const tempRules = items.tempRules || [];
  const whitelist = items.userWhitelist || [];
  const gfwRules = items.gfwDomains || [];

  const userRulesSet = new Set(userRules.filter(Boolean));
  const tempRulesSet = new Set(tempRules.filter(Boolean));
  const whitelistSet = new Set(whitelist.filter(Boolean));
  const gfwRulesSet = new Set(gfwRules.filter(Boolean));

  const wildcardSuffixes = userRules
    .filter(r => typeof r === 'string' && r.startsWith('*.'))
    .map(r => r.substring(2));

  const matchUserRules = (domain) => {
    if (matchDomain(domain, userRulesSet)) return true;
    if (!wildcardSuffixes.length) return false;
    for (const suffix of wildcardSuffixes) {
      if (domain === suffix || domain.endsWith('.' + suffix)) return true;
    }
    return false;
  };
  
  let text = i18n("popStatusDirect");
  let icon = "🛡️";
  let isProxy = false;
  let isWhite = false;
  let statusClass = "status-direct";

  if (matchDomain(currentTabDomain, whitelistSet)) { 
    text = i18n("popStatusForceDirect"); 
    icon = "🛡️";
    isWhite = true; 
    statusClass = "status-direct";
  } 
  else if (matchDomain(currentTabDomain, tempRulesSet)) { 
    text = i18n("popStatusTemp"); 
    icon = "⏱️";
    isProxy = true; 
    statusClass = "status-temp";
  }
  else if (matchUserRules(currentTabDomain)) { 
    text = i18n("popStatusForceProxy"); 
    icon = "🚀";
    isProxy = true; 
    statusClass = "status-user";
  }
  else if (!isLoading && matchDomain(currentTabDomain, gfwRulesSet)) { 
    text = i18n("popStatusGfw"); 
    icon = "🌏";
    statusClass = "status-proxy";
  } else if (isLoading) {
    text = i18n("statusNotLoaded");
    icon = "⏳";
    statusClass = "status-direct";
  }

  els.status.textContent = text;
  els.statusIcon.textContent = icon;

  const wrapper = document.querySelector('.domain-card');
  if (wrapper) {
    wrapper.className = `domain-card ${statusClass}`;
  }
  
  if (isProxy || isWhite) {
    els.removeBtn.style.display = 'flex'; 
    els.addBtnGroup.style.display = 'none';
    els.removeBtn.onclick = () => removeDomainRule();
  } else {
    els.removeBtn.style.display = 'none'; 
    els.addBtnGroup.style.display = 'flex';
    
    els.addRuleBtn.onclick = () => addRule('userRules');
    els.addTempRuleBtn.onclick = () => addRule('tempRules');
  }
}

// 事件绑定
els.serverSelect.onchange = () => {
  const id = els.serverSelect.value;
  chrome.storage.local.set({ activeServerId: id }, () => {
    sendMessageWithTimeout({type: 'REFRESH_PROXY'}, 2000, 'REFRESH_PROXY').then(() => {});
  });
};

// 模式切换
els.modePac.onclick = () => setMode('pac_script');
els.modeFixed.onclick = () => setMode('fixed_servers');
els.modeDirect.onclick = () => setMode('direct');
els.modeSystem.onclick = () => setMode('system');

function applyPacMode(pacScriptData) {
  applySetting({ mode: 'pac_script', pacScript: { data: pacScriptData } }, 'pac_script');
}

function setMode(mode) {
  const config = { mode: mode };
  if (mode === 'pac_script') {
    chrome.storage.local.get(['pacScriptData', 'serverList'], (i) => {
      if (i.pacScriptData) {
        applyPacMode(i.pacScriptData);
        return;
      }
      if (!(i.serverList || []).length) {
        PSL.warn('popup', 'No proxy server configured');
        alert(i18n('popErrAddServer'));
        chrome.runtime.openOptionsPage();
        return;
      }
      sendMessageWithTimeout({ type: 'ENSURE_PAC' }, 8000, 'ENSURE_PAC').then((res) => {
        if (res && res.timeout) {
          alert(i18n('popErrPac'));
          return;
        }
        if (res && res.error) {
          alert(i18n('popErrPac'));
          return;
        }
        if (res?.success && res.pacScriptData) {
          applyPacMode(res.pacScriptData);
        } else if (res?.error === 'no_server') {
          alert(i18n('popErrAddServer'));
          chrome.runtime.openOptionsPage();
        } else {
          PSL.warn('popup', 'PAC generation failed', res?.error || 'unknown');
          alert(i18n('popErrPac'));
        }
      });
    });
    return;
  } else if (mode === 'fixed_servers') {
    chrome.storage.local.get(['serverList', 'activeServerId'], (i) => {
      const s = (i.serverList||[]).find(x => x.id === i.activeServerId);
      if (s) { 
        config.rules = { singleProxy: { scheme: s.scheme.toLowerCase(), host: s.host, port: parseInt(s.port || 80) } }; 
        applySetting(config, mode); 
      } else {
        PSL.warn('popup', 'No proxy server configured');
        alert(i18n("popErrAddServer"));
        chrome.runtime.openOptionsPage();
      }
    });
  } else {
    // direct or system
    applySetting(config, mode);
  }
}

function applySetting(c, m) { 
  chrome.proxy.settings.set({ value: c, scope: 'regular' }, () => {
    if (chrome.runtime.lastError) {
      PSL.error('popup', 'Proxy mode apply failed', chrome.runtime.lastError.message);
    }
    currentMode = m; 
    updateModeUI(m); 
    // 刷新状态（传递正确 loading 标志）
    if (currentTabDomain) checkDomainStatusWrapper(currentTabLoading);
    sendMessageWithTimeout({type: 'REFRESH_PROXY'}, 2000, 'REFRESH_PROXY').then(() => {});
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
  if (!currentTabDomain) {
    PSL.warn('popup', 'Cannot add rule', 'empty domain');
    return;
  }

  const root = getRootDomain(currentTabDomain);
  if (!root) return;

  const btn = key === 'userRules' ? els.addRuleBtn : els.addTempRuleBtn;
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;

  chrome.storage.local.get([key], (i) => {
    const list = i[key] || []; 
    if (!list.includes(root)) {
      list.push(root);
      chrome.storage.local.set({ [key]: list }, () => {
        sendMessageWithTimeout({type: 'REFRESH_PROXY'}, 2000, 'REFRESH_PROXY').then(() => {});
        checkDomainStatusWrapper(currentTabLoading);
        if (btn) btn.disabled = false;
      });
    } else {
      checkDomainStatusWrapper(currentTabLoading);
      if (btn) btn.disabled = false;
    }
  });
}

function removeDomainRule() {
  if (!currentTabDomain) return;

  if (els.removeBtn && els.removeBtn.disabled) return;
  if (els.removeBtn) els.removeBtn.disabled = true;

  chrome.storage.local.get(['userRules', 'tempRules', 'userWhitelist'], (i) => {
    const root = getRootDomain(currentTabDomain);
    const plain = currentTabDomain.replace(/^www\./, '');
    const filterFn = d => {
      if (d === currentTabDomain) return false;
      if (d === root) return false;
      if (d === plain) return false;
      if (d === '*.' + root) return false;
      if (d === '.' + root) return false;
      if (d === '*.' + plain) return false;
      if (d === '.' + plain) return false;
      if (d === '*.' + currentTabDomain) return false;
      if (d === '.' + currentTabDomain) return false;
      return true;
    };
    
    chrome.storage.local.set({
      tempRules: (i.tempRules||[]).filter(filterFn),
      userWhitelist: (i.userWhitelist||[]).filter(filterFn),
      userRules: (i.userRules||[]).filter(filterFn)
    }, () => {
      sendMessageWithTimeout({type: 'REFRESH_PROXY'}, 2000, 'REFRESH_PROXY').then(() => {});
      checkDomainStatusWrapper(currentTabLoading);
      if (els.removeBtn) els.removeBtn.disabled = false;
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
