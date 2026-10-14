// js/popup.js - ProxySwitch (i18n Version Fixed)

PSL.checkpoint('popup', 'popup.script_entered', { readyState: document.readyState });

const els = {
  serverSelect: document.getElementById('serverSelect'),
  
  // 状态显示区域
  domain: document.getElementById('currentDomain'),
  status: document.getElementById('routingStatus'),
  statusIcon: document.getElementById('statusIcon'),
  domainArea: document.getElementById('domainArea'),
  pageLoadingState: document.getElementById('pageLoadingState'),
  routingDetailsBtn: document.getElementById('routingDetailsBtn'),
  routingDetails: document.getElementById('routingDetails'),
  routingDetailsText: document.getElementById('routingDetailsText'),
  routingScopeText: document.getElementById('routingScopeText'),
  
  // 模式切换按钮
  modePac: document.getElementById('mode-pac'),
  modeFixed: document.getElementById('mode-fixed'),
  modeDirect: document.getElementById('mode-direct'),
  modeSystem: document.getElementById('mode-system'),
  
  // 操作按钮
  actionArea: document.getElementById('actionArea'), // 包含按钮的父容器
  addBtnGroup: document.getElementById('addBtnGroup'),
  addRuleBtn: document.getElementById('addRuleBtn'),
  proxyButtonLabel: document.getElementById('proxyButtonLabel'),
  addTempRuleBtn: document.getElementById('addTempRuleBtn'),
  removeBtn: document.getElementById('removeBtn'),
  removeRuleIcon: document.getElementById('removeRuleIcon'),
  removeRuleLabel: document.getElementById('removeRuleLabel'),
  manageRulesBtn: document.getElementById('manageRulesBtn'),
  manageRulesLabel: document.getElementById('manageRulesLabel'),
  whitelistArea: document.getElementById('whitelistArea'),
  addWhitelistBtn: document.getElementById('addWhitelistBtn'),
  removeWhitelistBtn: document.getElementById('removeWhitelistBtn'),
  whitelistButtonLabel: document.getElementById('whitelistButtonLabel'),
  whitelistHint: document.getElementById('whitelistHint'),
  whitelistMessage: document.getElementById('whitelistMessage'),
  operationMessage: document.getElementById('operationMessage'),
  ruleHint: document.getElementById('ruleScopeHint'),
  moreActionsBtn: document.getElementById('moreActionsBtn'),
  moreActions: document.getElementById('moreActions'),
  exceptionManageRulesBtn: document.getElementById('exceptionManageRulesBtn'),
  proxyControlMessage: document.getElementById('proxyControlMessage'),
  
  goOptions: document.getElementById('openSettings')
};

let currentTabDomain = '';
let currentMode = null; // Do not highlight Direct before the actual browser mode is known.
let trackedTabId = null;
let trackedTab = null;
let tabUpdateListener = null;
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
const operationState = { busy: false, messageKey: '', error: false };
let proxyLevelOfControl = null;
let proxyRuntimeStatus = null;
let modeRequestId = 0;
let modeReadId = 0;
let inheritedProxyRule = false;
let exactProxyRuleActive = false;
let localRuleRoute = false;
let matchedProxyRule = '';
let siteProxySaved = false;
let siteProxyBlocked = false;
let siteTemporaryBlocked = false;
const storageBaselines = new Map();
let pendingConfigurationSave = null;
const CONFIGURATION_REJECTION_CODES = ['config_changed', 'invalid_configuration', 'invalid_rules', 'invalid_server', 'storage_failed', 'storage_timeout'];

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
  if (tabUpdateListener && chrome.tabs.onUpdated && chrome.tabs.onUpdated.removeListener) chrome.tabs.onUpdated.removeListener(tabUpdateListener);
});

function setStatusIcon(name) {
  els.statusIcon.setAttribute('data-icon', name);
  if (globalThis.ProxySwitchUI && typeof ProxySwitchUI.setIcon === 'function') ProxySwitchUI.setIcon(els.statusIcon, name);
}

function routeIconKey(mode, source, route) {
  if (mode === 'fixed_servers') return 'fixed';
  if (mode === 'direct') return 'direct';
  if (mode === 'system') return 'system';
  if (mode !== 'pac_script') return 'pac_gray';
  if (route === 'direct' && source && source !== 'default') return 'pac_blue';
  if (route === 'proxy') return source === 'trial' || source === 'temporary' ? 'pac_org'
    : source === 'subscription' ? 'pac_green' : 'pac_purp';
  return 'pac_gray';
}

function setRouteAppearance(key) {
  els.domainArea.setAttribute('data-icon-key', key);
  refreshDomainDescription();
}

function refreshDomainDescription() {
  // Ordinary sites use a compact visual heading, while an unsupported page
  // still needs its explicit explanation rather than an unexplained gray icon.
  els.status.className = currentTabDomain ? 'sr-only' : 'unavailable-state';
  if (!currentTabDomain) return;
  // Keep the full hostname and rule explanation available when the single-line
  // heading is shortened. This describes rule routing, not a measured exit.
  const descriptions = [currentTabDomain, els.status.textContent, els.routingDetailsText.textContent];
  els.domain.setAttribute('title', [...new Set(descriptions.filter(Boolean))].join('\n'));
}

function focusInside(panel) {
  let active = document.activeElement;
  while (active) {
    if (active === panel) return true;
    active = active.parentElement;
  }
  return false;
}

function setDisclosure(button, panel, expanded, restoreFocus = false) {
  const returnFocus = !expanded && restoreFocus && focusInside(panel);
  panel.hidden = !expanded;
  button.setAttribute('aria-expanded', String(expanded));
  if (returnFocus && typeof button.focus === 'function') button.focus();
}

function closeSiteDisclosures() {
  setDisclosure(els.routingDetailsBtn, els.routingDetails, false, true);
  setDisclosure(els.moreActionsBtn, els.moreActions, false, true);
}

els.routingDetailsBtn.onclick = () => setDisclosure(els.routingDetailsBtn, els.routingDetails, els.routingDetails.hidden);
els.moreActionsBtn.onclick = () => {
  const expanded = els.moreActions.hidden;
  setDisclosure(els.moreActionsBtn, els.moreActions, expanded);
  // The trigger is in the section heading, before the main buttons. Start at
  // the first available secondary action so keyboard users can use it directly.
  if (expanded) {
    const first = Array.from(els.moreActions.querySelectorAll('button')).find(button => !button.disabled && !button.hidden && button.style.display !== 'none');
    if (first && typeof first.focus === 'function') first.focus();
  }
};
els.exceptionManageRulesBtn.onclick = openRuleManagement;
if (typeof document.addEventListener === 'function') document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  // Close only the disclosure the user is operating, without a focus trap or
  // intercepting unrelated controls such as the native server selector.
  if (!els.moreActions.hidden && (focusInside(els.moreActions) || document.activeElement === els.moreActionsBtn)) {
    event.preventDefault(); setDisclosure(els.moreActionsBtn, els.moreActions, false, true);
  } else if (!els.routingDetails.hidden && (focusInside(els.routingDetails) || document.activeElement === els.routingDetailsBtn)) {
    event.preventDefault(); setDisclosure(els.routingDetailsBtn, els.routingDetails, false, true);
  }
});

function sendMessageWithTimeout(message, timeoutMs, label, onLate) {
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
      const lastError = chrome.runtime.lastError;
      if (finished) {
        if (onLate) onLate(lastError ? { error: lastError.message } : res);
        return;
      }
      finished = true;
      clearTimeout(timer);
      if (lastError) {
        PSL.error('popup', `${label} sendMessage failed`, lastError.message);
        resolve({ error: lastError.message });
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
const POPUP_RELEVANT_KEYS = ['serverList', 'activeServerId', 'userRules', 'tempRules', 'userWhitelist', 'gfwDomains', 'pacScriptData', 'diagnosticTrial', 'appLanguage', 'theme', 'proxyRuntimeStatus'];
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
    chrome.storage.local.get(['serverList', 'activeServerId', 'theme', 'appLanguage', 'proxyRuntimeStatus'], (items) => {
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
      if (globalThis.ProxySwitchUI && typeof ProxySwitchUI.applyTheme === 'function') ProxySwitchUI.applyTheme(theme);
      else {
        const doc = document.documentElement;
        if (theme === 'dark') doc.setAttribute('data-theme', 'dark');
        else if (theme === 'light') doc.setAttribute('data-theme', 'light');
        else doc.removeAttribute('data-theme');
      }

      configuredServers = items.serverList || [];
      configuredActiveServerId = items.activeServerId;
      proxyRuntimeStatus = items.proxyRuntimeStatus || null;
      renderServerOptions();

      const requestId = modeRequestId;
      const readId = ++modeReadId;
      chrome.proxy.settings.get({}, (d) => {
        const error = chrome.runtime.lastError;
        if (loadId !== baseConfigLoadId || requestId !== modeRequestId || readId !== modeReadId || operationState.busy) return;
        if (error) {
          PSL.error('popup', 'Proxy mode read failed', error.message);
          return;
        }
        if (d && d.value) {
          currentMode = d.value.mode;
          proxyLevelOfControl = d.levelOfControl || null;
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
    els.serverSelect.setAttribute('title', i18n('popNoServer'));
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
  els.serverSelect.disabled = configurationMutationBusy();
  els.serverSelect.value = configuredServers.some(server => server.id === configuredActiveServerId)
    ? configuredActiveServerId : configuredServers[0].id;
  updateSelectedServerTitle();
}

function updateSelectedServerTitle() {
  const selected = configuredServers.find(server => String(server.id) === els.serverSelect.value);
  els.serverSelect.setAttribute('title', selected ? selected.name : i18n('popNoServer'));
}

function refreshLocalizedUI() {
  localizeHtmlPage();
  renderServerOptions();
  if (initDone) checkDomainStatusWrapper(currentTabLoading);
  if (typeof refreshWhitelistUI === 'function') refreshWhitelistUI();
  renderOperationFeedback();
  renderRuleHint();
  renderProxyControl();
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
  const raw = tab && (tab.status === 'loading' && tab.pendingUrl || tab.url || tab.pendingUrl);
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
    trackedTabId = tab && Number.isInteger(tab.id) ? tab.id : null;
    trackedTab = tab || null;
    trackCurrentTabUpdates();
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
    
    applyCurrentTab(tab);
  });
}

function trackCurrentTabUpdates() {
  if (tabUpdateListener || trackedTabId === null || !chrome.tabs.onUpdated || typeof chrome.tabs.onUpdated.addListener !== 'function') return;
  // A popup belongs to the page that opened it. Do not re-query the active tab:
  // diagnostics or Settings can become active without changing that page.
  tabUpdateListener = (tabId, changeInfo, tab) => {
    if (tabId !== trackedTabId || tab && tab.id !== undefined && tab.id !== trackedTabId) return;
    if (!changeInfo || !['url', 'pendingUrl', 'status'].some(key => Object.prototype.hasOwnProperty.call(changeInfo, key))) return;
    trackedTab = { ...trackedTab, ...(tab || {}), ...changeInfo };
    if (changeInfo.url || changeInfo.status === 'complete') delete trackedTab.pendingUrl;
    applyCurrentTab(trackedTab);
  };
  chrome.tabs.onUpdated.addListener(tabUpdateListener);
}

function applyCurrentTab(tab) {
  currentTabLoading = !!(tab && tab.status === 'loading');
  currentTabUrlKind = classifyTabUrl(tab);
  const raw = tab && (currentTabLoading && tab.pendingUrl || tab.url || tab.pendingUrl);
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('Unsupported page');
    const hostname = url.hostname.toLowerCase();
    if (hostname !== currentTabDomain) {
      closeSiteDisclosures();
      // Never carry a disabled proxy button or an inherited-delete handler from
      // the previous host while the new host's small rules read is pending.
      siteProxySaved = false;
      const coverage = getWhitelistCoverage(hostname, whitelistState.rules);
      siteProxyBlocked = !!coverage.parentMatch;
      siteTemporaryBlocked = !!coverage.matched;
      exactProxyRuleActive = false;
      inheritedProxyRule = false;
      matchedProxyRule = '';
      localRuleRoute = false;
      els.removeBtn.style.display = 'none';
      els.addTempRuleBtn.style.display = 'inline-flex';
      els.proxyButtonLabel.textContent = i18n('popBtnSiteProxy');
      els.addRuleBtn.setAttribute('aria-pressed', 'false');
      renderPendingRouting();
    }
    currentTabDomain = hostname;
    els.domain.textContent = currentTabDomain;
    els.domainArea.classList.remove('status-fail');
    refreshDomainDescription();
    els.domainArea.style.display = 'block';
    els.actionArea.style.display = 'block';
    els.routingScopeText.textContent = i18n('popRuleScope').replace('%DOMAIN%', currentTabDomain);
    syncMutationControls();
    renderRuleHint();
    checkDomainStatusWrapper(currentTabLoading);
  } catch (_) {
    ++domainStatusRequestId;
    showInvalidPageUI();
    recordPopupUiState(currentTabUrlKind);
  }
}

const whitelistState = { rules: [], busy: false, messageKey: '', error: false };
let domainStatusRequestId = 0;

function mutationBusy() { return operationState.busy || whitelistState.busy; }
function configurationMutationBusy() { return mutationBusy() || !!pendingConfigurationSave; }

function renderOperationFeedback() {
  els.operationMessage.textContent = operationState.messageKey ? i18n(operationState.messageKey) : '';
  els.operationMessage.style.display = operationState.messageKey ? 'block' : 'none';
  els.operationMessage.className = 'rule-message' + (operationState.error ? ' error' : '');
}

function operationFeedback(key, error = false) {
  operationState.messageKey = key;
  operationState.error = error;
  renderOperationFeedback();
}

function renderProxyControl() {
  const unavailable = proxyLevelOfControl === 'not_controllable' || proxyLevelOfControl === 'controlled_by_other_extensions';
  const proxyError = proxyRuntimeStatus && proxyRuntimeStatus.error && proxyRuntimeStatus.mode === currentMode &&
    (currentMode === 'pac_script' || currentMode === 'fixed_servers');
  els.proxyControlMessage.textContent = unavailable ? i18n('popErrProxyControl') : proxyError ? i18n('popProxyRuntimeError') : '';
  els.proxyControlMessage.style.display = unavailable || proxyError ? 'block' : 'none';
}

function syncMutationControls() {
  const busy = mutationBusy();
  [els.modePac, els.modeFixed, els.modeDirect, els.modeSystem].forEach(button => { button.disabled = busy; });
  [els.addRuleBtn, els.addTempRuleBtn, els.removeBtn].forEach(button => { button.disabled = configurationMutationBusy(); });
  els.addRuleBtn.disabled = configurationMutationBusy() || siteProxySaved || siteProxyBlocked;
  els.addTempRuleBtn.disabled = configurationMutationBusy() || siteProxySaved || siteTemporaryBlocked;
  els.serverSelect.disabled = configurationMutationBusy() || !configuredServers.length;
  updateSelectedServerTitle();
  refreshWhitelistUI();
}

function beginOperation(kind = 'configuration') {
  if (mutationBusy() || kind === 'configuration' && pendingConfigurationSave) return false;
  operationState.busy = true;
  // Feedback survives redraws, but a new user operation replaces the previous
  // operation's result instead of stacking two contradictory success notices.
  whitelistState.messageKey = '';
  whitelistState.error = false;
  operationFeedback('popOperationSaving');
  syncMutationControls();
  return true;
}

function finishOperation() {
  operationState.busy = false;
  syncMutationControls();
}

// A callback is not a confirmation when Chrome reports lastError, and a callback
// that arrives after the timeout must not complete a newer popup operation.
function popupApiCall(invoke, label, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      const error = new Error(label + ' timeout');
      error.code = 'timeout';
      reject(error);
    }, timeoutMs);
    try {
      invoke(result => {
        const lastError = chrome.runtime.lastError;
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (lastError) reject(new Error(lastError.message));
        else resolve(result);
      });
    } catch (error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function popupStorageCall(method, value, compareKeys = []) {
  if (method === 'get') {
    const items = await popupApiCall(done => chrome.storage.local.get(value, done), 'storage.get');
    const keys = typeof value === 'string' ? [value] : value;
    for (const key of keys) {
      const exists = !!items && Object.prototype.hasOwnProperty.call(items, key) && items[key] !== undefined;
      // Keep the read baseline separate from arrays/objects the action will edit.
      storageBaselines.set(key, exists ? { exists: true, value: JSON.parse(JSON.stringify(items[key])) } : { exists: false });
    }
    return items || {};
  }
  const expected = {};
  // Reads that determine whether an action is permitted also need a comparison
  // lease, even when the action does not write those dependency fields.
  const guardKeys = new Set([...Object.keys(value), ...compareKeys]);
  if (Object.prototype.hasOwnProperty.call(value, 'activeServerId')) guardKeys.add('serverList');
  for (const key of guardKeys) {
    if (!storageBaselines.has(key)) {
      const error = new Error('Configuration read baseline missing'); error.code = 'config_changed'; throw error;
    }
    expected[key] = storageBaselines.get(key);
  }
  // Configuration writes share the worker's restore/save gate. A stale popup
  // cannot overwrite a newer edit or an in-progress cloud restore.
  const token = {};
  const modeVersion = modeRequestId;
  const result = await sendMessageWithTimeout({ type: 'SAVE_CONFIGURATION', items: value, expected }, 10000, 'SAVE_CONFIGURATION', reply => {
    if (pendingConfigurationSave !== token) return;
    if (!reply || !reply.success && !CONFIGURATION_REJECTION_CODES.includes(reply.error)) return;
    pendingConfigurationSave = null;
    syncMutationControls();
    reconcileLateConfiguration(reply, value, expected, modeVersion).catch(error => PSL.warn('popup', 'Late configuration confirmation failed', error));
  });
  if (!result || !result.success) {
    if (!result || result.timeout || !CONFIGURATION_REJECTION_CODES.includes(result.error)) pendingConfigurationSave = token;
    const error = new Error('Configuration save not confirmed');
    error.code = result && result.error || 'save_unconfirmed';
    throw error;
  }
  const savedItems = result.items || value;
  for (const key of Object.keys(value)) storageBaselines.set(key, { exists: true, value: JSON.parse(JSON.stringify(savedItems[key])) });
}

async function reconcileLateConfiguration(reply, items, expected, modeVersion) {
  const whitelist = Object.prototype.hasOwnProperty.call(items, 'userWhitelist') && !Object.prototype.hasOwnProperty.call(items, 'userRules');
  if (!reply || !reply.success) {
    if (reply && reply.error === 'config_changed') {
      if (whitelist) { whitelistState.messageKey = 'popErrConfigChanged'; whitelistState.error = true; refreshWhitelistUI(); }
      else if (modeVersion === modeRequestId && !mutationBusy()) operationFeedback('popErrConfigChanged', true);
    }
    return;
  }
  const server = Object.prototype.hasOwnProperty.call(items, 'activeServerId');
  const removed = Object.keys(items).some(key => (whitelist || key !== 'userWhitelist') && Array.isArray(items[key]) && items[key].length < (expected[key].value || []).length);
  const result = await sendMessageWithTimeout({ type: 'REFRESH_PROXY', ...(!server ? { applyIfPac: true } : {}) }, 2500, 'REFRESH_PROXY');
  if (whitelist) {
    whitelistState.rules = (reply.items || items).userWhitelist;
    whitelistState.messageKey = result && result.success ? removed ? 'popWhitelistRemoved' : 'popWhitelistSaved' : 'popWhitelistApplyPending';
    whitelistState.error = false;
    refreshWhitelistUI();
  } else if (modeVersion === modeRequestId && !mutationBusy()) {
    operationFeedback(result && result.success ? server ? 'popServerSaved' : removed ? 'popRuleRemoved' : 'popRuleSaved' : server ? 'popServerApplyPending' : 'popRuleApplyPending');
  }
  await loadBaseConfig();
  if (currentTabDomain) checkDomainStatusWrapper(currentTabLoading);
}

function normalizeProxyRule(rule) {
  if (typeof rule !== 'string') return '';
  return normalizeWhitelistHost(rule.trim().replace(/^\*\./, '').replace(/^\./, ''));
}

function exactProxyRule(rule, hostname) {
  return normalizeProxyRule(rule) === hostname;
}

function renderRuleHint() {
  const inherited = currentTabDomain && inheritedProxyRule;
  const local = currentTabDomain && localRuleRoute && currentMode === 'pac_script';
  els.ruleHint.style.display = inherited || local ? 'block' : 'none';
  els.ruleHint.textContent = inherited ? i18n('popInheritedProxyCompact') + (matchedProxyRule ? ' · ' + matchedProxyRule : '')
    : local ? i18n('popLocalDirectCompact') : '';
  els.routingScopeText.textContent = currentTabDomain ? i18n('popRuleScope').replace('%DOMAIN%', currentTabDomain) : '';
  renderExceptionManagement();
  els.removeRuleLabel.textContent = i18n(inheritedProxyRule ? 'popBtnManageRule' : 'popBtnRemove');
  els.removeRuleIcon.setAttribute('data-icon', inheritedProxyRule ? 'list' : 'undo');
  if (globalThis.ProxySwitchUI && typeof ProxySwitchUI.setIcon === 'function') ProxySwitchUI.setIcon(els.removeRuleIcon, inheritedProxyRule ? 'list' : 'undo');
}

function renderExceptionManagement() {
  const parentDirect = currentTabDomain && getWhitelistCoverage(currentTabDomain, whitelistState.rules).parentMatch;
  els.exceptionManageRulesBtn.hidden = !currentTabDomain || !parentDirect && !inheritedProxyRule;
}

function openRuleManagement() {
  chrome.tabs.create({ url: chrome.runtime.getURL('html/options.html#rules') });
}

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

function getWhitelistCoverage(domain, rules) {
  const exact = rules.some(rule => normalizeWhitelistHost(rule) === domain);
  const parentMatch = findWhitelistRule(domain, rules.filter(rule => normalizeWhitelistHost(rule) !== domain));
  return { exact, parentMatch, matched: exact ? domain : parentMatch };
}

function refreshWhitelistUI(rules) {
  if (Array.isArray(rules)) whitelistState.rules = rules;
  els.whitelistArea.style.display = currentTabDomain ? 'block' : 'none';
  if (!currentTabDomain) return;
  const { matched, exact, parentMatch } = getWhitelistCoverage(currentTabDomain, whitelistState.rules);
  els.whitelistButtonLabel.textContent = i18n(matched ? 'popBtnSiteDirectSaved' : 'popBtnSiteDirect');
  els.addWhitelistBtn.setAttribute('aria-pressed', String(!!matched));
  els.addWhitelistBtn.disabled = configurationMutationBusy() || !!matched;
  els.removeWhitelistBtn.style.display = exact ? 'flex' : 'none';
  els.removeWhitelistBtn.disabled = configurationMutationBusy();
  els.manageRulesLabel.textContent = i18n(parentMatch ? 'popBtnManageDirectRule' : 'popBtnManageRule');
  els.manageRulesBtn.style.display = inheritedProxyRule ? 'none' : 'inline-flex';
  const nonAuto = currentMode && currentMode !== 'pac_script';
  els.whitelistHint.textContent = parentMatch ? i18n('popParentDirectCompact').replace('%DOMAIN%', parentMatch) : '';
  if (nonAuto) els.whitelistHint.textContent += (parentMatch ? ' ' : '') + i18n('popSiteAutoOnlyCompact');
  els.whitelistHint.style.display = parentMatch || nonAuto ? 'block' : 'none';
  renderExceptionManagement();
  els.whitelistMessage.textContent = whitelistState.messageKey ? i18n(whitelistState.messageKey) : '';
  els.whitelistMessage.style.display = whitelistState.messageKey ? 'block' : 'none';
  els.whitelistMessage.className = 'rule-message' + (whitelistState.error ? ' error' : '');
}

function whitelistStorageCall(method, value) {
  return popupStorageCall(method, value);
}

async function updateWhitelist(add) {
  const domain = currentTabDomain;
  if (!domain || configurationMutationBusy()) return;
  whitelistState.busy = true;
  operationState.messageKey = '';
  operationState.error = false;
  renderOperationFeedback();
  whitelistState.messageKey = 'popOperationSaving';
  whitelistState.error = false;
  syncMutationControls();
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
    whitelistState.messageKey = error.code === 'config_changed' ? 'popErrConfigChanged' : saved ? 'popWhitelistApplyPending' : 'popErrWhitelist';
    whitelistState.error = true;
    PSL.error('popup', 'Whitelist operation failed', error);
  } finally {
    whitelistState.busy = false;
    syncMutationControls();
  }
}

els.addWhitelistBtn.onclick = () => updateWhitelist(true);
els.removeWhitelistBtn.onclick = () => updateWhitelist(false);
els.addRuleBtn.onclick = () => addRule('userRules');
els.addTempRuleBtn.onclick = () => addRule('tempRules');
els.manageRulesBtn.onclick = openRuleManagement;

function renderPendingRouting() {
  const modeKey = { system: 'popTitleSystem', fixed_servers: 'popTitleGlobal', direct: 'popTitleDirect' }[currentMode];
  els.status.textContent = i18n(modeKey || 'popRoutePending');
  els.routingDetailsText.textContent = i18n(modeKey || 'statusNotLoaded');
  setStatusIcon(currentMode === 'system' ? 'monitor' : currentMode === 'fixed_servers' ? 'route' : currentMode === 'direct' ? 'arrow-up-right' : 'clock');
  setRouteAppearance(routeIconKey(currentMode, '', 'unknown'));
}

function checkDomainStatusWrapper(isLoading) {
  const requestId = ++domainStatusRequestId;
  els.pageLoadingState.textContent = i18n('popPageLoadingCompact');
  els.pageLoadingState.style.display = isLoading ? 'block' : 'none';
  // 如果域名为空，不要去查 storage，直接显示无效 UI
  if (!currentTabDomain) {
    showInvalidPageUI();
    recordPopupUiState('invalid');
    return;
  }
  if (isLoading) {
    renderPendingRouting();
    els.addBtnGroup.style.display = 'block';
    refreshWhitelistUI();
    // Keep loading pages actionable and light: evaluate manual/session rules,
    // but never read or compile the subscription list while the page is stuck.
    chrome.storage.local.get(['userRules', 'tempRules', 'userWhitelist', 'diagnosticTrial'], (items) => {
      const error = chrome.runtime.lastError;
      if (requestId !== domainStatusRequestId || error) return;
      checkDomainStatus(items || {}, { loading: true });
    });
    recordPopupUiState(currentTabUrlKind);
    return;
  }
  chrome.storage.local.get(['userRules', 'tempRules', 'userWhitelist', 'gfwDomains', 'diagnosticTrial'], (items) => {
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
  const focusWasInActions = focusInside(els.actionArea);
  closeSiteDisclosures();
  currentTabDomain = ""; // 确保变量清空
  inheritedProxyRule = false;
  matchedProxyRule = '';
  siteProxySaved = false;
  siteProxyBlocked = false;
  siteTemporaryBlocked = false;
  currentTabLoading = false;
  renderRuleHint();
  els.domain.textContent = i18n("popInvalidPage");
  els.domain.removeAttribute('title');
  els.domainArea.style.display = 'block';
  els.status.textContent = i18n("popCannotSet");
  els.routingDetailsText.textContent = i18n('popCannotSet');
  setStatusIcon('info');
  setRouteAppearance('pac_gray');
  els.pageLoadingState.style.display = 'none';
  
  const wrapper = document.querySelector('.domain-card');
  if (wrapper) {
    wrapper.className = 'domain-card status-fail';
  }
  
  if (els.addBtnGroup) els.addBtnGroup.style.display = 'none';
  if (els.removeBtn) els.removeBtn.style.display = 'none';
  els.actionArea.style.display = 'none';
  refreshWhitelistUI();
  if (focusWasInActions && typeof els.routingDetailsBtn.focus === 'function') els.routingDetailsBtn.focus();
}

// 核心状态判断逻辑
function checkDomainStatus(items, opts) {
  if (!currentTabDomain) {
    showInvalidPageUI();
    return;
  }

  const isLoading = !!(opts && opts.loading);
  const userRules = Array.isArray(items.userRules) ? items.userRules : [];
  const tempRules = Array.isArray(items.tempRules) ? items.tempRules : [];
  const whitelist = Array.isArray(items.userWhitelist) ? items.userWhitelist : [];
  let text = i18n(isLoading ? 'statusNotLoaded' : 'popStatusDirect');
  let icon = isLoading ? 'clock' : 'arrow-up-right';
  let isProxy = false;
  let isWhite = false;
  let statusClass = 'status-direct';
  let diagnosticTrialActive = false;
  let expectedRoute = 'unknown';
  let routeSource = '';

  // All normal and trial rule badges use the same evaluation as the generated
  // PAC, including local-address bypass and manual/temporary rule precedence.
  localRuleRoute = false;
  matchedProxyRule = '';
  if (globalThis.ProxySwitchRouting) {
    const route = ProxySwitchRouting.evaluate(currentTabDomain, ProxySwitchRouting.prepare(items), { trial: items.diagnosticTrial });
    routeSource = route.source;
    isWhite = route.source === 'whitelist';
    isProxy = route.source === 'user' || route.source === 'temporary';
    localRuleRoute = route.source === 'local';
    matchedProxyRule = isProxy ? route.rule || '' : '';
    expectedRoute = route.source === 'default' && isLoading ? 'unknown' : route.route;
    const badge = {
      whitelist: ['popStatusForceDirect', 'arrow-up-right', 'status-direct'],
      user: ['popStatusForceProxy', 'route', 'status-user'],
      temporary: ['popStatusTemp', 'clock', 'status-temp'],
      subscription: ['popStatusGfw', 'globe', 'status-proxy'],
      local: ['popStatusDirect', 'arrow-up-right', 'status-direct'],
      default: [isLoading ? 'statusNotLoaded' : 'popStatusDirect', isLoading ? 'clock' : 'arrow-up-right', 'status-direct'],
    }[route.source];
    if (badge) { text = i18n(badge[0]); icon = badge[1]; statusClass = badge[2]; }
    if (currentMode === 'pac_script' && route.source === 'trial' && globalThis.ProxySwitchDiagnosticsI18n) {
      diagnosticTrialActive = true;
      text = ProxySwitchDiagnosticsI18n.t('diagSourceTrial') + ' · ' + ProxySwitchDiagnosticsI18n.t(route.route === 'proxy' ? 'diagRouteProxy' : 'diagRouteDirect');
      icon = 'clock';
      statusClass = 'status-temp';
    }
  }

  // Saved domain rules only control routing in Auto mode.
  if (currentMode === 'system') {
    text = i18n('popTitleSystem');
    icon = 'monitor';
    statusClass = 'status-direct';
  } else if (currentMode === 'fixed_servers') {
    text = i18n('popTitleGlobal');
    icon = 'route';
    statusClass = 'status-proxy';
  } else if (currentMode === 'direct') {
    text = i18n('popTitleDirect');
    icon = 'arrow-up-right';
    statusClass = 'status-direct';
  }

  els.routingDetailsText.textContent = text;
  els.status.textContent = currentMode === 'pac_script'
    ? i18n(expectedRoute === 'proxy' ? 'popRouteExpectedProxy' : expectedRoute === 'direct' ? 'popRouteExpectedDirect' : 'popRoutePending')
    : currentMode ? text : i18n('popRoutePending');
  setStatusIcon(icon);
  setRouteAppearance(routeIconKey(currentMode, routeSource, expectedRoute));
  els.pageLoadingState.textContent = i18n('popPageLoadingCompact');
  els.pageLoadingState.style.display = isLoading ? 'block' : 'none';

  const wrapper = document.querySelector('.domain-card');
  if (wrapper) {
    wrapper.className = `domain-card ${statusClass}`;
  }
  
  exactProxyRuleActive = [...userRules, ...tempRules].some(rule => exactProxyRule(rule, currentTabDomain));
  inheritedProxyRule = isProxy && !exactProxyRuleActive;
  const directCoverage = getWhitelistCoverage(currentTabDomain, whitelist);
  siteProxySaved = (isProxy || exactProxyRuleActive) && !directCoverage.matched;
  siteProxyBlocked = !!directCoverage.parentMatch || diagnosticTrialActive;
  siteTemporaryBlocked = !!directCoverage.matched || diagnosticTrialActive;
  els.proxyButtonLabel.textContent = i18n(siteProxySaved ? 'popBtnSiteProxySaved' : 'popBtnSiteProxy');
  els.addRuleBtn.setAttribute('aria-pressed', String(siteProxySaved && !isWhite));
  els.addRuleBtn.setAttribute('title', directCoverage.parentMatch ? i18n('popWhitelistInherited').replace('%DOMAIN%', directCoverage.parentMatch) : i18n('popBtnSiteProxy'));
  els.addBtnGroup.style.display = 'block';
  els.addTempRuleBtn.style.display = diagnosticTrialActive || isWhite || siteProxySaved ? 'none' : 'inline-flex';
  if (diagnosticTrialActive) {
    els.removeBtn.style.display = 'none';
  } else if (isWhite) {
    // Removing a direct exception must not erase underlying proxy rules.
    els.removeBtn.style.display = 'none';
  } else if (isProxy || exactProxyRuleActive) {
    els.removeBtn.style.display = 'flex'; 
    els.removeBtn.onclick = inheritedProxyRule ? openRuleManagement : () => removeDomainRule();
  } else {
    els.removeBtn.style.display = 'none'; 
  }
  refreshWhitelistUI(whitelist);
  syncMutationControls();
  renderRuleHint();
}

// 事件绑定
els.serverSelect.onchange = async () => {
  const id = els.serverSelect.value;
  const previousId = configuredActiveServerId;
  if (!beginOperation()) {
    els.serverSelect.value = previousId || configuredServers[0]?.id || '';
    return;
  }
  let saved = false;
  try {
    const items = await popupStorageCall('get', ['serverList', 'activeServerId']);
    if (!Array.isArray(items.serverList) || !items.serverList.some(server => server.id === id)) throw new Error('Server no longer exists');
    await popupStorageCall('set', { activeServerId: id });
    saved = true;
    configuredActiveServerId = id;
    operationFeedback('popServerSaved');
    const result = await sendMessageWithTimeout({ type: 'REFRESH_PROXY' }, 2500, 'REFRESH_PROXY');
    if (!result || !result.success) operationFeedback('popServerApplyPending');
  } catch (error) {
    if (!saved) {
      configuredActiveServerId = previousId;
      els.serverSelect.value = previousId || configuredServers[0]?.id || '';
    }
    operationFeedback(error.code === 'config_changed' ? 'popErrConfigChanged' : saved ? 'popServerApplyPending' : 'popErrOperation', !saved);
    PSL.error('popup', 'Server selection failed', error);
  } finally {
    finishOperation();
  }
};

// 模式切换
els.modePac.onclick = () => setMode('pac_script');
els.modeFixed.onclick = () => setMode('fixed_servers');
els.modeDirect.onclick = () => setMode('direct');
els.modeSystem.onclick = () => setMode('system');

async function setMode(mode) {
  if (!beginOperation('mode')) return;
  const requestId = ++modeRequestId;
  ++modeReadId;
  try {
    // The worker owns one settings-write queue for user mode changes, trial
    // changes and background maintenance. Never apply a cached PAC in the popup.
    const result = await sendMessageWithTimeout({ type: 'SET_PROXY_MODE', mode }, 10000, 'SET_PROXY_MODE');
    if (requestId !== modeRequestId) return;
    if (!result || !result.success) {
      const errors = { proxy_uncontrolled: 'popErrProxyControl', no_server: 'popErrAddServer', proxy_failed: 'popErrProxyApply', invalid_mode: 'popErrProxyApply' };
      operationFeedback(errors[result && result.error] || 'popModeApplyPending', true);
      return;
    }
    await confirmMode(mode, requestId);
  } catch (error) {
    // Missing confirmation does not imply rollback; the worker can finish the
    // serialized write after this popup's bounded wait has ended.
    operationFeedback('popModeApplyPending', true);
    PSL.error('popup', 'Proxy mode switch failed', error);
  } finally {
    if (requestId === modeRequestId) finishOperation();
  }
}

async function confirmMode(mode, requestId) {
  let actual;
  try {
    actual = await popupApiCall(done => chrome.proxy.settings.get({}, done), 'proxy.readback');
    if (!actual || !actual.value) throw new Error('Missing proxy read-back');
  } catch (error) {
    error.code = 'readback';
    throw error;
  }
  if (requestId !== modeRequestId) return;
  currentMode = actual.value.mode;
  proxyLevelOfControl = actual.levelOfControl || null;
  updateModeUI(currentMode);
  if (currentTabDomain) checkDomainStatusWrapper(currentTabLoading);
  const unavailable = proxyLevelOfControl === 'not_controllable' || proxyLevelOfControl === 'controlled_by_other_extensions';
  operationFeedback(unavailable ? 'popErrProxyControl' : currentMode === mode ? 'popModeApplied' : 'popModeApplyPending', unavailable || currentMode !== mode);
}

function updateModeUI(m) {
  [els.modePac, els.modeFixed, els.modeDirect, els.modeSystem].forEach(e => e.classList.remove('active'));
  if (m === 'pac_script') els.modePac.classList.add('active');
  else if (m === 'fixed_servers') els.modeFixed.classList.add('active');
  else if (m === 'direct') els.modeDirect.classList.add('active');
  else if (m === 'system') els.modeSystem.classList.add('active');
  [els.modePac, els.modeFixed, els.modeDirect, els.modeSystem].forEach(button => button.setAttribute('aria-pressed', String(button.classList.contains('active'))));
  refreshWhitelistUI();
  renderProxyControl();
  renderRuleHint();
}

async function changeProxyRules(key, remove = false) {
  const hostname = currentTabDomain;
  if (!hostname || !beginOperation()) return;
  let saved = false;
  try {
    const keys = remove ? ['userRules', 'tempRules'] : [key];
    const permanentAdd = !remove && key === 'userRules';
    const items = await popupStorageCall('get', [...keys, 'userWhitelist']);
    const changes = {};
    for (const name of keys) {
      const list = items[name] === undefined ? [] : items[name];
      if (!Array.isArray(list) || list.some(rule => typeof rule !== 'string')) throw new Error('Invalid proxy rule list');
      changes[name] = remove ? list.filter(rule => !exactProxyRule(rule, hostname))
        : list.some(rule => exactProxyRule(rule, hostname)) ? list : [...list, hostname];
    }
    const whitelist = items.userWhitelist === undefined ? [] : items.userWhitelist;
    if (!Array.isArray(whitelist) || whitelist.some(rule => typeof rule !== 'string')) throw new Error('Invalid whitelist configuration');
    const coverage = getWhitelistCoverage(hostname, whitelist);
    if (coverage.parentMatch || !permanentAdd && coverage.matched) {
      // Never broaden a one-click change into removal of a shared parent
      // direct rule. Temporary/removal controls must not act through a newly
      // added direct exception, either.
      const error = new Error('Direct rule now covers this page');
      error.code = 'config_changed';
      checkDomainStatusWrapper(currentTabLoading);
      throw error;
    }
    if (permanentAdd && coverage.exact) changes.userWhitelist = whitelist.filter(rule => normalizeWhitelistHost(rule) !== hostname);
    const changed = Object.keys(changes).some(name => changes[name].length !== (items[name] || []).length);
    if (changed) await popupStorageCall('set', changes, ['userWhitelist']);
    saved = true;
    operationFeedback(remove ? 'popRuleRemoved' : 'popRuleSaved');
    checkDomainStatusWrapper(currentTabLoading);
    const result = await sendMessageWithTimeout({ type: 'REFRESH_PROXY', applyIfPac: true }, 2500, 'REFRESH_PROXY');
    if (!result || !result.success) operationFeedback('popRuleApplyPending');
  } catch (error) {
    operationFeedback(error.code === 'config_changed' ? 'popErrConfigChanged' : saved ? 'popRuleApplyPending' : 'popErrOperation', !saved);
    PSL.error('popup', 'Proxy rule operation failed', error);
  } finally {
    finishOperation();
  }
}

function addRule(key) { return changeProxyRules(key); }

function removeDomainRule() {
  if (inheritedProxyRule) { openRuleManagement(); return; }
  return changeProxyRules(null, true);
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
