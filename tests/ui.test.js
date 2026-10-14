'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SOURCE = fs.readFileSync(path.join(__dirname, '../js/ui.js'), 'utf8');
function harness({dark = false, legacy = false, noMedia = false} = {}) {
  const attributes = {}, style = {}, listeners = {};
  const media = {matches:dark};
  let onChange;
  media[legacy?'addListener':'addEventListener'] = (...args) => { onChange=args[args.length-1]; };
  const icons = [{innerHTML:'',getAttribute:()=> 'clock'}, {innerHTML:'',getAttribute:()=> 'constructor'}];
  const document = {readyState:'loading', documentElement:{style,setAttribute:(key,value)=>{attributes[key]=value;}},
    addEventListener:(name,fn)=>{listeners[name]=fn;},querySelectorAll:()=>icons};
  const context=vm.createContext({document,matchMedia:noMedia?undefined:()=>media});
  vm.runInContext(SOURCE, context);
  return {api:context.ProxySwitchUI,attributes,style,icons,listeners,change(dark){media.matches=dark;if(onChange)onChange({matches:dark});}};
}
test('system appearance resolves before page initialization and follows later OS changes',()=>{
  const ui=harness({dark:true});
  assert.equal(ui.attributes['data-theme'],'dark');assert.equal(ui.style.colorScheme,'dark');
  assert.equal(ui.attributes['data-theme-preference'],'system');
  ui.change(false);assert.equal(ui.attributes['data-theme'],'light');
  ui.change(true);assert.equal(ui.attributes['data-theme'],'dark');
});
test('explicit themes remain stable until the user returns to system appearance',()=>{
  const ui=harness();ui.api.applyTheme('light');ui.change(true);assert.equal(ui.attributes['data-theme'],'light');
  ui.api.applyTheme('system');assert.equal(ui.attributes['data-theme'],'dark');
  ui.api.applyTheme('dark');ui.change(false);assert.equal(ui.attributes['data-theme'],'dark');
  ui.api.applyTheme(undefined);assert.equal(ui.attributes['data-theme'],'light');
});
test('legacy media-query listener and unavailable media APIs degrade safely',()=>{
  const legacy=harness({legacy:true});legacy.change(true);assert.equal(legacy.attributes['data-theme'],'dark');
  const missing=harness({noMedia:true});assert.equal(missing.attributes['data-theme'],'light');
  missing.api.applyTheme('dark');assert.equal(missing.attributes['data-theme'],'dark');
});
test('icons are bundled accessible decoration with safe unknown-name fallback',()=>{
  const ui=harness();const clock=ui.api.icon('clock');assert.match(clock,/<svg/);assert.match(clock,/aria-hidden="true"/);assert.match(clock,/currentColor/);
  for(const name of ['constructor','__proto__','<script>alert(1)</script>']){const value=ui.api.icon(name);assert.doesNotMatch(value,/<script|onload|https?:/);assert.equal(value,ui.api.icon('info'));}
  ui.listeners.DOMContentLoaded();assert.equal(ui.icons[0].innerHTML,clock);assert.equal(ui.icons[1].innerHTML,ui.api.icon('info'));
  assert.doesNotThrow(()=>ui.api.setIcon(null,'clock'));
});
test('all common functional icons are available without external requests',()=>{
  const ui=harness();for(const key of ['grid','route','arrow-up-right','settings','list','globe','cloud','plus','pencil','trash','undo','download','upload','clock','copy','check','alert','chevron-right','chevron-down','search','refresh','external','moon','sun','monitor','close']) {
    assert.notEqual(ui.api.icon(key),ui.api.icon('info'),key);
  }
  assert.doesNotMatch(SOURCE,/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(|chrome\.(?:storage|proxy|permissions)/);
});
