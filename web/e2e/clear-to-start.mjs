#!/usr/bin/env node
/**
 * clear-to-start.mjs — real-browser/sessiond coverage for browser-local Clear to start.
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

  const command = pevalJsonFor(primarySession, `${APP}.commands.get('terminal.clear-to-start') ?? null`);
  assert(command?.id === 'terminal.clear-to-start', `missing clear Command: ${JSON.stringify(command)}`);
  assert(command?.title === 'Clear to start', `unexpected clear title: ${command?.title}`);
  assert(command?.available === true, 'clear should be available with an Active Pane');
  assert(
    command.defaultShortcuts.some((shortcut) =>
      shortcut.chord === 'meta+k' && shortcut.platform === 'macos'),
    `missing macOS Cmd+K default: ${JSON.stringify(command.defaultShortcuts)}`,
  );

  const paneId = pevalJsonFor(primarySession, `${STORE}.activePaneId`);
  assert(
    pevalJsonFor(observerSession, `${STORE}.activePaneId`) === paneId,
    'the observer did not attach to the same Active Pane',
  );
  const marker = `clear-to-start-before-${Date.now()}`;
  const probeTimestamp = Date.now();
  const readReady = `clear-to-start-read-ready-${probeTimestamp}`;
  const postMarker = `clear-to-start-after-${probeTimestamp}`;
  const shellProbe = [
    `printf '%s\\n' '${marker}'`,
    'clear_original_pwd=$PWD',
    'export AR_CLEAR_SENTINEL=preserved',
    `printf '%s%s\\n' 'clear-to-start-read-' 'ready-${probeTimestamp}'`,
    'IFS= read -r clear_probe',
    `[ "$clear_probe" = x ] && [ "$PWD" = "$clear_original_pwd" ] && [ "$AR_CLEAR_SENTINEL" = preserved ] && printf '%s%s\\n' 'clear-to-start-' 'after-${probeTimestamp}'`,
  ].join('; ');
  pcliFor(
    primarySession,
    'eval',
    `${APP}._socket.sendPaneInput(${paneId}, new TextEncoder().encode(${JSON.stringify(`${shellProbe}\r`)}))`,
  );
  waitFor(primarySession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(readReady)})`);
  waitFor(observerSession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(readReady)})`);

  pcliFor(primarySession, 'press', 'Meta+k');
  waitFor(primarySession, `!${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(marker)})`);
  sleep(500);
  assert(
    pevalJsonFor(observerSession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(marker)})`) === true,
    'Clear to start mutated the observer presentation',
  );
  assert(
    pevalJsonFor(observerSession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(postMarker)})`) === false,
    'Cmd+K sent input to the foreground process',
  );
  pcliFor(
    observerSession,
    'eval',
    `${APP}._socket.sendPaneInput(${paneId}, new TextEncoder().encode('x\\r'))`,
  );
  waitFor(primarySession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(postMarker)})`);
  waitFor(observerSession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(postMarker)})`);

  pcliFor(primarySession, 'reload');
  waitFor(primarySession, `${DOCK} && ${STORE}?.activePaneId === ${paneId}`, 15_000);
  waitFor(primarySession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(postMarker)})`, 15_000);
  assert(
    pevalJsonFor(primarySession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(marker)})`) === false,
    'a reload revealed output hidden before the local clear boundary',
  );
  assert(
    pevalJsonFor(observerSession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(marker)})`) === true,
    'the primary reload changed the observer presentation',
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
    'a WebSocket reconnect revealed output hidden before the local clear boundary',
  );

  const alternateTimestamp = Date.now();
  const alternateBefore = `clear-alt-before-${alternateTimestamp}`;
  const alternateReady = `clear-alt-ready-${alternateTimestamp}`;
  const alternateAfter = `clear-alt-after-${alternateTimestamp}`;
  const alternateProbe = [
    `printf '\\033[?1049h'`,
    `printf '%s\\n' '${alternateBefore}'`,
    `printf '%s\\n' '${alternateReady}'`,
    'IFS= read -r clear_alt_probe',
    `[ "$clear_alt_probe" = x ] && printf '%s\\n' '${alternateAfter}'`,
    'IFS= read -r clear_alt_exit',
    `printf '\\033[?1049l'`,
  ].join('; ');
  pcliFor(
    observerSession,
    'eval',
    `${APP}._socket.sendPaneInput(${paneId}, new TextEncoder().encode(${JSON.stringify(`${alternateProbe}\r`)}))`,
  );
  waitFor(primarySession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(alternateReady)})`);
  waitFor(observerSession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(alternateReady)})`);
  assert(
    pevalJsonFor(primarySession, `${DOCK}.getTerminalBufferType(${paneId})`) === 'alternate',
    'the primary did not enter the foreground process alternate screen',
  );

  pcliFor(primarySession, 'press', 'Meta+k');
  waitFor(primarySession, `!${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(alternateBefore)})`);
  assert(
    pevalJsonFor(primarySession, `${DOCK}.getTerminalBufferType(${paneId})`) === 'alternate',
    'Clear to start reset the primary emulator out of alternate-screen mode',
  );
  assert(
    pevalJsonFor(observerSession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(alternateBefore)})`) === true,
    'alternate-screen clear changed the observer presentation',
  );
  pcliFor(
    observerSession,
    'eval',
    `${APP}._socket.sendPaneInput(${paneId}, new TextEncoder().encode('x\\r'))`,
  );
  waitFor(primarySession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(alternateAfter)})`);
  waitFor(observerSession, `${DOCK}.getTerminalContent(${paneId}).includes(${JSON.stringify(alternateAfter)})`);
  assert(
    pevalJsonFor(primarySession, `${DOCK}.getTerminalBufferType(${paneId})`) === 'alternate',
    'new output after clear did not remain in the foreground alternate screen',
  );
  pcliFor(
    observerSession,
    'eval',
    `${APP}._socket.sendPaneInput(${paneId}, new TextEncoder().encode('y\\r'))`,
  );
  waitFor(primarySession, `${DOCK}.getTerminalBufferType(${paneId}) === 'normal'`);

  console.log('PASS: registered macOS Cmd+K clears the Active Pane presentation');
  console.log('PASS: clear sends no PTY input and preserves process, shell, and emulator state');
  console.log('PASS: another connected browser retains its own presentation and sees new output');
  console.log('PASS: reload and reconnect retain the local clear boundary and post-clear output');
  console.log('PASS: alternate-screen mode and foreground process survive Clear to start');
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
