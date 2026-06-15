// js/utils.js - ProxySwitch shared utilities

function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function matchDomain(domain, set) {
  if (!set || set.size === 0 || !domain) return false;

  const tryMatch = (d) => {
    if (set.has(d)) return true;
    if (set.has('.' + d)) return true;
    if (set.has('*.' + d)) return true;
    return false;
  };

  const cleanDomain = domain.replace(/^www\./, '');
  if (tryMatch(domain) || tryMatch(cleanDomain)) return true;

  let p = domain.indexOf('.');
  while (p !== -1) {
    if (tryMatch(domain.substring(p + 1))) return true;
    p = domain.indexOf('.', p + 1);
  }

  return false;
}
