// The single mutation lease shared by UI edits, cloud restore and restore undo.
(function (root) {
  'use strict';
  const RULE_KEYS = ['userRules', 'userWhitelist', 'tempRules', 'gfwDomains'];
  const STRING_LIMITS = { activeServerId: 128, gfwlistUrl: 4096, gitToken: 4096,
    davUrl: 4096, davUser: 1024, davPass: 4096, lastUpdate: 200 };
  const KEYS = Object.freeze([...RULE_KEYS, 'serverList', ...Object.keys(STRING_LIMITS),
    'autoSync', 'syncProvider', 'theme', 'appLanguage', 'ruleCount']);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]';
  function fail(code, field) {
    const error = Object.assign(new Error(code), { code });
    if (field) error.field = field;
    throw error;
  }
  function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_) { fail('invalid_configuration'); }
  }
  function equal(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => own(right, key) && equal(left[key], right[key]));
  }
  function create({ chrome, configuration, readTimeout = 8000 }) {
    let tail = Promise.resolve();
    function run(fn) {
      if (typeof fn !== 'function') return Promise.reject(Object.assign(new Error('invalid_configuration'), { code: 'invalid_configuration' }));
      const result = tail.then(fn);
      // A pending write keeps this promise pending. Never release its lease based on elapsed time.
      tail = result.catch(() => {});
      return result;
    }
    function call(method, argument) {
      return new Promise((resolve, reject) => {
        let finished = false;
        let timer = null;
        const finish = (error, value) => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          error ? reject(error) : resolve(value);
        };
        if (method === 'get') timer = setTimeout(() => finish(Object.assign(new Error('storage_timeout'), { code: 'storage_timeout' })), readTimeout);
        try {
          chrome.storage.local[method](argument, value => finish(chrome.runtime.lastError ?
            Object.assign(new Error('storage_failed'), { code: 'storage_failed' }) : null, value));
        } catch (_) { finish(Object.assign(new Error('storage_failed'), { code: 'storage_failed' })); }
      });
    }
    function validate(items) {
      if (!object(items) || !Object.keys(items).length || Object.keys(items).some(key => !KEYS.includes(key))) fail('invalid_configuration');
      const clean = {};
      for (const [key, value] of Object.entries(items)) {
        if (RULE_KEYS.includes(key)) {
          clean[key] = configuration.validateRules(value, { allowWildcards: key === 'userRules' || key === 'tempRules' });
        } else if (key === 'serverList') {
          if (!Array.isArray(value) || value.length > 1000) fail('invalid_server', key);
          clean[key] = value.map(configuration.validateServer);
          if (new Set(clean[key].map(server => server.id)).size !== clean[key].length) fail('invalid_server', key);
        } else if (own(STRING_LIMITS, key)) {
          if (typeof value !== 'string' || value.length > STRING_LIMITS[key]) fail('invalid_configuration', key);
          if (key === 'activeServerId' && value && !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) fail('invalid_configuration', key);
          // A partially typed subscription URL may be saved locally; backup upload validates it strictly.
          clean[key] = value;
        } else if (key === 'autoSync') {
          if (typeof value !== 'boolean') fail('invalid_configuration', key);
          clean[key] = value;
        } else if (key === 'ruleCount') {
          if (!Number.isInteger(value) || value < 0 || value > 100000) fail('invalid_configuration', key);
          clean[key] = value;
        } else {
          const choices = key === 'syncProvider' ? ['github', 'webdav'] :
            key === 'theme' ? ['system', 'light', 'dark'] : ['auto', 'zh_CN', 'en', 'ru', 'es'];
          if (!choices.includes(value)) fail('invalid_configuration', key);
          clean[key] = value;
        }
      }
      return clean;
    }
    function validateExpected(expected, items) {
      if (!object(expected) || Object.keys(expected).some(key => !KEYS.includes(key)) ||
          Object.keys(items).some(key => !own(expected, key))) fail('invalid_configuration');
      const clean = {};
      for (const [key, descriptor] of Object.entries(expected)) {
        if (!object(descriptor) || typeof descriptor.exists !== 'boolean' ||
            Object.keys(descriptor).some(field => !['exists', 'value'].includes(field)) ||
            descriptor.exists && (!own(descriptor, 'value') || descriptor.value === undefined)) fail('invalid_configuration', key);
        clean[key] = descriptor.exists ? { exists: true, value: clone(descriptor.value) } : { exists: false };
      }
      return clean;
    }
    function save(items, expected) {
      let clean; let baseline;
      try { clean = validate(items); baseline = validateExpected(expected, clean); }
      catch (error) { return Promise.reject(error); }
      return run(async () => {
        const fields = [...new Set([...Object.keys(baseline),
          ...(own(clean, 'serverList') || own(clean, 'activeServerId') ? ['serverList', 'activeServerId'] : [])])];
        const current = await call('get', fields);
        if (!object(current)) fail('storage_failed');
        for (const [key, descriptor] of Object.entries(baseline)) {
          if (own(current, key) !== descriptor.exists || descriptor.exists && !equal(current[key], descriptor.value)) fail('config_changed', key);
        }
        if (own(clean, 'serverList') || own(clean, 'activeServerId')) {
          const servers = own(clean, 'serverList') ? clean.serverList : current.serverList;
          const activeId = own(clean, 'activeServerId') ? clean.activeServerId : current.activeServerId;
          if (!Array.isArray(servers) || activeId && !servers.some(server => server && server.id === activeId)) fail('invalid_configuration', 'activeServerId');
        }
        if (own(clean, 'gfwDomains') && own(clean, 'ruleCount') && clean.gfwDomains.length !== clean.ruleCount) fail('invalid_configuration', 'ruleCount');
        await call('set', clean);
        return clean;
      });
    }
    return { run, save };
  }
  const api = { create, KEYS };
  root.ProxySwitchConfigurationStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
