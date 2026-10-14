// Optional cloud backup. All restores are validated, previewed and locally undoable.
(function (root) {
  'use strict';
  const CORE = ['userRules', 'userWhitelist', 'serverList', 'activeServerId', 'gfwlistUrl'];
  const DIRTY = 'cloudSyncPending';
  const PREVIEW = 'cloudRestorePreview';
  const UNDO = 'cloudRestoreUndo';
  const ALARM = 'proxyswitch-cloud-sync';
  const PREVIEW_ALARM = 'proxyswitch-cloud-preview';
  const FILE = 'proxyswitch_config.json';
  const PREVIEW_MS = 5 * 60000;
  const MAX_BYTES = 1024 * 1024;
  function create({ chrome, configuration, fetch: fetcher, refresh = async () => {}, mutateConfiguration = fn => fn(), now = Date.now,
    uuid = () => crypto.randomUUID(), report = () => {}, networkTimeout = 20000 }) {
    let queue = Promise.resolve();
    let active = false;
    let restoring = null;
    let revision = null;
    let autoTimer = null;
    let previewTimer = null;
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const signature = data => JSON.stringify(CORE.map(key => [key, data[key] === undefined ? null : data[key]]));
    function call(name, argument) {
      return new Promise((resolve, reject) => {
        let finished = false;
        // A write whose callback is late may still commit. Keep it serialized;
        // only reads can safely time out and allow another operation to start.
        const timer = name === 'get' ? setTimeout(() => finish(Object.assign(new Error('storage_timeout'), { code: 'storage_timeout' })), 8000) : null;
        function finish(error, value) {
          if (finished) return;
          finished = true; if (timer) clearTimeout(timer);
          error ? reject(error) : resolve(value);
        }
        try { chrome.storage.local[name](argument, value => finish(chrome.runtime.lastError ?
          Object.assign(new Error('storage_failed'), { code: 'storage_failed' }) : null, value)); }
        catch (_) { finish(Object.assign(new Error('storage_failed'), { code: 'storage_failed' })); }
      });
    }
    const read = keys => call('get', keys);
    const write = value => call('set', value);
    const remove = keys => call('remove', keys);
    function serialize(fn) {
      const result = queue.then(async () => { active = true; try { return await fn(); } finally { active = false; } });
      queue = result.catch(() => {});
      return result;
    }
    async function network(fn) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), networkTimeout);
      try { return await fn(controller.signal); }
      catch (error) {
        if (controller.signal.aborted) fail('network_timeout');
        throw error;
      } finally { clearTimeout(timer); }
    }
    async function request(url, options, signal) {
      const response = await fetcher(url, { ...options, signal, cache: 'no-store', redirect: 'error' });
      if (!response.ok) fail('http_' + response.status);
      return response;
    }
    async function json(response) {
      const size = Number(response.headers && response.headers.get('content-length'));
      if (size > MAX_BYTES) fail('backup_too_large');
      const text = await response.text();
      if (text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) fail('backup_too_large');
      try { return JSON.parse(text); } catch (_) { fail('invalid_backup'); }
    }
    function githubOptions(token, method = 'GET', body) {
      if (!token) fail('missing_credentials');
      return { method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) };
    }
    async function findGist(token, signal) {
      for (let page = 1; page <= 10; page++) {
        const list = await json(await request('https://api.github.com/gists?per_page=100&page=' + page,
          githubOptions(token), signal));
        if (!Array.isArray(list)) fail('invalid_service_response');
        const found = list.find(gist => gist.files && gist.files[FILE]);
        if (found) {
          if (found.public) fail('public_gist');
          return found;
        }
        if (list.length < 100) return null;
      }
      fail('gist_search_limit');
    }
    function dav(config) {
      let url;
      try { url = new URL(config.davUrl); } catch (_) { fail('invalid_backup_url'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('invalid_backup_url');
      // Local HTTP servers remain supported. Remote credentials must use TLS.
      if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail('insecure_backup_url');
      let auth;
      try { auth = 'Basic ' + btoa(config.davUser + ':' + config.davPass); } catch (_) { fail('invalid_credentials'); }
      return { base: url.href.replace(/\/$/, '') + '/ProxySwitch/', headers: { Authorization: auth } };
    }
    async function uploadNetwork(config, backup, signal) {
      const content = JSON.stringify(backup, null, 2);
      if (new TextEncoder().encode(content).length > MAX_BYTES) fail('backup_too_large');
      if (config.syncProvider === 'webdav') {
        const target = dav(config);
        const folder = await fetcher(target.base, { method: 'MKCOL', headers: target.headers, signal, redirect: 'error' });
        if (!folder.ok && ![403, 405, 501].includes(folder.status)) fail('http_' + folder.status);
        await request(target.base + FILE, { method: 'PUT', headers: { ...target.headers,
          'Content-Type': 'application/json' }, body: content }, signal);
      } else {
        const gist = await findGist(config.gitToken, signal);
        if (gist && !/^[a-f0-9]+$/i.test(gist.id || '')) fail('invalid_service_response');
        const body = { description: 'ProxySwitch Configuration Backup', public: false, files: { [FILE]: { content } } };
        await request('https://api.github.com/gists' + (gist ? '/' + gist.id : ''),
          githubOptions(config.gitToken, gist ? 'PATCH' : 'POST', body), signal);
      }
    }
    async function downloadNetwork(config, signal) {
      if (config.syncProvider === 'webdav') {
        const target = dav(config);
        return json(await request(target.base + FILE, { headers: target.headers }, signal));
      }
      const gist = await findGist(config.gitToken, signal);
      if (!gist) fail('backup_not_found');
      const raw = gist.files[FILE].raw_url;
      let url;
      try { url = new URL(raw); } catch (_) { fail('invalid_service_response'); }
      if (url.protocol !== 'https:' || url.hostname !== 'gist.githubusercontent.com') fail('invalid_service_response');
      return json(await request(url.href, {}, signal));
    }
    function scheduleAuto() {
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = setTimeout(() => { autoTimer = null; flushAuto().catch(report); }, 10000);
      if (chrome.alarms) chrome.alarms.create(ALARM, { when: now() + 60000 });
    }
    async function changed(changes) {
      const relevant = CORE.filter(key => changes[key]);
      if (changes.autoSync && changes.autoSync.newValue) {
        const settings = await read([DIRTY]);
        if (settings[DIRTY]) scheduleAuto();
      }
      if (!relevant.length) return;
      // Ignore only the exact writes belonging to a restore, never concurrent user edits.
      if (restoring && relevant.every(key => Object.prototype.hasOwnProperty.call(restoring, key) &&
        same(changes[key].newValue, restoring[key]))) return;
      revision = uuid();
      const marker = revision;
      await write({ [DIRTY]: { revision: marker, changedAt: now() } });
      const settings = await read(['autoSync']);
      if (settings.autoSync) scheduleAuto();
    }
    async function upload() {
      const config = await read(null);
      const startRevision = revision;
      const marker = config[DIRTY];
      const backup = { ...configuration.validateBackup({ backupVer: 5,
        userRules: config.userRules || [], userWhitelist: config.userWhitelist || [], serverList: config.serverList || [],
        activeServerId: config.activeServerId || '', gfwlistUrl: config.gfwlistUrl || '' }),
        backupVer: 5, updatedAt: new Date(now()).toISOString() };
      await network(signal => uploadNetwork(config, backup, signal));
      const latest = await read([DIRTY]);
      if (revision === startRevision && same(latest[DIRTY], marker)) await remove([DIRTY]);
      else if ((await read(['autoSync'])).autoSync) scheduleAuto();
      const time = new Date(now()).toLocaleString();
      await write({ lastSyncTime: time });
      return time;
    }
    async function flushAuto() {
      if (active) { scheduleAuto(); return; }
      const config = await read(['autoSync', DIRTY]);
      if (!config.autoSync || !config[DIRTY]) {
        if (chrome.alarms) chrome.alarms.clear(ALARM, () => {});
        return;
      }
      return serialize(async () => {
        // Recheck inside the queue: the user may have turned automatic sync off
        // while a preceding manual cloud operation was still running.
        const latest = await read(['autoSync', DIRTY]);
        if (!latest.autoSync || !latest[DIRTY]) return;
        return upload();
      }).catch(error => { scheduleAutoRetry(); throw error; });
    }
    function scheduleAutoRetry() {
      // Persisted dirty state survives worker suspension; retry slowly, not a network loop.
      if (chrome.alarms) chrome.alarms.create(ALARM, { when: now() + 5 * 60000 });
    }
    async function preview() {
      const local = await read(null);
      const config = configuration.validateBackup(await network(signal => downloadNetwork(local, signal)));
      if (!Object.keys(config).length) fail('invalid_backup');
      const latest = await read(CORE);
      if (signature(latest) !== signature(local)) fail('restore_modified');
      const previewId = uuid();
      await write({ [PREVIEW]: { id: previewId, expiresAt: now() + PREVIEW_MS, config,
        localSignature: signature(latest) } });
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        previewTimer = null;
        read([PREVIEW]).then(data => {
          if (data[PREVIEW] && data[PREVIEW].id === previewId && data[PREVIEW].expiresAt <= now()) return remove([PREVIEW]);
        }).catch(report);
      }, PREVIEW_MS);
      if (chrome.alarms) chrome.alarms.create(PREVIEW_ALARM, { when: now() + PREVIEW_MS });
      return { previewId, summary: configuration.summarizeBackup(config, latest) };
    }
    async function apply(previewId) {
      const local = await read(null);
      const saved = local[PREVIEW];
      if (!saved || saved.id !== previewId || saved.expiresAt <= now()) fail('preview_expired');
      if (signature(local) !== saved.localSignature) fail('restore_modified');
      const config = configuration.validateBackup({ ...saved.config, backupVer: 5 });
      const before = {};
      Object.keys(config).forEach(key => {
        before[key] = local[key] === undefined ? (['userRules', 'userWhitelist', 'serverList'].includes(key) ? [] : '') : local[key];
      });
      const after = { ...local, ...config };
      const undo = { before, afterSignature: signature(after), createdAt: now() };
      restoring = config;
      try {
        // One atomic storage write retains the original configuration before replacing it.
        await write({ ...config, [UNDO]: undo });
        await remove([PREVIEW]).catch(report);
        const time = new Date(now()).toLocaleString();
        await write({ lastSyncTime: time }).catch(report);
        let applyPending = false;
        try { await refresh(); } catch (_) { applyPending = true; }
        return { time, applyPending };
      } finally { restoring = null; }
    }
    async function undo() {
      const local = await read(null);
      const saved = local[UNDO];
      if (!saved || !saved.before) fail('undo_unavailable');
      if (signature(local) !== saved.afterSignature) fail('restore_modified');
      const before = Object.fromEntries(Object.entries(saved.before).filter(([key]) => CORE.includes(key)));
      restoring = before;
      try {
        await write(before);
        await remove([UNDO]).catch(report);
        let applyPending = false;
        try { await refresh(); } catch (_) { applyPending = true; }
        return { applyPending };
      } finally { restoring = null; }
    }
    if (chrome.alarms && chrome.alarms.onAlarm) chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === ALARM) flushAuto().catch(report);
      if (alarm.name === PREVIEW_ALARM) read([PREVIEW]).then(data => {
        if (data[PREVIEW] && data[PREVIEW].expiresAt <= now()) return remove([PREVIEW]);
      }).catch(report);
    });
    const ready = read([PREVIEW, 'autoSync', DIRTY]).then(async data => {
      if (data[PREVIEW] && data[PREVIEW].expiresAt <= now()) await remove([PREVIEW]);
      else if (data[PREVIEW] && chrome.alarms) chrome.alarms.create(PREVIEW_ALARM, { when: data[PREVIEW].expiresAt });
      if (data.autoSync && data[DIRTY]) scheduleAuto();
    }).catch(report);
    return { ready, changed, flushAuto, upload: () => serialize(upload), preview: () => serialize(preview),
      apply: id => serialize(() => mutateConfiguration(() => apply(id))),
      undo: () => serialize(() => mutateConfiguration(undo)),
      dispose() { if (autoTimer) clearTimeout(autoTimer); if (previewTimer) clearTimeout(previewTimer); } };
  }
  root.ProxySwitchCloudSync = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
