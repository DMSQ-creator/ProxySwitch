// js/background.js - ProxySwitch
// ⚠️ MV3 Service Worker 生命周期提醒：
//   - Chrome 会在空闲 ~30s 后终止 SW，setTimeout/setInterval 会丢失。
//   - 短延时（<30s）操作如 debounce(500ms)、图标更新(50ms) 在实际使用中通常能完成。
//   - 长延时如 triggerAutoUpload(10s) 若 SW 在当前事件结束后快速终止可能会丢失，
//     但这是 MV3 的已知限制，对用户无感知影响。
//   - chrome.alarms 最小间隔 30+ 秒，不适用于本扩展的延时需求。
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
  coreModulesReady = true;
} catch (e) {
  console.error('[ProxySwitch] Failed to load core modules — extension may not work correctly', e);
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
let isSyncing = false;

// 🔥 修复 Bug #1: PAC 死循环防护
let isApplyingProxy = false;
let lastPacHash = '';
let pacUpdateVersion = 0;

// 🔥 修复 Bug #4: 内存泄漏防护
let uploadDebounceTimer = null;
let debouncedUpdateTimer = null;

// 图标像素在构建时生成。运行时只构造 ImageData，不触发 Canvas/GPU 读回。
const STATIC_ICON_SIZES = Object.freeze([16, 32]);
const staticIconImageDataCache = new Map();
let currentProxyMode = 'direct';

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

/**
 * 防抖函数（带清理）
 * 🔥 修复 Bug #4: 显式清理定时器引用
 */
function debounce(func, wait) {
  return function(...args) {
    if (debouncedUpdateTimer) {
      clearTimeout(debouncedUpdateTimer);
      debouncedUpdateTimer = null;
    }
    debouncedUpdateTimer = setTimeout(() => {
      debouncedUpdateTimer = null;
      func.apply(this, args);
    }, wait);
  };
}

const debouncedUpdate = debounce(updateCacheAndApply, 500);

function resolveActiveServer(items) {
  const servers = items.serverList || [];
  return servers.find(s => s.id === items.activeServerId) || servers[0] || null;
}

function buildPacScriptString(activeServer) {
  if (!activeServer) return '';
  let host = (activeServer.host || '127.0.0.1').trim();
  if (/[^\x00-\x7F]/.test(host)) {
    try { host = new URL('http://' + host).hostname; }
    catch (e) { host = '127.0.0.1'; }
  }
  let port = parseInt(activeServer.port, 10);
  if (isNaN(port) || port < 1 || port > 65535) port = 1080;
  const scheme = (activeServer.scheme || 'SOCKS5').toUpperCase();
  const SUPPORTED_SCHEMES = ['HTTP', 'HTTPS', 'SOCKS4', 'SOCKS5'];
  if (!SUPPORTED_SCHEMES.includes(scheme)) {
    PSL.warn('background', `Unsupported proxy scheme "${scheme}", falling back to SOCKS5`);
  }
  let pacProxyType = 'SOCKS5';
  if (scheme === 'HTTP' || scheme === 'HTTPS') pacProxyType = 'PROXY';
  else if (scheme === 'SOCKS4') pacProxyType = 'SOCKS';
  const proxyStr = `${pacProxyType} ${host}:${port}; DIRECT`;
  const rawUserRules = Array.from(cachedUserRules || []);
  const wildcardRules = rawUserRules.filter(r => r.includes('*'));
  const normalUserRules = rawUserRules.filter(r => !r.includes('*'));
  const allMapRules = [...normalUserRules, ...cachedGfwDomains, ...cachedTempRules];
  return `
      var Proxy = "${proxyStr}";
      var Direct = "DIRECT";
      var pMap = ${JSON.stringify(Object.fromEntries(allMapRules.map(d => [d, 1])))};
      var dMap = ${JSON.stringify(Object.fromEntries([...cachedUserWhitelist].map(d => [d, 1])))};
      var wList = ${JSON.stringify(wildcardRules)};
      var ipRegex = /^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$/;
      function FindProxyForURL(url, host) {
        if (isPlainHostName(host) || shExpMatch(host, "*.local")) return Direct;
        if (ipRegex.test(host)) {
          if (isInNet(host, "10.0.0.0", "255.0.0.0") ||
              isInNet(host, "172.16.0.0", "255.240.0.0") ||
              isInNet(host, "192.168.0.0", "255.255.0.0") ||
              isInNet(host, "127.0.0.0", "255.0.0.0")) return Direct;
        }
        host = host.toLowerCase();
        if (check(host, dMap)) return Direct;
        for (var i = 0; i < wList.length; i++) {
          if (shExpMatch(host, wList[i]) || shExpMatch("." + host, wList[i])) return Proxy;
        }
        if (check(host, pMap)) return Proxy;
        return Direct;
      }
      function check(h, m) {
        if (m[h]) return true;
        var p = h.indexOf('.');
        while (p !== -1) {
          if (m[h.substring(p + 1)]) return true;
          p = h.indexOf('.', p + 1);
        }
        return false;
      }
    `;
}

function persistPacScriptIfNeeded(items, pacScriptStr, callback) {
  if (!pacScriptStr) {
    if (callback) callback();
    return;
  }
  const newPacHash = simpleHash(pacScriptStr);
  const needsPersist = newPacHash !== lastPacHash || !items.pacScriptData;
  if (!needsPersist) {
    if (callback) callback();
    return;
  }
  isApplyingProxy = true;
  pacUpdateVersion++;
  const tSet = Date.now();
  chrome.storage.local.set({
    pacScriptData: pacScriptStr,
    pacVersion: pacUpdateVersion,
    pacHash: newPacHash,
  }, () => {
    PSL.perf('background', 'PAC persist set', tSet, `len=${pacScriptStr.length}`, 300);
    lastPacHash = newPacHash;
    isApplyingProxy = false;
    if (callback) callback();
  });
}

// ===== 初始化与监听 =====
chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason === 'install') {
    const items = await chrome.storage.local.get(['serverList']);
    if (!items.serverList || items.serverList.length === 0) {
      const def = { 
        id: generateUUID(), 
        name: 'Default', 
        scheme: 'SOCKS5', 
        host: '127.0.0.1', 
        port: 10808 
      };
      await chrome.storage.local.set({ 
        serverList: [def], 
        activeServerId: def.id 
      });
    }
    chrome.runtime.openOptionsPage();
  }
  updateCacheAndApply();
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

  const changedKeys = Object.keys(changes);
  const hasConfigChange = changedKeys.some(key => AUTO_UPDATE_KEYS.includes(key));
  // Diagnostic records and unrelated settings must not enter proxy-update logic or create log recursion.
  if (!hasConfigChange) return;
  
  // 🔥 修复 Bug #1.1: 如果正在应用代理设置，跳过此次更新
  if (isApplyingProxy) {
    PSL.info('background', 'Skipping storage update: proxy application in progress');
    return;
  }

  PSL.info('background', 'Config changed', changedKeys.join(', '));
  debouncedUpdate();
  
  // 处理自动同步逻辑
  if (!isSyncing && (changes.userRules || changes.userWhitelist || changes.serverList)) {
    chrome.storage.local.get(['autoSync'], (s) => {
      if (s.autoSync) triggerAutoUpload();
    });
  }
});

// ===== 消息监听 =====
chrome.runtime.onMessage.addListener((m, s, sendResponse) => {
  if (m.type === 'REFRESH_PROXY') {
    const t0 = Date.now();
    refreshCacheAndIcon(() => {
      PSL.perf('background', 'REFRESH_PROXY total', t0, null, 300);
      sendResponse({ success: true });
    });
    return true;
  } else if (m.type === 'ENSURE_PAC') {
    const t0 = Date.now();
    const tGet = Date.now();
    chrome.storage.local.get(PAC_RELATED_KEYS, (items) => {
      PSL.perf('background', 'ENSURE_PAC storage.get', tGet, null, 200);
      cachedUserRules = normalizeSet(items.userRules);
      cachedUserWhitelist = normalizeSet(items.userWhitelist);
      cachedGfwDomains = normalizeSet(items.gfwDomains);
      cachedTempRules = normalizeSet(items.tempRules);
      if (!lastPacHash && items.pacHash) lastPacHash = items.pacHash;

      const activeServer = resolveActiveServer(items);
      const tBuild = Date.now();
      const pacScriptStr = buildPacScriptString(activeServer);
      PSL.perf('background', 'ENSURE_PAC buildPac', tBuild, `len=${pacScriptStr ? pacScriptStr.length : 0}`, 300);
      if (!pacScriptStr) {
        sendResponse({ success: false, error: 'no_server' });
        return;
      }
      persistPacScriptIfNeeded(items, pacScriptStr, () => {
        PSL.perf('background', 'ENSURE_PAC total', t0, null, 500);
        sendResponse({ success: true, pacScriptData: pacScriptStr });
      });
    });
    return true;
  } else if (m.type === 'UPDATE_ICON') {
    updateIconForActiveTab();
  } else if (m.type === 'MANUAL_SYNC_UPLOAD') {
    performCloudUpload()
      .then(t => sendResponse({success:true, time:t}))
      .catch(e => {
        PSL.error('background', 'Manual sync upload failed', e.message);
        sendResponse({success:false, error:e.message});
      });
    return true; 
  } else if (m.type === 'MANUAL_SYNC_DOWNLOAD') {
    performCloudDownload()
      .then(t => sendResponse({success:true, time:t}))
      .catch(e => {
        // SyntaxError messages from response.json() may echo remote config content.
        const safeMessage = e && e.name === 'SyntaxError'
          ? 'Remote configuration is not valid JSON'
          : (e && e.message) || 'Unknown';
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
  if (!list) return new Set();
  return new Set(list.map(d => {
    if (!d) return null;
    let raw = d.toLowerCase().trim();
    let prefix = "";
    if (raw.startsWith('*.')) { prefix = "*."; raw = raw.substring(2); } 
    else if (raw.startsWith('.')) { prefix = "."; raw = raw.substring(1); }
    // 🔥 修复: IDN 域名转换前先剥离前缀，转换后再拼回
    if (/[^\x00-\x7F]/.test(raw)) {
      try { 
        raw = new URL('http://' + raw).hostname; 
      } catch (e) { 
        PSL.warn('background', 'normalizeSet: IDN parse failed, keeping original', {
          inputLength: raw.length,
          nonAscii: true,
        });
        // keep original raw value rather than silently dropping
      }
    }
    return prefix + raw;
  }).filter(Boolean));
}

/**
 * Lightweight refresh: only update in-memory cache and regenerate PAC script,
 * without re-applying proxy mode. Used for REFRESH_PROXY messages from popup
 * to avoid background overwriting popup's just-set proxy config.
 */
function refreshCacheAndIcon(done) {
  if (isApplyingProxy) {
    let retries = 0;
    const tryAgain = () => {
      if (!isApplyingProxy) {
        refreshCacheAndIcon(done);
        return;
      }
      retries++;
      if (retries > 20) {
        PSL.warn('background', 'refreshCacheAndIcon timeout, forcing unlock');
        isApplyingProxy = false;
        refreshCacheAndIcon(done);
        return;
      }
      setTimeout(tryAgain, 50);
    };
    setTimeout(tryAgain, 50);
    return;
  }
  isApplyingProxy = true;
  chrome.storage.local.get(PAC_RELATED_KEYS, (items) => {
    cachedUserRules = normalizeSet(items.userRules);
    cachedUserWhitelist = normalizeSet(items.userWhitelist);
    cachedGfwDomains = normalizeSet(items.gfwDomains);
    cachedTempRules = normalizeSet(items.tempRules);
    if (!lastPacHash && items.pacHash) lastPacHash = items.pacHash;

    const pacScriptStr = buildPacScriptString(resolveActiveServer(items));
    persistPacScriptIfNeeded(items, pacScriptStr, () => {
      chrome.proxy.settings.get({}, (d) => {
        const mode = (d && d.value) ? d.value.mode : 'direct';
        currentProxyMode = mode;
        handleGlobalIconUpdate(mode);
        isApplyingProxy = false;
        if (done) done();
      });
    });
  });
}

function updateCacheAndApply(specificTabId, specificUrl, _retries, traceBoot) {
  if (isApplyingProxy) {
    const retries = (_retries || 0) + 1;
    if (retries > 20) {
      PSL.warn('background', 'updateCacheAndApply timeout, forcing unlock');
      isApplyingProxy = false;
    } else {
      setTimeout(() => updateCacheAndApply(specificTabId, specificUrl, retries, traceBoot), 100);
      return;
    }
  }
  
  chrome.storage.local.get(PAC_RELATED_KEYS, (items) => {
    if (traceBoot) ProxySwitchBootJournal.mark('initial_storage_get_returned');
    // 1. 更新内存缓存
    cachedUserRules = normalizeSet(items.userRules);
    cachedUserWhitelist = normalizeSet(items.userWhitelist);
    cachedGfwDomains = normalizeSet(items.gfwDomains);
    cachedTempRules = normalizeSet(items.tempRules);
    if (traceBoot) {
      ProxySwitchBootJournal.mark('initial_cache_built', {
        userRules: cachedUserRules.size,
        whitelist: cachedUserWhitelist.size,
        gfw: cachedGfwDomains.size,
        tempRules: cachedTempRules.size,
      });
    }
    
    // 🔥 修复: 初始化哈希值（首次运行时）
    if (!lastPacHash && items.pacHash) {
      lastPacHash = items.pacHash;
    }
    
    // 2. 应用设置 (生成 PAC 并注入)
    applyProxySettings(items, () => {
      // 3. 设置应用完毕后的回调
      // 4. 更新图标
      if (traceBoot) ProxySwitchBootJournal.mark('initial_active_icon_entered');
      if (specificTabId && specificUrl) {
        // 针对性更新（来自 Popup 的操作）
        updateTabIcon(specificTabId, specificUrl);
      } else {
        // 常规更新
        updateIconForActiveTab();
      }
      if (traceBoot) ProxySwitchBootJournal.mark('initial_active_icon_returned');

      if (initReadyResolver) {
        initReadyResolver();
        initReadyResolver = null;
      }
    }, traceBoot);
  });
}

function applyProxySettings(items, callback, traceBoot) {
  const activeServer = resolveActiveServer(items);
  if (traceBoot) ProxySwitchBootJournal.mark('initial_pac_build_entered');
  const pacScriptStr = buildPacScriptString(activeServer);
  if (traceBoot) ProxySwitchBootJournal.mark('initial_pac_build_returned', { pacLength: pacScriptStr.length });

  persistPacScriptIfNeeded(items, pacScriptStr, () => {
    if (traceBoot) ProxySwitchBootJournal.mark('initial_pac_persist_returned');
    doApplyProxyConfig(callback);
  });

  function doApplyProxyConfig(cb) {
    if (traceBoot) ProxySwitchBootJournal.mark('initial_proxy_get_dispatched');
    chrome.proxy.settings.get({}, (d) => {
      const mode = (d && d.value) ? d.value.mode : 'direct';
      currentProxyMode = mode;
      if (traceBoot) ProxySwitchBootJournal.mark('initial_proxy_get_returned', { mode });
      if (traceBoot) ProxySwitchBootJournal.mark('initial_global_icon_entered', { mode });
      handleGlobalIconUpdate(mode);
      if (traceBoot) ProxySwitchBootJournal.mark('initial_global_icon_returned', { mode });

      if (mode === 'pac_script' && pacScriptStr) {
        if (traceBoot) ProxySwitchBootJournal.mark('initial_proxy_set_dispatched', { mode });
        chrome.proxy.settings.set({
          value: { mode: "pac_script", pacScript: { data: pacScriptStr } },
          scope: 'regular'
        }, () => {
          if (traceBoot) ProxySwitchBootJournal.mark('initial_proxy_set_returned', {
            mode,
            success: !chrome.runtime.lastError,
          });
          if (chrome.runtime.lastError) {
            PSL.error('background', 'PAC proxy apply failed', chrome.runtime.lastError.message);
          } else {
            PSL.info('background', 'PAC proxy settings applied');
          }
          if (cb) cb();
        });
      } else if (mode === 'pac_script' && !pacScriptStr) {
        PSL.warn('background', 'PAC mode but no active server, falling back to direct');
        if (traceBoot) ProxySwitchBootJournal.mark('initial_proxy_set_dispatched', { mode: 'direct-fallback' });
        chrome.proxy.settings.set({
          value: { mode: "direct" },
          scope: 'regular'
        }, () => {
          if (traceBoot) ProxySwitchBootJournal.mark('initial_proxy_set_returned', {
            mode: 'direct-fallback',
            success: !chrome.runtime.lastError,
          });
          currentProxyMode = 'direct';
          handleGlobalIconUpdate('direct');
          if (cb) cb();
        });
      } else if (mode === 'fixed_servers' && activeServer) {
        if (traceBoot) ProxySwitchBootJournal.mark('initial_proxy_set_dispatched', { mode });
        chrome.proxy.settings.set({
          value: {
            mode: "fixed_servers",
            rules: {
              singleProxy: {
                scheme: (activeServer.scheme || 'SOCKS5').toLowerCase(),
                host: (activeServer.host || '127.0.0.1').trim(),
                port: parseInt(activeServer.port, 10) || 1080
              }
            }
          },
          scope: 'regular'
        }, () => {
          if (traceBoot) ProxySwitchBootJournal.mark('initial_proxy_set_returned', {
            mode,
            success: !chrome.runtime.lastError,
          });
          if (chrome.runtime.lastError) {
            PSL.error('background', 'Fixed proxy apply failed', chrome.runtime.lastError.message);
          } else {
            PSL.info('background', 'Fixed proxy settings applied');
          }
          if (cb) cb();
        });
      } else {
        if (traceBoot) ProxySwitchBootJournal.mark('initial_proxy_set_skipped', { mode });
        if (cb) cb();
      }
    });
  }
}

// ===== 同步逻辑 =====
// ===== 同步逻辑 (纯明文 JSON 版本) =====

/**
 * 辅助：WebDAV 上传
 */
async function bgWebdavUpload(config, jsonString){
  // 注意：Basic Auth 这里的 btoa 是 HTTP 标准认证头，Google 允许使用
  const auth = 'Basic ' + btoa(config.davUser + ':' + config.davPass);
  const baseUrl = config.davUrl.endsWith('/') ? config.davUrl : config.davUrl + '/';
  
  // 1. 尝试创建目录 (忽略错误，因为目录可能已存在)
  try { 
    await fetch(baseUrl + DAV_DIR_NAME + '/', {
      method: 'MKCOL', 
      headers: { 'Authorization': auth }
    }); 
  } catch (e) {
    PSL.warn('background', 'WebDAV MKCOL skipped', e.message);
  }
  
  // 2. 上传文件 (直接 PUT JSON 字符串)
  const res = await fetch(baseUrl + DAV_DIR_NAME + '/' + CONFIG_FILE_NAME, {
    method: 'PUT',
    headers: { 
      'Authorization': auth, 
      'Content-Type': 'application/json' 
    },
    body: jsonString // 发送明文
  });
  
  if(!res.ok) throw new Error("WebDAV Upload failed: " + res.status);
}

/**
 * 辅助：GitHub Gist 下载
 */
async function bgGithubDownload(token){
  const gists = await ghFetch('https://api.github.com/gists', 'GET', token);
  // 查找包含配置文件的 Gist
  const target = gists.find(x => x.files && x.files[CONFIG_FILE_NAME]);
  if(!target) throw new Error("Gist 中未找到配置文件");
  
  // 获取 Raw 内容
  const rawUrl = target.files[CONFIG_FILE_NAME].raw_url;
  const r = await fetch(rawUrl + '?t=' + Date.now()); // 加时间戳防缓存
  if(!r.ok) throw new Error("Gist Raw Download failed");
  
  return await r.json(); // 直接解析 JSON
}

/**
 * 核心：执行上传
 */
async function performCloudUpload(){
  isSyncing = true;
  try {
    // 1. 获取本地数据
    const items = await chrome.storage.local.get(null);
    
    // 2. 构造备份对象 (只备份核心配置；UI 偏好和同步元信息不纳入备份)
    const backupData = {
      userRules: items.userRules || [],
      userWhitelist: items.userWhitelist || [],
      tempRules: items.tempRules || [],
      serverList: items.serverList || [],
      activeServerId: items.activeServerId || '',
      gfwlistUrl: items.gfwlistUrl || '',

      updatedAt: new Date().toISOString(),
      backupVer: 5
    };
    
    // 3. 转换为格式化的 JSON 字符串 (方便用户阅读)
    const jsonContent = JSON.stringify(backupData, null, 2);
    
    // 4. 根据提供商上传
    if (items.syncProvider === 'webdav') {
      if (!items.davUrl) throw new Error("WebDAV URL 未设置");
      await bgWebdavUpload(items, jsonContent);
    } else {
      if (!items.gitToken) throw new Error("GitHub Token 未设置");
      
      // 检查是否存在旧 Gist，存在则更新，不存在则创建
      let gistId = null;
      try {
        const gists = await ghFetch('https://api.github.com/gists', 'GET', items.gitToken);
        const exist = gists.find(x => x.files && x.files[CONFIG_FILE_NAME]);
        if (exist) gistId = exist.id;
      } catch (e) {
        PSL.warn('background', 'Gist lookup failed, will create new', e.message);
      }
      
      const body = {
        description: "ProxySwitch Configuration Backup", // 移除 Obfuscated 字样
        public: false,
        files: { 
          [CONFIG_FILE_NAME]: { content: jsonContent } 
        }
      };
      
      if (gistId) {
        await ghFetch(`https://api.github.com/gists/${gistId}`, 'PATCH', items.gitToken, body);
      } else {
        await ghFetch('https://api.github.com/gists', 'POST', items.gitToken, body);
      }
    }
    
    const timeDisplay = new Date().toLocaleString();
    await chrome.storage.local.set({ lastSyncTime: timeDisplay });
    return timeDisplay;
    
  } finally { 
    isSyncing = false; 
  }
}

/**
 * 核心：执行下载
 */
async function performCloudDownload(){
  isSyncing = true;
  try {
    const items = await chrome.storage.local.get(['syncProvider', 'gitToken', 'davUrl', 'davUser', 'davPass']);
    let remoteData = null;
    
    // 1. 下载数据
    if (items.syncProvider === 'webdav') {
      if (!items.davUrl) throw new Error("WebDAV URL 未设置");
      const auth = 'Basic ' + btoa(items.davUser + ':' + items.davPass);
      const baseUrl = items.davUrl.endsWith('/') ? items.davUrl : items.davUrl + '/';
      
      const res = await fetch(baseUrl + DAV_DIR_NAME + '/' + CONFIG_FILE_NAME + '?t=' + Date.now(), { 
        headers: { 'Authorization': auth } 
      });
      if (!res.ok) throw new Error("WebDAV Download failed");
      remoteData = await res.json();
      
    } else {
      if (!items.gitToken) throw new Error("GitHub Token 未设置");
      remoteData = await bgGithubDownload(items.gitToken);
    }
    
    // 2. 验证与应用 (不兼容旧版，直接读取字段)
    if (remoteData && typeof remoteData === 'object') {
      
      // 清理敏感字段和不应同步的字段
      delete remoteData.gitToken;
      delete remoteData.davUrl;
      delete remoteData.davUser;
      delete remoteData.davPass;
      delete remoteData.gfwDomains;
      delete remoteData.pacScriptData;
      delete remoteData.pacVersion;
      delete remoteData.pacHash;
      delete remoteData.lastSyncTime;
      delete remoteData.ruleCount;
      delete remoteData.lastUpdate;
      delete remoteData.updatedAt;
      delete remoteData.backupVer;

      // Skip empty arrays and null values to avoid overwriting local data
      const safeData = {};
      for (const [key, value] of Object.entries(remoteData)) {
        if (Array.isArray(value) && value.length === 0) continue;
        if (value === undefined || value === null) continue;
        safeData[key] = value;
      }

      await chrome.storage.local.set(safeData);
      
      const timeDisplay = new Date().toLocaleString();
      await chrome.storage.local.set({ lastSyncTime: timeDisplay });
      
      // 3. 仅在下载数据含代理相关键时才刷新 PAC，避免无意义重生成
      const hasProxyKeys = Object.keys(safeData).some(k => 
        ['userRules','userWhitelist','gfwDomains','tempRules','serverList','activeServerId'].includes(k)
      );
      if (hasProxyKeys) {
        if (uploadDebounceTimer) { clearTimeout(uploadDebounceTimer); uploadDebounceTimer = null; }
        uploadDebounceTimer = setTimeout(() => {
          uploadDebounceTimer = null;
          updateCacheAndApply();
        }, 200);
      }
      
      return timeDisplay;
    } else {
      throw new Error("云端数据格式错误或不兼容");
    }
    
  } finally { 
    isSyncing = false; 
  }
}

/**
 * 🔥 修复 Bug #4: 内存泄漏防护
 * 自动上传触发器（带防抖和清理）
 */
function triggerAutoUpload() {
  // 清理旧定时器
  if (uploadDebounceTimer) {
    clearTimeout(uploadDebounceTimer);
    uploadDebounceTimer = null;
  }
  
  uploadDebounceTimer = setTimeout(() => {
    performCloudUpload()
      .catch(err => {
        PSL.error('background', 'Auto upload failed', err.message);
      })
      .finally(() => {
        // 操作完成后清空引用
        uploadDebounceTimer = null;
      });
  }, 10000);
}

async function ghFetch(url, method, token, body) {
  const opts = { 
    method, 
    headers: { 
      'Authorization': `token ${token}`, 
      'Accept': 'application/vnd.github.v3+json', 
      'Content-Type': 'application/json' 
    } 
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`GitHub API Error: ${res.status}`);
  return await res.json();
}

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
  if (mode !== 'pac_script') {
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
  if (currentProxyMode !== 'pac_script') return;
  const i18n = chrome.i18n.getMessage;

  // 清理该标签页的旧定时器
  if (pendingIconUpdates.has(tabId)) {
    clearTimeout(pendingIconUpdates.get(tabId));
    pendingIconUpdates.delete(tabId);
  }

  const hostname = getSafeHostname(url);
  
  let iconKey = 'pac_gray'; 
  let title = i18n("bgTitleAuto");

  if (hostname) {
    if (checkSet(hostname, cachedUserWhitelist)) { 
      iconKey = 'pac_blue'; 
      title = i18n("bgTitleDirect"); 
    }
    else if (checkSet(hostname, cachedTempRules)) { 
      iconKey = 'pac_org'; 
      title = i18n("bgTitleTemp"); 
    }
    else if (checkSet(hostname, cachedUserRules)) { 
      iconKey = 'pac_purp'; 
      title = i18n("bgTitleProxy"); 
    }
    else if (checkSet(hostname, cachedGfwDomains)) { 
      iconKey = 'pac_green'; 
      title = i18n("bgTitleAutoProxy"); 
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
      if (tab && tab.url === url) {
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
  if (currentProxyMode === 'pac_script') {
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
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  loadingTabs.delete(tabId);
  if (pendingIconUpdates.has(tabId)) {
    clearTimeout(pendingIconUpdates.get(tabId));
    pendingIconUpdates.delete(tabId);
  }
});

// All extension listeners are now registered synchronously. Business initialization starts afterwards.
ProxySwitchBootJournal.mark('listeners_registered');
ProxySwitchBootJournal.mark('initialization_dispatching');
updateCacheAndApply(undefined, undefined, undefined, true);
ProxySwitchBootJournal.mark('initialization_dispatched');
initPromise.then(async () => {
  await ProxySwitchBootJournal.mark('ready', { proxyMode: currentProxyMode });
  PSL.checkpoint('background', 'worker.ready', { proxyMode: currentProxyMode });
  await PSL.prune();
});
