// js/logger.js - Local fault black box (privacy-safe, append-only)
const PSL = (function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  const LEGACY_STORAGE_KEY = 'errorLogs';
  const VERBOSE_KEY = 'errorLogVerbose';
  const LOG_PREFIX = '__psl_log_v2__:';
  const BOOT_PREFIX = '__psl_boot_v2__:';
  const CHROME_CLEAR_BEFORE_KEY = '__psl_log_clear_before_v2';
  const PAGE_CLEAR_BEFORE_KEY = '__psl_page_log_clear_before_v2';
  const CHROME_GENERATION_KEY = '__psl_log_generation_v2';
  const PAGE_GENERATION_KEY = '__psl_page_log_generation_v2';
  const MAX_ENTRIES = 500;
  const MAX_BOOT_SESSIONS = 20;
  const MAX_SOURCE_LEN = 48;
  const MAX_MESSAGE_LEN = 240;
  const MAX_DETAIL_LEN = 1800;
  const PRUNE_EVERY = 40;

  const isPageContext = typeof document !== 'undefined';
  const pageStorageAvailable = isPageContext && typeof localStorage !== 'undefined';
  const contextName = detectContextName();
  const earlyPageBoot = typeof globalThis !== 'undefined' ? globalThis.ProxySwitchPageBoot : null;
  const contextId = earlyPageBoot && earlyPageBoot.context === contextName && earlyPageBoot.contextId
    ? earlyPageBoot.contextId
    : `${contextName}:${createId().slice(0, 12)}`;
  const pendingWrites = new Set();

  let bootId = '';
  let sequence = earlyPageBoot && typeof earlyPageBoot.getSequence === 'function'
    ? Number(earlyPageBoot.getSequence()) || 0
    : 0;
  let writesSincePrune = 0;
  let prunePromise = null;
  let verboseEnabled = false;
  let chromeGeneration = '';
  let lastPageReadError = '';

  let verboseReady;
  try {
    verboseReady = Promise.resolve(chrome.storage.local.get([VERBOSE_KEY, CHROME_GENERATION_KEY]))
      .then((data) => {
        verboseEnabled = !!data[VERBOSE_KEY];
        chromeGeneration = String(data[CHROME_GENERATION_KEY] || '');
        return verboseEnabled;
      })
      .catch((error) => {
        console.error('[ProxySwitch][blackbox] Failed to read recorder settings', error);
        return false;
      });
  } catch (error) {
    console.error('[ProxySwitch][blackbox] Recorder settings API unavailable', error);
    verboseReady = Promise.resolve(false);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[VERBOSE_KEY]) {
      verboseEnabled = !!changes[VERBOSE_KEY].newValue;
    }
    if (area === 'local' && changes[CHROME_GENERATION_KEY]) {
      chromeGeneration = String(changes[CHROME_GENERATION_KEY].newValue || '');
    }
  });

  function detectContextName() {
    if (typeof document === 'undefined') return 'background';
    if (typeof location !== 'undefined') {
      const path = String(location.pathname || '');
      if (path.endsWith('/popup.html')) return 'popup';
      if (path.endsWith('/options.html')) return 'options';
    }
    return 'extension-page';
  }

  function createId() {
    try {
      if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (_) {}
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  function serializeDetail(value) {
    if (value == null) return '';
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (typeof value === 'object' && value.stack) return String(value.stack);
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return String(value);

    try {
      return JSON.stringify(value, (key, nestedValue) => {
        if (/(?:password|pass|token|authorization|secret|cookie)/i.test(key)) return '***';
        if (nestedValue instanceof Error) return nestedValue.stack || nestedValue.message;
        return nestedValue;
      });
    } catch (_) {
      return String(value);
    }
  }

  function sanitize(value, maxLength) {
    let text = serializeDetail(value);
    text = text.replace(/ghp_[a-zA-Z0-9]{20,}/gi, 'ghp_***');
    text = text.replace(/github_pat_[a-zA-Z0-9_]+/gi, 'github_pat_***');
    text = text.replace(
      /((?:Proxy-Authorization|Authorization|Set-Cookie|Cookie)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n,}]+)/gi,
      '$1***',
    );
    text = text.replace(/(Bearer\s+)\S+/gi, '$1***');
    text = text.replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, '$1***');
    text = text.replace(/((?:gitToken|davPass|password|token|secret|cookie)["']?\s*[=:]\s*["']?)[^\s,;"'}]+/gi, '$1***');
    text = text.replace(/\bchrome-extension:\/\/[^/\s"'<>]+(\/[^\s"'<>]*)?/gi, (_match, path) => `[extension]${path || ''}`);
    // Remove the entire URL, including its path, query and fragment. Never export raw page/server URLs.
    text = text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[url]');
    text = text.replace(/\b(?:file|ftp|blob):\/\/[^\s"'<>]+/gi, '[url]');
    text = text.replace(/\bdata:[^\s"'<>]+/gi, '[data-url]');
    text = text.replace(/\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?\b/gi, '[address]');
    text = text.replace(/\[[0-9a-f:]+\](?::\d{1,5})?/gi, '[address]');
    if (text.length > maxLength) text = `${text.slice(0, maxLength)}…`;
    return text;
  }

  function makeEntry(level, source, message, detail) {
    const createdAtMs = Date.now();
    let generation = chromeGeneration;
    if (pageStorageAvailable) {
      try {
        generation = String(localStorage.getItem(PAGE_GENERATION_KEY) || '');
      } catch (_) {
        generation = chromeGeneration;
      }
    }
    sequence += 1;
    return {
      schemaVersion: SCHEMA_VERSION,
      id: createId(),
      createdAtMs,
      createdAt: new Date(createdAtMs).toISOString(),
      level,
      source: sanitize(source, MAX_SOURCE_LEN),
      message: sanitize(message, MAX_MESSAGE_LEN),
      detail: sanitize(detail, MAX_DETAIL_LEN) || undefined,
      context: contextName,
      contextId,
      bootId: bootId || undefined,
      sequence,
      generation: generation || undefined,
    };
  }

  function makeLogKey(entry) {
    return `${LOG_PREFIX}${String(entry.createdAtMs).padStart(13, '0')}:${entry.id}`;
  }

  function logToConsole(level, entry) {
    const args = [`[ProxySwitch][${entry.source}]`, entry.message];
    if (entry.detail) args.push(entry.detail);
    if (level === 'error') console.error(...args);
    else if (level === 'warn') console.warn(...args);
    else console.log(...args);
  }

  function trackWrite(promise) {
    pendingWrites.add(promise);
    promise.finally(() => pendingWrites.delete(promise));
    return promise;
  }

  function persistToChrome(entry) {
    const key = makeLogKey(entry);
    let storageWrite;
    try {
      storageWrite = chrome.storage.local.set({ [key]: entry });
    } catch (error) {
      console.error('[ProxySwitch][blackbox] Persistent write API failed', error);
      return Promise.resolve(false);
    }
    const promise = Promise.resolve(storageWrite)
      .then(() => {
        writesSincePrune += 1;
        if (writesSincePrune >= PRUNE_EVERY) {
          writesSincePrune = 0;
          void prune();
        }
        return true;
      })
      .catch((error) => {
        // Never call PSL from here: storage failure must not recurse into the logger.
        console.error('[ProxySwitch][blackbox] Persistent write failed', error);
        return false;
      });
    return trackWrite(promise);
  }

  function persistToPage(entry) {
    const key = makeLogKey(entry);
    try {
      localStorage.setItem(key, JSON.stringify(entry));
      writesSincePrune += 1;
      if (writesSincePrune >= PRUNE_EVERY) {
        writesSincePrune = 0;
        prunePageStorage();
      }
      return Promise.resolve(true);
    } catch (error) {
      // Do not fall back to chrome.storage from a page context. A storage write can
      // wake the service worker and change the failure that the popup is observing.
      console.error('[ProxySwitch][blackbox] Page write failed', error);
      return Promise.resolve(false);
    }
  }

  function persistEntry(entry) {
    // Page localStorage is synchronous and does not wake the service worker via chrome.storage.onChanged.
    if (isPageContext) {
      return pageStorageAvailable ? persistToPage(entry) : Promise.resolve(false);
    }
    return persistToChrome(entry);
  }

  function emit(level, source, message, detail, persist) {
    const entry = makeEntry(level, source, message, detail);
    logToConsole(level, entry);
    if (!persist) return Promise.resolve(false);
    return persistEntry(entry);
  }

  async function flush() {
    while (pendingWrites.size > 0) {
      await Promise.allSettled(Array.from(pendingWrites));
    }
  }

  function readPageEntries() {
    if (!pageStorageAvailable) return [];
    lastPageReadError = '';
    const entries = [];
    try {
      const cutoff = Number(localStorage.getItem(PAGE_CLEAR_BEFORE_KEY) || 0);
      const generation = String(localStorage.getItem(PAGE_GENERATION_KEY) || '');
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(LOG_PREFIX)) continue;
        try {
          const entry = JSON.parse(localStorage.getItem(key));
          if (isEntryVisible(entry, generation, cutoff)) entries.push(entry);
        } catch (_) {}
      }
    } catch (error) {
      lastPageReadError = sanitize(error, 240);
      console.error('[ProxySwitch][blackbox] Failed to read page records', error);
    }
    return entries;
  }

  function prunePageStorage() {
    if (!pageStorageAvailable) return;
    try {
      const cutoff = Number(localStorage.getItem(PAGE_CLEAR_BEFORE_KEY) || 0);
      const generation = String(localStorage.getItem(PAGE_GENERATION_KEY) || '');
      const entries = [];
      const removeKeys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(LOG_PREFIX)) continue;
        try {
          const entry = JSON.parse(localStorage.getItem(key));
          if (!isEntryVisible(entry, generation, cutoff)) removeKeys.push(key);
          else entries.push({ key, createdAtMs: Number(entry.createdAtMs), id: entry.id || key });
        } catch (_) {
          removeKeys.push(key);
        }
      }
      entries.sort(compareStoredItems);
      for (const item of entries.slice(0, Math.max(0, entries.length - MAX_ENTRIES))) {
        removeKeys.push(item.key);
      }
      for (const key of new Set(removeKeys)) localStorage.removeItem(key);
    } catch (error) {
      console.error('[ProxySwitch][blackbox] Failed to prune page records', error);
    }
  }

  function compareStoredItems(a, b) {
    const timeOrder = a.createdAtMs - b.createdAtMs;
    if (timeOrder) return timeOrder;
    if (a.contextId && a.contextId === b.contextId && a.sequence && b.sequence && a.sequence !== b.sequence) {
      return a.sequence - b.sequence;
    }
    return String(a.id).localeCompare(String(b.id));
  }

  function isEntryVisible(entry, generation, cutoff) {
    if (!entry) return false;
    if (!generation) return Number(entry.createdAtMs) > cutoff;
    if (entry.generation === generation) return true;
    // Migration/propagation fallback: an early context may emit before it has read
    // the current generation. The timestamp admits only generation-less entries.
    return !entry.generation && Number(entry.createdAtMs) > cutoff;
  }

  function normalizeStoredEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const timestamp = Number(entry.createdAtMs);
    const validTimestamp = Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8640000000000000;
    return {
      schemaVersion: Number(entry.schemaVersion) || 0,
      id: sanitize(entry.id || createId(), 160),
      createdAtMs: validTimestamp ? timestamp : 0,
      createdAt: validTimestamp ? new Date(timestamp).toISOString() : sanitize(entry.createdAt, 80),
      level: sanitize(entry.level || 'info', 24),
      source: sanitize(entry.source || '', MAX_SOURCE_LEN),
      message: sanitize(entry.message || '', MAX_MESSAGE_LEN),
      detail: sanitize(entry.detail, MAX_DETAIL_LEN) || undefined,
      context: sanitize(entry.context || 'unknown', 48),
      contextId: sanitize(entry.contextId || entry.context || 'unknown', 160),
      bootId: sanitize(entry.bootId, 160) || undefined,
      sequence: Number(entry.sequence) || 0,
    };
  }

  function extractChromeEntries(data) {
    const cutoff = Number(data[CHROME_CLEAR_BEFORE_KEY] || 0);
    const generation = String(data[CHROME_GENERATION_KEY] || '');
    const entries = [];
    for (const [key, value] of Object.entries(data)) {
      if (!key.startsWith(LOG_PREFIX)) continue;
      if (isEntryVisible(value, generation, cutoff)) entries.push(value);
    }

    // Keep existing diagnostics readable until the user clears them.
    if (!cutoff && Array.isArray(data[LEGACY_STORAGE_KEY])) {
      for (const legacy of data[LEGACY_STORAGE_KEY]) {
        const parsed = Date.parse(legacy.time || '');
        entries.push({
          schemaVersion: 1,
          id: `legacy:${createId()}`,
          createdAtMs: Number.isFinite(parsed) ? parsed : 0,
          createdAt: legacy.time || '',
          level: legacy.level || 'info',
          source: sanitize(legacy.source, MAX_SOURCE_LEN),
          message: sanitize(legacy.message, MAX_MESSAGE_LEN),
          detail: sanitize(legacy.detail, MAX_DETAIL_LEN) || undefined,
          context: 'legacy',
          contextId: 'legacy',
          sequence: 0,
        });
      }
    }
    return entries;
  }

  function mergeAndSortEntries(...groups) {
    const byId = new Map();
    for (const group of groups) {
      for (const entry of group) {
        if (!entry || !entry.id) continue;
        const normalized = normalizeStoredEntry(entry);
        if (normalized) byId.set(normalized.id, normalized);
      }
    }
    return Array.from(byId.values()).sort(compareStoredItems);
  }

  function groupBootRecords(data) {
    const groups = new Map();
    for (const [key, value] of Object.entries(data)) {
      if (!key.startsWith(BOOT_PREFIX)) continue;
      const stage = normalizeBootStage(value);
      if (!stage) continue;
      if (!groups.has(stage.bootId)) groups.set(stage.bootId, []);
      groups.get(stage.bootId).push(stage);
    }

    const boots = [];
    for (const [id, stages] of groups) {
      stages.sort((a, b) => (Number(a.sequence) - Number(b.sequence)) || (Number(a.createdAtMs) - Number(b.createdAtMs)));
      const startedAtMs = Math.min(...stages.map((stage) => Number(stage.createdAtMs) || Date.now()));
      const last = stages[stages.length - 1];
      boots.push({
        bootId: id,
        version: last.version || stages[0].version || '',
        startedAtMs,
        lastAtMs: Number(last.createdAtMs) || startedAtMs,
        lastPhase: last.phase || 'unknown',
        ready: stages.some((stage) => stage.phase === 'ready'),
        stages,
      });
    }
    boots.sort((a, b) => a.startedAtMs - b.startedAtMs);
    return boots.slice(-MAX_BOOT_SESSIONS);
  }

  function normalizeBootStage(value) {
    if (!value || typeof value !== 'object') return null;
    const bootId = sanitize(value.bootId, 160);
    const timestamp = Number(value.createdAtMs);
    if (!bootId || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 8640000000000000) return null;
    return {
      schemaVersion: Number(value.schemaVersion) || 0,
      bootId,
      sequence: Number(value.sequence) || 0,
      phase: sanitize(value.phase || 'unknown', 120),
      detail: sanitize(value.detail, MAX_DETAIL_LEN) || undefined,
      createdAtMs: timestamp,
      createdAt: new Date(timestamp).toISOString(),
      version: sanitize(value.version || '', 80),
    };
  }

  async function readChromeStorage() {
    await flush();
    return chrome.storage.local.get(null);
  }

  async function getLogs() {
    const data = await readChromeStorage();
    return mergeAndSortEntries(extractChromeEntries(data), readPageEntries()).slice(-MAX_ENTRIES);
  }

  async function getBootRecords() {
    const data = await readChromeStorage();
    return groupBootRecords(data);
  }

  async function clearLogs() {
    await flush();
    const cutoff = Date.now();
    const generation = createId();

    if (pageStorageAvailable) {
      try {
        localStorage.setItem(PAGE_GENERATION_KEY, generation);
        localStorage.setItem(PAGE_CLEAR_BEFORE_KEY, String(cutoff));
        prunePageStorage();
      } catch (error) {
        // Continue clearing the worker backend even when page Web Storage is unavailable.
        console.error('[ProxySwitch][blackbox] Page clear barrier failed', error);
      }
    }

    // Generation is the logical clear barrier. Late writes from the old generation stay hidden
    // regardless of same-millisecond timestamps or system clock changes. The timestamp remains
    // for compatibility with schema-v1/v2 entries written before generations existed.
    chromeGeneration = generation;
    await chrome.storage.local.set({
      [CHROME_GENERATION_KEY]: generation,
      [CHROME_CLEAR_BEFORE_KEY]: cutoff,
    });
    const data = await chrome.storage.local.get(null);
    const removeKeys = Object.entries(data)
      .filter(([key, value]) => key.startsWith(LOG_PREFIX) && !isEntryVisible(value, generation, cutoff))
      .map(([key]) => key);
    if (Object.prototype.hasOwnProperty.call(data, LEGACY_STORAGE_KEY)) removeKeys.push(LEGACY_STORAGE_KEY);
    if (removeKeys.length) await chrome.storage.local.remove(Array.from(new Set(removeKeys)));
  }

  function clearPageDiagnostics() {
    if (!pageStorageAvailable) return;
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith(LOG_PREFIX) || key === PAGE_CLEAR_BEFORE_KEY || key === PAGE_GENERATION_KEY)) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
    } catch (error) {
      console.error('[ProxySwitch][blackbox] Failed to clear page records', error);
    }
  }

  async function prune() {
    if (prunePromise) return prunePromise;
    prunePromise = (async () => {
      if (pageStorageAvailable) prunePageStorage();
      const data = await chrome.storage.local.get(null);
      const cutoff = Number(data[CHROME_CLEAR_BEFORE_KEY] || 0);
      const generation = String(data[CHROME_GENERATION_KEY] || '');
      const removeKeys = [];
      const entries = [];

      for (const [key, value] of Object.entries(data)) {
        if (!key.startsWith(LOG_PREFIX)) continue;
        if (!isEntryVisible(value, generation, cutoff)) removeKeys.push(key);
        else entries.push({ key, createdAtMs: Number(value.createdAtMs), id: value.id || key });
      }
      entries.sort(compareStoredItems);
      for (const item of entries.slice(0, Math.max(0, entries.length - MAX_ENTRIES))) removeKeys.push(item.key);

      const allBoots = groupBootRecords(data);
      const keepBootIds = new Set(allBoots.slice(-MAX_BOOT_SESSIONS).map((item) => item.bootId));
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith(BOOT_PREFIX) && value && !keepBootIds.has(value.bootId)) removeKeys.push(key);
      }

      if (removeKeys.length) await chrome.storage.local.remove(Array.from(new Set(removeKeys)));
    })()
      .catch((error) => {
        console.error('[ProxySwitch][blackbox] Retention cleanup failed', error);
      })
      .finally(() => {
        prunePromise = null;
      });
    return prunePromise;
  }

  function formatTimestamp(entry) {
    const timestamp = Number(entry.createdAtMs);
    if (Number.isFinite(timestamp) && timestamp > 0) return new Date(timestamp).toISOString();
    return entry.createdAt || '';
  }

  function formatLogs(logs) {
    if (!logs || logs.length === 0) return '';
    return logs.map((entry) => {
      const meta = [`ctx=${entry.contextId || entry.context || 'unknown'}`];
      if (entry.bootId) meta.push(`boot=${String(entry.bootId).slice(0, 12)}`);
      if (entry.sequence) meta.push(`seq=${entry.sequence}`);
      let line = `[${formatTimestamp(entry)}] ${(entry.level || 'info').toUpperCase()} ${entry.source || ''} ${entry.message || ''}`;
      line += `\n  · ${meta.join(' ')}`;
      if (entry.detail) line += `\n  → ${entry.detail}`;
      return line;
    }).join('\n\n');
  }

  function formatBootRecords(boots) {
    if (!boots.length) return 'No worker boot record. The worker may not have executed its first JavaScript statement.';
    const now = Date.now();
    return boots.map((boot, index) => {
      const isLatest = index === boots.length - 1;
      let status = 'READY';
      if (!boot.ready) {
        if (bootImportFailed(boot)) status = 'IMPORT FAILURE';
        else status = isLatest && now - boot.lastAtMs < 120000
          ? 'RECENT INCOMPLETE / MAY STILL BE STARTING'
          : 'INCOMPLETE/INTERRUPTED';
      }
      const lines = [
        `[${new Date(boot.startedAtMs).toISOString()}] ${status} boot=${boot.bootId} version=${boot.version || 'unknown'}`,
      ];
      for (const stage of boot.stages) {
        const offset = Math.max(0, Number(stage.createdAtMs) - boot.startedAtMs);
        let line = `  +${offset}ms ${stage.phase}`;
        if (stage.detail) line += ` → ${sanitize(stage.detail, MAX_DETAIL_LEN)}`;
        lines.push(line);
      }
      return lines.join('\n');
    }).join('\n\n');
  }

  function bootImportFailed(boot) {
    const stage = boot && boot.stages.find((item) => item.phase === 'imports_completed');
    if (!stage || !stage.detail) return false;
    try {
      return JSON.parse(stage.detail).coreModulesReady === false;
    } catch (_) {
      return /coreModulesReady[^a-z]+false/i.test(stage.detail);
    }
  }

  function getProxySnapshot() {
    return new Promise((resolve) => {
      try {
        chrome.proxy.settings.get({}, (details) => {
          if (chrome.runtime.lastError) {
            resolve({ error: sanitize(chrome.runtime.lastError.message, 240) });
            return;
          }
          resolve({
            mode: details && details.value ? details.value.mode : 'unknown',
            levelOfControl: details && details.levelOfControl ? details.levelOfControl : 'unknown',
          });
        });
      } catch (error) {
        resolve({ error: sanitize(error, 240) });
      }
    });
  }

  function normalizeActionPopup(value) {
    const raw = String(value || '');
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'chrome-extension:') return parsed.pathname || '/';
      return `[${parsed.protocol.replace(':', '')}-url]`;
    } catch (_) {
      return sanitize(raw, 240);
    }
  }

  function getManifestPopup() {
    try {
      const manifest = chrome.runtime.getManifest();
      return normalizeActionPopup(manifest.action && manifest.action.default_popup);
    } catch (_) {
      return '';
    }
  }

  async function getActionSnapshot(manifestPopup = getManifestPopup()) {
    const popupPromise = new Promise((resolve) => {
      if (!chrome.action || typeof chrome.action.getPopup !== 'function') {
        resolve('unavailable');
        return;
      }
      chrome.action.getPopup({}, (popup) => {
        resolve(chrome.runtime.lastError ? 'error' : normalizeActionPopup(popup));
      });
    });
    const enabledPromise = new Promise((resolve) => {
      if (!chrome.action || typeof chrome.action.isEnabled !== 'function') {
        resolve('unavailable');
        return;
      }
      try {
        Promise.resolve(chrome.action.isEnabled()).then(
          (enabled) => resolve(!!enabled),
          () => resolve('error'),
        );
      } catch (_) {
        resolve('error');
      }
    });

    const [popupResult, enabledResult] = await Promise.all([
      settleWithTimeout(popupPromise, 1200, 'chrome.action.getPopup'),
      settleWithTimeout(enabledPromise, 1200, 'chrome.action.isEnabled'),
    ]);
    const errors = [];
    if (!popupResult.ok) errors.push(popupResult.error);
    if (!enabledResult.ok) errors.push(enabledResult.error);

    return {
      manifestPopup,
      effectivePopup: popupResult.ok ? popupResult.value : 'unavailable',
      enabled: enabledResult.ok ? enabledResult.value : 'unavailable',
      error: errors.filter(Boolean).join('; '),
    };
  }

  function settleWithTimeout(promise, timeoutMs, label) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: `${label} timeout after ${timeoutMs}ms` }), timeoutMs);
      Promise.resolve(promise).then(
        (value) => finish({ ok: true, value }),
        (error) => finish({ ok: false, error: sanitize(error, 240) || `${label} failed` }),
      );
    });
  }

  function parseEntryDetail(entry) {
    if (!entry || !entry.detail || typeof entry.detail !== 'string') return {};
    try {
      const parsed = JSON.parse(entry.detail);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function groupPopupSessions(logs) {
    const groups = new Map();
    for (const entry of logs) {
      if (entry.context !== 'popup' || !entry.contextId) continue;
      if (!groups.has(entry.contextId)) groups.set(entry.contextId, []);
      groups.get(entry.contextId).push(entry);
    }
    const sessions = Array.from(groups, ([popupContextId, entries]) => {
      entries.sort(compareStoredItems);
      const phases = new Set(entries.map((entry) => entry.message));
      return {
        popupContextId,
        entries,
        startedAtMs: Number(entries[0] && entries[0].createdAtMs) || 0,
        lastAtMs: Number(entries[entries.length - 1] && entries[entries.length - 1].createdAtMs) || 0,
        lastPhase: entries[entries.length - 1] && entries[entries.length - 1].message || 'unknown',
        ready: phases.has('popup.ui_state_applied') || phases.has('popup.ui_ready'),
      };
    });
    sessions.sort((a, b) =>
      (a.startedAtMs - b.startedAtMs) ||
      (a.lastAtMs - b.lastAtMs) ||
      a.popupContextId.localeCompare(b.popupContextId)
    );
    return sessions;
  }

  function findLast(items, predicate) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (predicate(items[i])) return items[i];
    }
    return null;
  }

  function buildDiagnosis(boots, popupSessions, logs, availability) {
    const latestBoot = boots.length ? boots[boots.length - 1] : null;
    const recentIncompleteBoot = findLast(boots, (boot) => !boot.ready);
    let worker;
    if (!availability.chromeStorage) {
      worker = 'JOURNAL UNAVAILABLE — worker-side storage could not be read for this report.';
    } else if (!latestBoot) {
      worker = 'NO FIRST MARKER — the worker did not execute the journal, storage was unavailable, or its history was reset.';
    } else if (latestBoot.ready) {
      worker = `READY — boot ${latestBoot.bootId.slice(0, 12)} reached ready; last phase ${latestBoot.lastPhase}.`;
    } else if (bootImportFailed(latestBoot)) {
      worker = 'IMPORT FAILURE — the worker reported that its core modules did not load.';
    } else {
      const recent = Date.now() - latestBoot.lastAtMs < 120000;
      worker = `${recent ? 'NOT READY / POSSIBLY STILL STARTING' : 'INCOMPLETE OR INTERRUPTED'} — last confirmed phase ${latestBoot.lastPhase}.`;
    }
    const workerHistory = !availability.chromeStorage
      ? 'Worker boot history unavailable.'
      : recentIncompleteBoot
      ? `RETAINED INCOMPLETE/INTERRUPTED BOOT — ${recentIncompleteBoot.bootId.slice(0, 12)} stopped after ${recentIncompleteBoot.lastPhase}.`
      : 'No incomplete worker boot appears in retained history.';

    const latestPopupSession = popupSessions.length ? popupSessions[popupSessions.length - 1] : null;
    const latestPopup = latestPopupSession ? latestPopupSession.entries : [];
    const recentIncompletePopup = findLast(popupSessions, (session) => !session.ready);
    if (!latestPopup.length) {
      return {
        worker,
        workerHistory,
        popup: availability.pageStorage
          ? 'NO RETAINED FIRST MARKER — no retained popup-side JavaScript evidence exists. This cannot prove whether the toolbar icon was clicked.'
          : 'PAGE RECORDS UNAVAILABLE — page-local evidence could not be read for this report.',
        popupHistory: 'No incomplete popup context appears in retained history.',
        handshake: 'NOT REACHED — no popup context was recorded.',
      };
    }

    const phases = new Set(latestPopup.map((entry) => entry.message));
    const lastPhase = latestPopup[latestPopup.length - 1].message || 'unknown';
    let popup;
    const uiStateApplied = phases.has('popup.ui_state_applied') || phases.has('popup.ui_ready');
    if (!phases.has('popup.script_entered')) {
      popup = `PAGE BOOT SCRIPT RAN, MAIN SCRIPT NOT REACHED — last confirmed marker ${lastPhase}.`;
    } else if (!uiStateApplied) {
      popup = `MAIN SCRIPT STARTED, UI STATE NOT APPLIED — last confirmed marker ${lastPhase}.`;
    } else {
      popup = phases.has('popup.frame_callback')
        ? `UI STATE APPLIED; RENDERER REACHED A FRAME CALLBACK — last confirmed marker ${lastPhase}.`
        : `UI STATE APPLIED; NO FRAME CALLBACK RETAINED — last confirmed marker ${lastPhase}.`;
    }
    const popupHistory = recentIncompletePopup
      ? `RETAINED INCOMPLETE POPUP — ${recentIncompletePopup.popupContextId} stopped after ${recentIncompletePopup.lastPhase}.`
      : 'No incomplete popup context appears in retained history.';

    let handshake;
    const ackEntry = findLast(latestPopup, (entry) => entry.message === 'popup.background_ack');
    const ackDetail = parseEntryDetail(ackEntry);
    const ackBootPrefix = String(ackDetail.workerBootId || '');
    const matchingBoot = ackBootPrefix
      ? boots.find((boot) => boot.bootId.startsWith(ackBootPrefix))
      : null;
    const receivedEntry = findLast(logs, (entry) => {
      if (entry.context !== 'background' || entry.message !== 'popup.open_received') return false;
      return parseEntryDetail(entry).popupContextId === latestPopupSession.popupContextId;
    });
    if (ackEntry) {
      const bootStatus = matchingBoot
        ? `${matchingBoot.ready ? 'ready' : 'not ready'} boot ${matchingBoot.bootId.slice(0, 12)}`
        : ackBootPrefix
          ? `boot ${ackBootPrefix} (not retained)`
          : `workerReady=${!!ackDetail.workerReady}`;
      const acknowledgementState = ackDetail.workerReady === false ? '; worker reported not ready at ACK time' : '';
      handshake = `ACKNOWLEDGED — the worker answered this popup context (${bootStatus}${acknowledgementState}).`;
    } else if (phases.has('popup.open_posted') || phases.has('popup.open_sent')) {
      handshake = receivedEntry
        ? 'WORKER RECEIVED OPEN, NO POPUP ACK — the worker recorded the message, but acknowledgement was not persisted by this popup.'
        : 'MESSAGE POSTED/QUEUED, NOT CONFIRMED RECEIVED — no matching worker receipt or popup acknowledgement was persisted.';
    } else if (phases.has('popup.port_connected')) {
      handshake = 'PORT CREATED, OPEN MESSAGE NOT CONFIRMED.';
    } else {
      handshake = 'NOT REACHED — no worker connection marker was persisted.';
    }
    return { worker, workerHistory, popup, popupHistory, handshake };
  }

  async function getDiagnosticSnapshot() {
    const pageEntries = readPageEntries();
    const pageStorageOk = pageStorageAvailable && !lastPageReadError;
    const storageResult = await settleWithTimeout(readChromeStorage(), 1500, 'chrome.storage.local.get');
    const data = storageResult.ok && storageResult.value ? storageResult.value : {};
    // Diagnose against both bounded backends before trimming the general event
    // timeline. Otherwise later worker noise can hide a retained popup failure.
    const diagnosticLogs = mergeAndSortEntries(extractChromeEntries(data), pageEntries);
    const logs = diagnosticLogs.slice(-MAX_ENTRIES);
    const boots = groupBootRecords(data);
    const manifest = chrome.runtime.getManifest();
    const manifestPopup = getManifestPopup();
    const [proxyResult, actionResult] = await Promise.all([
      settleWithTimeout(getProxySnapshot(), 1200, 'chrome.proxy.settings.get'),
      // The inner action calls have independent timeouts so one hung API does not
      // discard the other result. This outer guard is only a final safety net.
      settleWithTimeout(getActionSnapshot(manifestPopup), 1500, 'chrome.action snapshot'),
    ]);
    const proxy = proxyResult.ok
      ? proxyResult.value
      : { mode: 'unavailable', levelOfControl: 'unavailable', error: proxyResult.error };
    const action = actionResult.ok
      ? actionResult.value
      : { manifestPopup, effectivePopup: 'unavailable', enabled: 'unavailable', error: actionResult.error };
    const popupSessions = groupPopupSessions(diagnosticLogs);
    const latestPopup = popupSessions.length ? popupSessions[popupSessions.length - 1].entries : [];
    const diagnosis = buildDiagnosis(boots, popupSessions, diagnosticLogs, {
      chromeStorage: storageResult.ok,
      pageStorage: pageStorageOk,
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      extension: {
        version: manifest.version,
        manifestVersion: manifest.manifest_version,
      },
      environment: {
        userAgent: typeof navigator !== 'undefined' ? sanitize(navigator.userAgent, 500) : 'unavailable',
        platform: typeof navigator !== 'undefined' ? sanitize(navigator.platform || '', 120) : 'unavailable',
        language: typeof navigator !== 'undefined' ? sanitize(navigator.language || '', 40) : 'unavailable',
      },
      recorder: {
        verbose: verboseEnabled,
        entryCount: logs.length,
        bootCount: boots.length,
        pageBackend: pageStorageAvailable ? 'localStorage' : 'unavailable',
        pageReadError: lastPageReadError || '',
        workerBackend: 'chrome.storage.local',
        workerReadError: storageResult.ok ? '' : storageResult.error,
      },
      proxy,
      action,
      diagnosis,
      config: {
        available: storageResult.ok,
        serverCount: Array.isArray(data.serverList) ? data.serverList.length : 0,
        activeServerPresent: !!data.activeServerId,
        userRulesCount: Array.isArray(data.userRules) ? data.userRules.length : 0,
        whitelistCount: Array.isArray(data.userWhitelist) ? data.userWhitelist.length : 0,
        tempRulesCount: Array.isArray(data.tempRules) ? data.tempRules.length : 0,
        gfwDomainsCount: Array.isArray(data.gfwDomains) ? data.gfwDomains.length : 0,
        pacPresent: typeof data.pacScriptData === 'string' && data.pacScriptData.length > 0,
        pacByteLength: typeof data.pacScriptData === 'string' ? data.pacScriptData.length : 0,
        pacHashPresent: !!data.pacHash,
      },
      latestPopup,
      boots,
      logs,
    };
  }

  function formatDiagnosticReport(snapshot) {
    const lines = [
      `ProxySwitch Fault Black Box (schema ${snapshot.schemaVersion})`,
      `Generated: ${snapshot.generatedAt}`,
      'Coverage: extension-side evidence starts only after the relevant JavaScript context executes. A missing first marker requires chrome://extensions or browser-level tracing. Page markers use local Web Storage and may be removed when browsing data is cleared.',
      '',
      '=== Immediate Diagnosis ===',
      `Worker: ${snapshot.diagnosis.worker}`,
      `Worker history: ${snapshot.diagnosis.workerHistory}`,
      `Popup: ${snapshot.diagnosis.popup}`,
      `Popup history: ${snapshot.diagnosis.popupHistory}`,
      `Handshake: ${snapshot.diagnosis.handshake}`,
      '',
      '=== Environment ===',
      `Extension: ${snapshot.extension.version} (Manifest V${snapshot.extension.manifestVersion})`,
      `Browser: ${snapshot.environment.userAgent}`,
      `Platform: ${snapshot.environment.platform}  Language: ${snapshot.environment.language}`,
      `Recorder: verbose=${snapshot.recorder.verbose} entries=${snapshot.recorder.entryCount} boots=${snapshot.recorder.bootCount} page=${snapshot.recorder.pageReadError || snapshot.recorder.pageBackend} worker=${snapshot.recorder.workerReadError || snapshot.recorder.workerBackend}`,
      '',
      '=== Action / Proxy ===',
      `Popup: manifest=${snapshot.action.manifestPopup || 'none'} effective=${snapshot.action.effectivePopup || 'none'} enabled=${String(snapshot.action.enabled ?? 'unavailable')}${snapshot.action.error ? ` error=${snapshot.action.error}` : ''}`,
      `Proxy: mode=${snapshot.proxy.mode || 'unknown'} control=${snapshot.proxy.levelOfControl || 'unknown'}${snapshot.proxy.error ? ` error=${snapshot.proxy.error}` : ''}`,
      snapshot.config.available
        ? `Config: servers=${snapshot.config.serverCount} active=${snapshot.config.activeServerPresent} userRules=${snapshot.config.userRulesCount} whitelist=${snapshot.config.whitelistCount} tempRules=${snapshot.config.tempRulesCount} gfw=${snapshot.config.gfwDomainsCount}`
        : 'Config: unavailable because chrome.storage.local could not be read.',
      `PAC: present=${snapshot.config.pacPresent} bytes=${snapshot.config.pacByteLength} hashPresent=${snapshot.config.pacHashPresent}`,
      '',
      '=== Worker Boot Journal ===',
      formatBootRecords(snapshot.boots),
      '',
      '=== Latest Popup Timeline ===',
      snapshot.latestPopup.length ? formatLogs(snapshot.latestPopup) : 'No popup-side marker was persisted.',
      '',
      '=== Event Timeline ===',
      formatLogs(snapshot.logs) || 'No event entry was persisted.',
    ];
    return lines.join('\n');
  }

  async function getDiagnosticReport() {
    return formatDiagnosticReport(await getDiagnosticSnapshot());
  }

  function isDiagnosticStorageChange(changes) {
    return Object.keys(changes || {}).some((key) =>
      key === LEGACY_STORAGE_KEY ||
      key === VERBOSE_KEY ||
      key === CHROME_CLEAR_BEFORE_KEY ||
      key === CHROME_GENERATION_KEY ||
      key.startsWith(LOG_PREFIX) ||
      key.startsWith(BOOT_PREFIX)
    );
  }

  function isDiagnosticPageStorageKey(key) {
    return !!key && (key === PAGE_CLEAR_BEFORE_KEY || key === PAGE_GENERATION_KEY || key.startsWith(LOG_PREFIX));
  }

  return {
    error(source, message, detail) {
      return emit('error', source, message, detail, true);
    },
    warn(source, message, detail) {
      return emit('warn', source, message, detail, true);
    },
    info(source, message, detail) {
      return emit('info', source, message, detail, true);
    },
    checkpoint(source, code, detail) {
      return emit('checkpoint', source, code, detail, true);
    },
    async perf(source, name, startMs, detail, warnThresholdMs) {
      const durationMs = Date.now() - (startMs || Date.now());
      const message = `${name} ${durationMs}ms`;
      if (typeof warnThresholdMs === 'number' && durationMs >= warnThresholdMs) {
        return emit('warn', source, message, detail, true);
      }
      await verboseReady;
      return emit('info', source, message, detail, verboseEnabled);
    },
    getLogs,
    getBootRecords,
    clearLogs,
    clearPageDiagnostics,
    flush,
    prune,
    formatLogs,
    getDiagnosticSnapshot,
    formatDiagnosticReport,
    getDiagnosticReport,
    isDiagnosticStorageChange,
    isDiagnosticPageStorageKey,
    getContextId() {
      return contextId;
    },
    setBootId(value) {
      bootId = sanitize(value, 80);
    },
    async setVerbose(enabled) {
      verboseEnabled = !!enabled;
      await chrome.storage.local.set({ [VERBOSE_KEY]: verboseEnabled });
    },
    async getVerbose() {
      await verboseReady;
      return verboseEnabled;
    },
  };
})();
