// Experience regression checks in a disposable Chromium profile. All source
// traffic uses a loopback fixture; no real accounts, browser profiles or cloud
// services are touched. The production extension is copied, never rewritten.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PROXYSWITCH_PLAYWRIGHT || 'playwright');

const root = path.resolve(__dirname, '..');
const focusedVisualCheck = process.env.PROXYSWITCH_EXPERIENCE_FOCUS === '1';
const showcaseOnly = process.env.PROXYSWITCH_EXPERIENCE_SHOWCASE === '1';
const geometryOnly = process.env.PROXYSWITCH_EXPERIENCE_GEOMETRY === '1';
const inlineVisualCheck = process.env.PROXYSWITCH_EXPERIENCE_INLINE === '1';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyswitch-experience-'));
const extension = path.join(scratch, 'extension');
fs.mkdirSync(extension);
for (const folder of ['js', 'html', 'assets', '_locales']) {
  fs.cpSync(path.join(root, folder), path.join(extension, folder), { recursive: true });
}
fs.copyFileSync(path.join(root, 'manifest.json'), path.join(extension, 'manifest.json'));

const pendingImages = new Set();
let finishLoading = false;
const origin = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  if (url.pathname === '/pending.svg' && !finishLoading) {
    pendingImages.add(res);
    res.on('close', () => pendingImages.delete(res));
    return;
  }
  if (url.pathname === '/pending.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Experience fixture</title><p>Local experience fixture</p><img src="/pending.svg" alt="">');
});

async function until(fn, label) {
  for (let count = 0; count < 120; count++) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}
async function screenshot(page, name, popup = false) {
  if (popup) await page.locator('body').screenshot({ path: path.join(scratch, name + '.png'), animations: 'disabled', timeout: 10000 });
  else await page.screenshot({ path: path.join(scratch, name + '.png'), fullPage: true, animations: 'disabled', timeout: 10000 });
}
async function noEmoji(page, label) {
  const text = await page.locator('body').innerText();
  assert.ok(!/[\u{1f300}-\u{1faff}\u2600-\u26ff]/u.test(text), label + ': functional UI should use consistent line icons');
}
async function assertLayout(page, label) {
  const layout = await page.evaluate(() => {
    const width = window.innerWidth;
    const section = document.querySelector('.section.active') || document.body;
    const outside = [...section.querySelectorAll('button,input,select,textarea,h2')].filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width && rect.height && (rect.left < -1 || rect.right > width + 1);
    }).map(el => ({ id: el.id, tag: el.tagName, rect: el.getBoundingClientRect().toJSON() }));
    return { width, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, outside };
  });
  assert.ok(layout.documentWidth <= layout.width + 1 && layout.bodyWidth <= layout.width + 1, label + ': horizontal page overflow ' + JSON.stringify(layout));
  assert.deepEqual(layout.outside, [], label + ': clipped essential controls ' + JSON.stringify(layout.outside));
}
async function buttonContrasts(page, label) {
  const contrasts = await page.evaluate(() => {
    const channels = value => (value.match(/[\d.]+/g) || []).map(Number);
    const composite = (top, below) => {
      const alpha = top.length > 3 ? top[3] : 1;
      return top.slice(0, 3).map((value, index) => value * alpha + below[index] * (1 - alpha));
    };
    const background = el => {
      const value = channels(getComputedStyle(el).backgroundColor);
      if (value.length < 4 || value[3] === 1) return value.slice(0, 3);
      return composite(value, el.parentElement ? background(el.parentElement) : [255, 255, 255]);
    };
    const luminance = value => value.map(channel => {
      channel /= 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    return [...document.querySelectorAll('.btn-primary,.btn-add,.ps-diag-primary')].filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width && rect.height && !el.disabled;
    }).map(el => {
      const bg = background(el);
      const fg = composite(channels(getComputedStyle(el).color), bg);
      const light = [luminance(bg), luminance(fg)].sort((a, b) => b - a);
      return { id: el.id || el.dataset.action || el.className, ratio: (light[0] + 0.05) / (light[1] + 0.05) };
    });
  });
  for (const button of contrasts) assert.ok(button.ratio >= 4.5, label + ': low contrast ' + JSON.stringify(button));
  return contrasts;
}
async function popupDimensions(page, label) {
  const dimensions = await page.evaluate(() => ({
    width: document.body.scrollWidth, height: document.body.scrollHeight,
    visibleHeight: document.body.getBoundingClientRect().height,
    overflowY: getComputedStyle(document.body).overflowY,
  }));
  return { label, ...dimensions };
}
async function disclosure(page, buttonId, panelId, open) {
  const button = page.locator('#' + buttonId);
  if ((await button.getAttribute('aria-expanded')) !== String(open)) await button.click();
  await until(async () => (await button.getAttribute('aria-expanded')) === String(open) &&
    (await page.locator('#' + panelId).isVisible()) === open, buttonId + ' disclosure ' + open);
}
async function moreActions(page, open = true) {
  await disclosure(page, 'moreActionsBtn', 'moreActions', open);
}
async function compactPopup(page, language, scheme) {
  const label = language + ' ' + scheme;
  await moreActions(page, false);
  await disclosure(page, 'routingDetailsBtn', 'routingDetails', false);
  const host = await page.locator('#currentDomain').innerText();
  const hostOccurrences = (await page.locator('#app').innerText()).split(host).length - 1;
  assert.equal(hostOccurrences, 1, label + ': the ordinary first screen does not repeat the current host');
  assert.equal(await page.locator('#addRuleBtn').isVisible(), true, label + ': site proxy remains a primary action');
  assert.equal(await page.locator('#addWhitelistBtn').isVisible(), true, label + ': site direct remains a primary action');
  assert.equal(await page.locator('#addTempRuleBtn').isVisible(), false, label + ': secondary operations stay behind More');
  assert.equal(await page.locator('#manageRulesBtn').isVisible(), false, label + ': ordinary management stays behind More');
  assert.equal(await page.locator('#routingDetailsText').isVisible(), false, label + ': rule source is available on demand, not duplicated on the first screen');
  const oversizeIcons = await page.evaluate(() => [...document.querySelectorAll('#app .ui-icon,#app .ps-diag-icon')].map(el => {
    const rect = el.getBoundingClientRect();
    return { parent: el.parentElement.id || el.parentElement.className, width: rect.width, height: rect.height };
  }).filter(rect => rect.width > 24 || rect.height > 24));
  assert.deepEqual(oversizeIcons, [], label + ': shared line icons must not expand and cover controls');
  const footer = await page.locator('#diagnosticsEntry').boundingBox();
  const settings = await page.locator('#openSettings').boundingBox();
  assert.ok(footer && settings && Math.abs(footer.y - settings.y) <= 2, label + ': requests and settings share one footer row');
  assert.equal(await page.locator('#routingStatus').innerText(), await page.evaluate(() => i18n('popRouteExpectedDirect')), label + ': default route is labeled as rule-based, not an actual exit claim');
  await popupVisualStructure(page, label);
  return { label, visibleCharacters: (await page.locator('#app').innerText()).replace(/\s/g, '').length };
}
async function popupVisualStructure(page, label) {
  const layout = await page.evaluate(() => {
    const domain = document.querySelector('#currentDomain');
    const marker = document.querySelector('#statusIcon');
    const status = document.querySelector('#routingStatus');
    const information = document.querySelector('#routingDetailsBtn');
    const more = document.querySelector('#moreActionsBtn');
    const box = el => el.getBoundingClientRect().toJSON();
    return {
      domain: box(domain), marker: box(marker), information: box(information), more: box(more),
      headingChildren: [...domain.parentElement.children].map(el => el.id),
      domainCss: { whiteSpace: getComputedStyle(domain).whiteSpace, overflow: getComputedStyle(domain).overflow,
        textOverflow: getComputedStyle(domain).textOverflow, height: getComputedStyle(domain).lineHeight,
        clientWidth: domain.clientWidth, scrollWidth: domain.scrollWidth },
      status: { box: box(status), className: status.className, role: status.getAttribute('role'),
        live: status.getAttribute('aria-live'), atomic: status.getAttribute('aria-atomic'),
        clip: getComputedStyle(status).clip, position: getComputedStyle(status).position },
      describedBy: document.querySelector('#domainArea').getAttribute('aria-describedby'),
      domainTitle: domain.getAttribute('title'), domainText: domain.textContent,
      statusText: status.textContent, sourceText: document.querySelector('#routingDetailsText').textContent,
      heading: box(document.querySelector('#siteRulesLabel')),
      primary: ['#addRuleBtn', '#addWhitelistBtn'].map(selector => box(document.querySelector(selector))),
      domainNext: domain.nextElementSibling && domain.nextElementSibling.id,
      domainContainer: domain.parentElement.className,
      moreContainer: more.parentElement.className,
      panelRole: document.querySelector('#moreActions').getAttribute('role'),
      moreRole: more.getAttribute('role'),
      viewport: document.body.getBoundingClientRect().width,
    };
  });
  assert.equal(layout.domainNext, 'routingDetailsBtn', label + ': information follows the domain');
  assert.match(layout.domainContainer, /(?:^|\s)domain-heading(?:\s|$)/);
  assert.deepEqual(layout.headingChildren, ['statusIcon', 'currentDomain', 'routingDetailsBtn'],
    label + ': the complete route heading is icon, domain and information in one line');
  const centerY = box => box.y + box.height / 2;
  assert.ok(Math.abs(centerY(layout.marker) - centerY(layout.domain)) <= 1 &&
    Math.abs(centerY(layout.information) - centerY(layout.domain)) <= 1,
    label + ': route marker and information align with the domain baseline row');
  assert.ok(layout.marker.x + layout.marker.width <= layout.domain.x && layout.marker.width >= 15,
    label + ': the route icon remains complete before the domain');
  assert.equal(layout.domainCss.whiteSpace, 'nowrap', label + ': domain never becomes a second row');
  assert.equal(layout.domainCss.textOverflow, 'ellipsis', label + ': long domains shorten visually');
  assert.equal(layout.domainCss.overflow, 'hidden');
  assert.ok(Math.abs(layout.domain.height - parseFloat(layout.domainCss.height)) <= 1,
    label + ': domain occupies exactly one text line');
  assert.match(layout.status.className, /(?:^|\s)sr-only(?:\s|$)/);
  assert.equal(layout.status.role, 'status');
  assert.equal(layout.status.live, 'polite');
  assert.equal(layout.status.atomic, 'true');
  assert.equal(layout.describedBy, 'routingStatus');
  assert.equal(layout.status.position, 'absolute');
  assert.equal(layout.status.clip, 'rect(0px, 0px, 0px, 0px)');
  assert.ok(layout.status.box.width <= 1 && layout.status.box.height <= 1,
    label + ': route status is accessible without a visible status-label row');
  assert.ok(layout.domainTitle && layout.domainTitle.split('\n').includes(layout.domainText) &&
    layout.domainTitle.includes(layout.statusText) && layout.domainTitle.includes(layout.sourceText),
    label + ': full domain, route status and matching source remain in the domain tooltip');
  assert.ok(layout.information.x >= layout.domain.x + layout.domain.width - 1 &&
    layout.information.x + layout.information.width <= layout.viewport + 1, label + ': the complete information button remains alongside the domain');
  assert.ok(layout.information.y >= layout.domain.y - 8 &&
    layout.information.y <= layout.domain.y + layout.domain.height, label + ': information does not drift below the domain heading');
  assert.match(layout.moreContainer, /(?:^|\s)section-heading(?:\s|$)/, label + ': More belongs beside the site heading');
  assert.ok(layout.more.x > layout.heading.x + layout.heading.width && Math.abs(layout.more.y - layout.heading.y) <= 8,
    label + ': More is a quiet right-aligned heading action, not a centered extra row');
  assert.notEqual(layout.panelRole, 'menu', label + ': ordinary secondary buttons do not pretend to be an arrow-key menu');
  assert.notEqual(layout.moreRole, 'menuitem');
  assert.ok(Math.abs(layout.primary[0].height - layout.primary[1].height) <= 1,
    label + ': paired site actions stay the same height when one translation wraps ' + JSON.stringify(layout.primary));
  return layout;
}
async function secondaryActionAlignment(page, label) {
  const controls = await page.evaluate(() => [...document.querySelectorAll('#moreActions > button')].filter(el => {
    const box = el.getBoundingClientRect(); return box.width && box.height;
  }).map(el => {
    const box = el.getBoundingClientRect();
    const icon = el.querySelector('[data-icon]').getBoundingClientRect();
    const text = el.querySelector('span:last-child').getBoundingClientRect();
    const css = getComputedStyle(el);
    return { id: el.id, x: box.x, y: box.y, right: box.right, height: box.height,
      iconLeft: icon.x, textLeft: text.x, textAlign: css.textAlign, justify: css.justifyContent };
  }));
  assert.ok(controls.length >= 2, label + ': there are visible normal secondary actions');
  for (const control of controls) {
    assert.ok(Math.abs(control.x - controls[0].x) <= 1 && Math.abs(control.right - controls[0].right) <= 1,
      label + ': secondary controls share a full-width column ' + JSON.stringify(controls));
    assert.ok(Math.abs(control.iconLeft - controls[0].iconLeft) <= 1 && Math.abs(control.textLeft - controls[0].textLeft) <= 1,
      label + ': icons and captions have consistent left edges ' + JSON.stringify(controls));
    assert.equal(control.justify, 'flex-start', label + ': secondary captions align to the left');
  }
  for (let index = 1; index < controls.length; index++) assert.ok(controls[index].y >= controls[index - 1].y + controls[index - 1].height - 1,
    label + ': More expands as one vertical list, not a wrapped toolbar');
}
async function routeAppearance(page, expectedKey, expectedColor, label) {
  await until(async () => (await page.locator('#domainArea').getAttribute('data-icon-key')) === expectedKey,
    label + ': route color key ' + expectedKey);
  await page.mouse.move(0, 0);
  await page.locator('#routingDetailsBtn').evaluate(async information => {
    getComputedStyle(information).color;
    await Promise.all(information.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  const appearance = await page.evaluate(() => {
    const channels = value => (value.match(/[\d.]+/g) || []).map(Number);
    const composite = (top, below) => {
      const alpha = top.length > 3 ? top[3] : 1;
      return top.slice(0, 3).map((value, index) => value * alpha + below[index] * (1 - alpha));
    };
    const background = el => {
      const value = channels(getComputedStyle(el).backgroundColor);
      return value.length < 4 || value[3] === 1 ? value.slice(0, 3) :
        composite(value, el.parentElement ? background(el.parentElement) : [255, 255, 255]);
    };
    const luminance = rgb => rgb.map(value => {
      value /= 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const text = document.querySelector('#currentDomain');
    const status = document.querySelector('#routingStatus');
    const marker = document.querySelector('#statusIcon');
    const foreground = channels(getComputedStyle(text).color);
    const bg = background(text);
    const levels = [luminance(composite(foreground, bg)), luminance(bg)].sort((a, b) => b - a);
    const svg = marker.querySelector('svg');
    return { key: document.querySelector('#domainArea').getAttribute('data-icon-key'),
      iconColor: getComputedStyle(marker).color, svgColor: svg && getComputedStyle(svg).color,
      strokes: [...marker.querySelectorAll('svg,svg path,svg circle,svg rect,svg polyline,svg line')]
        .map(el => getComputedStyle(el).stroke).filter(value => value !== 'none'),
      textColor: getComputedStyle(text).color, background: bg,
      ratio: (levels[0] + 0.05) / (levels[1] + 0.05), text: text.innerText,
      statusText: status.textContent, informationColor: getComputedStyle(document.querySelector('#routingDetailsBtn')).color,
      neutralColor: getComputedStyle(document.querySelector('#modeLabel')).color,
      title: text.getAttribute('title'), source: document.querySelector('#routingDetailsText').textContent };
  });
  assert.equal(appearance.iconColor, expectedColor, label + ': the marker uses the exact toolbar palette');
  assert.equal(appearance.svgColor, expectedColor, label + ': the glyph inherits that exact marker color');
  assert.ok(appearance.strokes.length && appearance.strokes.every(color => color === expectedColor),
    label + ': SVG strokes match the toolbar route color ' + JSON.stringify(appearance));
  assert.ok(appearance.ratio >= 4.5, label + ': the colored domain retains readable text contrast ' + JSON.stringify(appearance));
  assert.equal(appearance.informationColor, appearance.neutralColor, label + ': information remains a quiet neutral control');
  const hue = value => {
    const rgb = (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min;
    if (!delta) return 0;
    return ((max === rgb[0] ? (rgb[1] - rgb[2]) / delta :
      max === rgb[1] ? (rgb[2] - rgb[0]) / delta + 2 : (rgb[0] - rgb[1]) / delta + 4) * 60 + 360) % 360;
  };
  const hueDistance = Math.abs(hue(appearance.iconColor) - hue(appearance.textColor));
  assert.ok(Math.min(hueDistance, 360 - hueDistance) <= 16,
    label + ': readable domain shade stays in the route marker color family ' + JSON.stringify(appearance));
  assert.ok(appearance.statusText.trim(), label + ': route status remains available to assistive technology');
  assert.ok(appearance.title && appearance.title.includes(appearance.text) && appearance.title.includes(appearance.statusText) &&
    appearance.title.includes(appearance.source), label + ': source and route details remain discoverable without status-label clutter');
  return { label, ...appearance };
}
async function routeColorMatrix(popup, worker, sourceTabId, language, scheme) {
  const host = await popup.locator('#currentDomain').innerText();
  const fixture = { userRules: [], userWhitelist: [], tempRules: [], gfwDomains: [], diagnosticTrial: null };
  const trial = direction => ({ id: 'experience-' + direction, sessionId: 'experience-visual', tabId: sourceTabId,
    hosts: [host], direction, expiresAt: Date.now() + 60000 });
  const cases = [
    { label: 'default', key: 'pac_gray', color: 'rgb(148, 163, 184)', sourceKey: 'popStatusDirect', patch: {} },
    { label: 'subscription', key: 'pac_green', color: 'rgb(16, 185, 129)', sourceKey: 'popStatusGfw', patch: { gfwDomains: [host] } },
    { label: 'manual', key: 'pac_purp', color: 'rgb(139, 92, 246)', sourceKey: 'popStatusForceProxy', patch: { userRules: [host] } },
    { label: 'temporary', key: 'pac_org', color: 'rgb(245, 158, 11)', sourceKey: 'popStatusTemp', patch: { tempRules: [host] } },
    { label: 'direct rule', key: 'pac_blue', color: 'rgb(14, 165, 233)', sourceKey: 'popStatusForceDirect', patch: { userWhitelist: [host] } },
    { label: 'proxy trial', key: 'pac_org', color: 'rgb(245, 158, 11)', patch: { diagnosticTrial: trial('proxy') } },
    { label: 'direct trial', key: 'pac_blue', color: 'rgb(14, 165, 233)', patch: { diagnosticTrial: trial('direct') } },
  ];
  const result = [];
  for (const item of cases) {
    // These disposable UI fixtures never visit an external origin. They test
    // route-source presentation; actual trial application/undo has its own
    // message-driven, local-proxy integration suite.
    await worker.evaluate(config => chrome.storage.local.set(config), { ...fixture, ...item.patch });
    const expectedSource = await popup.evaluate(item => item.sourceKey ? i18n(item.sourceKey) :
      ProxySwitchDiagnosticsI18n.t('diagSourceTrial') + ' · ' + ProxySwitchDiagnosticsI18n.t(item.label === 'proxy trial' ? 'diagRouteProxy' : 'diagRouteDirect'), item);
    await until(async () => (await popup.locator('#routingDetailsText').innerText()) === expectedSource,
      language + ' ' + scheme + ' matching source ' + item.label);
    result.push(await routeAppearance(popup, item.key, item.color, language + ' ' + scheme + ' ' + item.label));
    if (item.label === 'subscription') await screenshot(popup, 'popup-subscription-' + language + '-' + scheme, true);
  }
  await worker.evaluate(config => chrome.storage.local.set(config), fixture);
  for (const item of [
    { mode: 'fixed_servers', key: 'fixed', color: 'rgb(139, 92, 246)' },
    { mode: 'direct', key: 'direct', color: 'rgb(14, 165, 233)' },
    { mode: 'system', key: 'system', color: 'rgb(100, 116, 139)' },
  ]) {
    const response = await popup.evaluate(mode => new Promise(resolve => chrome.runtime.sendMessage({ type: 'SET_PROXY_MODE', mode }, resolve)), item.mode);
    assert.equal(response.success, true, language + ' ' + scheme + ' mode fixture ' + JSON.stringify(response));
    await popup.evaluate(() => loadBaseConfig());
    result.push(await routeAppearance(popup, item.key, item.color, language + ' ' + scheme + ' ' + item.mode));
  }
  const response = await popup.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage({ type: 'SET_PROXY_MODE', mode: 'pac_script' }, resolve)));
  assert.equal(response.success, true, 'restore Auto after route presentation matrix');
  await popup.evaluate(() => loadBaseConfig());
  await routeAppearance(popup, 'pac_gray', 'rgb(148, 163, 184)', language + ' ' + scheme + ' restored Auto');
  return result;
}
async function cleanPopupShowcases(options, popup, source, popupUrl, popupSizes) {
  // Loaded loopback fixture, then an illustrative local proxy. The examples
  // never make a request to Google or another external website.
  finishLoading = true;
  await source.goto('http://example.test:' + origin.address().port + '/', { waitUntil: 'load' });
  await options.evaluate(async () => {
    await chrome.storage.local.set({
      serverList: [{ id: 'showcase', name: 'Local proxy', scheme: 'HTTP', host: '127.0.0.1', port: 9 }],
      activeServerId: 'showcase', userRules: ['example.test'], userWhitelist: [], tempRules: [], gfwDomains: [],
      appLanguage: 'zh_CN', theme: 'light', autoSync: false, diagnosticTrial: null,
    });
    const result = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'SET_PROXY_MODE', mode: 'pac_script' }, resolve));
    if (!result || !result.success) throw new Error('Showcase proxy mode failed: ' + JSON.stringify(result));
  });
  await popup.emulateMedia({ colorScheme: 'light' });
  await source.bringToFront();
  await popup.goto(popupUrl);
  await until(async () => (await popup.locator('#currentDomain').innerText()) === 'example.test' &&
    (await popup.locator('#openSettings').innerText()).includes('设置'), 'clean Chinese showcase loaded');
  await popup.locator('#pageLoadingState').waitFor({ state: 'hidden' });
  await popup.locator('#operationMessage').waitFor({ state: 'hidden' });
  await popup.locator('#whitelistMessage').waitFor({ state: 'hidden' });
  await until(async () => await popup.locator('#addRuleBtn').getAttribute('aria-pressed') === 'true', 'showcase proxy rule confirmed');
  assert.equal(await popup.locator('#serverSelect').getAttribute('title'), 'Local proxy');
  assert.equal(await popup.locator('#addRuleBtn').getAttribute('aria-pressed'), 'true');
  await routeAppearance(popup, 'pac_purp', 'rgb(139, 92, 246)', 'clean manual-proxy showcase');
  popupSizes.push(await popupDimensions(popup, 'clean showcase zh_CN light'));
  assert.ok(popupSizes[popupSizes.length - 1].height <= 600);
  await screenshot(popup, 'popup-showcase-zh', true);
  await options.evaluate(() => chrome.storage.local.set({ userRules: [], gfwDomains: ['example.test'] }));
  await routeAppearance(popup, 'pac_green', 'rgb(16, 185, 129)', 'clean subscription showcase');
  await until(async () => (await popup.locator('#addRuleBtn').getAttribute('aria-pressed')) === 'false', 'subscription showcase offers site-rule action');
  assert.equal(await popup.locator('#routingDetails').isVisible(), false);
  assert.equal(await popup.locator('#moreActions').isVisible(), false);
  await screenshot(popup, 'popup-showcase-subscription-zh', true);
  await moreActions(popup);
  await secondaryActionAlignment(popup, 'clean showcase expanded secondary actions');
  assert.equal(await popup.locator('#routingDetails').isVisible(), false, 'More does not expand unrelated rule details');
  popupSizes.push(await popupDimensions(popup, 'clean More showcase zh_CN light'));
  assert.ok(popupSizes[popupSizes.length - 1].height <= 600);
  await screenshot(popup, 'popup-showcase-more-zh', true);
}
async function translatedPopupGeometry(options, popup, source, popupUrl) {
  finishLoading = true;
  await source.goto('http://loading.experience.example:' + origin.address().port + '/', { waitUntil: 'load' });
  await source.bringToFront();
  await popup.goto(popupUrl);
  await until(async () => (await popup.locator('#currentDomain').innerText()) === 'loading.experience.example', 'geometry fixture source');
  // Show the already initialized popup tab for fast, non-throttled snapshots.
  // Its original source remains tracked, matching the full navigation tests.
  await popup.bringToFront();
  const popupSizes = [];
  for (const language of ['zh_CN', 'en', 'es', 'ru']) {
    await options.evaluate(language => chrome.storage.local.set({ appLanguage: language }), language);
    const messages = JSON.parse(fs.readFileSync(path.join(root, '_locales', language, 'messages.json'), 'utf8'));
    await until(async () => (await popup.locator('#openSettings').innerText()).trim() === messages.popFooter.message, 'geometry live language ' + language);
    for (const scheme of ['light', 'dark']) {
      await popup.emulateMedia({ colorScheme: scheme });
      await until(async () => (await popup.locator('html').getAttribute('data-theme')) === scheme, 'geometry system theme ' + scheme);
      await compactPopup(popup, language, scheme);
      await assertLayout(popup, 'paired actions ' + language + ' ' + scheme);
      await noEmoji(popup, 'paired actions ' + language + ' ' + scheme);
      // This fast path can sample while the theme's 150ms color transition is
      // still in flight. Check its settled endpoint, as the full suite does.
      await popup.locator('#addRuleBtn').evaluate(async button => {
        getComputedStyle(button).color;
        await Promise.all(button.getAnimations().map(animation => animation.finished.catch(() => {})));
      });
      await buttonContrasts(popup, 'paired actions ' + language + ' ' + scheme);
      await routeAppearance(popup, 'pac_gray', 'rgb(148, 163, 184)', 'paired actions ' + language + ' ' + scheme);
      await screenshot(popup, 'popup-equal-actions-' + language + '-' + scheme, true);
      popupSizes.push(await popupDimensions(popup, language + ' ' + scheme));
      await moreActions(popup);
      await secondaryActionAlignment(popup, 'paired actions ' + language + ' ' + scheme);
      await moreActions(popup, false);
    }
  }
  assert.ok(popupSizes.every(item => item.width <= 360 && item.height <= 600 && item.visibleHeight <= 600));
  return popupSizes;
}
async function gfwSourceGeometry(options, language, scheme, width) {
  const label = 'GFW source ' + language + ' ' + scheme + ' ' + width;
  await options.locator('[data-target="gfw"]').click();
  await options.setViewportSize({ width, height: 900 });
  await assertLayout(options, label);
  const geometry = await options.evaluate(() => {
    const input = document.querySelector('#gfwUrlInput');
    const button = document.querySelector('#saveGfwUrlBtn');
    const row = input.parentElement;
    const range = document.createRange();
    range.selectNodeContents(button);
    const rect = el => el.getBoundingClientRect().toJSON();
    const textLines = [...range.getClientRects()].filter(box => box.width && box.height).map(box => box.toJSON());
    return { input: rect(input), button: rect(button), row: rect(row), textLines,
      buttonText: button.textContent, nowrap: getComputedStyle(button).whiteSpace,
      shrink: getComputedStyle(button).flexShrink, inputValue: input.value };
  });
  assert.equal(geometry.nowrap, 'nowrap', label + ': the complete save caption never wraps within the button');
  assert.equal(geometry.shrink, '0', label + ': the input gives up space, not the save caption');
  assert.equal(geometry.textLines.length, 1, label + ': one caption line ' + JSON.stringify(geometry));
  assert.ok(geometry.button.height <= 43 && geometry.button.height >= 38,
    label + ': Save remains an input-height control, not a tall two-line box');
  assert.ok(geometry.textLines[0].x >= geometry.button.x && geometry.textLines[0].right <= geometry.button.right + 1,
    label + ': the entire caption fits inside its button');
  assert.ok(geometry.button.x >= geometry.row.x && geometry.button.right <= geometry.row.right + 1,
    label + ': the entire save control fits its form row');
  if (geometry.button.y < geometry.input.bottom - 1) {
    assert.ok(geometry.button.x >= geometry.input.right + 6 && Math.abs(geometry.button.height - geometry.input.height) <= 1,
      label + ': a desktop inline save button aligns with its flexible input');
  } else {
    assert.ok(geometry.button.y >= geometry.input.bottom + 6,
      label + ': constrained space moves the whole control to another row');
  }
  if (width <= 620) assert.ok(geometry.button.y >= geometry.input.bottom + 6 &&
    Math.abs(geometry.button.width - geometry.input.width) <= 1,
    label + ': small screens get full-width input and full-width save rows');
  return { label, ...geometry };
}
async function inlineRouteExperience(options, popup, source, worker, popupUrl) {
  const popupSizes = [], routeAppearances = [], gfwGeometry = [];
  await source.goto('http://loading.experience.example:' + origin.address().port + '/', { waitUntil: 'domcontentloaded' });
  const sourceTabId = await options.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url.includes('loading.experience.example')).id);
  await source.bringToFront();
  await popup.goto(popupUrl);
  // Keep snapshots in an active disposable tab instead of background timer
  // throttling. Popup continues tracking its original page through navigation.
  await popup.bringToFront();
  await popup.locator('#pageLoadingState').waitFor({ state: 'visible' });
  await routeAppearance(popup, 'pac_gray', 'rgb(148, 163, 184)', 'real pending page');
  const loadingBox = await popup.locator('#pageLoadingState').boundingBox();
  assert.ok(loadingBox && loadingBox.height > 1, 'actual page loading feedback remains visible, not screen-reader-only');
  await worker.evaluate(host => chrome.storage.local.set({ gfwDomains: [host] }), 'loading.experience.example');
  await routeAppearance(popup, 'pac_gray', 'rgb(148, 163, 184)', 'subscription is not fetched while the page is stuck');
  finishLoading = true;
  for (const res of pendingImages) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  }
  pendingImages.clear();
  await source.waitForLoadState('load');
  await popup.locator('#pageLoadingState').waitFor({ state: 'hidden' });
  await routeAppearance(popup, 'pac_green', 'rgb(16, 185, 129)', 'finished page reflects its subscription');
  await worker.evaluate(() => chrome.storage.local.set({ gfwDomains: [], userRules: [] }));
  await routeAppearance(popup, 'pac_gray', 'rgb(148, 163, 184)', 'ordinary source reset before the language matrix');
  for (const mode of ['pac_script', 'fixed_servers', 'direct', 'system']) {
    await source.goto('about:blank');
    await until(async () => (await popup.locator('#routingStatus').getAttribute('class')) === 'unavailable-state',
      'restricted page before pending recovery ' + mode);
    const response = await popup.evaluate(mode => new Promise(resolve => chrome.runtime.sendMessage({ type: 'SET_PROXY_MODE', mode }, resolve)), mode);
    assert.equal(response.success, true, 'set recovery mode ' + mode);
    await popup.evaluate(() => loadBaseConfig());
    assert.equal(await popup.locator('#domainArea').getAttribute('data-icon-key'), 'pac_gray', 'unsupported pages remain neutral in ' + mode);
    finishLoading = false;
    // Global mode is an actual proxy setting; a loopback page is intentionally
    // bypassed by Chromium, so this visual recovery check is not a proxy test.
    await source.goto('http://localhost:' + origin.address().port + '/', { waitUntil: 'domcontentloaded' });
    await popup.locator('#pageLoadingState').waitFor({ state: 'visible' });
    await until(async () => (await popup.locator('#currentDomain').innerText()) === 'localhost', 'supported pending host returns');
    assert.ok(!(await popup.locator('#domainArea').getAttribute('class')).split(/\s+/).includes('status-fail'),
      'restricted-page gray failure override is cleared before pending mode ' + mode);
    const appearance = { pac_script: ['pac_blue', 'rgb(14, 165, 233)'], fixed_servers: ['fixed', 'rgb(139, 92, 246)'],
      direct: ['direct', 'rgb(14, 165, 233)'], system: ['system', 'rgb(100, 116, 139)'] }[mode];
    await routeAppearance(popup, ...appearance, 'unsupported to pending ' + mode);
    finishLoading = true;
    for (const res of pendingImages) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    }
    pendingImages.clear();
    await source.waitForLoadState('load');
    await popup.locator('#pageLoadingState').waitFor({ state: 'hidden' });
  }
  const recoveredAuto = await popup.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage({ type: 'SET_PROXY_MODE', mode: 'pac_script' }, resolve)));
  assert.equal(recoveredAuto.success, true);
  await source.goto('http://loading.experience.example:' + origin.address().port + '/', { waitUntil: 'load' });
  await popup.evaluate(() => loadBaseConfig());
  await routeAppearance(popup, 'pac_gray', 'rgb(148, 163, 184)', 'Auto restored after pending recovery');
  const sourceUrl = 'https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt';
  for (const language of ['zh_CN', 'en', 'es', 'ru']) {
    await options.evaluate(language => chrome.storage.local.set({ appLanguage: language }), language);
    await options.reload();
    const messages = JSON.parse(fs.readFileSync(path.join(root, '_locales', language, 'messages.json'), 'utf8'));
    await until(async () => (await popup.locator('#openSettings').innerText()).trim() === messages.popFooter.message,
      'inline visual language ' + language);
    for (const scheme of ['light', 'dark']) {
      await Promise.all([options, popup].map(page => page.emulateMedia({ colorScheme: scheme })));
      await until(async () => (await popup.locator('html').getAttribute('data-theme')) === scheme,
        'inline route theme ' + scheme);
      await compactPopup(popup, language, scheme);
      routeAppearances.push(...await routeColorMatrix(popup, worker, sourceTabId, language, scheme));
      await screenshot(popup, 'popup-inline-' + language + '-' + scheme, true);
      popupSizes.push(await popupDimensions(popup, language + ' ' + scheme));
      await popup.locator('#routingDetailsBtn').focus();
      await popup.keyboard.press('Enter');
      assert.equal(await popup.locator('#routingDetails').isVisible(), true, 'keyboard opens route explanation');
      assert.equal(await popup.locator('#routingDetails .route-disclaimer').innerText(), messages.popExpectedRoutingHint.message,
        'color never promises an actual exit');
      await popup.keyboard.press('Escape');
      assert.equal(await popup.locator('#routingDetails').isVisible(), false);
      await popup.locator('#moreActionsBtn').focus();
      await popup.keyboard.press('Space');
      await secondaryActionAlignment(popup, language + ' ' + scheme);
      assert.equal(await popup.locator('#addTempRuleBtn').evaluate(el => document.activeElement === el), true);
      await popup.keyboard.press('Escape');
      assert.equal(await popup.locator('#moreActionsBtn').evaluate(el => document.activeElement === el), true);
      const longDomain = ['long-' + 'a'.repeat(55), 'b'.repeat(60), 'c'.repeat(60), 'experience.example'].join('.');
      await source.goto('http://' + longDomain + ':' + origin.address().port + '/', { waitUntil: 'load' });
      await until(async () => (await popup.locator('#currentDomain').innerText()) === longDomain, 'single-line long domain');
      const structure = await popupVisualStructure(popup, 'long domain ' + language + ' ' + scheme);
      assert.ok(structure.domainCss.scrollWidth > structure.domainCss.clientWidth, 'the long domain actually exercises ellipsis');
      assert.ok(structure.domainTitle.includes(longDomain));
      await assertLayout(popup, 'long domain ' + language + ' ' + scheme);
      await popup.locator('#routingDetailsBtn').focus();
      await popup.keyboard.press('Enter');
      assert.equal(await popup.locator('#routingDetails').isVisible(), true);
      assert.ok((await popup.locator('#routingScopeText').innerText()).includes(longDomain), 'full long-host rule scope remains readable');
      await popup.keyboard.press('Escape');
      await screenshot(popup, 'popup-inline-long-' + language + '-' + scheme, true);
      popupSizes.push(await popupDimensions(popup, 'long domain ' + language + ' ' + scheme));
      await source.goto('http://localhost:' + origin.address().port + '/', { waitUntil: 'load' });
      await until(async () => (await popup.locator('#currentDomain').innerText()) === 'localhost', 'local source selected');
      routeAppearances.push(await routeAppearance(popup, 'pac_blue', 'rgb(14, 165, 233)', language + ' ' + scheme + ' local direct'));
      await source.goto('about:blank');
      await until(async () => (await popup.locator('#currentDomain').innerText()) === messages.popInvalidPage.message, 'unsupported page visible');
      assert.equal(await popup.locator('#routingStatus').innerText(), messages.popCannotSet.message);
      assert.equal(await popup.locator('#routingStatus').getAttribute('class'), 'unavailable-state', 'unsupported-page explanation stays visible');
      assert.equal(await popup.locator('#domainArea').getAttribute('data-icon-key'), 'pac_gray');
      assert.equal(await popup.locator('#currentDomain').getAttribute('title'), null, 'old host tooltip is removed');
      await source.goto('http://loading.experience.example:' + origin.address().port + '/', { waitUntil: 'load' });
      await until(async () => (await popup.locator('#currentDomain').innerText()) === 'loading.experience.example', 'ordinary source restored');
      assert.ok(!(await popup.locator('#domainArea').getAttribute('class')).split(/\s+/).includes('status-fail'),
        'ordinary host has no stale unsupported-page gray override');
      await options.locator('[data-target="gfw"]').click();
      await options.locator('#gfwUrlInput').fill(sourceUrl);
      for (const width of [1280, 1024, 760, 640, 620, 380]) {
        gfwGeometry.push(await gfwSourceGeometry(options, language, scheme, width));
        if ((language === 'zh_CN' || language === 'en') && (width === 1280 || width === 380)) {
          await screenshot(options, 'gfw-source-' + language + '-' + scheme + '-' + width);
        }
      }
      await options.setViewportSize({ width: 1280, height: 900 });
      if (language === 'zh_CN' && scheme === 'light') {
        await options.locator('#saveGfwUrlBtn').click();
        await until(async () => (await options.evaluate(() => chrome.storage.local.get('gfwlistUrl'))).gfwlistUrl === sourceUrl,
          'GFW Save still commits the explicitly edited source URL without downloading');
        assert.equal(await options.locator('#gfwUrlInput').inputValue(), sourceUrl);
      }
    }
  }
  await cleanPopupShowcases(options, popup, source, popupUrl, popupSizes);
  assert.ok(popupSizes.every(item => item.width <= 360 && item.visibleHeight <= 600 && item.height <= 600),
    'inline home and long-host states fit Chrome popup limits ' + JSON.stringify(popupSizes));
  return { popupSizes, routeSourcesChecked: routeAppearances.length,
    minimumDomainContrast: Math.min(...routeAppearances.map(item => item.ratio)),
    routeColorKeys: [...new Set(routeAppearances.map(item => item.key))],
    gfwLayoutsChecked: gfwGeometry.length, gfwViewports: [1280, 1024, 760, 640, 620, 380] };
}
async function languageDraftProtection(page, draftUrl, dialogs) {
  const marker = await page.evaluate(() => window.__experienceDraftMarker = 'draft-' + Date.now());
  await page.locator('[data-target="about"]').click();
  await page.locator('#langSelect').selectOption('en');
  await until(async () => (await page.evaluate(() => chrome.storage.local.get('appLanguage'))).appLanguage === 'en' &&
    await page.locator('#generalOperationStatus .configuration-reload').isVisible(), 'language saved with explicit refresh offered');
  assert.equal(await page.evaluate(() => window.__experienceDraftMarker), marker, 'language saving cannot reload away an unsaved form');
  assert.equal(await page.locator('#gfwUrlInput').inputValue(), draftUrl);
  assert.match(await page.locator('[data-target="about"]').innerText(), /通用设置/, 'the current page retains its old language until explicit refresh');
  assert.match(await page.locator('#generalOperationStatus').getAttribute('class'), /warning/);
  await screenshot(page, 'options-language-draft-protection-zh');
  await page.locator('[data-target="gfw"]').click();
  await page.locator('#saveGfwUrlBtn').click();
  await until(async () => (await page.evaluate(() => chrome.storage.local.get('gfwlistUrl'))).gfwlistUrl === draftUrl, 'preserved draft explicitly saved');
  await page.locator('[data-target="about"]').click();
  // Accept only this expected, user-visible confirmation. All other native
  // dialogs still fail the regression instead of silently discarding a draft.
  page.removeAllListeners('dialog');
  let confirmations = 0;
  const confirmRefresh = async dialog => {
    if (dialog.type() === 'confirm') { confirmations++; await dialog.accept(); }
    else { dialogs.push(dialog.message()); await dialog.dismiss(); }
  };
  page.on('dialog', confirmRefresh);
  await Promise.all([page.waitForEvent('load'), page.locator('#generalOperationStatus .configuration-reload').click()]);
  assert.equal(confirmations, 1);
  await until(async () => /General/.test(await page.locator('[data-target="about"]').innerText()), 'explicit refresh applies saved English language');
  assert.equal(await page.evaluate(() => window.__experienceDraftMarker), undefined);
  page.removeListener('dialog', confirmRefresh);
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.evaluate(() => chrome.storage.local.set({ appLanguage: 'zh_CN' }));
  await page.reload();
  await until(async () => /通用设置/.test(await page.locator('[data-target="about"]').innerText()), 'Chinese preference reset for remaining checks');
  await page.locator('[data-target="gfw"]').click();
  assert.equal(await page.locator('#gfwUrlInput').inputValue(), draftUrl);
}

let context;
(async () => {
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath: process.env.PROXYSWITCH_CHROMIUM,
    channel: process.env.PROXYSWITCH_CHROMIUM ? undefined : 'chromium',
    headless: true,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--host-resolver-rules=MAP *.experience.example 127.0.0.1, MAP example.test 127.0.0.1', '--no-proxy-server'],
    viewport: { width: 1200, height: 900 },
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const options = await context.newPage();
  const popup = await context.newPage();
  const diagnostics = await context.newPage();
  const pages = [options, popup, diagnostics];
  const errors = [];
  const dialogs = [];
  for (const page of pages) {
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  }
  const extensionUrl = name => 'chrome-extension://' + extensionId + '/html/' + name + '.html';
  await options.goto(extensionUrl('options'));
  const longName = 'Comfort fixture — A very long server name that remains fully available';
  await options.evaluate(async data => {
    await chrome.storage.local.set({
      userRules: ['edit.experience.example', 'delete.experience.example', 'stale.experience.example'],
      userWhitelist: [], tempRules: [], gfwDomains: [], gfwlistUrl: '',
      serverList: [{ id: 'experience', name: data.longName, scheme: 'HTTP', host: '127.0.0.1', port: data.port }],
      activeServerId: 'experience', appLanguage: 'zh_CN', theme: 'system', autoSync: false,
      syncProvider: 'webdav', davUrl: 'http://unsafe.experience.example/dav/', davUser: 'fixture', davPass: 'fixture-password',
    });
    const result = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'SET_PROXY_MODE', mode: 'pac_script' }, resolve));
    if (!result.success) throw new Error(JSON.stringify(result));
  }, { port: origin.address().port, longName });
  await options.reload();
  await until(async () => (await options.locator('body').innerText()).includes(longName), 'server configuration ready');

  // A pending resource keeps the source tab genuinely loading, without a mock
  // tabs.query response. Popup controls must work before the page finishes.
  const source = await context.newPage();
  source.on('pageerror', error => errors.push(error.message));
  if (inlineVisualCheck) {
    const visual = await inlineRouteExperience(options, popup, source, worker, extensionUrl('popup'));
    assert.deepEqual(dialogs, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, scratch, inlineVisualCheck, ...visual, errors }, null, 2));
    return;
  }
  if (geometryOnly) {
    const popupSizes = await translatedPopupGeometry(options, popup, source, extensionUrl('popup'));
    assert.deepEqual(dialogs, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, scratch, geometryOnly, popupSizes, errors }, null, 2));
    return;
  }
  if (showcaseOnly) {
    const popupSizes = [];
    await cleanPopupShowcases(options, popup, source, extensionUrl('popup'), popupSizes);
    assert.deepEqual(dialogs, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, scratch, showcaseOnly, popupSizes, errors }, null, 2));
    return;
  }
  await source.goto('http://loading.experience.example:' + origin.address().port + '/', { waitUntil: 'domcontentloaded' });
  const sourceTabId = await options.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url.includes('loading.experience.example')).id);
  assert.equal(await options.evaluate(async id => (await chrome.tabs.get(id)).status, sourceTabId), 'loading');
  await source.bringToFront();
  await popup.goto(extensionUrl('popup'));
  await until(async () => (await popup.locator('#currentDomain').innerText()) === 'loading.experience.example', 'loading source selected');
  await popup.locator('#pageLoadingState').waitFor({ state: 'visible' });
  await routeAppearance(popup, 'pac_gray', 'rgb(148, 163, 184)', 'loading without a known small-rule match');
  assert.equal(await popup.locator('#addRuleBtn').isVisible(), true);
  assert.equal(await popup.locator('#addWhitelistBtn').isVisible(), true);
  await popup.locator('#addRuleBtn').click();
  await until(async () => (await options.evaluate(async () => (await chrome.storage.local.get('userRules')).userRules)).includes('loading.experience.example'), 'add proxy while loading');
  await until(async () => !(await popup.locator('#addWhitelistBtn').isDisabled()), 'loading proxy save completed');
  await popup.locator('#addWhitelistBtn').click();
  await until(async () => (await options.evaluate(async () => (await chrome.storage.local.get('userWhitelist')).userWhitelist)).includes('loading.experience.example'), 'add direct while loading');
  await until(async () => !(await popup.locator('#removeWhitelistBtn').isDisabled()), 'loading direct save completed');
  await moreActions(popup);
  await popup.locator('#removeWhitelistBtn').click();
  await until(async () => !(await popup.locator('#addWhitelistBtn').isDisabled()), 'loading direct undo completed');
  await popup.locator('#addWhitelistBtn').click();
  await until(async () => (await options.evaluate(() => chrome.storage.local.get('userWhitelist'))).userWhitelist.includes('loading.experience.example'), 'direct rule restored for route switching');
  await until(async () => !(await popup.locator('#addRuleBtn').isDisabled()), 'exact direct rule can switch back to site proxy');
  await popup.locator('#addRuleBtn').click();
  await until(async () => {
    const config = await options.evaluate(() => chrome.storage.local.get(['userRules', 'userWhitelist']));
    return config.userRules.includes('loading.experience.example') && !config.userWhitelist.includes('loading.experience.example');
  }, 'one site-proxy operation removes only the exact conflicting direct rule');
  await until(async () => !(await popup.locator('#addWhitelistBtn').isDisabled()), 'atomic site-route switch completed');
  finishLoading = true;
  for (const res of pendingImages) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  }
  pendingImages.clear();
  await source.waitForLoadState('load');
  await popup.locator('#pageLoadingState').waitFor({ state: 'hidden' });
  assert.equal(await popup.locator('#currentDomain').innerText(), 'loading.experience.example');
  await moreActions(popup);
  await popup.locator('#removeBtn').click();
  await until(async () => !(await popup.locator('#addRuleBtn').isDisabled()), 'current-site proxy rule undo restores editable primary action');
  assert.ok(!(await options.evaluate(() => chrome.storage.local.get('userRules'))).userRules.includes('loading.experience.example'));
  const selectedServerTitle = await popup.locator('#serverSelect').getAttribute('title');
  assert.equal(selectedServerTitle, longName, 'truncated native selection exposes full server name');

  // The rule-source field is a draft, not a per-keystroke write. Saving cannot
  // interrupt typing or silently change the stored URL before confirmation.
  await options.locator('[data-target="gfw"]').click();
  const draftUrl = 'https://rules.experience.example/subscription.txt';
  await options.locator('#gfwUrlInput').fill('');
  await options.locator('#gfwUrlInput').focus();
  await options.keyboard.type(draftUrl, { delay: 20 });
  assert.equal(await options.locator('#gfwUrlInput').inputValue(), draftUrl);
  assert.equal(await options.locator('#gfwUrlInput').evaluate(el => document.activeElement === el), true);
  assert.equal((await options.evaluate(() => chrome.storage.local.get('gfwlistUrl'))).gfwlistUrl, '');
  await languageDraftProtection(options, draftUrl, dialogs);
  await options.locator('#saveGfwUrlBtn').click();
  await until(async () => (await options.evaluate(() => chrome.storage.local.get('gfwlistUrl'))).gfwlistUrl === draftUrl, 'explicit rule-source save');

  // An invalid form remains editable, including every draft field.
  await options.locator('[data-target="server"]').click();
  await options.locator('#addServerBtn').click();
  await options.locator('#editName').fill('Unsaved server draft');
  await options.locator('#editPort').fill('70000');
  await options.locator('#saveServerItemBtn').click();
  assert.equal(await options.locator('#serverForm').isVisible(), true);
  assert.equal(await options.locator('#editName').inputValue(), 'Unsaved server draft');
  assert.equal(await options.locator('#editPort').inputValue(), '70000');
  assert.equal((await options.evaluate(() => chrome.storage.local.get('serverList'))).serverList.length, 1);
  await options.locator('#cancelServerItemBtn').click();

  // This intentionally insecure, non-loopback address is rejected locally by
  // the cloud validator before a request can leave the browser. Its explanation
  // should remain next to the controls rather than disappearing as a toast.
  await options.locator('[data-target="sync"]').click();
  await options.locator('#davUser').fill('updated-fixture-user');
  const uploadBounds = await options.locator('#cloudUploadBtn').boundingBox();
  // One physical click must still submit after this input's change/blur. The
  // test deliberately avoids locator auto-retry concealing a swallowed click.
  await options.mouse.click(uploadBounds.x + uploadBounds.width / 2, uploadBounds.y + uploadBounds.height / 2);
  await options.locator('#cloudOperationStatus').waitFor({ state: 'visible' });
  await until(async () => await options.locator('#cloudOperationStatus').getAttribute('role') === 'alert' &&
    !(await options.locator('#cloudUploadBtn').isDisabled()), 'first click submits a cloud operation after credential blur and then unlocks');
  const cloudError = await options.locator('#cloudOperationStatus').innerText();
  assert.ok(cloudError.trim(), 'cloud failure explains the problem next to the action');
  await new Promise(resolve => setTimeout(resolve, 2400));
  assert.equal(await options.locator('#cloudOperationStatus').isVisible(), true);
  assert.equal(await options.locator('#cloudOperationStatus').innerText(), cloudError);
  assert.equal(await options.locator('#cloudRetryBtn').isVisible(), true);
  await options.locator('#cloudRetryBtn').click();
  await until(async () => await options.locator('#cloudOperationStatus').getAttribute('role') === 'alert' && !(await options.locator('#cloudUploadBtn').isDisabled()), 'cloud failure retry retains editable controls');

  // Editing has an explicit transaction boundary. Blur is not a save; Enter
  // commits, Escape discards. Delete offers one safe, conflict-aware undo.
  await options.locator('[data-target="rules"]').click();
  const ruleRow = text => options.locator('.rule-item').filter({ hasText: text });
  await ruleRow('edit.experience.example').locator('.btn-edit').click();
  const editor = options.locator('.rule-item input').first();
  await editor.fill('changed.experience.example');
  await options.locator('#ruleSearch').focus();
  assert.ok((await options.evaluate(() => chrome.storage.local.get('userRules'))).userRules.includes('edit.experience.example'));
  await editor.focus();
  await options.keyboard.press('Escape');
  assert.ok((await options.evaluate(() => chrome.storage.local.get('userRules'))).userRules.includes('edit.experience.example'));
  await ruleRow('edit.experience.example').locator('.btn-edit').click();
  await options.locator('.rule-item input').first().fill('changed.experience.example');
  await options.keyboard.press('Enter');
  await until(async () => (await options.evaluate(() => chrome.storage.local.get('userRules'))).userRules.includes('changed.experience.example'), 'Enter saves rule');
  await ruleRow('delete.experience.example').locator('.btn-del').click();
  await until(async () => !(await options.evaluate(() => chrome.storage.local.get('userRules'))).userRules.includes('delete.experience.example'), 'rule deleted');
  await options.locator('#ruleUndoBtn').click();
  await until(async () => (await options.evaluate(() => chrome.storage.local.get('userRules'))).userRules.includes('delete.experience.example'), 'rule deletion undo');
  await ruleRow('stale.experience.example').locator('.btn-del').click();
  await until(async () => !(await options.evaluate(() => chrome.storage.local.get('userRules'))).userRules.includes('stale.experience.example'), 'rule deleted before external change');
  await worker.evaluate(async () => {
    const items = await chrome.storage.local.get('userRules');
    await chrome.storage.local.set({ userRules: items.userRules.concat('external.experience.example') });
  });
  await options.locator('#ruleUndoBtn').click();
  await until(async () => {
    const status = options.locator('#ruleOperationStatus');
    return await status.getAttribute('role') === 'alert' && (await status.innerText()).trim();
  }, 'conflicting undo explains rejection');
  const afterConflict = await options.evaluate(() => chrome.storage.local.get('userRules'));
  assert.ok(afterConflict.userRules.includes('external.experience.example'));
  assert.ok(!afterConflict.userRules.includes('stale.experience.example'));

  await diagnostics.goto(extensionUrl('diagnostics') + '?tabId=' + sourceTabId);
  const themeStates = [];
  for (const scheme of ['dark', 'light', 'dark']) {
    await Promise.all(pages.map(page => page.emulateMedia({ colorScheme: scheme })));
    await until(async () => {
      const states = await Promise.all(pages.map(page => page.evaluate(() => ({
        theme: document.documentElement.getAttribute('data-theme'),
        preference: document.documentElement.getAttribute('data-theme-preference'),
        token: getComputedStyle(document.documentElement).getPropertyValue('--bg-body').trim(),
      }))));
      return states.every(state => state.theme === scheme && state.preference === 'system' && state.token && state.token === states[0].token) ? states : null;
    }, 'shared system theme ' + scheme);
    const states = await Promise.all(pages.map(page => page.evaluate(() => ({
      preference: matchMedia('(prefers-color-scheme: dark)').matches,
      bg: getComputedStyle(document.body).backgroundColor,
      token: getComputedStyle(document.documentElement).getPropertyValue('--bg-body').trim(),
    }))));
    assert.ok(states.every(state => state.preference === (scheme === 'dark')));
    themeStates.push(states);
  }
  assert.notEqual(themeStates[0][0].bg, themeStates[1][0].bg, 'system theme updates live without a reload');
  assert.equal(themeStates[0][0].bg, themeStates[2][0].bg);
  for (const page of [options, popup]) {
    assert.ok(await page.locator('img[src="../assets/icon.png"]').count(), 'original logo stays in the product');
    await noEmoji(page, page === options ? 'options' : 'popup');
  }

  const contrasts = [];
  const popupSizes = [];
  const compactScreens = [];
  const routeAppearances = [];
  const gfwGeometries = [];
  const popupConfiguration = await options.evaluate(() => chrome.storage.local.get(['userRules', 'userWhitelist']));
  await popup.evaluate(() => operationFeedback(''));
  for (const language of focusedVisualCheck ? ['zh_CN'] : ['zh_CN', 'en', 'es', 'ru']) {
    await options.evaluate(language => chrome.storage.local.set({ appLanguage: language }), language);
    await options.reload();
    const messages = JSON.parse(fs.readFileSync(path.join(root, '_locales', language, 'messages.json'), 'utf8'));
    await until(async () => (await popup.locator('#openSettings').innerText()).trim() === messages.popFooter.message, 'live popup language ' + language);
    for (const scheme of ['light', 'dark']) {
      await Promise.all(pages.map(page => page.emulateMedia({ colorScheme: scheme })));
      await options.locator('[data-target="about"]').click();
      await screenshot(options, 'options-general-' + language + '-' + scheme);
      await assertLayout(options, 'general ' + language + ' ' + scheme);
      await noEmoji(options, 'general ' + language + ' ' + scheme);
      for (const width of [1280, 1024, 760, 640, 620, 380]) {
        gfwGeometries.push(await gfwSourceGeometry(options, language, scheme, width));
      }
      await options.setViewportSize({ width: 1200, height: 900 });
      await options.locator('[data-target="rules"]').click();
      await screenshot(options, 'options-rules-' + language + '-' + scheme);
      contrasts.push(...await buttonContrasts(options, 'rules ' + language + ' ' + scheme));
      compactScreens.push(await compactPopup(popup, language, scheme));
      await screenshot(popup, 'popup-' + language + '-' + scheme, true);
      contrasts.push(...await buttonContrasts(popup, 'popup ' + language + ' ' + scheme));
      popupSizes.push(await popupDimensions(popup, 'ordinary ' + language + ' ' + scheme));
      routeAppearances.push(...await routeColorMatrix(popup, worker, sourceTabId, language, scheme));
      await worker.evaluate(async config => chrome.storage.local.set(config), popupConfiguration);
      await until(async () => (await popup.locator('#domainArea').getAttribute('data-icon-key')) === 'pac_gray' &&
        !(await popup.locator('#addRuleBtn').isDisabled()), 'ordinary fixture restored after route colors');
      await popup.locator('#routingDetailsBtn').focus();
      await popup.keyboard.press('Enter');
      await until(async () => (await popup.locator('#routingDetailsBtn').getAttribute('aria-expanded')) === 'true' &&
        await popup.locator('#routingDetailsText').isVisible(), 'keyboard opens routing details ' + language + ' ' + scheme);
      assert.ok((await popup.locator('#routingDetailsText').innerText()).trim(), 'routing details retain the matching rule explanation');
      assert.equal(await popup.locator('#routingDetails .route-disclaimer').innerText(), messages.popExpectedRoutingHint.message, 'predicted rule routing is distinguished from an actual exit');
      await popup.locator('#moreActionsBtn').focus();
      await popup.keyboard.press('Space');
      await until(async () => (await popup.locator('#moreActionsBtn').getAttribute('aria-expanded')) === 'true' &&
        await popup.locator('#manageRulesBtn').isVisible(), 'keyboard opens more actions ' + language + ' ' + scheme);
      await secondaryActionAlignment(popup, language + ' ' + scheme);
      assert.equal(await popup.locator('#addTempRuleBtn').evaluate(el => document.activeElement === el), true,
        language + ' ' + scheme + ': expanding More sends keyboard focus to the first usable secondary action');
      await screenshot(popup, 'popup-expanded-' + language + '-' + scheme, true);
      popupSizes.push(await popupDimensions(popup, 'expanded ' + language + ' ' + scheme));
      await popup.locator('#manageRulesBtn').focus();
      await popup.keyboard.press('Escape');
      await until(async () => (await popup.locator('#moreActionsBtn').getAttribute('aria-expanded')) === 'false', 'Escape closes more actions ' + language + ' ' + scheme);
      assert.equal(await popup.locator('#moreActionsBtn').evaluate(el => document.activeElement === el), true, 'Escape returns focus to More');
      await popup.locator('#routingDetailsBtn').focus();
      await popup.keyboard.press('Escape');
      await until(async () => (await popup.locator('#routingDetailsBtn').getAttribute('aria-expanded')) === 'false', 'Escape closes routing details ' + language + ' ' + scheme);
      const ordinaryStatus = await popup.locator('#routingStatus').innerText();
      await worker.evaluate(async config => chrome.storage.local.set({ userRules: config.userRules.concat('experience.example') }), popupConfiguration);
      await until(async () => (await popup.locator('#routingStatus').innerText()) !== ordinaryStatus, 'inherited proxy route badge');
      await popup.locator('#exceptionManageRulesBtn').waitFor({ state: 'visible' });
      assert.equal(await popup.locator('#moreActions').isVisible(), false, 'inherited rule management is outside the collapsed menu');
      await screenshot(popup, 'popup-inherited-' + language + '-' + scheme, true);
      popupSizes.push(await popupDimensions(popup, 'inherited ' + language + ' ' + scheme));
      await worker.evaluate(async () => chrome.storage.local.set({ userWhitelist: ['loading.experience.example'] }));
      await until(async () => (await popup.locator('#addWhitelistBtn').getAttribute('aria-pressed')) === 'true', 'exact direct-rule selected state');
      await screenshot(popup, 'popup-whitelist-' + language + '-' + scheme, true);
      popupSizes.push(await popupDimensions(popup, 'whitelist ' + language + ' ' + scheme));
      // Exercise the longest persistent feedback layout without provoking an
      // actual broken proxy or sending traffic to an external server.
      await popup.evaluate(() => operationFeedback('popErrOperation', true));
      await screenshot(popup, 'popup-failure-' + language + '-' + scheme, true);
      popupSizes.push(await popupDimensions(popup, 'failure ' + language + ' ' + scheme));
      await popup.evaluate(() => operationFeedback(''));
      await worker.evaluate(async config => chrome.storage.local.set(config), popupConfiguration);
      await until(async () => (await popup.locator('#addWhitelistBtn').getAttribute('aria-pressed')) === 'false' && (await popup.locator('#routingStatus').innerText()) === ordinaryStatus, 'popup fixture state restored');
      await worker.evaluate(async () => chrome.storage.local.set({ userWhitelist: ['experience.example'] }));
      await until(async () => await popup.locator('#exceptionManageRulesBtn').isVisible() &&
        await popup.locator('#addRuleBtn').isDisabled(), 'parent direct rule remains a visible blocking exception');
      assert.equal(await popup.locator('#whitelistHint').isVisible(), true, 'parent direct exception remains explained outside More');
      await screenshot(popup, 'popup-parent-direct-' + language + '-' + scheme, true);
      popupSizes.push(await popupDimensions(popup, 'parent direct ' + language + ' ' + scheme));
      await worker.evaluate(async config => chrome.storage.local.set(config), popupConfiguration);
      await until(async () => !(await popup.locator('#addRuleBtn').isDisabled()), 'parent direct fixture cleared');
      const longDomain = ['long-' + 'a'.repeat(55), 'b'.repeat(60), 'c'.repeat(60), 'experience.example'].join('.');
      await source.goto('http://' + longDomain + ':' + origin.address().port + '/', { waitUntil: 'load' });
      await until(async () => (await popup.locator('#currentDomain').innerText()) === longDomain, 'long source domain ' + language + ' ' + scheme);
      await popupVisualStructure(popup, 'long domain ' + language + ' ' + scheme);
      await assertLayout(popup, 'long domain ' + language + ' ' + scheme);
      await popup.locator('#routingDetailsBtn').click();
      assert.equal(await popup.locator('#routingDetails').isVisible(), true, 'long domain keeps its information action usable');
      await popup.locator('#routingDetailsBtn').click();
      await screenshot(popup, 'popup-long-domain-' + language + '-' + scheme, true);
      popupSizes.push(await popupDimensions(popup, 'long domain ' + language + ' ' + scheme));
      await source.goto('http://localhost:' + origin.address().port + '/', { waitUntil: 'load' });
      await until(async () => (await popup.locator('#currentDomain').innerText()) === 'localhost', 'local source domain');
      routeAppearances.push(await routeAppearance(popup, 'pac_blue', 'rgb(14, 165, 233)', language + ' ' + scheme + ' local direct'));
      await source.goto('http://loading.experience.example:' + origin.address().port + '/', { waitUntil: 'load' });
      await until(async () => (await popup.locator('#currentDomain').innerText()) === 'loading.experience.example', 'ordinary source restored');
    }
  }
  await popup.locator('#mode-direct').click();
  await until(async () => (await popup.locator('#mode-direct').getAttribute('aria-pressed')) === 'true', 'direct mode warning fixture');
  assert.equal(await popup.locator('#whitelistHint').isVisible(), true, 'non-Auto mode reminder is not hidden behind More');
  assert.equal(await popup.locator('#moreActions').isVisible(), false);
  await screenshot(popup, 'popup-non-auto-' + (focusedVisualCheck ? 'zh_CN' : 'ru') + '-dark', true);
  await popup.locator('#mode-pac').click();
  await until(async () => (await popup.locator('#mode-pac').getAttribute('aria-pressed')) === 'true', 'Auto fixture restored');
  for (const width of [760, 640, 380]) {
    await options.setViewportSize({ width, height: 900 });
    for (const section of ['server', 'rules', 'gfw', 'sync', 'about']) {
      await options.locator('[data-target="' + section + '"]').click();
      await assertLayout(options, section + ' at ' + width + ' CSS px');
      if (section === 'server') {
        await options.locator('#addServerBtn').click();
        await assertLayout(options, 'server draft at ' + width + ' CSS px');
        await options.locator('#cancelServerItemBtn').click();
      } else if (section === 'rules') {
        await ruleRow('changed.experience.example').locator('.btn-edit').click();
        await assertLayout(options, 'rule editor at ' + width + ' CSS px');
        await options.keyboard.press('Escape');
      }
    }
    await screenshot(options, 'options-narrow-' + width);
  }
  assert.ok(contrasts.length > 0, 'a real primary button was contrast-tested');
  assert.ok(popupSizes.every(item => item.width <= 360 && item.visibleHeight <= 600), 'popup viewport stays within Chrome limits: ' + JSON.stringify(popupSizes));
  assert.ok(popupSizes.filter(item => !item.label.startsWith('expanded ')).every(item => item.height <= 600), 'default and exceptional home states should fit Chrome without routine scrolling: ' + JSON.stringify(popupSizes));
  assert.ok(popupSizes.filter(item => item.label.startsWith('expanded ') && item.height > 600).every(item => ['auto', 'scroll'].includes(item.overflowY)), 'user-expanded details must remain scrollable instead of clipping controls');
  // Preserve disclosure-reset regression before generating clean examples.
  await moreActions(popup);
  await disclosure(popup, 'routingDetailsBtn', 'routingDetails', true);
  await source.goto('http://example.test:' + origin.address().port + '/', { waitUntil: 'load' });
  await until(async () => (await popup.locator('#currentDomain').innerText()) === 'example.test', 'popup follows the original source navigation');
  assert.equal(await popup.locator('#routingDetails').isVisible(), false, 'new site starts with routing details closed');
  assert.equal(await popup.locator('#moreActions').isVisible(), false, 'new site starts with secondary actions closed');
  await cleanPopupShowcases(options, popup, source, extensionUrl('popup'), popupSizes);
  assert.deepEqual(dialogs, [], 'validation and transaction errors must not interrupt drafts with native alerts');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, scratch, focusedVisualCheck,
    assertions: 'live shared system theme, original logo, consistent line icons, primary and colored-domain contrast, exact toolbar route-source colors including trial/local/loading/mode states, one-line icon/domain/information, accessible hidden status and complete long-domain ellipsis tooltip, draft typing and explicit save/language-change protection, keyboard edit, delete undo/conflict, invalid form draft, first-click cloud action/persistent failure and retry, narrow reflow, loading-page actions and atomic site-route switch/live status, compact first screen with one host, keyboard details and right-aligned More with a left-aligned vertical disclosure and first-action focus, visible parent-rule/non-Auto exceptions, selected-language default and expanded screenshots',
    minimumPrimaryContrast: Math.min(...contrasts.map(item => item.ratio)),
    minimumRouteContrast: Math.min(...routeAppearances.map(item => item.ratio)),
    routeSourcesChecked: routeAppearances.length,
    routeColorKeys: [...new Set(routeAppearances.map(item => item.key))],
    popupSizes, compactScreens, gfwLayoutsChecked: gfwGeometries.length, errors }, null, 2));
})().catch(async error => {
  console.error(error);
  console.error('Experience fixture artifacts: ' + scratch);
  if (context) {
    await Promise.all(context.pages().map((page, index) => page.screenshot({
      path: path.join(scratch, 'failure-' + index + '.png'), fullPage: true, timeout: 5000,
    }).catch(() => {})));
  }
  process.exitCode = 1;
}).finally(async () => {
  if (context) await context.close();
  origin.closeAllConnections();
  origin.close();
});
