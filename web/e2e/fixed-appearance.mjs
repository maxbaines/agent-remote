#!/usr/bin/env node
/**
 * fixed-appearance.mjs — real-browser coverage for Agent Remote's bundled style.
 *
 * Usage:
 *   node web/e2e/fixed-appearance.mjs [--url http://127.0.0.1:8313]
 *     [--capture docs/visual-reference/agent-remote-desktop-v1.png]
 *
 * Prereqs: playwright-cli installed; a real Agent Remote Gateway + Session Owner
 * are running at --url with a fresh runtime directory.
 */

import { execFileSync } from 'node:child_process';

let url = 'http://127.0.0.1:8313';
let capture = '';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url' && i + 1 < argv.length) url = argv[++i];
  else if (argv[i].startsWith('--url=')) url = argv[i].slice('--url='.length);
  else if (argv[i] === '--capture' && i + 1 < argv.length) capture = argv[++i];
  else if (argv[i].startsWith('--capture=')) capture = argv[i].slice('--capture='.length);
}

function pcli(...args) {
  return execFileSync('playwright-cli', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function peval(js) {
  return execFileSync('playwright-cli', ['--raw', 'eval', js], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function pevalJson(js) {
  const raw = peval(`JSON.stringify(${js})`);
  const trimmed = raw.trim();
  try {
    const outer = JSON.parse(trimmed);
    return typeof outer === 'string' ? JSON.parse(outer) : outer;
  } catch { /* fall through to extraction for CLI status-prefixed output */ }
  const firstQuote = raw.indexOf('"');
  const lastQuote = raw.lastIndexOf('"');
  if (firstQuote !== -1 && lastQuote > firstQuote) {
    try { return JSON.parse(JSON.parse(raw.slice(firstQuote, lastQuote + 1))); }
    catch { /* fall through to direct JSON extraction */ }
  }
  const objectStart = raw.indexOf('{');
  const arrayStart = raw.indexOf('[');
  let start = objectStart;
  if (arrayStart !== -1 && (start === -1 || arrayStart < start)) start = arrayStart;
  if (start === -1) return JSON.parse(raw.trim().split('\n').at(-1));
  const close = raw[start] === '{' ? '}' : ']';
  return JSON.parse(raw.slice(start, raw.lastIndexOf(close) + 1));
}

function sleep(ms) {
  execFileSync('sleep', [String(ms / 1000)]);
}

function waitFor(expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (pevalJson(`Boolean(${expression})`) === true) return;
    } catch { /* transient reconnect/render state */ }
    sleep(250);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255);
  const linear = rgb.map((value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const APP = `document.querySelector('mux-app')`;
const DOCK = `${APP}?.shadowRoot?.querySelector('mux-dock')`;
const STORE = `${DOCK}?.__store`;
const SETTINGS = `${APP}?.shadowRoot?.querySelector('mux-settings-surface')`;

try {
  pcli('open', url);
  pcli('resize', '1440', '900');
  peval(`(async () => {
    localStorage.setItem('agent-remote.titlebarColor', '#923737');
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) await registration.unregister();
    const cacheKeys = await caches.keys();
    for (const key of cacheKeys) await caches.delete(key);
    return true;
  })()`);
  pcli('reload');
  waitFor(`${DOCK} && ${STORE}?.activePaneId > 0`, 15_000);

  const appearance = pevalJson(`(() => {
    const style = getComputedStyle(document.documentElement);
    const variables = [
      '--mux-bg', '--mux-fg', '--mux-accent', '--mux-warn', '--mux-error', '--mux-ok',
      '--chrome-bar', '--chrome-body', '--chrome-border', '--chrome-text-dim',
      '--chrome-text-bright', '--chrome-accent', '--chrome-hover', '--chrome-danger',
      '--mux-titlebar-bg',
    ];
    return Object.fromEntries(variables.map((name) => [name, style.getPropertyValue(name).trim()]));
  })()`);
  const expected = {
    '--mux-bg': '#1a1b26',
    '--mux-fg': '#a9b1d6',
    '--mux-accent': '#7aa2f7',
    '--mux-warn': '#e0af68',
    '--mux-error': '#f7768e',
    '--mux-ok': '#9ece6a',
    '--chrome-bar': '#16161e',
    '--chrome-body': '#1a1b26',
    '--chrome-border': '#292e42',
    '--chrome-text-dim': '#7f89b3',
    '--chrome-text-bright': '#c0caf5',
    '--chrome-accent': '#7aa2f7',
    '--chrome-hover': '#1f2335',
    '--chrome-danger': '#f7768e',
    '--mux-titlebar-bg': '',
  };
  assert(JSON.stringify(appearance) === JSON.stringify(expected),
    `appearance tokens differ: ${JSON.stringify(appearance)}`);
  assert(contrast(appearance['--chrome-text-bright'], appearance['--chrome-body']) >= 4.5,
    'primary chrome text does not meet 4.5:1 contrast');
  assert(contrast(appearance['--chrome-text-dim'], appearance['--chrome-bar']) >= 4.5,
    'inactive chrome text does not meet 4.5:1 contrast');
  for (const state of ['--mux-accent', '--mux-warn', '--mux-error', '--mux-ok']) {
    assert(contrast(appearance[state], appearance['--mux-bg']) >= 3,
      `${state} does not meet 3:1 state contrast`);
  }
  assert(appearance['--mux-warn'] !== appearance['--mux-error'],
    'warning and error states use the same colour');

  const config = pevalJson(`fetch('/api/config').then((response) => response.json())`);
  assert(!Object.hasOwn(config, 'theme'), `config still exposes a theme surface: ${JSON.stringify(config.theme)}`);

  pcli('eval', `(() => {
    const sidebar = ${APP}.shadowRoot.querySelector('mux-sidebar');
    sidebar.shadowRoot.querySelector('.launcher-btn').click();
  })()`);
  waitFor(`${APP}?.shadowRoot?.querySelector('mux-sidebar')?.shadowRoot?.querySelector('mux-launcher-menu')`);
  pcli('eval', `(() => {
    const sidebar = ${APP}.shadowRoot.querySelector('mux-sidebar');
    sidebar.shadowRoot.querySelector('mux-launcher-menu').shadowRoot
      .querySelector('[data-action="settings"]').click();
  })()`);
  waitFor(`${SETTINGS}`);
  const settings = pevalJson(`(() => {
    const root = ${SETTINGS}.shadowRoot;
    return {
      text: root.textContent,
      colorInputs: root.querySelectorAll('input[type="color"]').length,
      themeCards: root.querySelectorAll('.theme-card').length,
    };
  })()`);
  assert(!/theme/i.test(settings.text), `Settings still exposes theme controls: ${settings.text}`);
  assert(settings.colorInputs === 0, 'Settings still exposes a custom color editor');
  assert(settings.themeCards === 0, 'Settings still exposes selectable palettes');
  pcli('eval', `${SETTINGS}.shadowRoot.querySelector('.close-btn').click()`);
  waitFor(`!${SETTINGS}`);

  const hoverTarget = pevalJson(`(() => {
    const button = ${APP}.shadowRoot.querySelector('mux-sidebar').shadowRoot.querySelector('.new-ws-btn');
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  pcli('mousemove', String(hoverTarget.x), String(hoverTarget.y));
  const hoverBackground = pevalJson(`getComputedStyle(
    ${APP}.shadowRoot.querySelector('mux-sidebar').shadowRoot.querySelector('.new-ws-btn')
  ).backgroundColor`);
  assert(hoverBackground === 'rgb(31, 35, 53)', `control hover cue missing: ${hoverBackground}`);

  const before = pevalJson(`${STORE}.panes.filter((pane) => pane.paneId > 0).length`);
  pcli('eval', `${APP}.commands.invoke('pane.create-tab')`);
  waitFor(`${STORE}.panes.filter((pane) => pane.paneId > 0).length === ${before + 1}`);
  pcli('eval', `${APP}.commands.invoke('pane.split-right')`);
  waitFor(`${STORE}.panes.filter((pane) => pane.paneId > 0).length === ${before + 2}`);

  const states = pevalJson(`(() => {
    const dock = ${DOCK};
    const active = dock.querySelector('.dv-tab.dv-active-tab');
    const inactive = dock.querySelector('.dv-tab:not(.dv-active-tab)');
    const dockview = dock.querySelector('.dv-dockview');
    return {
      activeBorder: getComputedStyle(active).borderTopColor,
      activeText: getComputedStyle(active).color,
      inactiveText: getComputedStyle(inactive).color,
      divider: getComputedStyle(dockview).getPropertyValue('--dv-separator-border').trim(),
      visibleText: document.body.innerText,
      title: document.title,
    };
  })()`);
  assert(states.activeBorder === 'rgb(122, 162, 247)', `active tab focus cue missing: ${states.activeBorder}`);
  assert(states.activeText !== states.inactiveText,
    `active and inactive tab text are indistinguishable: ${states.activeText}`);
  assert(states.divider === '#292e42', `pane divider is not tokenized: ${states.divider}`);
  assert(!/cmux/i.test(`${states.visibleText}\n${states.title}`), 'inherited product branding remains');

  if (capture) pcli('screenshot', `--filename=${capture}`);

  console.log('PASS: fixed terminal and chrome tokens, including contrast thresholds');
  console.log('PASS: no server or Settings theme/custom-color surface');
  console.log('PASS: active, inactive, focused, divider, warning, and error states');
  console.log('PASS: product-facing UI contains no inherited branding');
  if (capture) console.log(`PASS: captured representative desktop state at ${capture}`);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = error instanceof Error ? 1 : 2;
} finally {
  try { pcli('close'); } catch { /* best-effort browser cleanup */ }
}
