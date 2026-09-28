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
  whitelistArea: document.getElementById('whitelistArea'),
  addWhitelistBtn: document.getElementById('addWhitelistBtn'),
  removeWhitelistBtn: document.getElementById('removeWhitelistBtn'),
  whitelistButtonLabel: document.getElementById('whitelistButtonLabel'),
  whitelistHint: document.getElementById('whitelistHint'),
  whitelistMessage: document.getElementById('whitelistMessage'),
  
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
let baseConfigLoadId = 0;
let hasLoadedBaseConfig = false;
let configuredServers = [];
let configuredActiveServerId = null;
let requestedLanguage = null;
let languageRequestId = 0;
let languageLoadPromise = Promise.resolve();
const languagePackCache = new Map();
const htmlTranslationTemplates = { attributes: [], text: [] };

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
  // 在填入服务器名称等动态内容之前保留原始模板，切换语言时仍能重新翻译。
  captureHtmlTranslations();
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
const POPUP_RELEVANT_KEYS = ['serverList', 'activeServerId', 'userRules', 'tempRules', 'userWhitelist', 'gfwDomains', 'pacScriptData', 'appLanguage', 'theme'];
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
  const loadId = ++baseConfigLoadId;
  return new Promise(resolve => {
    chrome.storage.local.get(['serverList', 'activeServerId', 'theme', 'appLanguage', 'pacScriptData'], (items) => {
      const error = chrome.runtime.lastError;
      if (error) PSL.error('popup', 'base config storage.get failed', error.message);
      if (loadId !== baseConfigLoadId) {
        resolve();
        return;
      }
      if (error && hasLoadedBaseConfig) {
        // 临时读取失败不代表用户清空配置，保留已显示的语言、主题和服务器。
        resolve();
        return;
      }
      if (!error) hasLoadedBaseConfig = true;
      items = error ? {} : items || {};
      const userLang = items.appLanguage || 'auto';
      // 语言包独立加载，慢请求不会延迟页面状态或依赖后台唤醒。
      loadLanguagePack(userLang);

      const theme = items.theme || 'system';
      const doc = document.documentElement;
      if (theme === 'dark') doc.setAttribute('data-theme', 'dark');
      else if (theme === 'light') doc.setAttribute('data-theme', 'light');
      else doc.removeAttribute('data-theme');

      configuredServers = items.serverList || [];
      configuredActiveServerId = items.activeServerId;
      renderServerOptions();

      chrome.proxy.settings.get({}, (d) => {
        const error = chrome.runtime.lastError;
        if (loadId !== baseConfigLoadId) return;
        if (error) {
          PSL.error('popup', 'Proxy mode read failed', error.message);
          return;
        }
        if (d && d.value) {
          currentMode = d.value.mode;
          updateModeUI(currentMode);
          if (currentTabDomain) checkDomainStatusWrapper(currentTabLoading);
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

function renderServerOptions() {
  const options = Array.from(els.serverSelect.options);
  if (!configuredServers.length) {
    if (!els.serverSelect.disabled || options.length !== 1) {
      els.serverSelect.innerHTML = '';
      els.serverSelect.appendChild(document.createElement('option'));
    }
    els.serverSelect.options[0].textContent = i18n('popNoServer');
    els.serverSelect.disabled = true;
    return;
  }

  const optionsMatch = !els.serverSelect.disabled && options.length === configuredServers.length &&
    configuredServers.every((server, index) => options[index].value === String(server.id) && options[index].textContent === server.name);
  if (!optionsMatch) {
    els.serverSelect.innerHTML = '';
    configuredServers.forEach(server => {
      const option = document.createElement('option');
      option.value = server.id;
      option.textContent = server.name;
      els.serverSelect.appendChild(option);
    });
  }
  els.serverSelect.disabled = false;
  els.serverSelect.value = configuredServers.some(server => server.id === configuredActiveServerId)
    ? configuredActiveServerId : configuredServers[0].id;
}

function refreshLocalizedUI() {
  localizeHtmlPage();
  renderServerOptions();
  if (initDone) checkDomainStatusWrapper(currentTabLoading);
  if (typeof refreshWhitelistUI === 'function') refreshWhitelistUI();
}

function loadLanguagePack(lang) {
  if (lang === requestedLanguage) return languageLoadPromise;
  requestedLanguage = lang;
  const requestId = ++languageRequestId;

  if (lang === 'auto') {
    customMessages = null;
    languageLoadPromise = Promise.resolve();
    if (initDone) refreshLocalizedUI();
    return languageLoadPromise;
  }

  if (!languagePackCache.has(lang)) {
    const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
    languagePackCache.set(lang, fetch(url).then(res => {
      if (!res.ok) throw new Error(`Language pack request failed: ${res.status}`);
      return res.json();
    }).catch(error => {
      languagePackCache.delete(lang);
      throw error;
    }));
  }

  languageLoadPromise = languagePackCache.get(lang).then(messages => {
    if (requestId !== languageRequestId) return;
    customMessages = messages;
    refreshLocalizedUI();
  }).catch(error => {
    if (requestId !== languageRequestId) return;
    customMessages = null;
    PSL.error('popup', 'Failed to load language pack', error.message);
    refreshLocalizedUI();
  });
  return languageLoadPromise;
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

const whitelistState = { rules: [], busy: false, messageKey: '', error: false };
let domainStatusRequestId = 0;

// Match the PAC's hostname/suffix lookup, without broadening a host to its root domain.
function normalizeWhitelistHost(rule) {
  if (typeof rule !== 'string') return '';
  const host = rule.trim().toLowerCase();
  if (!/[^\x00-\x7F]/.test(host)) return host;
  try { return new URL('http://' + host).hostname; }
  catch (_) { return host; }
}

function findWhitelistRule(domain, rules) {
  let host = domain;
  const normalized = new Set(rules.map(normalizeWhitelistHost));
  while (host) {
    if (normalized.has(host)) return host;
    const dot = host.indexOf('.');
    if (dot < 0) break;
    host = host.substring(dot + 1);
  }
  return '';
}

function refreshWhitelistUI(rules) {
  if (Array.isArray(rules)) whitelistState.rules = rules;
  els.whitelistArea.style.display = currentTabDomain ? 'block' : 'none';
  if (!currentTabDomain) return;
  const matched = findWhitelistRule(currentTabDomain, whitelistState.rules);
  const exact = whitelistState.rules.some(rule => normalizeWhitelistHost(rule) === currentTabDomain);
  els.whitelistButtonLabel.textContent = i18n(matched ? 'popBtnWhitelisted' : 'popBtnWhitelist');
  els.addWhitelistBtn.disabled = whitelistState.busy || !!matched;
  els.removeWhitelistBtn.style.display = exact ? 'flex' : 'none';
  els.removeWhitelistBtn.disabled = whitelistState.busy;
  els.whitelistHint.textContent = i18n(matched && !exact ? 'popWhitelistInherited' : 'popWhitelistScope')
    .replace('%DOMAIN%', matched || currentTabDomain);
  if (currentMode !== 'pac_script') {
    els.whitelistHint.textContent += ' ' + i18n('popWhitelistAutoOnly');
  }
  els.whitelistMessage.textContent = whitelistState.messageKey ? i18n(whitelistState.messageKey) : '';
  els.whitelistMessage.style.display = whitelistState.messageKey ? 'block' : 'none';
  els.whitelistMessage.className = 'rule-message' + (whitelistState.error ? ' error' : '');
}

function whitelistStorageCall(method, value) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Whitelist storage timeout')), 3000);
    try {
      chrome.storage.local[method](value, (result) => {
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function updateWhitelist(add) {
  const domain = currentTabDomain;
  const otherButtons = [els.addRuleBtn, els.addTempRuleBtn, els.removeBtn];
  if (!domain || whitelistState.busy || otherButtons.some(button => button.disabled)) return;
  whitelistState.busy = true;
  whitelistState.messageKey = '';
  whitelistState.error = false;
  otherButtons.forEach(button => { button.disabled = true; });
  refreshWhitelistUI();
  let saved = false;
  try {
    const items = await whitelistStorageCall('get', ['userWhitelist']);
    const rules = items && items.userWhitelist === undefined ? [] : items && items.userWhitelist;
    if (!Array.isArray(rules)) throw new Error('Invalid whitelist configuration');
    const next = add
      ? (findWhitelistRule(domain, rules) ? rules : [...rules, domain])
      : rules.filter(rule => normalizeWhitelistHost(rule) !== domain);
    if (next.length !== rules.length) {
      await whitelistStorageCall('set', { userWhitelist: next });
    }
    saved = true;
    whitelistState.rules = next;
    whitelistState.messageKey = add ? 'popWhitelistSaved' : 'popWhitelistRemoved';
    refreshWhitelistUI();
    checkDomainStatusWrapper(currentTabLoading);
    // The worker applies this only if the actual proxy mode is still Auto.
    const result = await sendMessageWithTimeout({ type: 'REFRESH_PROXY', applyIfPac: true }, 2500, 'REFRESH_PROXY');
    if (!result || !result.success) whitelistState.messageKey = 'popWhitelistApplyPending';
  } catch (error) {
    whitelistState.messageKey = saved ? 'popWhitelistApplyPending' : 'popErrWhitelist';
    whitelistState.error = true;
    PSL.error('popup', 'Whitelist operation failed', error);
  } finally {
    whitelistState.busy = false;
    otherButtons.forEach(button => { button.disabled = false; });
    refreshWhitelistUI();
  }
}

els.addWhitelistBtn.onclick = () => updateWhitelist(true);
els.removeWhitelistBtn.onclick = () => updateWhitelist(false);

function checkDomainStatusWrapper(isLoading) {
  const requestId = ++domainStatusRequestId;
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
    refreshWhitelistUI();
    // Keep the loading-page path light: no GFWList read or rule compilation.
    chrome.storage.local.get(['userWhitelist'], (items) => {
      const error = chrome.runtime.lastError;
      if (requestId !== domainStatusRequestId || error) return;
      refreshWhitelistUI(items && items.userWhitelist || []);
    });
    recordPopupUiState(currentTabUrlKind);
    return;
  }
  chrome.storage.local.get(['userRules', 'tempRules', 'userWhitelist', 'gfwDomains'], (items) => {
    if (requestId !== domainStatusRequestId) return;
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
  refreshWhitelistUI();
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

  if (findWhitelistRule(currentTabDomain, whitelist)) {
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

  // Saved domain rules only control routing in Auto mode.
  if (currentMode === 'system') {
    text = i18n('popTitleSystem');
    icon = '💻';
    statusClass = 'status-direct';
  } else if (currentMode === 'fixed_servers') {
    text = i18n('popTitleGlobal');
    icon = '🚀';
    statusClass = 'status-proxy';
  } else if (currentMode === 'direct') {
    text = i18n('popTitleDirect');
    icon = '🛡️';
    statusClass = 'status-direct';
  }

  els.status.textContent = text;
  els.statusIcon.textContent = icon;

  const wrapper = document.querySelector('.domain-card');
  if (wrapper) {
    wrapper.className = `domain-card ${statusClass}`;
  }
  
  refreshWhitelistUI(whitelist);
  if (isWhite) {
    // Removing a direct exception must not erase underlying proxy rules.
    els.removeBtn.style.display = 'none';
    els.addBtnGroup.style.display = 'none';
  } else if (isProxy) {
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
  refreshWhitelistUI();
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

// --- 翻译辅助函数：保留模板，支持异步加载完成后及语言切换时重新翻译 ---
function captureHtmlTranslations() {
  const attributes = ['placeholder', 'title', 'alt', 'value', 'aria-label'];
  const elements = document.querySelectorAll(attributes.map(attr => `[${attr}]`).join(','));
  elements.forEach(el => {
    attributes.forEach(attr => {
      const template = el.getAttribute(attr);
      if (template && template.includes('__MSG_')) {
        htmlTranslationTemplates.attributes.push({ el, attr, template });
      }
    });
  });

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue.includes('__MSG_')) {
      htmlTranslationTemplates.text.push({ node, template: node.nodeValue, html: false });
    }
  }
}

function localizeHtmlPage() {
  const translate = template => template.replace(/__MSG_(\w+)__/g, (match, key) => i18n(key) || match);
  htmlTranslationTemplates.attributes.forEach(({ el, attr, template }) => {
    el.setAttribute(attr, translate(template));
  });
  htmlTranslationTemplates.text.forEach(entry => {
    if (!entry.node.parentNode) return;
    const translatedText = translate(entry.template);
    if (!entry.html && translatedText.includes('<') && translatedText.includes('>')) {
      const span = document.createElement('span');
      entry.node.parentNode.replaceChild(span, entry.node);
      entry.node = span;
      entry.html = true;
    }
    if (entry.html) entry.node.innerHTML = translatedText;
    else entry.node.nodeValue = translatedText;
  });
}

els.goOptions.onclick = () => chrome.runtime.openOptionsPage();
