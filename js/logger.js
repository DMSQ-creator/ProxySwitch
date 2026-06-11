// js/logger.js - Local error log (ring buffer, privacy-safe)
const PSL = (function () {
  const STORAGE_KEY = 'errorLogs';
  const VERBOSE_KEY = 'errorLogVerbose';
  const MAX_ENTRIES = 500;
  const MAX_DETAIL_LEN = 500;
  const FLUSH_INTERVAL_MS = 2000;
  const nowMs = () => Date.now();

  let pendingEntries = [];
  let flushTimer = null;

  function sanitize(value) {
    if (value == null) return '';
    let s = typeof value === 'string' ? value : String(value);
    if (typeof value === 'object') {
      try { s = JSON.stringify(value); } catch (_) { s = String(value); }
    }
    s = s.replace(/ghp_[a-zA-Z0-9]{20,}/gi, 'ghp_***');
    s = s.replace(/github_pat_[a-zA-Z0-9_]+/gi, 'github_pat_***');
    s = s.replace(/(Bearer\s+)\S+/gi, '$1***');
    s = s.replace(/(Authorization:\s*)\S+/gi, '$1***');
    s = s.replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, '$1***');
    s = s.replace(/("(?:gitToken|davPass|password|token)"\s*:\s*)"[^"]*"/gi, '$1"***"');
    s = s.replace(/https?:\/\/[^\s?#]+/gi, (url) => {
      try {
        const u = new URL(url);
        return u.origin + (u.pathname.length > 1 ? u.pathname : '');
      } catch (_) { return '[url]'; }
    });
    if (s.length > MAX_DETAIL_LEN) s = s.slice(0, MAX_DETAIL_LEN) + '…';
    return s;
  }

  async function isVerbose() {
    const data = await chrome.storage.local.get(VERBOSE_KEY);
    return !!data[VERBOSE_KEY];
  }

  async function shouldLog(level) {
    if (level === 'error' || level === 'warn') return true;
    return isVerbose();
  }

  async function append(level, source, message, detail) {
    if (!(await shouldLog(level))) return;
    const entry = {
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      level,
      source: sanitize(source),
      message: sanitize(message),
    };
    const d = sanitize(detail);
    if (d) entry.detail = d;

    pendingEntries.push(entry);
    if (!flushTimer) {
      flushTimer = setTimeout(flushToStorage, FLUSH_INTERVAL_MS);
    }
    // Also flush urgently for errors/warns
    if (level === 'error' || level === 'warn') {
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushToStorage, 0);
    }
  }

  async function flushToStorage() {
    flushTimer = null;
    if (pendingEntries.length === 0) return;
    const batch = pendingEntries;
    pendingEntries = [];

    const data = await chrome.storage.local.get(STORAGE_KEY);
    const logs = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
    for (const entry of batch) {
      logs.push(entry);
    }
    while (logs.length > MAX_ENTRIES) logs.shift();
    await chrome.storage.local.set({ [STORAGE_KEY]: logs });
  }

  async function perf(source, name, startMs, detail, warnThresholdMs) {
    const dur = nowMs() - (startMs || nowMs());
    const msg = `${name} ${dur}ms`;
    if (typeof warnThresholdMs === 'number' && dur >= warnThresholdMs) {
      return append('warn', source, msg, detail);
    }
    return append('info', source, msg, detail);
  }

  function formatLogs(logs) {
    if (!logs || logs.length === 0) return '';
    return logs.map((e) => {
      const t = e.time || '';
      let line = `[${t}] ${(e.level || 'info').toUpperCase()} ${e.source || ''}\n${e.message || ''}`;
      if (e.detail) line += `\n  → ${e.detail}`;
      return line;
    }).join('\n\n');
  }

  return {
    error(source, message, detail) {
      const p = append('error', source, message, detail);
      console.error(`[ProxySwitch][${source}]`, message, detail || '');
      return p;
    },
    warn(source, message, detail) {
      const p = append('warn', source, message, detail);
      console.warn(`[ProxySwitch][${source}]`, message, detail || '');
      return p;
    },
    info(source, message, detail) {
      const p = append('info', source, message, detail);
      console.log(`[ProxySwitch][${source}]`, message, detail || '');
      return p;
    },
    async getLogs() {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
    },
    async clearLogs() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      pendingEntries = [];
      await chrome.storage.local.set({ [STORAGE_KEY]: [] });
    },
    formatLogs,
    async setVerbose(enabled) {
      await chrome.storage.local.set({ [VERBOSE_KEY]: !!enabled });
    },
    async getVerbose() {
      return isVerbose();
    },
    perf,
  };
})();
