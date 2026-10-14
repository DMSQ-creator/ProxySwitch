// js/background.js - ProxySwitch
// MV3 listeners are registered synchronously before business initialization.
// Proxy mutations share a serial queue; unacknowledged writes retain their lease.
// Cloud work persists its pending state separately so worker suspension cannot erase it.
const ProxySwitchBootJournal = (() => {
  const BOOT_PREFIX = '__psl_boot_v2__:';
  const bootId = (() => {
    try {
      if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (_) {}
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  })();
  const version = chrome.runtime.getManifest().version;
  let sequence = 0;

  function redactDetailText(value) {
    let text = String(value || '');
    text = text.replace(
      /((?:Proxy-Authorization|Authorization|Set-Cookie|Cookie)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n,}]+)/gi,
      '$1***',
    );
    text = text.replace(/((?:password|pass|token|secret|cookie)["']?\s*[=:]\s*["']?)[^\s,;"'}]+/gi, '$1***');
    text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[url]');
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  }

  function safeDetail(detail) {
    if (detail == null) return '';
    try {
      let text = typeof detail === 'string' ? detail : JSON.stringify(detail, (key, value) =>
        /(?:password|pass|token|authorization|secret|cookie)/i.test(key) ? '***' : value
      );
      return redactDetailText(text);
    } catch (_) {
      return redactDetailText(detail);
    }
  }

  function mark(phase, detail) {
    sequence += 1;
    const createdAtMs = Date.now();
    const record = {
      schemaVersion: 2,
      bootId,
      sequence,
      phase,
      detail: safeDetail(detail) || undefined,
      createdAtMs,
      createdAt: new Date(createdAtMs).toISOString(),
      version,
    };
    const key = `${BOOT_PREFIX}${bootId}:${String(sequence).padStart(2, '0')}:${phase}`;
    const write = () => {
      try {
        return Promise.resolve(chrome.storage.local.set({ [key]: record }))
          .then(() => true)
          .catch((error) => {
            // This recorder cannot use PSL: a storage failure must never recurse into itself.
            console.error('[ProxySwitch][boot-journal] Phase write failed', phase, error);
            return false;
          });
      } catch (error) {
        // The black box must never become the reason the worker fails to start.
        console.error('[ProxySwitch][boot-journal] Phase write API failed', phase, error);
        return Promise.resolve(false);
      }
    };

    // Each phase has a unique key, so issue it immediately. Promise chaining here
    // would postpone later calls until top-level evaluation ends and would lose the
    // exact last phase when that evaluation hard-hangs.
    return write();
  }

  return { id: bootId, mark };
})();

ProxySwitchBootJournal.mark('script_entered');

let coreModulesReady = false;
try {
  importScripts('logger.js');
  importScripts('utils.js');
  importScripts('routing.js');
  importScripts('configuration.js');
  importScripts('configuration-store.js');
  importScripts('cloud-sync.js');
  coreModulesReady = true;
} catch (e) {
  console.error('[ProxySwitch] Failed to load core modules — extension may not work correctly', e);
}

try {
  importScripts('request-recorder.js', 'diagnostics-background.js');
} catch (error) {
  console.error('[ProxySwitch] Request diagnostics unavailable', error);
}

let iconDataReady = false;
try {
  importScripts('icon-data.js');
  iconDataReady = !!self.ProxySwitchIconData;
} catch (e) {
  console.error('[ProxySwitch] Failed to load static icon data', e);
}

ProxySwitchBootJournal.mark('imports_completed', { coreModulesReady, iconDataReady });
if (!coreModulesReady || typeof PSL === 'undefined') {
  throw new Error('ProxySwitch core modules failed to load; see the worker boot journal');
}
PSL.setBootId(ProxySwitchBootJournal.id);

self.addEventListener('error', (e) => {
  PSL.error('background', 'Uncaught error', e && (e.error || {
    message: e.message,
    filename: e.filename,
    line: e.lineno,
    column: e.colno,
  }) || String(e));
});

self.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  PSL.error('background', 'Unhandled rejection', r || String(e));
});

// ===== 全局变量 =====
let cachedUserRules = new Set();
let cachedUserWhitelist = new Set();
let cachedGfwDomains = new Set();
let cachedTempRules = new Set();
let cachedDiagnosticTrial = null;
let cachedRoutingRules = null;
let isSyncing = false;

// All cache/PAC work is serialized. Configuration changes are never dropped while an API is pending.
let isApplyingProxy = false;
let proxyOperationActive = null;
const proxyOperationQueue = [];
let proxyConfigurationVersion = 0;
const PROXY_OPERATION_TIMEOUT_MS = 8000;
let lastPacHash = '';
let pacUpdateVersion = 0;

// 🔥 修复 Bug #4: 内存泄漏防护
let uploadDebounceTimer = null;

// 图标像素在构建时生成。运行时只构造 ImageData，不触发 Canvas/GPU 读回。
const STATIC_ICON_SIZES = Object.freeze([16, 32]);
const staticIconImageDataCache = new Map();
let currentProxyMode = 'direct';
let currentProxyControl = 'unknown';
let currentProxyError = null;
let configurationStore = null;
let configurationResetting = false;

function getConfigurationStore() {
  if (!configurationStore) configurationStore = ProxySwitchConfigurationStore.create({ chrome, configuration: ProxySwitchConfiguration });
  return configurationStore;
}

function runConfigurationMutation(fn) {
  return getConfigurationStore().run(fn);
}

// 🔥 修复 Bug #2: 竞态条件防护
let activeTabId = null;
let pendingIconUpdates = new Map(); // tabId -> timeout
let loadingTabs = new Set();

const CONFIG_FILE_NAME = 'proxyswitch_config.json';
const DAV_DIR_NAME = 'ProxySwitch';
const PAC_RELATED_KEYS = [
  'userRules',
  'userWhitelist',
  'gfwDomains',
  'tempRules',
  'serverList',
  'activeServerId',
  'pacScriptData',
  'pacHash',
  'diagnosticTrial',
];

// ===== 初始化 Promise =====
let initReadyResolver = null;
const initPromise = new Promise((resolve) => {
  initReadyResolver = resolve;
});

// ===== 工具函数 =====
/**
 * 计算字符串的哈希值（用于 PAC 内容比对）
 * @param {string} str - 要计算哈希的字符串
 * @returns {string} 哈希值
 */
function simpleHash(str) {
  if (!str || str.length === 0) return '0';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 转换为 32 位整数
  }
  return Math.abs(hash).toString(36);
}

function resolveActiveServer(items) {
  const servers = (Array.isArray(items && items.serverList) ? items.serverList : []).map(server => {
    if (!server || typeof server !== 'object' || typeof server.host !== 'string') return null;
    const scheme = typeof server.scheme === 'string' ? server.scheme.toUpperCase() : 'SOCKS5';
    const port = typeof server.port === 'number' || typeof server.port === 'string' ? Number(server.port) : NaN;
    if (!['HTTP', 'HTTPS', 'SOCKS4', 'SOCKS5'].includes(scheme) ||
        !Number.isInteger(port) || port < 1 || port > 65535) return null;
    let host = server.host.trim();
    if (!host || /[\s/@?#\\]/.test(host)) return null;
    try {
      const parsed = new URL('http://' + (host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host));
      if (!parsed.hostname || parsed.port || parsed.username || parsed.password) return null;
      host = parsed.hostname;
    } catch (_) { return null; }
    return { ...server, scheme, host, port };
  }).filter(Boolean);
  return servers.find(server => server.id === (items && items.activeServerId)) || servers[0] || null;
}

function buildPacScriptString(activeServer) {
  cachedRoutingRules = ProxySwitchRouting.prepare({
    userRules: cachedUserRules,
    userWhitelist: cachedUserWhitelist,
    gfwDomains: cachedGfwDomains,
    tempRules: cachedTempRules,
  });
  return ProxySwitchRouting.buildPac(activeServer, cachedRoutingRules, cachedDiagnosticTrial);
}

function persistPacScriptIfNeeded(items, pacScriptStr, callback, stillActive = () => true, onWritePending = () => {}) {
  if (!pacScriptStr) {
    if (callback) callback();
    return;
  }
  const newPacHash = simpleHash(pacScriptStr);
  // A short non-cryptographic hash is only metadata, not proof that rule scripts are identical.
  const needsPersist = newPacHash !== lastPacHash || items.pacScriptData !== pacScriptStr;
  if (!needsPersist) {
    if (callback) callback();
    return;
  }
  pacUpdateVersion++;
  const tSet = Date.now();
  let completed = false;
  const finish = (error) => {
    if (completed || !stillActive()) return;
    completed = true;
    onWritePending(false);
    PSL.perf('background', 'PAC persist set', tSet, `len=${pacScriptStr.length}`, 300);
    if (!error) lastPacHash = newPacHash;
    if (callback) callback(error);
  };
  try {
    onWritePending(true);
    chrome.storage.local.set({
      pacScriptData: pacScriptStr,
      pacVersion: pacUpdateVersion,
      pacHash: newPacHash,
    }, () => finish(chrome.runtime.lastError ? new Error(chrome.runtime.lastError.message) : null));
  } catch (error) {
    finish(error);
  }
}

// ===== 初始化与监听 =====
chrome.runtime.onInstalled.addListener(async (d) => {
  try {
    await runConfigurationMutation(async () => {
      if (d.reason === 'install') {
        const items = await chrome.storage.local.get(['serverList']);
        if (!Array.isArray(items.serverList) || items.serverList.length === 0) {
          const def = { id: generateUUID(), name: 'Default', scheme: 'SOCKS5', host: '127.0.0.1', port: 10808 };
          await chrome.storage.local.set({ serverList: [def], activeServerId: def.id });
        }
        chrome.runtime.openOptionsPage();
      }
    });
    updateCacheAndApply();
  } catch (error) {
    PSL.error('background', 'Install initialization failed', error.message || String(error));
  }
});

// Browser-session rules expire on a real browser startup, not on every MV3 worker wake.
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(async () => {
  try {
    await runConfigurationMutation(() => chrome.storage.local.set({ tempRules: [] }));
    updateCacheAndApply();
  } catch (error) {
    PSL.error('background', 'Temporary rule startup cleanup failed', error.message || String(error));
  }
});

// ===== Storage 变化监听（修复死循环） =====
const AUTO_UPDATE_KEYS = [
  'userRules', 
  'userWhitelist', 
  'gfwDomains', 
  'tempRules', 
  'serverList', 
  'activeServerId'
];

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== 'local') return;
  if (typeof notifyCloudConfigurationChange === 'function') notifyCloudConfigurationChange(changes);

  const changedKeys = Object.keys(changes);
  const hasConfigChange = changedKeys.some(key => AUTO_UPDATE_KEYS.includes(key));
  // Diagnostic records and unrelated settings must not enter proxy-update logic or create log recursion.
  if (!hasConfigChange) return;
  
  proxyConfigurationVersion++;
  PSL.info('background', 'Config changed', changedKeys.join(', '));
  updateCacheAndApply();
});

// ===== 消息监听 =====
chrome.runtime.onMessage.addListener((m, s, sendResponse) => {
  if (m.type === 'SAVE_CONFIGURATION') {
    if (configurationResetting) {
      sendResponse({ success: false, error: 'config_resetting' });
      return;
    }
    try {
      getConfigurationStore().save(m.items, m.expected).then(items => sendResponse({ success: true, items })).catch(error => {
        const code = error && error.code || 'storage_failed';
        PSL.warn('background', 'Configuration save rejected', { code, field: error && error.field });
        sendResponse({ success: false, error: code });
      });
    } catch (_) { sendResponse({ success: false, error: 'storage_failed' }); }
    return true;
  } else if (m.type === 'RESET_CONFIGURATION') {
    if (configurationResetting) {
      sendResponse({ success: false, error: 'config_resetting' });
      return;
    }
    // Fence new UI writes immediately; clear waits behind any restore/write lease.
    // Keep the fence after success until the requesting UI reloads the extension.
    configurationResetting = true;
    // Removing storage alone would leave an already-installed PAC active. Release only
    // this extension's browser setting first, behind any outstanding proxy write lease.
    const stopDiagnostics = diagnosticsController ? diagnosticsController.beginReset() : Promise.resolve();
    stopDiagnostics.then(() => new Promise((resolve, reject) => enqueueProxyOperation({ kind: 'release', done: error => error ? reject(error) : resolve() })))
      .then(() => runConfigurationMutation(() => new Promise((resolve, reject) => {
        try {
          chrome.storage.local.clear(() => chrome.runtime.lastError ? reject(new Error('storage_failed')) : resolve());
        } catch (_) { reject(new Error('storage_failed')); }
      }))).then(() => sendResponse({ success: true, mode: currentProxyMode, levelOfControl: currentProxyControl })).catch(error => {
      configurationResetting = false;
      if (diagnosticsController) diagnosticsController.endReset(false);
      const raw = error && (error.message || String(error));
      sendResponse({ success: false, error: raw === 'proxy_operation_timeout' ? 'proxy_timeout' :
        raw === 'storage_failed' ? 'storage_failed' : 'proxy_failed' });
    });
    return true;
  } else if (m.type === 'SET_PROXY_MODE') {
    if (configurationResetting) {
      sendResponse({ success: false, error: 'config_resetting' });
      return;
    }
    if (!['direct', 'system', 'fixed_servers', 'pac_script'].includes(m.mode)) {
      sendResponse({ success: false, error: 'invalid_mode' });
      return;
    }
    enqueueProxyOperation({ kind: 'user-mode', mode: m.mode, done: (error, _pac, status) => {
      const raw = error && (error.message || String(error));
      const code = raw === 'proxy_operation_timeout' ? 'proxy_timeout' :
        ['no_server', 'proxy_uncontrolled', 'invalid_mode'].includes(raw) ? raw : 'proxy_failed';
      sendResponse(error ? { success: false, error: code } : { success: true, ...status });
    } });
    return true;
  } else if (m.type === 'REFRESH_PROXY') {
    const t0 = Date.now();
    refreshCacheAndIcon((error) => {
      PSL.perf('background', 'REFRESH_PROXY total', t0, null, 300);
      sendResponse(error ? { success: false, error: error.message || String(error) } : { success: true });
    }, m.applyIfPac === true);
    return true;
  } else if (m.type === 'ENSURE_PAC') {
    const t0 = Date.now();
    enqueueProxyOperation({ kind: 'ensure', done: (error, pacScriptData) => {
      PSL.perf('background', 'ENSURE_PAC total', t0, null, 500);
      sendResponse(error ? { success: false, error: error.message || String(error) } : { success: true, pacScriptData });
    } });
    return true;
  } else if (m.type === 'UPDATE_ICON') {
    updateIconForActiveTab();
  } else if (m.type === 'MANUAL_SYNC_UPLOAD') {
    performCloudUpload()
      .then(t => sendResponse({success:true, time:t}))
      .catch(e => {
        const code = e && e.code || 'cloud_failed';
        PSL.error('background', 'Manual sync upload failed', code);
        sendResponse({success:false, error:code});
      });
    return true; 
  } else if (m.type === 'MANUAL_SYNC_PREVIEW') {
    performCloudPreview()
      .then(result => sendResponse({success:true, ...result}))
      .catch(error => sendResponse({success:false, error: error && error.code || 'cloud_failed'}));
    return true;
  } else if (m.type === 'MANUAL_SYNC_UNDO') {
    performCloudUndo()
      .then(result => sendResponse({success:true, canUndo:false, ...result}))
      .catch(error => sendResponse({success:false, error: error && error.code || 'cloud_failed'}));
    return true;
  } else if (m.type === 'MANUAL_SYNC_DOWNLOAD') {
    performCloudDownload(m.previewId)
      .then(result => sendResponse({success:true, canUndo:true, ...result}))
      .catch(e => {
        // SyntaxError messages from response.json() may echo remote config content.
        const safeMessage = e && e.code || 'cloud_failed';
        PSL.error('background', 'Manual sync download failed', safeMessage);
        sendResponse({success:false, error:safeMessage});
      });
    return true; 
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== 'popup') return;
  const t0 = Date.now();
  PSL.checkpoint('background', 'popup.port_connected');
  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'POPUP_OPEN') {
      const allowedKinds = new Set(['none', 'http', 'https', 'extension', 'restricted-or-other', 'invalid']);
      const tabUrlKind = allowedKinds.has(msg.tabUrlKind) ? msg.tabUrlKind : 'unknown';
      PSL.checkpoint('background', 'popup.open_received', {
        popupContextId: msg.contextId || '',
        loading: !!msg.loading,
        tabUrlKind,
      });
      try {
        port.postMessage({
          type: 'POPUP_ACK',
          bootId: ProxySwitchBootJournal.id,
          ready: initReadyResolver === null,
        });
      } catch (error) {
        PSL.warn('background', 'popup.ack_failed', error);
      }
    }
  });
  port.onDisconnect.addListener(() => {
    PSL.perf('background', 'Popup session', t0, null, 500);
    PSL.checkpoint('background', 'popup.port_disconnected', { durationMs: Date.now() - t0 });
  });
});

// ===== 核心逻辑 =====
function normalizeSet(list) {
  return new Set(ProxySwitchRouting.normalizeRules(Array.isArray(list) ? list : []));
}

/**
 * Refreshing rules never grants permission to take over another controller's proxy.
 * Keep the legacy ownedOnly argument for diagnostics callers; all maintenance now owns-only.
 */
function refreshCacheAndIcon(done, applyIfPac = false, ownedOnly = false) {
  enqueueProxyOperation({ kind: 'refresh', applyIfPac, done });
}

function updateCacheAndApply(specificTabId, specificUrl, _retries, traceBoot) {
  const queued = proxyOperationQueue.find(operation => operation.kind === 'maintenance');
  if (queued) {
    queued.specificTabId = specificTabId;
    queued.specificUrl = specificUrl;
    queued.traceBoot = queued.traceBoot || traceBoot;
    return;
  }
  enqueueProxyOperation({ kind: 'maintenance', specificTabId, specificUrl, traceBoot });
}

function enqueueProxyOperation(operation) {
  proxyOperationQueue.push(operation);
  runNextProxyOperation();
}

function runNextProxyOperation() {
  if (proxyOperationActive || !proxyOperationQueue.length) return;
  const operation = proxyOperationQueue.shift();
  proxyOperationActive = operation;
  isApplyingProxy = true;
  let completed = false;
  let notified = false;
  let pendingWrite = false;
  let timedOut = false;
  let pacScriptStr = '';
  const active = () => !completed && proxyOperationActive === operation;
  const mark = (phase, detail) => {
    if (operation.traceBoot) ProxySwitchBootJournal.mark(phase, detail);
  };
  const notify = (error) => {
    if (notified) return;
    notified = true;
    if (operation.traceBoot && initReadyResolver) {
      initReadyResolver({ error: error ? error.message || String(error) : null });
      initReadyResolver = null;
    }
    try {
      if (operation.done) operation.done(error, pacScriptStr, { mode: currentProxyMode, levelOfControl: currentProxyControl });
    } catch (callbackError) {
      PSL.error('background', 'Proxy operation callback failed', callbackError.message || String(callbackError));
    }
  };
  const finish = (error) => {
    if (!active()) return;
    completed = true;
    clearTimeout(timeout);
    proxyOperationActive = null;
    isApplyingProxy = false;
    if (error) PSL.error('background', 'Proxy operation failed', { kind: operation.kind, error: error.message || String(error) });
    try { notify(error); } finally {
      runNextProxyOperation();
    }
  };
  const guarded = (callback) => (...args) => {
    if (!active()) return;
    try { callback(...args); } catch (error) { finish(error); }
  };
  const checkLastError = () => {
    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
  };
  // Reads can be abandoned. A dispatched write cannot be cancelled: keep its lease until
  // Chrome acknowledges the commit, even after the caller has been told it timed out.
  const timeout = setTimeout(() => {
    timedOut = true;
    const error = new Error('proxy_operation_timeout');
    if (pendingWrite) {
      operation.writePending = true;
      PSL.warn('background', 'Proxy write is still pending; retaining operation lease', { kind: operation.kind });
      notify(error);
    } else finish(error);
  }, PROXY_OPERATION_TIMEOUT_MS);
  const readCache = guarded(() => {
    const configurationVersion = proxyConfigurationVersion;
    const readReturned = guarded((stored, checkStorageError = true) => {
      if (checkStorageError) checkLastError();
      const items = stored && typeof stored === 'object' ? stored : {};
      mark('initial_storage_get_returned');
      cachedUserRules = normalizeSet(items.userRules);
      cachedUserWhitelist = normalizeSet(items.userWhitelist);
      cachedGfwDomains = normalizeSet(items.gfwDomains);
      cachedTempRules = normalizeSet(items.tempRules);
      cachedDiagnosticTrial = ProxySwitchRouting.safeTrial(items.diagnosticTrial);
      mark('initial_cache_built', { userRules: cachedUserRules.size, whitelist: cachedUserWhitelist.size, gfw: cachedGfwDomains.size, tempRules: cachedTempRules.size });
      if (!lastPacHash && typeof items.pacHash === 'string') lastPacHash = items.pacHash;
      const activeServer = resolveActiveServer(items);
      mark('initial_pac_build_entered');
      pacScriptStr = buildPacScriptString(activeServer);
      mark('initial_pac_build_returned', { pacLength: pacScriptStr.length });
      if (operation.kind === 'ensure' && !pacScriptStr) throw new Error('no_server');
      persistPacScriptIfNeeded(items, pacScriptStr, guarded((error) => {
        if (timedOut) {
          finish(error || new Error('proxy_operation_timeout'));
          updateCacheAndApply();
          return;
        }
        if (error) throw error;
        mark('initial_pac_persist_returned');
        if (configurationVersion !== proxyConfigurationVersion) { readCache(); return; }
        if (operation.kind === 'ensure') { finish(); return; }
        mark('initial_proxy_get_dispatched');
        chrome.proxy.settings.get({}, guarded((details) => {
          checkLastError();
          if (configurationVersion !== proxyConfigurationVersion) { readCache(); return; }
          observeProxyState(details);
          const mode = currentProxyMode;
          mark('initial_proxy_get_returned', { mode, control: currentProxyControl });
          let value = null;
          const release = operation.kind === 'release';
          if (operation.kind === 'user-mode') {
            if (!['controlled_by_this_extension', 'controllable_by_this_extension'].includes(currentProxyControl)) throw new Error('proxy_uncontrolled');
            const target = operation.mode;
            if (target === 'pac_script') {
              if (!pacScriptStr) throw new Error('no_server');
              value = { mode: target, pacScript: { data: pacScriptStr } };
            } else if (target === 'fixed_servers') {
              if (!activeServer) throw new Error('no_server');
              value = { mode: target, rules: { singleProxy: { scheme: activeServer.scheme.toLowerCase(), host: activeServer.host, port: activeServer.port } } };
            } else value = { mode: target };
          } else if (currentProxyControl === 'controlled_by_this_extension') {
            if (mode === 'pac_script' && (operation.kind === 'maintenance' || operation.applyIfPac)) {
              if (!pacScriptStr) throw new Error('no_server');
              if (!details.value.pacScript || details.value.pacScript.data !== pacScriptStr) value = { mode, pacScript: { data: pacScriptStr } };
            } else if (mode === 'fixed_servers' && operation.kind === 'maintenance') {
              if (!activeServer) throw new Error('no_server');
              value = { mode, rules: { singleProxy: { scheme: activeServer.scheme.toLowerCase(), host: activeServer.host, port: activeServer.port } } };
              if (JSON.stringify(details.value.rules) === JSON.stringify(value.rules)) value = null;
            }
          }
          const completeCurrent = () => {
            if (configurationVersion !== proxyConfigurationVersion) { readCache(); return; }
            mark('initial_active_icon_entered');
            if (Number.isInteger(operation.specificTabId) && operation.specificUrl) updateTabIcon(operation.specificTabId, operation.specificUrl);
            else updateIconForActiveTab();
            mark('initial_active_icon_returned');
            finish();
          };
          if (!value && !release) {
            mark('initial_proxy_set_skipped', { mode, control: currentProxyControl });
            completeCurrent();
            return;
          }
          mark('initial_proxy_set_dispatched', { mode });
          pendingWrite = true;
          try {
            const mutation = release ? 'clear' : 'set';
            const settings = release ? { scope: 'regular' } : { value, scope: 'regular' };
            chrome.proxy.settings[mutation](settings, guarded(() => {
              pendingWrite = false;
              checkLastError();
              mark('initial_proxy_set_returned', { mode, success: true });
              if (timedOut) {
                // The write really committed. Release only now and let the next operation
                // reread the latest configuration; never run this expired operation further.
                finish(new Error('proxy_operation_timeout'));
                updateCacheAndApply();
                return;
              }
              // Report the actual resulting state, not just the mode we requested.
              chrome.proxy.settings.get({}, guarded((actual) => {
                checkLastError();
                observeProxyState(actual, true);
                if (release && currentProxyControl === 'controlled_by_this_extension') throw new Error('proxy_failed');
                if (operation.kind === 'user-mode') {
                  if (currentProxyControl !== 'controlled_by_this_extension') throw new Error('proxy_uncontrolled');
                  if (currentProxyMode !== operation.mode) throw new Error('proxy_failed');
                }
                PSL.info('background', 'Proxy settings applied', { mode: currentProxyMode });
                completeCurrent();
              }));
            }));
          } catch (error) { pendingWrite = false; throw error; }
        }));
      }), active, (pending) => { pendingWrite = pending; });
    });
    // Direct/system are recovery actions and must remain usable when configuration storage fails.
    if (operation.kind === 'release' || operation.kind === 'user-mode' && ['direct', 'system'].includes(operation.mode)) readReturned({}, false);
    else chrome.storage.local.get(PAC_RELATED_KEYS, readReturned);
  });
  readCache();
}

function observeProxyState(details, clearError = false) {
  const mode = details && details.value && typeof details.value.mode === 'string' ? details.value.mode : 'unknown';
  if (clearError || mode !== currentProxyMode) currentProxyError = null;
  currentProxyMode = mode;
  currentProxyControl = details && typeof details.levelOfControl === 'string' ? details.levelOfControl : 'unknown';
  handleGlobalIconUpdate(mode);
  const status = { mode, levelOfControl: currentProxyControl, updatedAt: Date.now(), error: currentProxyError };
  try {
    Promise.resolve(chrome.storage.local.set({ proxyRuntimeStatus: status })).catch(error => {
      PSL.warn('background', 'Proxy status persistence failed', error.message || String(error));
    });
  } catch (error) { PSL.warn('background', 'Proxy status persistence failed', error.message || String(error)); }
  if (chrome.action && chrome.action.setBadgeText) {
    const warning = !!currentProxyError || ['controlled_by_other_extensions', 'not_controllable'].includes(currentProxyControl);
    chrome.action.setBadgeText({ text: warning ? '!' : '' });
    if (warning && chrome.action.setBadgeBackgroundColor) chrome.action.setBadgeBackgroundColor({ color: '#B76B16' });
  }
}

// ===== 同步逻辑 =====
// This service persists pending uploads and validates every cloud restore.
let cloudSyncService = null;
function getCloudSyncService() {
  if (!cloudSyncService) cloudSyncService = ProxySwitchCloudSync.create({
    chrome, configuration: ProxySwitchConfiguration, fetch: (...args) => fetch(...args),
    mutateConfiguration: fn => runConfigurationMutation(fn),
    uuid: generateUUID,
    refresh: () => new Promise((resolve, reject) => refreshCacheAndIcon(error => error ? reject(error) : resolve(), true, true)),
    report: error => PSL.warn('background', 'Cloud operation failed', error && error.code || 'cloud_failed'),
  });
  return cloudSyncService;
}
function notifyCloudConfigurationChange(changes) {
  return getCloudSyncService().changed(changes).catch(error =>
    PSL.warn('background', 'Cloud pending state failed', error && error.code || 'storage_failed'));
}
function performCloudUpload() { return getCloudSyncService().upload(); }
function performCloudPreview() { return getCloudSyncService().preview(); }
function performCloudDownload(previewId) { return getCloudSyncService().apply(previewId); }
function performCloudUndo() { return getCloudSyncService().undo(); }

// Construct synchronously so alarms can wake a worker with an unfinished upload.
if (typeof ProxySwitchCloudSync !== 'undefined') getCloudSyncService();
// ===== 图标管理模块 =====
function getStaticIconImageData(key, size) {
  const iconData = self.ProxySwitchIconData;
  const resolvedKey = iconData && iconData[key] ? key : 'direct';
  const encoded = iconData && iconData[resolvedKey] && iconData[resolvedKey][size];
  if (!encoded || typeof ImageData === 'undefined') return null;

  const cacheKey = `${resolvedKey}:${size}`;
  if (staticIconImageDataCache.has(cacheKey)) {
    return staticIconImageDataCache.get(cacheKey);
  }

  try {
    const binary = atob(encoded);
    const expectedLength = size * size * 4;
    if (binary.length !== expectedLength) {
      throw new Error(`invalid RGBA length ${binary.length}, expected ${expectedLength}`);
    }

    const pixels = new Uint8ClampedArray(expectedLength);
    for (let i = 0; i < expectedLength; i++) {
      pixels[i] = binary.charCodeAt(i);
    }

    const imageData = new ImageData(pixels, size, size);
    staticIconImageDataCache.set(cacheKey, imageData);
    return imageData;
  } catch (e) {
    PSL.warn('background', 'Static icon decode failed', `${resolvedKey}/${size}: ${e.message}`);
    return null;
  }
}

function getStaticIconSet(key) {
  const imageData = {};
  for (const size of STATIC_ICON_SIZES) {
    const icon = getStaticIconImageData(key, size);
    if (icon) imageData[size] = icon;
  }
  return Object.keys(imageData).length ? imageData : null;
}

function setActionIcon(key, tabId) {
  const imageData = getStaticIconSet(key);
  if (!imageData) {
    PSL.warn('background', 'Static icon unavailable', key);
    return;
  }

  const details = { imageData };
  if (Number.isInteger(tabId)) details.tabId = tabId;

  chrome.action.setIcon(details, () => {
    if (chrome.runtime.lastError) {
      PSL.warn('background', 'Icon update failed', chrome.runtime.lastError.message);
    }
  });
}

function setGlobalIcon(key) {
  setActionIcon(key);
}

function handleGlobalIconUpdate(mode) {
  const i18n = chrome.i18n.getMessage;
  // 1. 确定要使用哪个图标 Key
  let iconKey = 'direct'; // 默认 fallback
  
  if (mode === 'pac_script') {
    iconKey = 'pac_gray'; // 自动模式的默认图标
  } else if (mode === 'fixed_servers') {
    iconKey = 'fixed';
  } else if (mode === 'direct') {
    iconKey = 'direct';
  } else if (mode === 'system') {
    iconKey = 'system';
  }

  // 2. 设置全局默认图标 (给新标签页或未设置专用图标的标签页使用)
  setGlobalIcon(iconKey);

  // 3. 仅在非 PAC 模式下强制覆盖标签专用图标
  //    PAC 模式下的标签图标由 updateTabIcon 按域名匹配单独管理，此处不应覆盖。
  if (mode !== 'pac_script' || currentProxyControl !== 'controlled_by_this_extension') {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs && tabs[0]) {
        setActionIcon(iconKey, tabs[0].id);

        let title = "ProxySwitch";
        if (mode === 'fixed_servers') title = `ProxySwitch: ${i18n("popTitleGlobal")}`;
        else if (mode === 'direct') title = `ProxySwitch: ${i18n("popTitleDirect")}`;
        else if (mode === 'system') title = `ProxySwitch: ${i18n("popTitleSystem")}`;

        chrome.action.setTitle({ title: title, tabId: tabs[0].id });
      }
    });
  }
}

function getSafeHostname(urlStr) {
  if (!urlStr || !urlStr.startsWith('http')) return null;
  try { 
    return new URL(urlStr).hostname.toLowerCase(); 
  } catch (e) { 
    return null; 
  }
}

/**
 * 🔥 修复 Bug #2: 竞态条件防护
 * 更新标签页图标（带防抖和验证）
 */
function updateTabIcon(tabId, url) {
  if (currentProxyMode !== 'pac_script' || currentProxyControl !== 'controlled_by_this_extension') return;
  const i18n = chrome.i18n.getMessage;

  // 清理该标签页的旧定时器
  if (pendingIconUpdates.has(tabId)) {
    clearTimeout(pendingIconUpdates.get(tabId));
    pendingIconUpdates.delete(tabId);
  }

  const hostname = getSafeHostname(url);
  
  let iconKey = 'pac_gray'; 
  let title = i18n("bgTitleAuto");

  if (hostname && cachedRoutingRules) {
    const decision = ProxySwitchRouting.evaluate(hostname, cachedRoutingRules, {
      mode: currentProxyMode, trial: cachedDiagnosticTrial,
    });
    if (decision.route === 'direct' && decision.source !== 'default') {
      iconKey = 'pac_blue'; title = i18n('bgTitleDirect');
    } else if (decision.route === 'proxy') {
      if (decision.source === 'trial' || decision.source === 'temporary') {
        iconKey = 'pac_org'; title = i18n('bgTitleTemp');
      } else if (decision.source === 'subscription') {
        iconKey = 'pac_green'; title = i18n('bgTitleAutoProxy');
      } else {
        iconKey = 'pac_purp'; title = i18n('bgTitleProxy');
      }
    }
  }

  // 🔥 修复: 延迟执行，并验证标签页仍然有效
  const timerId = setTimeout(() => {
    pendingIconUpdates.delete(tabId);
    
    // 验证标签页是否仍然存在且 URL 未变
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        // 标签页已关闭
        return;
      }
      
      // 🔥 关键修复: 验证 URL 是否仍然匹配
      if (tab && tab.url === url && currentProxyMode === 'pac_script' && currentProxyControl === 'controlled_by_this_extension') {
        setActionIcon(iconKey, tabId);
        chrome.action.setTitle({ title: `ProxySwitch: ${title}`, tabId: tabId });
      }
    });
  }, 50); // 短暂延迟，避免快速切换时的闪烁
  
  pendingIconUpdates.set(tabId, timerId);
}

/**
 * 更新当前激活标签的图标
 */
function updateIconForActiveTab(){
  chrome.tabs.query({active:true, currentWindow:true}, tabs => {
    if(tabs && tabs[0] && tabs[0].id && tabs[0].url) {
      activeTabId = tabs[0].id;
      updateTabIcon(tabs[0].id, tabs[0].url);
    }
  });
}

function checkSet(h, s) { 
  return matchDomain(h, s); 
}

// ===== 事件监听 =====
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (currentProxyMode !== 'pac_script') return;
  if (!tab || !tab.url) return;

  const isActiveTab = tab.active || tabId === activeTabId;
  if (!isActiveTab) return;

  if (changeInfo.status === 'loading') {
    loadingTabs.add(tabId);
    return;
  }

  if (changeInfo.status !== 'complete') return;

  loadingTabs.delete(tabId);
  await initPromise;
  updateTabIcon(tabId, tab.url);
});

/**
 * 🔥 修复 Bug #2: 标签页切换时的竞态条件
 * 重新检查是否仍是活动标签
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (currentProxyMode === 'pac_script' && currentProxyControl === 'controlled_by_this_extension') {
    await initPromise;
    
    // 🔥 关键修复: 重新查询确认仍是活动标签
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0] && tabs[0].id === activeInfo.tabId) {
        activeTabId = tabs[0].id;
        if (tabs[0].url) {
          if (tabs[0].status === 'loading') {
            loadingTabs.add(tabs[0].id);
            return;
          }
          loadingTabs.delete(tabs[0].id);
          updateTabIcon(tabs[0].id, tabs[0].url);
        }
      }
    });
  } else {
    // A tab may retain a PAC-specific icon from before a global mode/control change.
    // Calibrate it when it becomes visible instead of leaving the old rule-route colour.
    handleGlobalIconUpdate(currentProxyMode);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  loadingTabs.delete(tabId);
  if (pendingIconUpdates.has(tabId)) {
    clearTimeout(pendingIconUpdates.get(tabId));
    pendingIconUpdates.delete(tabId);
  }
});

if (chrome.proxy.settings.onChange) chrome.proxy.settings.onChange.addListener((details) => {
  PSL.info('background', 'Proxy settings changed', {
    mode: details && details.value && details.value.mode,
    levelOfControl: details && details.levelOfControl,
  });
  observeProxyState(details);
  updateIconForActiveTab();
});

if (chrome.proxy.onProxyError) chrome.proxy.onProxyError.addListener((details) => {
  const rawError = details && details.error;
  const error = typeof rawError === 'string' && /^net::[A-Z_]+$/.test(rawError) ? rawError : 'proxy_error';
  currentProxyError = { message: error, fatal: !!(details && details.fatal), at: Date.now() };
  PSL.error('background', 'Proxy runtime error', currentProxyError);
  // Chrome's error details can contain URLs. Persist only an error category, never request data.
  observeProxyState({ value: { mode: currentProxyMode }, levelOfControl: currentProxyControl });
});

let diagnosticsController = null;
if (typeof ProxySwitchDiagnostics !== 'undefined') {
  diagnosticsController = ProxySwitchDiagnostics.create({
    chrome,
    routing: ProxySwitchRouting,
    mutateConfiguration: fn => runConfigurationMutation(fn),
    refresh: () => new Promise((resolve, reject) => {
      refreshCacheAndIcon((error) => error ? reject(error) : resolve(), true, true);
    }),
  });
}

// All extension listeners are now registered synchronously. Business initialization starts afterwards.
ProxySwitchBootJournal.mark('listeners_registered');
ProxySwitchBootJournal.mark('initialization_dispatching');
updateCacheAndApply(undefined, undefined, undefined, true);
ProxySwitchBootJournal.mark('initialization_dispatched');
initPromise.then(async (result) => {
  const phase = result && result.error ? 'initialization_failed' : 'ready';
  await ProxySwitchBootJournal.mark(phase, { proxyMode: currentProxyMode, error: result && result.error });
  PSL.checkpoint('background', 'worker.' + phase, { proxyMode: currentProxyMode });
  await PSL.prune();
});
