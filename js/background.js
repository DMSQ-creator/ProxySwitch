// js/background.js

let cachedUserRules = new Set();
let cachedUserWhitelist = new Set();
let cachedGfwDomains = new Set();
let cachedTempRules = new Set();
let isSyncing = false;
let uploadDebounceTimer = null;

// 图标数据缓存 (Key: StateString -> Value: ImageData)
let iconDataCache = {};
// 当前代理模式
let currentProxyMode = 'direct';

const CONFIG_FILE_NAME = 'proxyswitch_config.json';
const DAV_DIR_NAME = 'ProxySwitch';

// --- 初始化 Promise ---
let initReadyResolver = null;
const initPromise = new Promise((resolve) => {
  initReadyResolver = resolve;
});

// --- 工具函数 ---
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// --- 初始化与监听 ---
chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason === 'install') {
    const items = await chrome.storage.local.get(['serverList']);
    if (!items.serverList || items.serverList.length === 0) {
      const def = { id: crypto.randomUUID(), name: 'Default', scheme: 'SOCKS5', host: '127.0.0.1', port: 10808 };
      await chrome.storage.local.set({ serverList: [def], activeServerId: def.id });
    }
    chrome.runtime.openOptionsPage();
  }
  // 初始化预渲染图标
  await preloadAllIcons();
  updateCacheAndApply();
});

const debouncedUpdate = debounce(updateCacheAndApply, 500);



// 定义一个白名单：只有这些设置变了，才允许刷新后台
// 这样就过滤掉了 'pacScriptData'，防止死循环
const AUTO_UPDATE_KEYS = [
  'userRules', 
  'userWhitelist', 
  'gfwDomains', 
  'tempRules', 
  'serverList', 
  'activeServerId'
];

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    // 1. 检查本次变动中，是否包含上面列表里的任意一个 key
    // Object.keys(changes) 拿到了这次所有变动的字段名
    // .some(...) 判断其中是否有我们关心的字段
    const hasConfigChange = Object.keys(changes).some(key => AUTO_UPDATE_KEYS.includes(key));
    
    // 2. 只有确认是配置变了，才刷新
    if (hasConfigChange) {
      debouncedUpdate();
      
      // 3. 处理自动同步逻辑
      if (!isSyncing && (changes.userRules || changes.userWhitelist || changes.serverList)) {
        chrome.storage.local.get(['autoSync'], (s) => { 
          if (s.autoSync) triggerAutoUpload(); 
        });
      }
    }
  }
});

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

// 启动时先预渲染
preloadAllIcons().then(updateCacheAndApply);

// --- 核心逻辑 ---
function normalizeSet(list) {
  if (!list) return new Set();
  return new Set(list.map(d => {
    if (!d) return null;
    let raw = d.toLowerCase().trim();
    let prefix = "";
    if (raw.startsWith('*.')) { prefix = "*."; raw = raw.substring(2); } 
    else if (raw.startsWith('.')) { prefix = "."; raw = raw.substring(1); }
    if (/[^\x00-\x7F]/.test(raw)) {
      try { if (!raw.includes('*')) raw = new URL('http://' + raw).hostname; } catch (e) { return null; }
    }
    return prefix + raw;
  }).filter(Boolean));
}

function updateCacheAndApply(specificTabId, specificUrl) {
  chrome.storage.local.get(null, (items) => {
    // 1. 更新内存缓存
    cachedUserRules = normalizeSet(items.userRules);
    cachedUserWhitelist = normalizeSet(items.userWhitelist);
    cachedGfwDomains = normalizeSet(items.gfwDomains);
    cachedTempRules = normalizeSet(items.tempRules);
    
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
      if (/[^\x00-\x7F]/.test(host)) { try { host = new URL('http://'+host).hostname; } catch(e){ host="127.0.0.1"; } }
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

  // 2. 优化：先读取旧的 PAC 数据进行对比，只有内容变了才写入
  chrome.storage.local.get(['pacScriptData'], (oldData) => {
      const oldPac = oldData.pacScriptData || "";
      const hasChanged = oldPac !== pacScriptStr;

      // 定义应用逻辑
      const doApply = () => {
          chrome.proxy.settings.get({}, (d) => {
              const mode = (d && d.value) ? d.value.mode : 'direct';
              currentProxyMode = mode;
              handleGlobalIconUpdate(mode);

              // 只有当内容变了，且当前是自动模式，才重新设置代理
              if (mode === 'pac_script' && hasChanged && pacScriptStr) {
                  chrome.proxy.settings.set({
                      value: { mode: "pac_script", pacScript: { data: pacScriptStr } },
                      scope: 'regular'
                  }, () => {
                      if (callback) callback();
                  });
              } else {
                  if (callback) callback();
              }
          });
      };

      // 3. 只有当数据真的改变时，才写入 storage
      // 这能避免死循环和减少卡顿
      if (hasChanged) {
          chrome.storage.local.set({ pacScriptData: pacScriptStr }, doApply);
      } else {
          doApply();
      }
  });
}

// --- 同步逻辑 ---
async function bgWebdavUpload(i, d){
  const a = 'Basic ' + btoa(i.davUser + ':' + i.davPass);
  const r = i.davUrl.endsWith('/') ? i.davUrl : i.davUrl + '/';
  try { await fetch(r + DAV_DIR_NAME + '/', {method:'MKCOL', headers:{'Authorization':a}}); } catch(e){}
  const res = await fetch(r + DAV_DIR_NAME + '/' + CONFIG_FILE_NAME, {
    method: 'PUT',
    headers: { 'Authorization': a, 'Content-Type': 'application/json' },
    body: JSON.stringify(d)
  });
  if(!res.ok) throw new Error("WebDAV Upload failed: " + res.status);
}
async function bgGithubDownload(t){
  const g = await ghFetch('https://api.github.com/gists', 'GET', t);
  const target = g.find(x => x.files && x.files[CONFIG_FILE_NAME]);
  if(!target) throw new Error("No config found in Gist");
  const r = await fetch(target.files[CONFIG_FILE_NAME].raw_url + '?t=' + Date.now());
  return await r.json();
}
async function performCloudUpload(){
  isSyncing = true;
  try {
    const items = await chrome.storage.local.get(null);
    const { userRules, userWhitelist, serverList, activeServerId, gfwlistUrl, theme, autoSync, syncProvider } = items;
    const rawPayload = { userRules, userWhitelist, serverList, activeServerId, gfwlistUrl, theme, autoSync, syncProvider, timestamp: Date.now() };
    const jsonStr = JSON.stringify(rawPayload);
    const encodedStr = btoa(unescape(encodeURIComponent(jsonStr)));
    const finalBody = { encoded: true, content: encodedStr };
    if (items.syncProvider === 'webdav') {
      if (!items.davUrl) throw new Error("WebDAV URL not set");
      await bgWebdavUpload(items, finalBody);
    } else {
      if (!items.gitToken) throw new Error("GitHub Token not set");
      let gistId = null;
      try {
        const gists = await ghFetch('https://api.github.com/gists', 'GET', items.gitToken);
        const exist = gists.find(x => x.files && x.files[CONFIG_FILE_NAME]);
        if (exist) gistId = exist.id;
      } catch(e) {}
      const body = {
        // 修改这里的描述为 Backup
        description: "ProxySwitch Config Backup (Obfuscated)",
        public: false,
        files: { [CONFIG_FILE_NAME]: { content: JSON.stringify(finalBody) } }
      };
      if (gistId) await ghFetch(`https://api.github.com/gists/${gistId}`, 'PATCH', items.gitToken, body);
      else await ghFetch('https://api.github.com/gists', 'POST', items.gitToken, body);
    }
    const time = new Date().toLocaleString();
    await chrome.storage.local.set({ lastSyncTime: time });
    return time;
  } finally { isSyncing = false; }
}
async function performCloudDownload(){
  isSyncing = true;
  try {
    const items = await chrome.storage.local.get(['syncProvider', 'gitToken', 'davUrl', 'davUser', 'davPass']);
    let data = null;
    if (items.syncProvider === 'webdav') {
      if (!items.davUrl) throw new Error("WebDAV URL not set");
      const a = 'Basic ' + btoa(items.davUser + ':' + items.davPass);
      const r = items.davUrl.endsWith('/') ? items.davUrl : items.davUrl + '/';
      const res = await fetch(r + DAV_DIR_NAME + '/' + CONFIG_FILE_NAME + '?t=' + Date.now(), { headers: { 'Authorization': a } });
      if (!res.ok) throw new Error("WebDAV Download failed");
      data = await res.json();
    } else {
      if (!items.gitToken) throw new Error("GitHub Token not set");
      data = await bgGithubDownload(items.gitToken);
    }
    if (data && data.encoded && data.content) {
      try { const jsonStr = decodeURIComponent(escape(atob(data.content))); data = JSON.parse(jsonStr); } catch(e) { throw new Error("配置文件格式不兼容"); }
    }
    if (data) {
      delete data.gitToken; delete data.davUrl; delete data.davUser; delete data.davPass; delete data.gfwDomains; 
      await chrome.storage.local.set(data);
      const time = new Date().toLocaleString();
      await chrome.storage.local.set({ lastSyncTime: time });
      return time;
    }
  } finally { isSyncing = false; }
}
function triggerAutoUpload() {
  if (uploadDebounceTimer) clearTimeout(uploadDebounceTimer);
  uploadDebounceTimer = setTimeout(() => performCloudUpload().catch(console.error), 10000);
}
async function ghFetch(url, method, token, body) {
  const opts = { method, headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`GitHub API Error: ${res.status}`);
  return await res.json();
}

// --- 图标管理模块 ---
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
  // 这一步是为了覆盖掉自动模式下可能遗留的 "Sticky" (Tab专用) 图标
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
  try { return new URL(urlStr).hostname.toLowerCase(); } catch (e) { return null; }
}

function updateTabIcon(tabId, url) {
  if (currentProxyMode !== 'pac_script') return;

  const hostname = getSafeHostname(url);
  
  let iconKey = 'pac_gray'; 
  let title = "自动分流 (直连)";

  if (hostname) {
    if (checkSet(hostname, cachedUserWhitelist)) { iconKey = 'pac_blue'; title = "强制直连"; }
    else if (checkSet(hostname, cachedTempRules)) { iconKey = 'pac_org'; title = "临时规则"; }
    else if (checkSet(hostname, cachedUserRules)) { iconKey = 'pac_purp'; title = "强制代理"; }
    else if (checkSet(hostname, cachedGfwDomains)) { iconKey = 'pac_green'; title = "自动分流 (代理中)"; }
  }

  if (iconDataCache[iconKey]) {
    chrome.action.setIcon({ imageData: iconDataCache[iconKey], tabId: tabId });
    chrome.action.setTitle({ title: `ProxySwitch: ${title}`, tabId: tabId });
  }
}

function updateIconForActiveTab(){
  chrome.tabs.query({active:true, currentWindow:true}, t => {
    if(t && t[0] && t[0].id && t[0].url) {
      updateTabIcon(t[0].id, t[0].url);
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

// --- 事件监听 ---
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (currentProxyMode === 'pac_script' && tab.url) { 
    await initPromise; 
    updateTabIcon(tabId, tab.url); 
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (currentProxyMode === 'pac_script') {
    await initPromise;
    chrome.tabs.get(activeInfo.tabId, (tab) => {
      if (chrome.runtime.lastError) return; 
      if (tab && tab.url) updateTabIcon(tab.id, tab.url);
    });
  }
});