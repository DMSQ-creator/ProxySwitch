'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const routing = require('../js/routing');
const server = { host: '127.0.0.1', port: 7897, scheme: 'HTTP' };
const config = { userRules: ['site.example', '*.proxy.example', 'cdn*.assets.example'], userWhitelist: ['direct.site.example'], gfwDomains: ['subscription.example'], tempRules: ['temp.example'] };
const prepared = routing.prepare(config);
function pacRoute(host, trial, now = Date.now()) {
  const context = vm.createContext({Date: {now: () => now}});
  vm.runInContext(routing.buildPac(server, prepared, trial), context);
  return context.FindProxyForURL('https://' + host + '/', host);
}
for (const [host,route,source] of [
  ['site.example','proxy','user'], ['sub.site.example','proxy','user'], ['direct.site.example','direct','whitelist'],
  ['proxy.example','proxy','user'], ['x.proxy.example','proxy','user'], ['cdn2.assets.example','proxy','user'],
  ['cdn.assets.example','proxy','user'], ['temp.example','proxy','temporary'], ['subscription.example','proxy','subscription'],
  ['challenges.cloudflare.com','direct','default'], ['other.example','direct','default'], ['constructor.example','direct','default'],
  ['10.20.30.40','direct','local'], ['172.16.2.3','direct','local'], ['192.168.4.5','direct','local'],
  ['printer.local','direct','local'], ['localhost','direct','local'], ['[::1]','direct','local'],
]) {
  test(`PAC and diagnostics agree: ${host}`,()=>{
    const result=routing.evaluate(host,prepared,{});
    assert.equal(result.route,route);assert.equal(result.source,source);
    assert.equal(pacRoute(host),route==='proxy'?'PROXY 127.0.0.1:7897; DIRECT':'DIRECT');
  });
}
test('trial is global to selected hostname suffix and enforces expiry inside PAC',()=>{
  const trial={hosts:['challenges.cloudflare.com'],direction:'proxy',expiresAt:2000};
  assert.match(pacRoute('challenges.cloudflare.com',trial,1999),/^PROXY/);
  assert.match(pacRoute('sub.challenges.cloudflare.com',trial,1999),/^PROXY/);
  assert.equal(pacRoute('cloudflare.com',trial,1999),'DIRECT');
  assert.equal(pacRoute('challenges.cloudflare.com',trial,2000),'DIRECT');
  assert.equal(routing.evaluate('challenges.cloudflare.com',prepared,{trial,now:2000}).route,'direct');
});
test('trial never overrides existing whitelist or private-network bypass',()=>{
  const trial={hosts:['site.example','10.20.30.40'],direction:'proxy',expiresAt:2000};
  assert.equal(pacRoute('direct.site.example',trial,1999),'DIRECT');
  assert.equal(pacRoute('10.20.30.40',trial,1999),'DIRECT');
});
test('direct trial overrides subscription and expiry restores it',()=>{
  const trial={hosts:['subscription.example'],direction:'direct',expiresAt:2000};
  assert.equal(pacRoute('subscription.example',trial,1999),'DIRECT');
  assert.match(pacRoute('subscription.example',trial,2000),/^PROXY/);
});
test('new explicit proxy rules take priority over a direct trial',()=>{
  const trial={hosts:['site.example','proxy.example'],direction:'direct',expiresAt:2000};
  assert.match(pacRoute('sub.site.example',trial,1999),/^PROXY/);
  assert.match(pacRoute('x.proxy.example',trial,1999),/^PROXY/);
});
test('manual conflict covers both parent and child scopes',()=>{
  assert.equal(routing.conflict('site.example',prepared,'proxy'),true);
  assert.equal(routing.conflict('a.direct.site.example',prepared,'proxy'),true);
  assert.equal(routing.conflict('assets.example',prepared,'direct'),true);
  assert.equal(routing.conflict('a.proxy.example',prepared,'direct'),true);
  assert.equal(routing.conflict('example',prepared,'direct'),true);
  assert.equal(routing.conflict('subscription.example',prepared,'direct'),false);
  assert.equal(routing.conflict('cloudflare.com',prepared,'proxy'),false);
});
test('actual modes are distinguished and no false PAC claim in system mode',()=>{
  for(const [mode,expected] of [['direct','direct'],['fixed_servers','proxy'],['system','system'],['other','unknown']])assert.equal(routing.evaluate('site.example',prepared,{mode}).route,expected);
});
test('trial domain input is strict and IDN-safe',()=>{
  for(const input of ['example.com/x','https://example.com','example.com:443','*.example.com','localhost','127.0.0.1','user@example.com','example.com?token=secret','example.com.'])assert.equal(routing.hostname(input),null,input);
  assert.equal(routing.hostname('CHALLENGES.cloudflare.com'),'challenges.cloudflare.com');
  assert.equal(routing.hostname('中文.com'),'xn--fiq228c.com');
});
test('malformed server cannot inject code into generated PAC',()=>{
  const context=vm.createContext({});
  vm.runInContext(routing.buildPac({host:'127.0.0.1";throw Error("bad");',port:7897,scheme:'HTTP'},prepared,null),context);
  assert.equal(context.FindProxyForURL('', 'site.example'),'PROXY 127.0.0.1:7897; DIRECT');
});
test('normalization does not broaden existing leading-dot rules',()=>{
  const rules=routing.prepare({userRules:[' .hidden.example ','*.中文.com'],userWhitelist:['direct.example']});
  assert.equal(routing.evaluate('hidden.example',rules).route,'direct');
  assert.equal(routing.evaluate('xn--fiq228c.com',rules).route,'proxy');
});
