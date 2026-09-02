// js/page-boot.js - Earliest page-side black-box marker.
// Keep this file tiny and dependency-free: it must run before the normal logger.
(() => {
  'use strict';

  const LOG_PREFIX = '__psl_log_v2__:';
  const PAGE_GENERATION_KEY = '__psl_page_log_generation_v2';
  const PRUNE_TRIGGER = 550;
  const PRUNE_TARGET = 500;
  const path = String(location.pathname || '');
  const context = path.endsWith('/popup.html')
    ? 'popup'
    : path.endsWith('/options.html')
      ? 'options'
      : 'extension-page';

  function createId() {
    try {
      if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (_) {}
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  const contextId = `${context}:${createId().slice(0, 12)}`;
  let sequence = 0;

  function pruneOldPageRecords(target = PRUNE_TARGET) {
    try {
      const records = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(LOG_PREFIX)) continue;
        try {
          const entry = JSON.parse(localStorage.getItem(key));
          records.push({ key, createdAtMs: Number(entry && entry.createdAtMs) || 0, id: entry && entry.id || key });
        } catch (_) {
          records.push({ key, createdAtMs: 0, id: key });
        }
      }
      records.sort((a, b) => (a.createdAtMs - b.createdAtMs) || String(a.id).localeCompare(String(b.id)));
      for (const record of records.slice(0, Math.max(0, records.length - target))) {
        localStorage.removeItem(record.key);
      }
      return true;
    } catch (error) {
      console.error('[ProxySwitch][blackbox] Early page retention failed', error);
      return false;
    }
  }

  function mark(message, detail) {
    const createdAtMs = Date.now();
    sequence += 1;
    const id = createId();
    let generation;
    try {
      generation = localStorage.getItem(PAGE_GENERATION_KEY) || undefined;
    } catch (_) {
      generation = undefined;
    }
    const entry = {
      schemaVersion: 2,
      id,
      createdAtMs,
      createdAt: new Date(createdAtMs).toISOString(),
      level: 'checkpoint',
      source: context,
      message,
      detail,
      context,
      contextId,
      sequence,
      generation,
    };

    const key = `${LOG_PREFIX}${String(createdAtMs).padStart(13, '0')}:${id}`;
    const value = JSON.stringify(entry);
    try {
      localStorage.setItem(key, value);
      if (localStorage.length > PRUNE_TRIGGER) pruneOldPageRecords();
      return true;
    } catch (error) {
      // There is intentionally no fallback to chrome.storage here: that could wake
      // the service worker and change the failure we are trying to observe.
      console.error('[ProxySwitch][blackbox] Earliest page marker failed', error);
      // Quota recovery is best-effort and stays entirely page-local.
      if (!pruneOldPageRecords(400)) return false;
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (retryError) {
        console.error('[ProxySwitch][blackbox] Earliest page marker retry failed', retryError);
        return false;
      }
    }
  }

  globalThis.ProxySwitchPageBoot = Object.freeze({
    context,
    contextId,
    mark,
    getSequence: () => sequence,
  });
  mark(`${context}.page_boot_entered`, { readyState: document.readyState });
})();
