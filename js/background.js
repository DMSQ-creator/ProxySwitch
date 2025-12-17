// js/background.js

let cachedUserRules = new Set();
let cachedUserWhitelist = new Set();
let cachedGfwDomains = new Set();
let cachedTempRules = new Set();
let isSyncing = false;
let uploadDebounceTimer = null;

const CONFIG_FILE_NAME = 'proxyswitch_config.json';
const DAV_DIR_NAME = 'ProxySwitch';

// --- 初始化 Promise ---
let initReadyResolver = null;
const initPromise = new Promise((resolve) => {
  initReadyResolver = resolve;
});

// --- 工具函数：防抖 ---
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
  updateCacheAndApply();
});

const debouncedUpdate = debounce(updateCacheAndApply, 500);

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes.userRules || changes.userWhitelist || changes.gfwDomains || 
        changes.serverList || changes.activeServerId || changes.tempRules) {
      debouncedUpdate();
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

updateCacheAndApply();

// --- 核心逻辑 ---
function normalizeSet(list) {
  if (!list) return new Set();
  return new Set(list.map(d => {
    if (!d) return null;
    let raw = d.toLowerCase().trim();
    let prefix = "";

    // --- 修复逻辑第一步：切头 ---
    // 先把通配符 (*.) 拿掉，保存到 prefix 变量里
    if (raw.startsWith('*.')) {
      prefix = "*.";
      raw = raw.substring(2); // 去掉前两个字符
    } else if (raw.startsWith('.')) {
      prefix = ".";
      raw = raw.substring(1); // 去掉前一个字符
    }

    // --- 修复逻辑第二步：转码 ---
    // 现在 raw 里面是很干净的 "公司.com"，没有星号，可以放心转码
    if (/[^\x00-\x7F]/.test(raw)) {
      try {
        // 如果还包含 * (比如 google.*.com)，这种太复杂就不转了，防止报错
        if (!raw.includes('*')) {
           raw = new URL('http://' + raw).hostname;
        }
      } catch (e) {
        return null; // 转码失败则丢弃
      }
    }

    // --- 修复逻辑第三步：接回去 ---
    // 拼成 "*.xn--..."
    return prefix + raw;
  }).filter(Boolean));
}

function updateCacheAndApply() {
  chrome.storage.local.get(null, (items) => {
    cachedUserRules = normalizeSet(items.userRules);
    cachedUserWhitelist = normalizeSet(items.userWhitelist);
    cachedGfwDomains = normalizeSet(items.gfwDomains);
    cachedTempRules = normalizeSet(items.tempRules);
    applyProxySettings(items);
    if (initReadyResolver) {
      initReadyResolver();
      initReadyResolver = null;
    }
    updateIconForActiveTab();
  });
}

function applyProxySettings(items) {
  const servers = items.serverList || [];
  const activeServer = servers.find(s => s.id === items.activeServerId) || servers[0];
  
  if (!activeServer) {
    chrome.proxy.settings.set({ value: { mode: "direct" }, scope: 'regular' });
    return;
  }

  // 1. 数据清洗与格式化 (Punycode 处理)
  let host = (activeServer.host || "127.0.0.1").trim();
  if (/[^\x00-\x7F]/.test(host)) {
    try { host = new URL('http://' + host).hostname; } catch(e) { host = "127.0.0.1"; }
  }

  let port = parseInt(activeServer.port, 10);
  if (isNaN(port) || port < 1 || port > 65535) port = 1080; 
  
  const scheme = (activeServer.scheme || "SOCKS5").toUpperCase();
  
// --- 修复开始 ---
  let pacProxyType = "SOCKS5"; 
  
  if (scheme === 'HTTP' || scheme === 'HTTPS') pacProxyType = "PROXY";  
  else if (scheme === 'SOCKS4') pacProxyType = "SOCKS";
  else if (scheme === 'SOCKS5') pacProxyType = "SOCKS5";   
  const proxyStr = `${pacProxyType} ${host}:${port}; DIRECT`;

  // --------------------------------

  const rawUserRules = Array.from(cachedUserRules || []);
  const wildcardRules = rawUserRules.filter(r => r.includes('*'));
  const normalUserRules = rawUserRules.filter(r => !r.includes('*'));
  const allMapRules = [...normalUserRules, ...cachedGfwDomains, ...cachedTempRules];

  // --- PAC 脚本生成 (纯 ASCII) ---
  const pacScriptStr = `
    var Proxy = "${proxyStr}";
    var Direct = "DIRECT";
    
    var pMap = ${JSON.stringify(Object.fromEntries(allMapRules.map(d=>[d,1])))};
    var dMap = ${JSON.stringify(Object.fromEntries([...cachedUserWhitelist].map(d=>[d,1])))};
    var wList = ${JSON.stringify(wildcardRules)};

    // Regex for IPv4
    var ipRegex = /^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$/;

    function FindProxyForURL(url, host) {
      // Localhost optimization
      if (isPlainHostName(host) || shExpMatch(host, "*.local")) return Direct;
      
      // DNS Blocking Fix: Only check IPs
      if (ipRegex.test(host)) {
        if (isInNet(host, "10.0.0.0", "255.0.0.0") || 
            isInNet(host, "172.16.0.0", "255.240.0.0") || 
            isInNet(host, "192.168.0.0", "255.255.0.0") || 
            isInNet(host, "127.0.0.0", "255.0.0.0")) {
          return Direct;
        }
      }
      
      host = host.toLowerCase();

      // Check Whitelist
      if (check(host, dMap)) return Direct;

      // Check Wildcards
      for (var i = 0; i < wList.length; i++) {
        if (shExpMatch(host, wList[i]) || shExpMatch("." + host, wList[i])) return Proxy;
      }

      // Check Hash Map
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

  // 应用设置
  chrome.storage.local.set({ pacScriptData: pacScriptStr });
  chrome.proxy.settings.get({}, (d) => {
    if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);

    const mode = (d && d.value) ? d.value.mode : 'direct';
    if (mode === 'pac_script') {
      chrome.proxy.settings.set({ value: { mode: "pac_script", pacScript: { data: pacScriptStr } }, scope: 'regular' });
    } else if (mode === 'fixed_servers') {
      // fixed_servers 模式下，Chrome API 需要小写的 scheme (http, https, socks4, socks5)
      // 我们的 scheme 变量是全大写的，所以需要 toLowerCase()
      chrome.proxy.settings.set({ 
        value: { 
          mode: "fixed_servers", 
          rules: { 
            singleProxy: { 
              scheme: scheme.toLowerCase(), 
              host, 
              port 
            } 
          } 
        }, 
        scope: 'regular' 
      });
    }
  });
}

// --- 同步模块 (Base64 编码) ---

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
    
    // 原始 Payload
    const rawPayload = { userRules, userWhitelist, serverList, activeServerId, gfwlistUrl, theme, autoSync, syncProvider, timestamp: Date.now() };
    
    // 【Base64 编码混淆】 (支持 UTF-8)
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
        description: "ProxySwitch Config Sync (Obfuscated)",
        public: false,
        files: { [CONFIG_FILE_NAME]: { content: JSON.stringify(finalBody) } }
      };

      if (gistId) {
        await ghFetch(`https://api.github.com/gists/${gistId}`, 'PATCH', items.gitToken, body);
      } else {
        await ghFetch('https://api.github.com/gists', 'POST', items.gitToken, body);
      }
    }
    const time = new Date().toLocaleString();
    await chrome.storage.local.set({ lastSyncTime: time });
    return time;
  } finally {
    isSyncing = false;
  }
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

    // 【Base64 解码还原】
    if (data && data.encoded && data.content) {
      try {
        const jsonStr = decodeURIComponent(escape(atob(data.content)));
        data = JSON.parse(jsonStr);
      } catch(e) {
        // 兼容旧版加密数据的容错处理 (如果解不开 Base64，说明可能是旧数据，直接抛弃或尝试读取)
        // 这里简单处理，如果解析失败，抛出错误
        throw new Error("配置文件格式不兼容，无法解析。");
      }
    }

    if (data) {
      delete data.gitToken; delete data.davUrl; delete data.davUser; delete data.davPass;
      delete data.gfwDomains; 
      await chrome.storage.local.set(data);
      const time = new Date().toLocaleString();
      await chrome.storage.local.set({ lastSyncTime: time });
      return time;
    }
  } finally {
    isSyncing = false;
  }
}

function triggerAutoUpload() {
  if (uploadDebounceTimer) clearTimeout(uploadDebounceTimer);
  uploadDebounceTimer = setTimeout(() => performCloudUpload().catch(console.error), 10000);
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

function getSafeHostname(urlStr) {
  if (!urlStr || !urlStr.startsWith('http')) return null;
  try { return new URL(urlStr).hostname.toLowerCase(); } catch (e) { return null; }
}

async function updateTabIcon(tabId, url) {
  const hostname = getSafeHostname(url);
  chrome.proxy.settings.get({}, d => {
    const mode = (d && d.value) ? d.value.mode : 'direct';
    const state = calculateState(hostname, mode);
    drawIcon(state, tabId);
  });
}

function updateIconForActiveTab(){
  chrome.tabs.query({active:true, currentWindow:true}, t => {
    if(t && t[0] && t[0].id && t[0].url) {
      updateTabIcon(t[0].id, t[0].url);
    }
  });
}

function calculateState(h, m){
  if(m === 'fixed_servers') return {c:"#4CAF50", t:"P"};
  if(m === 'direct') return {c:"#2196F3", t:"D"};
  if(m === 'pac_script'){
    if (!h) return {c:"#9E9E9E", t:"A"};
    const cleanH = h;
    if(checkSet(cleanH, cachedUserWhitelist)) return {c:"#2196F3", t:"W"};
    if(checkSet(cleanH, cachedTempRules)) return {c:"#FF9800", t:"T"};
    if(checkSet(cleanH, cachedUserRules) || checkSet(cleanH, cachedGfwDomains)) return {c:"#4CAF50", t:"A"};
    return {c:"#9E9E9E", t:"A"};
  }
  return {c:"#9E9E9E", t:"D"};
}

function checkSet(h, s) { 
  if (!s || s.size === 0) return false; 
  
  // 辅助函数：尝试匹配当前域名的各种变体
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

function drawIcon(s, tabId){
  const c = new OffscreenCanvas(32,32);
  const x = c.getContext('2d');
  x.fillStyle = s.c; 
  x.beginPath(); x.arc(16,16,16,0,Math.PI*2); x.fill();
  x.fillStyle = "#fff"; x.font = "bold 20px sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(s.t, 16, 17);
  const imageData = x.getImageData(0,0,32,32);

  // [修改] 增加回调函数并在里面访问 lastError，这样 Chrome 就认为错误已被处理，不会在控制台报错
  chrome.action.setIcon({ imageData: imageData, tabId: tabId }, () => {
    if (chrome.runtime.lastError) {
      // 标签页已关闭，忽略此错误
    }
  });
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab.url) { await initPromise; updateTabIcon(tabId, tab.url); }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await initPromise;
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    // [修改] 如果获取过程中标签页被关闭，直接 return，防止报错
    if (chrome.runtime.lastError) return; 
    if (tab && tab.url) updateTabIcon(tab.id, tab.url);
  });
});