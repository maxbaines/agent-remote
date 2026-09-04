#!/usr/bin/env node
/**
 * clear-to-start.mjs — real-browser/sessiond coverage for terminal-owned Clear to start.
 *
 * Usage: node web/e2e/clear-to-start.mjs [--url http://127.0.0.1:8313]
 */

import { execFileSync } from 'node:child_process';

let url = 'http://127.0.0.1:8313';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url' && i + 1 < argv.length) url = argv[++i];
  else if (argv[i].startsWith('--url=')) url = argv[i].slice('--url='.length);
}

const browserSession = `clear-to-start-${process.pid}`;
const primarySession = 0;
const observerSession = 1;

function pcliRaw(...args) {
  return execFileSync('playwright-cli', [`-s=${browserSession}`, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function pcliFor(tab, ...args) {
  if (args[0] === 'open') {
    return tab === primarySession
      ? pcliRaw(...args)
      : pcliRaw('tab-new', args[1]);
  }
  pcliRaw('tab-select', String(tab));
  return pcliRaw(...args);
}

function pevalFor(tab, js) {
  pcliRaw('tab-select', String(tab));
  return execFileSync('playwright-cli', [`-s=${browserSession}`, '--raw', 'eval', js], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function pevalJsonFor(session, js) {
  const raw = pevalFor(session, `JSON.stringify(${js})`);
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

function waitFor(session, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (pevalJsonFor(session, `Boolean(${expression})`) === true) return;
    } catch { /* transient reconnect/render state */ }
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
  pcliFor(primarySession, 'open', url);
  waitFor(primarySession, `${DOCK} && ${STORE}?.activePaneId > 0`, 15_000);
  pcliFor(primarySession, 'eval', `${APP}.keybindings.resetAll()`);
  pcliFor(observerSession, 'open', url);
  waitFor(observerSession, `${DOCK} && ${STORE}?.activePaneId > 0`, 15_000);

  const fixtureName = `clear-to-start-${Date.now()}`;
  const fixtureRef = `${fixtureName}-${process.pid}`;
  pcliFor(
    primarySession,
    'eval',
    `${APP}._socket.createWorkspace(${JSON.stringify(fixtureName)}, ${JSON.stringify(fixtureRef)})`,
  );
  waitFor(
    primarySession,
    `${STORE}.attached === ${STORE}.workspaces.find((workspace) => workspace.name === ${JSON.stringify(fixtureName)})?.workspaceId && ${STORE}.activePaneId > 0`,
    15_000,
  );
  const fixtureWorkspaceId = pevalJsonFor(
    primarySession,
    `${STORE}.workspaces.find((workspace) => workspace.name === ${JSON.stringify(fixtureName)})?.workspaceId`,
  );
  pcliFor(
    observerSession,
    'eval',
    `${APP}._socket.attachWithBreakpoint(${JSON.stringify(fixtureWorkspaceId)}, 'wide')`,
  );
  waitFor(
    observerSession,
    `${STORE}.attached === ${JSON.stringify(fixtureWorkspaceId)} && ${STORE}.activePaneId > 0`,
    15_000,
  );

  const command = pevalJsonFor(primarySession, `${APP}.commands.get('terminal.clear-to-start') ?? null`);
  assert(command?.id === 'terminal.clear-to-start', `missing clear Command: ${JSON.stringify(command)}`);
  assert(command?.title === 'Clear to start', `unexpected clear title: ${command?.title}`);
  assert(command?.available === true, 'clear should be available with an Active Pane');
  assert(
    command.defaultShortcuts.some((shortcut) =>
      shortcut.chord === 'shift+meta+k' && shortcut.platform === 'macos'),
    `missing macOS Cmd+Shift+K default: ${JSON.stringify(command.defaultShortcuts)}`,
  );
  assert(
    command.defaultShortcuts.some((shortcut) =>
      shortcut.chord === 'ctrl+shift+k' && shortcut.platform === 'other'),
    `missing non-macOS Ctrl+Shift+K default: ${JSON.stringify(command.defaultShortcuts)}`,
  );

  const paneId = pevalJsonFor(primarySession, `${STORE}.activePaneId`);
  assert(
    pevalJsonFor(observerSession, `${STORE}.activePaneId`) === paneId,
    'the observer did not attach to the same Active Pane',
  );
  const marker = `clear-to-start-before-${Date.now()}`;
  const probeTimestamp = Date.now();
  const fillReady = `clear-to-start-fill-ready-${probeTimestamp}`;
  const postMarker = `clear-to-start-after-${probeTimestamp}`;
  const shellProbe = [
    `cpr() { stty raw -echo min 0 time 5; printf '\\033[6n'; dd bs=1 count=16 2>/dev/null | od -An -tx1; stty sane; }`,
    'clear_original_pwd=$PWD',
    'export AR_CLEAR_SENTINEL=preserved',
    `printf '%s\\n' '${marker}'`,
    'seq 1 35',
    `printf '%s\\n' '${fillReady}'`,
  ].join('; ');
  pcliFor(
    primarySession,
    'eval',
    `${APP}._socket.sendPaneInput(${paneId}, new TextEncoder().encode(${JSON.stringify(`${shellProbe}\r`)}))`,
  );
  waitFor(primarySession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(fillReady)})`);
  waitFor(observerSession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(fillReady)})`);

  // Playwright runs Linux Chrome, so exercise the registered non-macOS chord.
  // The foreground shell must receive Ctrl+L and emit the redraw through the
  // PTY; clearing xterm.js locally would desynchronise its cursor from
  // sessiond's authoritative VTBuffer.
  pcliFor(primarySession, 'press', 'Control+Shift+k');
  waitFor(primarySession, `!${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(marker)})`);
  waitFor(observerSession, `!${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(marker)})`);

  // Codex asks CSI 6n before its first inline render. The shell command itself
  // occupies row 1, so the authoritative reply must report row 2. The old
  // browser-local clear returned the pre-clear row (typically 30+).
  const cursorProbe = 'cpr';
  pcliFor(
    primarySession,
    'eval',
    `${APP}._socket.sendPaneInput(${paneId}, new TextEncoder().encode(${JSON.stringify(`${cursorProbe}\r`)}))`,
  );
  const rowTwoCPR = '1b 5b 32 3b';
  waitFor(primarySession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(rowTwoCPR)})`);
  waitFor(observerSession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(rowTwoCPR)})`);

  const stateProbe = [
    '[ "$PWD" = "$clear_original_pwd" ]',
    '[ "$AR_CLEAR_SENTINEL" = preserved ]',
    `printf '%s\\n' '${postMarker}'`,
  ].join(' && ');
  pcliFor(
    primarySession,
    'eval',
    `${APP}._socket.sendPaneInput(${paneId}, new TextEncoder().encode(${JSON.stringify(`${stateProbe}\r`)}))`,
  );
  waitFor(primarySession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(postMarker)})`);
  waitFor(observerSession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(postMarker)})`);

  pcliFor(primarySession, 'reload');
  waitFor(primarySession, `${DOCK} && ${STORE}?.activePaneId === ${paneId}`, 15_000);
  waitFor(primarySession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(postMarker)})`, 15_000);
  assert(
    pevalJsonFor(primarySession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(marker)})`) === false,
    'a reload revealed output hidden before the clear boundary',
  );

  const reconnectMarker = `clear-to-start-reconnect-${Date.now()}`;
  pcliFor(
    observerSession,
    'eval',
    `${APP}._socket.sendPaneInput(${paneId}, new TextEncoder().encode(${JSON.stringify(`printf '%s\\n' '${reconnectMarker}'\r`)}))`,
  );
  waitFor(primarySession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(reconnectMarker)})`);
  pcliFor(primarySession, 'eval', `(() => {
    window.__clearReconnectObserved = false;
    const ws = ${APP}._socket._ws;
    ws.addEventListener('close', () => { window.__clearReconnectObserved = true; }, { once: true });
    ws.close(4000, 'clear-to-start-e2e');
  })()`);
  waitFor(primarySession, `window.__clearReconnectObserved === true`);
  waitFor(primarySession, `${APP}._socket.connected === true`, 15_000);
  waitFor(primarySession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(reconnectMarker)})`, 15_000);
  assert(
    pevalJsonFor(primarySession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(marker)})`) === false,
    'a WebSocket reconnect revealed output hidden before the clear boundary',
  );

  console.log('PASS: registered Ctrl+Shift+K asks the foreground terminal to clear');
  console.log('PASS: sessiond and both browser emulators redraw from the same cursor row');
  console.log('PASS: CSI 6n reports row 2 after clear, matching cursor-aware programs such as Codex');
  console.log('PASS: clear preserves the shell process, cwd, and environment');
  console.log('PASS: reload and reconnect retain the clear boundary and post-clear output');
} catch (error) {
  try {
    console.error(`PRIMARY CONTENT: ${pevalJsonFor(primarySession, `${DOCK}?.getTerminalContent(${STORE}?.activePaneId)`)}`);
    console.error(`OBSERVER CONTENT: ${pevalJsonFor(observerSession, `${DOCK}?.getTerminalContent(${STORE}?.activePaneId)`)}`);
    console.error(`OBSERVER STATE: ${JSON.stringify(pevalJsonFor(observerSession, `({
      connected: ${APP}?._socket?.connected,
      attached: ${STORE}?.attached,
      activePaneId: ${STORE}?.activePaneId,
      panes: ${STORE}?.panes?.map((pane) => pane.paneId),
    })`))}`);
    console.error(pcliFor(observerSession, 'console', 'error'));
  } catch { /* best-effort failure diagnostics */ }
  console.error(`FAIL: ${error.message}`);
  process.exitCode = error instanceof Error ? 1 : 2;
} finally {
  try { pcliRaw('close'); } catch { /* best-effort browser cleanup */ }
}
