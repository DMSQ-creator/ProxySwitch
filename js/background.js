// js/background.js - ProxySwitch

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

// 图标数据缓存 (Key: StateString -> Value: ImageData)
let iconDataCache = {};
let currentProxyMode = 'direct';

// 🔥 修复 Bug #2: 竞态条件防护
let activeTabId = null;
let pendingIconUpdates = new Map(); // tabId -> timeout

const CONFIG_FILE_NAME = 'proxyswitch_config.json';
const DAV_DIR_NAME = 'ProxySwitch';

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

// ===== 初始化与监听 =====
chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason === 'install') {
    const items = await chrome.storage.local.get(['serverList']);
    if (!items.serverList || items.serverList.length === 0) {
      const def = { 
        id: crypto.randomUUID(), 
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
  // 初始化预渲染图标
  await preloadAllIcons();
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
  
  // 🔥 修复 Bug #1.1: 如果正在应用代理设置，跳过此次更新
  if (isApplyingProxy) {
    console.log('[ProxySwitch] Skipping update: proxy application in progress');
    return;
  }
  
  // 🔥 修复 Bug #1.2: 检查是否是 pacScriptData 的自我更新
  const changedKeys = Object.keys(changes);
  if (changedKeys.length === 1 && changedKeys[0] === 'pacScriptData') {
    console.log('[ProxySwitch] Ignoring self-triggered pacScriptData update');
    return;
  }
  
  // 如果是 pacVersion 或 pacHash 的单独更新，也忽略
  if (changedKeys.length === 1 && (changedKeys[0] === 'pacVersion' || changedKeys[0] === 'pacHash')) {
    return;
  }
  
  // 🔥 修复 Bug #1.3: 只处理配置变化
  const hasConfigChange = changedKeys.some(key => AUTO_UPDATE_KEYS.includes(key));
  
  if (hasConfigChange) {
    console.log('[ProxySwitch] Config changed:', changedKeys);
    debouncedUpdate();
    
    // 处理自动同步逻辑
    if (!isSyncing && (changes.userRules || changes.userWhitelist || changes.serverList)) {
      chrome.storage.local.get(['autoSync'], (s) => { 
        if (s.autoSync) triggerAutoUpload(); 
      });
    }
  }
});

// ===== 消息监听 =====
chrome.runtime.onMessage.addListener((m, s, sendResponse) => {
  if (m.type === 'REFRESH_PROXY') {
    updateCacheAndApply();
  } else if (m.type === 'UPDATE_ICON') {
    updateIconForActiveTab();
  } else if (m.type === 'MANUAL_SYNC_UPLOAD') {
    performCloudUpload()
      .then(t => sendResponse({success:true, time:t}))
      .catch(e => sendResponse({success:false, error:e.message}));
    return true; 
  } else if (m.type === 'MANUAL_SYNC_DOWNLOAD') {
    performCloudDownload()
      .then(t => sendResponse({success:true, time:t}))
      .catch(e => sendResponse({success:false, error:e.message}));
    return true; 
  }
});

// 启动时预渲染
preloadAllIcons().then(updateCacheAndApply);

// ===== 核心逻辑 =====
function normalizeSet(list) {
  if (!list) return new Set();
  return new Set(list.map(d => {
    if (!d) return null;
    let raw = d.toLowerCase().trim();
    let prefix = "";
    if (raw.startsWith('*.')) { prefix = "*."; raw = raw.substring(2); } 
    else if (raw.startsWith('.')) { prefix = "."; raw = raw.substring(1); }
    if (/[^\x00-\x7F]/.test(raw)) {
      try { 
        if (!raw.includes('*')) raw = new URL('http://' + raw).hostname; 
      } catch (e) { 
        return null; 
      }
    }
    return prefix + raw;
  }).filter(Boolean));
}

function updateCacheAndApply(specificTabId, specificUrl) {
  // 🔥 修复 Bug #1.4: 队列化处理，防止重入
  if (isApplyingProxy) {
    console.log('[ProxySwitch] Update queued: operation in progress');
    setTimeout(() => updateCacheAndApply(specificTabId, specificUrl), 100);
    return;
  }
  
  chrome.storage.local.get(null, (items) => {
    // 1. 更新内存缓存
    cachedUserRules = normalizeSet(items.userRules);
    cachedUserWhitelist = normalizeSet(items.userWhitelist);
    cachedGfwDomains = normalizeSet(items.gfwDomains);
    cachedTempRules = normalizeSet(items.tempRules);
    
    // 🔥 修复: 初始化哈希值（首次运行时）
    if (!lastPacHash && items.pacHash) {
      lastPacHash = items.pacHash;
    }
    
    // 2. 应用设置 (生成 PAC 并注入)
    applyProxySettings(items, () => {
      // 3. 设置应用完毕后的回调
      if (initReadyResolver) {
        initReadyResolver();
        initReadyResolver = null;
      }
      
      // 4. 更新图标
      if (specificTabId && specificUrl) {
        // 针对性更新（来自 Popup 的操作）
        updateTabIcon(specificTabId, specificUrl);
      } else {
        // 常规更新
        updateIconForActiveTab();
      }
    });
  });
}

function applyProxySettings(items, callback) {
  const servers = items.serverList || [];
  const activeServer = servers.find(s => s.id === items.activeServerId) || servers[0];
  
  // 1. 生成 PAC 脚本内容
  let pacScriptStr = "";
  if (activeServer) {
    let host = (activeServer.host || "127.0.0.1").trim();
    if (/[^\x00-\x7F]/.test(host)) { 
      try { host = new URL('http://'+host).hostname; } 
      catch(e){ host="127.0.0.1"; } 
    }
    
    let port = parseInt(activeServer.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) port = 1080; 
    
    const scheme = (activeServer.scheme || "SOCKS5").toUpperCase();
    let pacProxyType = "SOCKS5"; 
    if (scheme === 'HTTP' || scheme === 'HTTPS') pacProxyType = "PROXY";  
    else if (scheme === 'SOCKS4') pacProxyType = "SOCKS";
    
    const proxyStr = `${pacProxyType} ${host}:${port}; DIRECT`;
    const rawUserRules = Array.from(cachedUserRules || []);
    const wildcardRules = rawUserRules.filter(r => r.includes('*'));
    const normalUserRules = rawUserRules.filter(r => !r.includes('*'));
    const allMapRules = [...normalUserRules, ...cachedGfwDomains, ...cachedTempRules];

    pacScriptStr = `
      var Proxy = "${proxyStr}";
      var Direct = "DIRECT";
      var pMap = ${JSON.stringify(Object.fromEntries(allMapRules.map(d=>[d,1])))};
      var dMap = ${JSON.stringify(Object.fromEntries([...cachedUserWhitelist].map(d=>[d,1])))};
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

  // 🔥 修复 Bug #1.5: 计算新 PAC 的哈希值
  const newPacHash = simpleHash(pacScriptStr);
  
  // 🔥 修复 Bug #1.6: 如果内容完全相同，跳过 storage 写入
  if (newPacHash === lastPacHash) {
    console.log('[ProxySwitch] PAC content unchanged, skipping storage write');
    // 仍然需要应用代理设置（可能是模式切换）
    doApplyProxyConfig(callback);
    return;
  }
  
  console.log('[ProxySwitch] PAC content changed, updating storage');
  console.log('  Old hash:', lastPacHash);
  console.log('  New hash:', newPacHash);
  
  // 🔥 修复 Bug #1.7: 设置标志位，防止触发递归
  isApplyingProxy = true;
  pacUpdateVersion++;
  
  // 🔥 修复 Bug #1.8: 存储时附带版本号和哈希值
  chrome.storage.local.set({ 
    pacScriptData: pacScriptStr,
    pacVersion: pacUpdateVersion,
    pacHash: newPacHash
  }, () => {
    // 更新内存中的哈希值
    lastPacHash = newPacHash;
    
    // 应用代理配置
    doApplyProxyConfig(() => {
      // 🔥 修复 Bug #1.9: 操作完成后重置标志位
      isApplyingProxy = false;
      if (callback) callback();
    });
  });
  
  // 辅助函数：实际应用代理配置
  function doApplyProxyConfig(cb) {
    chrome.proxy.settings.get({}, (d) => {
      const mode = (d && d.value) ? d.value.mode : 'direct';
      currentProxyMode = mode;
      handleGlobalIconUpdate(mode);

      // 只有当前是自动模式，且 PAC 有内容时，才重新设置代理
      if (mode === 'pac_script' && pacScriptStr) {
        chrome.proxy.settings.set({
          value: { mode: "pac_script", pacScript: { data: pacScriptStr } },
          scope: 'regular'
        }, () => {
          console.log('[ProxySwitch] Proxy settings applied successfully');
          if (cb) cb();
        });
      } else {
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
  } catch(e){}
  
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
    
    // 2. 构造备份对象 (只备份核心配置)
    const backupData = {
      userRules: items.userRules || [],
      userWhitelist: items.userWhitelist || [],
      serverList: items.serverList || [],
      activeServerId: items.activeServerId || '',
      gfwlistUrl: items.gfwlistUrl || '',
      theme: items.theme || 'system',
      autoSync: items.autoSync || false,
      syncProvider: items.syncProvider || 'github',
      
      // 元数据
      updatedAt: new Date().toISOString(),
      backupVer: 3 // 标记版本，方便未来维护
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
      } catch(e) {}
      
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
      
      // 清理敏感字段，防止覆盖本地认证信息
      delete remoteData.gitToken; 
      delete remoteData.davUrl; 
      delete remoteData.davUser; 
      delete remoteData.davPass; 
      delete remoteData.gfwDomains; // 规则列表体积大且常变，不建议同步，让用户重新下载
      
      // 应用到本地
      await chrome.storage.local.set(remoteData);
      
      const timeDisplay = new Date().toLocaleString();
      await chrome.storage.local.set({ lastSyncTime: timeDisplay });
      
      // 3. 立即触发代理刷新
      setTimeout(() => updateCacheAndApply(), 200);
      
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
        console.error('[ProxySwitch] Auto upload failed:', err);
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
async function preloadAllIcons() {
  const configs = [
    { key: 'fixed',    c: "#8b5cf6", t: "G" }, 
    { key: 'direct',   c: "#0ea5e9", t: "D" }, 
    { key: 'system',   c: "#64748b", t: "S" }, 
    { key: 'pac_gray', c: "#94a3b8", t: "A" }, 
    { key: 'pac_green',c: "#10b981", t: "A" }, 
    { key: 'pac_blue', c: "#0ea5e9", t: "W" }, 
    { key: 'pac_org',  c: "#f59e0b", t: "T" }, 
    { key: 'pac_purp', c: "#8b5cf6", t: "M" } 
  ];
  
  for (const cfg of configs) {
    iconDataCache[cfg.key] = createIconImageData(cfg.c, cfg.t);
  }
}

function createIconImageData(color, text) {
  const c = new OffscreenCanvas(32,32);
  const ctx = c.getContext('2d');
  const radius = 8; 
  
  ctx.clearRect(0, 0, 32, 32);
  ctx.fillStyle = color; 
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(32 - radius, 0);
  ctx.quadraticCurveTo(32, 0, 32, radius);
  ctx.lineTo(32, 32 - radius);
  ctx.quadraticCurveTo(32, 32, 32 - radius, 32);
  ctx.lineTo(radius, 32);
  ctx.quadraticCurveTo(0, 32, 0, 32 - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 22px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 16, 17);

  return ctx.getImageData(0,0,32,32);
}

function setGlobalIcon(key) {
  if (iconDataCache[key]) {
    chrome.action.setIcon({ imageData: iconDataCache[key] });
  }
}

function handleGlobalIconUpdate(mode) {
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

  // 3. 【核心修复】强制更新当前激活标签页的图标
  // 这一步是为了覆盖掉自动模式下可能闪留的 "Sticky" (Tab专用) 图标
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    if (tabs && tabs[0]) {
      // 直接对当前 tabId 设置图标，确保它立即变化，不再显示旧的自动分流图标
      if (iconDataCache[iconKey]) {
        chrome.action.setIcon({ imageData: iconDataCache[iconKey], tabId: tabs[0].id });
        
        // 可选：顺便更新一下鼠标悬停标题
        let title = "ProxySwitch";
        if (mode === 'fixed_servers') title = "ProxySwitch: 全局代理";
        else if (mode === 'direct') title = "ProxySwitch: 直接连接";
        else if (mode === 'system') title = "ProxySwitch: 系统代理";
        else if (mode === 'pac_script') title = "ProxySwitch: 自动分流";
        
        chrome.action.setTitle({ title: title, tabId: tabs[0].id });
      }
    }
  });
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

  // 清理该标签页的旧定时器
  if (pendingIconUpdates.has(tabId)) {
    clearTimeout(pendingIconUpdates.get(tabId));
    pendingIconUpdates.delete(tabId);
  }

  const hostname = getSafeHostname(url);
  
  let iconKey = 'pac_gray'; 
  let title = "自动分流 (直连)";

  if (hostname) {
    if (checkSet(hostname, cachedUserWhitelist)) { 
      iconKey = 'pac_blue'; 
      title = "强制直连"; 
    }
    else if (checkSet(hostname, cachedTempRules)) { 
      iconKey = 'pac_org'; 
      title = "临时规则"; 
    }
    else if (checkSet(hostname, cachedUserRules)) { 
      iconKey = 'pac_purp'; 
      title = "强制代理"; 
    }
    else if (checkSet(hostname, cachedGfwDomains)) { 
      iconKey = 'pac_green'; 
      title = "自动分流 (代理中)"; 
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
        if (iconDataCache[iconKey]) {
          chrome.action.setIcon({ imageData: iconDataCache[iconKey], tabId: tabId });
          chrome.action.setTitle({ title: `ProxySwitch: ${title}`, tabId: tabId });
        }
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
  if (!s || s.size === 0) return false; 
  
  const tryMatch = (domain) => {
    if (s.has(domain)) return true;
    if (s.has('.' + domain)) return true; 
    if (s.has('*.' + domain)) return true;
    return false;
  };
  
  if (tryMatch(h)) return true;
  
  var p = h.indexOf('.'); 
  while (p !== -1) { 
    if (tryMatch(h.substring(p + 1))) return true; 
    p = h.indexOf('.', p + 1); 
  } 
  return false; 
}

// ===== 事件监听 =====
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (currentProxyMode === 'pac_script' && tab.url) { 
    await initPromise; 
    updateTabIcon(tabId, tab.url); 
  }
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
          updateTabIcon(tabs[0].id, tabs[0].url);
        }
      }
    });
  }
});