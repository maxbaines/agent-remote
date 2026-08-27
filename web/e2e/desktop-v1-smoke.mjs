#!/usr/bin/env node
/**
 * Desktop Chromium smoke for the combined Agent Remote desktop v1 cut.
 * Detailed behavior remains covered by the feature-specific E2E scripts.
 */

import { execFileSync } from 'node:child_process';

let url = 'http://127.0.0.1:8313';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url' && i + 1 < argv.length) url = argv[++i];
  else if (argv[i].startsWith('--url=')) url = argv[i].slice('--url='.length);
}

const expectedUid = process.env.AGENT_REMOTE_EXPECTED_UID;
const browserSession = `desktop-v1-smoke-${process.pid}`;

function pcli(...args) {
  return execFileSync('playwright-cli', [`-s=${browserSession}`, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function peval(expression) {
  return pcli('--raw', 'eval', `JSON.stringify(${expression})`);
}

function pevalJson(expression) {
  const raw = peval(expression).trim();
  try {
    const outer = JSON.parse(raw);
    return typeof outer === 'string' ? JSON.parse(outer) : outer;
  } catch {
    const firstQuote = raw.indexOf('"');
    const lastQuote = raw.lastIndexOf('"');
    if (firstQuote !== -1 && lastQuote > firstQuote) {
      return JSON.parse(JSON.parse(raw.slice(firstQuote, lastQuote + 1)));
    }
    throw new Error(`Could not parse browser result: ${raw}`);
  }
}

function sleep(ms) {
  execFileSync('sleep', [String(ms / 1000)]);
}

function waitFor(expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (pevalJson(`Boolean(${expression})`) === true) return;
    } catch { /* transient startup/reconnect state */ }
    sleep(250);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const APP = `document.querySelector('mux-app')`;
const DOCK = `${APP}?.shadowRoot?.querySelector('mux-dock')`;
const STORE = `${DOCK}?.__store`;

try {
  pcli('open', url);
  pcli('resize', '1440', '900');
  waitFor(`${DOCK} && ${STORE}?.activePaneId > 0`);

  const releaseState = pevalJson(`(() => {
    const app = ${APP};
    const style = getComputedStyle(document.documentElement);
    return {
      title: document.title,
      health: null,
      activePaneId: ${STORE}.activePaneId,
      commandIds: app.commands.list().map((command) => command.id).sort(),
      clearShortcut: app.commands.get('terminal.clear-to-start')?.defaultShortcuts,
      appearance: {
        background: style.getPropertyValue('--mux-bg').trim(),
        foreground: style.getPropertyValue('--mux-fg').trim(),
        accent: style.getPropertyValue('--chrome-accent').trim(),
      },
    };
  })()`);

  assert(releaseState.title === 'Agent Remote', `unexpected document title: ${releaseState.title}`);
  assert(releaseState.activePaneId > 0, 'no Active Pane after desktop startup');
  assert(
    JSON.stringify(releaseState.commandIds) === JSON.stringify([
      'pane.create-tab',
      'pane.split-down',
      'pane.split-left',
      'pane.split-right',
      'pane.split-up',
      'terminal.clear-to-start',
    ]),
    `unexpected Command registry: ${JSON.stringify(releaseState.commandIds)}`,
  );
  assert(
    releaseState.clearShortcut?.some((shortcut) => shortcut.chord === 'meta+k'),
    `Cmd+K is absent: ${JSON.stringify(releaseState.clearShortcut)}`,
  );
  assert(
    JSON.stringify(releaseState.appearance) === JSON.stringify({
      background: '#1e1e1e',
      foreground: '#ffffff',
      accent: '#0a84ff',
    }),
    `unexpected default theme: ${JSON.stringify(releaseState.appearance)}`,
  );

  pcli('eval', `(() => {
    window.__agentRemoteDesktopV1Health = null;
    fetch('/api/health')
      .then((response) => { window.__agentRemoteDesktopV1Health = { ok: response.ok, status: response.status }; })
      .catch(() => { window.__agentRemoteDesktopV1Health = { ok: false, status: 0 }; });
  })()`);
  waitFor(`window.__agentRemoteDesktopV1Health !== null`);
  const health = pevalJson(`window.__agentRemoteDesktopV1Health`);
  assert(health.ok === true && health.status === 200, `health endpoint failed: ${JSON.stringify(health)}`);

  if (!expectedUid) throw new Error('AGENT_REMOTE_EXPECTED_UID is required');
  const marker = `desktop-v1-owner-${Date.now()}`;
  const activePaneId = releaseState.activePaneId;
  pcli('eval', `(() => {
    const command = ${JSON.stringify(`printf '${marker}:%s\\n' "$(id -u)"\r`)};
    ${APP}._socket.sendPaneInput(${activePaneId}, new TextEncoder().encode(command));
  })()`);
  waitFor(`${DOCK}.getTerminalContent(${activePaneId}).includes(${JSON.stringify(`${marker}:${expectedUid}`)})`);

  console.log('PASS: desktop Chromium loads the combined v1 Command and appearance surfaces');
  console.log('PASS: health endpoint and real non-root Terminal Session');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  try { pcli('close'); } catch { /* best-effort browser cleanup */ }
}
