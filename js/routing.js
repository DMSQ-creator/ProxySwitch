// Shared, deterministic routing for PAC generation and request diagnostics.
// Functions embedded into the PAC deliberately use ES5 syntax and no browser APIs.
(function (root) {
  'use strict';
  function normalizeRules(values) {
    if (!values || typeof values[Symbol.iterator] !== 'function' || typeof values === 'string') return [];
    return Array.from(new Set(Array.from(values).filter(value => typeof value === 'string').map(value => {
      let rule = value.trim().toLowerCase();
      let prefix = '';
      if (rule.indexOf('*.') === 0) { prefix = '*.'; rule = rule.slice(2); }
      else if (rule.indexOf('.') === 0) { prefix = '.'; rule = rule.slice(1); }
      if (/[^\x00-\x7f]/.test(rule)) {
        try { rule = new URL('http://' + rule).hostname; } catch (_) { return ''; }
      }
      return rule ? prefix + rule : '';
    }).filter(Boolean)));
  }
  function mapOf(values) {
    const map = Object.create(null);
    values.forEach(value => { map[value] = 1; });
    return map;
  }
  function prepare(config) {
    config = config || {};
    const userRules = normalizeRules(config.userRules);
    return {
      user: mapOf(userRules.filter(rule => rule.indexOf('*') < 0)),
      wildcard: userRules.filter(rule => rule.indexOf('*') >= 0),
      whitelist: mapOf(normalizeRules(config.userWhitelist)),
      subscription: mapOf(normalizeRules(config.gfwDomains)),
      temporary: mapOf(normalizeRules(config.tempRules)),
    };
  }
  function suffixRule(host, map) {
    if (!map) return '';
    var part = host;
    while (part) {
      if (Object.prototype.hasOwnProperty.call(map, part)) return part;
      var index = part.indexOf('.');
      if (index < 0) break;
      part = part.substring(index + 1);
    }
    return '';
  }
  function wildcardMatch(host, pattern) {
    var escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    var regex = new RegExp('^' + escaped + '$');
    return regex.test(host) || regex.test('.' + host);
  }
  function localHost(host) {
    if (host.indexOf('.') < 0 || /\.local$/.test(host)) return true;
    if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host)) return false;
    var octets = host.split('.').map(Number);
    if (octets.some(function (part) { return part > 255; })) return false;
    return octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168);
  }
  function suffixOf(host, domain) {
    return host === domain || host.slice(-(domain.length + 1)) === '.' + domain;
  }
  function activeTrial(trial, now) {
    return !!(trial && Array.isArray(trial.hosts) && trial.hosts.length &&
      (trial.direction === 'proxy' || trial.direction === 'direct') &&
      typeof trial.expiresAt === 'number' && trial.expiresAt > now);
  }
  function evaluate(host, rules, options) {
    options = options || {};
    var mode = options.mode || 'pac_script';
    var now = typeof options.now === 'number' ? options.now : Date.now();
    if (mode !== 'pac_script') {
      return { route: mode === 'fixed_servers' ? 'proxy' : mode === 'direct' ? 'direct' : mode === 'system' ? 'system' : 'unknown', source: 'mode', rule: mode };
    }
    host = String(host || '').toLowerCase();
    if (!host) return { route: 'unknown', source: 'default', rule: '' };
    if (localHost(host)) return { route: 'direct', source: 'local', rule: '' };
    var match = suffixRule(host, rules.whitelist);
    // Existing explicit direct rules retain their established priority.
    if (match) return { route: 'direct', source: 'whitelist', rule: match };
    for (var w = 0; w < rules.wildcard.length; w++) {
      if (wildcardMatch(host, rules.wildcard[w])) return { route: 'proxy', source: 'user', rule: rules.wildcard[w] };
    }
    match = suffixRule(host, rules.user);
    if (match) return { route: 'proxy', source: 'user', rule: match };
    // Explicit rules added during a trial also win, without relying on a timer.
    if (activeTrial(options.trial, now)) {
      for (var t = 0; t < options.trial.hosts.length; t++) {
        if (suffixOf(host, options.trial.hosts[t])) return { route: options.trial.direction, source: 'trial', rule: options.trial.hosts[t] };
      }
    }
    var sources = ['temporary', 'subscription'];
    for (var i = 0; i < sources.length; i++) {
      match = suffixRule(host, rules[sources[i]]);
      if (match) return { route: 'proxy', source: sources[i], rule: match };
    }
    return { route: 'direct', source: 'default', rule: '' };
  }
  function hostname(value) {
    if (typeof value !== 'string' || value.length > 253 || !value || /[\s/@?#:*\\\[\]]/.test(value)) return null;
    try {
      const parsed = new URL('https://' + value).hostname.toLowerCase();
      return parsed && parsed.indexOf('.') >= 0 && !localHost(parsed) && !parsed.endsWith('.') &&
        parsed.split('.').every(label => /^[a-z0-9_-]+$/.test(label) && label.length <= 63) ? parsed : null;
    } catch (_) { return null; }
  }
  function conflict(host, rules, direction) {
    // Saving a suffix rule must not silently override an explicit child rule either.
    const opposite = direction === 'proxy' ? rules.whitelist : rules.user;
    if (Object.keys(opposite).some(rule => suffixOf(host, rule) || suffixOf(rule, host))) return true;
    if (direction === 'direct') {
      return rules.wildcard.some(rule => {
        if (wildcardMatch(host, rule)) return true;
        const suffix = rule.substring(rule.lastIndexOf('*') + 1).replace(/^\./, '');
        return !suffix || suffixOf(suffix, host) || suffixOf(host, suffix);
      });
    }
    return false;
  }
  function safeTrial(trial) {
    if (!trial || !activeTrial(trial, 0)) return null;
    const hosts = Array.from(new Set(trial.hosts.map(hostname).filter(Boolean))).slice(0, 200);
    return hosts.length ? { hosts, direction: trial.direction, expiresAt: trial.expiresAt } : null;
  }
  function buildPac(server, rules, trial) {
    if (!server) return '';
    let host = String(server.host || '127.0.0.1').trim();
    if (/[^\x00-\x7f]/.test(host)) {
      try { host = new URL('http://' + host).hostname; } catch (_) { host = '127.0.0.1'; }
    }
    if (!/^[a-zA-Z0-9._:\[\]-]+$/.test(host)) host = '127.0.0.1';
    let port = parseInt(server.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) port = 1080;
    const scheme = String(server.scheme || 'SOCKS5').toUpperCase();
    const protocol = scheme === 'HTTP' || scheme === 'HTTPS' ? 'PROXY' : scheme === 'SOCKS4' ? 'SOCKS' : 'SOCKS5';
    const proxy = protocol + ' ' + host + ':' + port + '; DIRECT';
    return [
      'var psRules = ' + JSON.stringify(rules) + ';',
      'var psTrial = ' + JSON.stringify(safeTrial(trial)) + ';',
      'var Proxy = ' + JSON.stringify(proxy) + ';',
      suffixRule.toString(), wildcardMatch.toString(), localHost.toString(), suffixOf.toString(), activeTrial.toString(), evaluate.toString(),
      'function FindProxyForURL(url, host) { return evaluate(host, psRules, { trial: psTrial, now: Date.now() }).route === "proxy" ? Proxy : "DIRECT"; }',
    ].join('\n');
  }
  const api = { normalizeRules, prepare, evaluate, conflict, buildPac, hostname, localHost, activeTrial };
  root.ProxySwitchRouting = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
