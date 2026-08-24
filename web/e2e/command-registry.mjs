#!/usr/bin/env node
/**
 * command-registry.mjs — real-browser/sessiond coverage for the create-tab tracer.
 *
 * Verifies against a fresh Agent Remote runtime that:
 *   1. pane.create-tab exposes stable presentation, shortcut, and availability metadata.
 *   2. The dock header button and default browser-safe shortcut both create a tab.
 *   3. An unavailable create-tab command is guarded and creates nothing.
 *   4. Created tabs and terminal output survive a browser reload/reconnect.
 *
 * Usage: node web/e2e/command-registry.mjs [--url http://127.0.0.1:8313]
 *
 * Exit codes: 0 = all passed, 1 = an assertion failed, 2 = setup error.
 * Prereqs: playwright-cli installed; a real Agent Remote Gateway + Session Owner
 * are running at --url with a fresh runtime directory.
 */

import { execFileSync } from 'node:child_process';

let url = 'http://127.0.0.1:8313';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url' && i + 1 < argv.length) url = argv[++i];
  else if (argv[i].startsWith('--url=')) url = argv[i].slice('--url='.length);
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
  if (start === -1) {
    const scalar = raw.trim().split('\n').at(-1);
    return JSON.parse(scalar);
  }
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

const APP = `document.querySelector('mux-app')`;
const DOCK = `${APP}?.shadowRoot?.querySelector('mux-dock')`;
const STORE = `${DOCK}?.__store`;
const POSITIVE_PANES = `${STORE}?.panes?.filter((pane) => pane.paneId > 0)`;

try {
  pcli('open', url);
  waitFor(`${DOCK} && ${POSITIVE_PANES}?.length === 1`, 15_000);
  waitFor(`${APP}?.commands?.get('pane.create-tab')?.available === true`, 15_000);

  const command = pevalJson(`(() => {
    const app = ${APP};
    return app?.commands?.get('pane.create-tab') ?? null;
  })()`);
  assert(command?.id === 'pane.create-tab', `unexpected command id: ${command?.id}`);
  assert(command?.title === 'Create tab', `unexpected command title: ${command?.title}`);
  assert(command?.available === true, 'create-tab should be available with an Active Pane');
  assert(
    Array.isArray(command?.defaultShortcuts) &&
      command.defaultShortcuts.some((shortcut) => shortcut.chord === 'ctrl+meta+t'),
    `missing browser-safe default shortcut metadata: ${JSON.stringify(command?.defaultShortcuts)}`,
  );

  const initialIds = pevalJson(`${POSITIVE_PANES}.map((pane) => pane.paneId)`);
  pcli('eval', `(() => {
    const button = ${DOCK}?.querySelector('.mux-header-btn[title="Create tab"]');
    if (!button) throw new Error('registry-backed Create tab button not found');
    button.click();
  })()`);
  waitFor(`${POSITIVE_PANES}?.length === ${initialIds.length + 1}`);

  const afterPointerIds = pevalJson(`${POSITIVE_PANES}.map((pane) => pane.paneId)`);
  pcli('eval', `window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 't', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true,
  }))`);
  waitFor(`${POSITIVE_PANES}?.length === ${afterPointerIds.length + 1}`);

  const beforeGuardIds = pevalJson(`${POSITIVE_PANES}.map((pane) => pane.paneId)`);
  const guardResult = pevalJson(`(() => {
    const dock = ${DOCK};
    const previous = ${STORE}.activePaneId;
    ${STORE}.setActivePane(-1);
    const state = ${APP}.commands.get('pane.create-tab');
    const invoked = ${APP}.commands.invoke('pane.create-tab');
    ${STORE}.setActivePane(previous);
    return { available: state.available, invoked };
  })()`);
  sleep(500);
  const afterGuardIds = pevalJson(`${POSITIVE_PANES}.map((pane) => pane.paneId)`);
  assert(guardResult.available === false, 'create-tab should expose unavailable without an Active Pane');
  assert(guardResult.invoked === false, 'unavailable create-tab invocation should be rejected');
  assert(
    JSON.stringify(afterGuardIds) === JSON.stringify(beforeGuardIds),
    `guarded invocation changed panes: before=${beforeGuardIds} after=${afterGuardIds}`,
  );

  const activePaneId = pevalJson(`${STORE}.activePaneId`);
  const marker = `command-registry-${Date.now()}`;
  pcli('eval', `(() => {
    const app = ${APP};
    app._socket.sendPaneInput(${activePaneId}, new TextEncoder().encode(${JSON.stringify(`printf '%s\\n' '${marker}'\\r`)}));
  })()`);
  waitFor(`${DOCK}?.getTerminalContent(${activePaneId}).includes(${JSON.stringify(marker)})`);

  const idsBeforeReload = pevalJson(`${POSITIVE_PANES}.map((pane) => pane.paneId)`);
  pcli('reload');
  waitFor(`${DOCK} && ${POSITIVE_PANES}?.length === ${idsBeforeReload.length}`, 15_000);
  waitFor(`${DOCK}?.getTerminalContent(${activePaneId}).includes(${JSON.stringify(marker)})`, 15_000);
  const idsAfterReload = pevalJson(`${POSITIVE_PANES}.map((pane) => pane.paneId)`);
  assert(
    JSON.stringify(idsAfterReload) === JSON.stringify(idsBeforeReload),
    `tabs changed across reconnect: before=${idsBeforeReload} after=${idsAfterReload}`,
  );

  console.log('PASS: command metadata and live availability');
  console.log('PASS: pointer and shortcut create-tab invocation');
  console.log('PASS: unavailable invocation guard');
  console.log('PASS: tab and terminal persistence across reconnect');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = error instanceof Error ? 1 : 2;
} finally {
  try { pcli('close'); } catch { /* best-effort browser cleanup */ }
}
