// Shared validation for untrusted imports and cloud configuration backups.
(function (root) {
  'use strict';
  const BACKUP_VERSION = 5;
  const BACKUP_FIELDS = ['userRules', 'userWhitelist', 'serverList', 'activeServerId', 'gfwlistUrl'];
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  function reject(code, field, index) {
    const error = new Error(code);
    error.code = code;
    if (field) error.field = field;
    if (Number.isInteger(index)) error.index = index;
    throw error;
  }
  function normalizeHost(value, code = 'invalid_server') {
    if (typeof value !== 'string' || !value.trim() || value.length > 253 || /[\s/@?#*\\]/.test(value.trim())) reject(code, 'host');
    let host = value.trim().toLowerCase();
    try {
      // Bracketed IPv6 is supported; an unbracketed colon must not become a port.
      if (host.includes(':') && !/^\[[0-9a-f:.]+\]$/.test(host)) reject(code, 'host');
      host = new URL('http://' + host).hostname.toLowerCase();
    } catch (_) { reject(code, 'host'); }
    if (/^\[[0-9a-f:.]+\]$/.test(host)) return host;
    if (!host || host.length > 253 || host.endsWith('.') || !host.split('.').every(label =>
      label.length > 0 && label.length <= 63 && /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/.test(label))) reject(code, 'host');
    return host;
  }
  function normalizeRule(value, allowWildcards) {
    if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\s/@#:\\[\]]/.test(value.trim())) reject('invalid_rules');
    let rule = value.trim().toLowerCase();
    const prefix = rule.startsWith('.') ? '.' : '';
    if (prefix) rule = rule.slice(1);
    const wildcard = /[*?]/.test(rule);
    if (wildcard && (!allowWildcards || !rule.includes('*'))) reject('invalid_rules');
    if (!wildcard) return prefix + normalizeHost(rule, 'invalid_rules');
    // Normalize IDN labels without letting a URL parser consume glob syntax.
    const labels = rule.split('.').map(label => {
      if (!label || label.length > 63) reject('invalid_rules');
      if (/[^\x00-\x7f]/.test(label)) {
        if (/[*?]/.test(label)) reject('invalid_rules');
        label = normalizeHost(label, 'invalid_rules');
      }
      if (!/^[a-z0-9_*?-]+$/.test(label) || label.startsWith('-') || label.endsWith('-')) reject('invalid_rules');
      return label;
    });
    rule = labels.join('.');
    if (rule.length > 253) reject('invalid_rules');
    return prefix + rule;
  }
  function validateRules(list, options = {}) {
    if (!Array.isArray(list) || list.length > 100000) reject('invalid_rules');
    const rules = list.map((value, index) => {
      try { return normalizeRule(value, options.allowWildcards !== false); }
      catch (_) { reject('invalid_rules', 'rules', index); }
    });
    return [...new Set(rules)];
  }
  function validateServer(server) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) reject('invalid_server');
    if (typeof server.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(server.id)) reject('invalid_server', 'id');
    if (typeof server.name !== 'string' || !server.name.trim() || server.name.length > 200 || /[\u0000-\u001f\u007f]/.test(server.name)) reject('invalid_server', 'name');
    if (typeof server.scheme !== 'string' || !['HTTP', 'HTTPS', 'SOCKS4', 'SOCKS5'].includes(server.scheme.toUpperCase())) reject('invalid_server', 'scheme');
    if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) reject('invalid_server', 'port');
    return { id: server.id, name: server.name.trim(), scheme: server.scheme.toUpperCase(), host: normalizeHost(server.host), port: server.port };
  }
  function validateBackup(remote) {
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) reject('invalid_backup');
    // Versions 1–5 accept the same recognized core fields.
    // Unknown fields are discarded, not migrated into local extension settings.
    if (!own(remote, 'backupVer') || !Number.isInteger(remote.backupVer) || remote.backupVer < 1 || remote.backupVer > BACKUP_VERSION) reject('unsupported_backup_version');
    const config = {};
    for (const field of BACKUP_FIELDS) {
      if (!own(remote, field)) continue;
      try {
        if (field === 'userRules' || field === 'userWhitelist') config[field] = validateRules(remote[field], { allowWildcards: field === 'userRules' });
        else if (field === 'serverList') {
          if (!Array.isArray(remote[field]) || remote[field].length > 1000) reject('invalid_backup', field);
          config[field] = remote[field].map(validateServer);
          if (new Set(config[field].map(server => server.id)).size !== config[field].length) reject('invalid_backup', field);
        } else if (field === 'activeServerId') {
          if (typeof remote[field] !== 'string' || (remote[field] && !/^[a-zA-Z0-9_-]{1,128}$/.test(remote[field]))) reject('invalid_backup', field);
          config[field] = remote[field];
        } else {
          if (typeof remote[field] !== 'string' || remote[field].length > 4096) reject('invalid_backup', field);
          if (remote[field]) {
            const parsed = new URL(remote[field]);
            if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) reject('invalid_backup', field);
            config[field] = parsed.href;
          } else config[field] = '';
        }
      } catch (error) {
        reject('invalid_backup', field, error && error.index);
      }
    }
    if (!Object.keys(config).length) reject('invalid_backup');
    if (own(config, 'serverList')) {
      if (config.activeServerId && !config.serverList.some(server => server.id === config.activeServerId)) reject('invalid_backup', 'activeServerId');
      if (!own(config, 'activeServerId')) config.activeServerId = config.serverList[0] ? config.serverList[0].id : '';
    }
    return config;
  }
  function summarizeBackup(config, local = {}) {
    return { fields: BACKUP_FIELDS.filter(field => own(config, field)).map(field => ({
      key: field,
      previousCount: Array.isArray(local[field]) ? local[field].length : null,
      count: Array.isArray(config[field]) ? config[field].length : null,
      clears: Array.isArray(config[field]) && config[field].length === 0,
    })) };
  }
  const api = { BACKUP_VERSION, BACKUP_FIELDS, validateBackup, validateRules, validateServer, summarizeBackup };
  root.ProxySwitchConfiguration = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
