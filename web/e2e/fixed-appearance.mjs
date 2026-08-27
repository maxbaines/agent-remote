#!/usr/bin/env node
/**
 * fixed-appearance.mjs — real-browser coverage for Agent Remote themes.
 *
 * Usage:
 *   node web/e2e/fixed-appearance.mjs [--url http://127.0.0.1:8313]
 *     [--capture docs/visual-reference/agent-remote-desktop-v1.png]
 *
 * Prereqs: playwright-cli installed; a real Agent Remote Gateway + Session Owner
 * are running at --url with a fresh runtime directory.
 */

import { execFileSync } from 'node:child_process';

// Keep this verification isolated from other concurrently-running agents and
// local playwright-cli work. The unnamed default session is process-global and
// can otherwise be navigated or closed by an unrelated verification run.
const playwrightSession = `fixed-appearance-${process.pid}`;

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
  return execFileSync('playwright-cli', [`-s=${playwrightSession}`, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function peval(js) {
  return execFileSync('playwright-cli', [`-s=${playwrightSession}`, '--raw', 'eval', js], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function pevalJson(js) {
  const raw = peval(`(async () => JSON.stringify(await (${js})))()`);
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
    localStorage.removeItem('agent-remote.titlebarColor');
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
    '--mux-bg': '#1e1e1e',
    '--mux-fg': '#ffffff',
    '--mux-accent': '#0869cb',
    '--mux-warn': '#cdac08',
    '--mux-error': '#cc372e',
    '--mux-ok': '#26a439',
    '--chrome-bar': '#1a1a1a',
    '--chrome-body': '#1e1e1e',
    '--chrome-border': '#303033',
    '--chrome-text-dim': '#98989d',
    '--chrome-text-bright': '#ffffff',
    '--chrome-accent': '#0a84ff',
    '--chrome-hover': '#2c2c2e',
    '--chrome-danger': '#ff453a',
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
  assert(config.theme?.palette === 'cmux',
    `default theme missing from config: ${JSON.stringify(config.theme)}`);

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
  assert(/theme/i.test(settings.text), `Settings does not expose theme controls: ${settings.text}`);
  assert(settings.colorInputs === 0, 'Settings still exposes a custom color editor');
  assert(settings.themeCards === 9, `expected 9 selectable palettes, got ${settings.themeCards}`);

  const selectTheme = (title) => {
    pcli('eval', `(() => {
      const root = ${SETTINGS}.shadowRoot;
      const card = [...root.querySelectorAll('.theme-card')]
        .find((candidate) => candidate.title === ${JSON.stringify(title)});
      if (!card) throw new Error('missing theme card: ${title}');
      card.click();
    })()`);
  };

  const themeState = () => pevalJson(`(() => {
    const style = getComputedStyle(document.documentElement);
    const terminal = ${DOCK}.getTerminalAppearance(${STORE}.activePaneId);
    const active = ${SETTINGS}?.shadowRoot?.querySelector('.theme-card.active');
    return {
      muxBg: style.getPropertyValue('--mux-bg').trim(),
      muxFg: style.getPropertyValue('--mux-fg').trim(),
      terminalTextOpacity: style.getPropertyValue('--mux-terminal-text-opacity').trim(),
      muxAccent: style.getPropertyValue('--mux-accent').trim(),
      chromeBar: style.getPropertyValue('--chrome-bar').trim(),
      chromeBody: style.getPropertyValue('--chrome-body').trim(),
      chromeTextDim: style.getPropertyValue('--chrome-text-dim').trim(),
      terminalBackground: terminal?.background ?? '',
      terminalSelectionForeground: terminal?.selectionForeground ?? '',
      terminalAllowsTransparency: terminal?.allowTransparency ?? false,
      renderedTextOpacity: terminal?.textOpacity ?? '',
      activeTheme: active?.title ?? '',
      frameTheme: document.querySelector('meta[name="theme-color"]')?.content ?? '',
    };
  })()`);

  selectTheme('Gruvbox');
  waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--mux-bg').trim() === '#282828'`);
  sleep(750);
  const gruvboxConfig = pevalJson(`fetch('/api/config').then((response) => response.json())`);
  assert(gruvboxConfig.theme?.palette === 'gruvbox',
    `Gruvbox did not persist: ${JSON.stringify(gruvboxConfig.theme)}`);
  const gruvbox = themeState();
  assert(gruvbox.muxBg === '#282828' && gruvbox.muxFg === '#ebdbb2',
    `Gruvbox terminal tokens did not apply: ${JSON.stringify(gruvbox)}`);
  assert(gruvbox.muxAccent === '#458588' && gruvbox.chromeBar === '#16161e',
    `Gruvbox chrome tokens did not apply: ${JSON.stringify(gruvbox)}`);
  assert(gruvbox.terminalBackground === '#282828',
    `existing xterm did not hot-reload Gruvbox: ${JSON.stringify(gruvbox)}`);
  assert(gruvbox.activeTheme === 'Gruvbox',
    `Gruvbox card did not become active: ${JSON.stringify(gruvbox)}`);

  selectTheme('cmux');
  waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--mux-bg').trim() === '#1e1e1e'`);
  sleep(750);
  const cmuxConfig = pevalJson(`fetch('/api/config').then((response) => response.json())`);
  assert(cmuxConfig.theme?.palette === 'cmux',
    `cmux did not persist: ${JSON.stringify(cmuxConfig.theme)}`);
  const cmux = themeState();
  assert(cmux.muxBg === '#1e1e1e' && cmux.muxFg === '#ffffff',
    `cmux terminal tokens did not apply: ${JSON.stringify(cmux)}`);
  assert(cmux.terminalTextOpacity === '0.92' && cmux.renderedTextOpacity === '0.92',
    `cmux terminal text fade did not apply: ${JSON.stringify(cmux)}`);
  assert(cmux.muxAccent === '#0869cb' && cmux.chromeBar === '#1a1a1a',
    `cmux chrome tokens did not apply: ${JSON.stringify(cmux)}`);
  assert(cmux.chromeBody === '#1e1e1e' && cmux.chromeTextDim === '#98989d',
    `cmux native chrome did not apply: ${JSON.stringify(cmux)}`);
  assert(cmux.frameTheme === '#1a1a1a',
    `cmux browser frame colour did not apply: ${JSON.stringify(cmux)}`);
  assert(cmux.terminalBackground === '#1e1e1e',
    `existing xterm did not hot-reload opaque cmux: ${JSON.stringify(cmux)}`);
  assert(cmux.terminalSelectionForeground === '#ffffff' && !cmux.terminalAllowsTransparency,
    `cmux selection/opacity options did not reach xterm: ${JSON.stringify(cmux)}`);
  assert(cmux.activeTheme === 'cmux',
    `cmux card did not become active: ${JSON.stringify(cmux)}`);

  selectTheme('GitHub Light');
  waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--mux-bg').trim() === '#ffffff'`);
  sleep(750);
  const githubConfig = pevalJson(`fetch('/api/config').then((response) => response.json())`);
  assert(githubConfig.theme?.palette === 'github-light',
    `GitHub Light did not persist: ${JSON.stringify(githubConfig.theme)}`);
  const githubLight = themeState();
  assert(githubLight.muxBg === '#ffffff' && githubLight.muxFg === '#1f2328',
    `GitHub Light terminal tokens did not apply: ${JSON.stringify(githubLight)}`);
  assert(githubLight.muxAccent === '#0969da' && githubLight.chromeBar === '#e8e8ed',
    `light chrome did not apply: ${JSON.stringify(githubLight)}`);
  assert(githubLight.chromeBody === '#f2f2f7' && githubLight.chromeTextDim === '#636366',
    `accessible light chrome tokens did not apply: ${JSON.stringify(githubLight)}`);
  assert(githubLight.frameTheme === '#e8e8ed',
    `light browser frame colour did not apply: ${JSON.stringify(githubLight)}`);
  assert(githubLight.terminalBackground === '#ffffff',
    `existing xterm did not hot-reload GitHub Light: ${JSON.stringify(githubLight)}`);
  assert(githubLight.activeTheme === 'GitHub Light',
    `GitHub Light card did not become active: ${JSON.stringify(githubLight)}`);
  assert(contrast(githubLight.chromeTextDim, githubLight.chromeBar) >= 4.5,
    'light inactive chrome text does not meet 4.5:1 contrast');

  // A reload must resolve the persisted Host setting before the terminal is used.
  pcli('reload');
  waitFor(`${DOCK} && ${STORE}?.activePaneId > 0`, 15_000);
  waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--mux-bg').trim() === '#ffffff'`);
  const persisted = pevalJson(`fetch('/api/config').then((response) => response.json())`);
  assert(persisted.theme?.palette === 'github-light',
    `theme did not persist across reload: ${JSON.stringify(persisted.theme)}`);

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
  const persistedCard = pevalJson(`${SETTINGS}.shadowRoot.querySelector('.theme-card.active')?.title`);
  assert(persistedCard === 'GitHub Light', `persisted theme card is not active: ${persistedCard}`);

  // Return the fixture to the canonical default before checking desktop states
  // and producing the optional visual reference capture.
  selectTheme('cmux');
  waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--mux-bg').trim() === '#1e1e1e'`);
  sleep(750);
  const restoredDefault = pevalJson(`fetch('/api/config').then((response) => response.json())`);
  assert(restoredDefault.theme?.palette === 'cmux',
    `default theme did not persist after restoration: ${JSON.stringify(restoredDefault.theme)}`);
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
  assert(hoverBackground === 'rgb(44, 44, 46)', `control hover cue missing: ${hoverBackground}`);

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
  assert(states.activeBorder === 'rgb(10, 132, 255)', `active tab focus cue missing: ${states.activeBorder}`);
  assert(states.activeText !== states.inactiveText,
    `active and inactive tab text are indistinguishable: ${states.activeText}`);
  assert(states.divider === '#303033', `pane divider is not tokenized: ${states.divider}`);
  assert(!/cmux/i.test(`${states.visibleText}\n${states.title}`), 'inherited product branding remains');

  if (capture) pcli('screenshot', `--filename=${capture}`);

  console.log('PASS: default terminal and chrome tokens, including contrast thresholds');
  console.log('PASS: nine Settings themes, opaque cmux text fade, dark/light switching, xterm hot reload, and persistence');
  console.log('PASS: active, inactive, focused, divider, warning, and error states');
  console.log('PASS: product-facing UI contains no inherited branding');
  if (capture) console.log(`PASS: captured representative desktop state at ${capture}`);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = error instanceof Error ? 1 : 2;
} finally {
  try { pcli('close'); } catch { /* best-effort browser cleanup */ }
}
