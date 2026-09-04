#!/usr/bin/env node
/**
 * keybindings-editor.mjs — real-browser/sessiond coverage for browser-local Keybindings.
 *
 * Usage: node web/e2e/keybindings-editor.mjs [--url http://127.0.0.1:8313]
 *
 * Exit codes: 0 = all passed, 1 = an assertion failed, 2 = setup error.
 * Prereqs: playwright-cli installed; a real JustTerminal Gateway + Session Owner
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

const APP = `document.querySelector('mux-app')`;
const DOCK = `${APP}?.shadowRoot?.querySelector('mux-dock')`;
const STORE = `${DOCK}?.__store`;
const POSITIVE_PANES = `${STORE}?.panes?.filter((pane) => pane.paneId > 0)`;
const EDITOR = `${APP}?.shadowRoot?.querySelector('mux-keybindings-surface')`;

function openEditor() {
  pcli('eval', `(() => {
    const sidebar = ${APP}.shadowRoot.querySelector('mux-sidebar');
    const launcher = sidebar.shadowRoot.querySelector('.launcher-btn[title="Open menu"]');
    if (!launcher) throw new Error('desktop launcher button not found');
    launcher.click();
  })()`);
  waitFor(`${APP}?.shadowRoot?.querySelector('mux-sidebar')?.shadowRoot?.querySelector('mux-launcher-menu')`);
  pcli('eval', `(() => {
    const sidebar = ${APP}.shadowRoot.querySelector('mux-sidebar');
    const menu = sidebar.shadowRoot.querySelector('mux-launcher-menu');
    const shortcuts = menu?.shadowRoot?.querySelector('[data-action="shortcuts"]');
    if (!shortcuts) throw new Error('Keyboard Shortcuts menu item not found');
    shortcuts.click();
  })()`);
  waitFor(`${EDITOR}`);
}

function recordShortcut(key, modifiers) {
  pcli('eval', `(() => {
    const editor = ${EDITOR};
    const button = editor.shadowRoot.querySelector('[data-command-id="pane.create-tab"] .edit-shortcut');
    button.focus();
    button.click();
    button.dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)},
      ${Object.entries(modifiers).map(([name, value]) => `${name}: ${value}`).join(', ')},
      bubbles: true, composed: true, cancelable: true,
    }));
  })()`);
}

try {
  pcli('open', url);
  peval(`(async () => {
    localStorage.removeItem('just-terminal.keybindings.v1');
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) await registration.unregister();
    const cacheKeys = await caches.keys();
    for (const key of cacheKeys) await caches.delete(key);
    return true;
  })()`);
  pcli('reload');
  waitFor(`${DOCK} && ${STORE}?.activePaneId > 0`, 15_000);

  openEditor();
  const editor = pevalJson(`(() => {
    const editor = ${EDITOR};
    const root = editor?.shadowRoot;
    return {
      heading: root?.querySelector('h2')?.textContent?.trim() ?? '',
      command: root?.querySelector('[data-command-id="pane.create-tab"] .command-title')?.textContent?.trim() ?? '',
      shortcut: root?.querySelector('[data-command-id="pane.create-tab"] .shortcut-value')?.textContent?.trim() ?? '',
      editLabel: root?.querySelector('[data-command-id="pane.create-tab"] .edit-shortcut')?.getAttribute('aria-label') ?? '',
    };
  })()`);

  assert(editor.heading.includes('Keyboard Shortcuts'), `unexpected editor heading: ${editor.heading}`);
  assert(editor.command === 'Create tab', `registered command missing from editor: ${editor.command}`);
  assert(
    editor.shortcut.includes('Ctrl+T'),
    `unexpected non-macOS create-tab shortcut: ${editor.shortcut}`,
  );
  assert(editor.editLabel === 'Change shortcut for Create tab', `edit control missing: ${editor.editLabel}`);

  console.log('PASS: registered Command and default Keybinding are inspectable and editable');

  recordShortcut('y', { ctrlKey: true, altKey: true });
  waitFor(`${EDITOR}?.shadowRoot?.querySelector('[data-command-id="pane.create-tab"] .shortcut-value')?.textContent?.trim() === 'Ctrl+Alt+Y'`);
  const persisted = pevalJson(`JSON.parse(localStorage.getItem('just-terminal.keybindings.v1') ?? '{}')`);
  assert(persisted['pane.create-tab'] === 'ctrl+alt+y', `custom Keybinding was not browser-persisted: ${JSON.stringify(persisted)}`);

  const paneCount = pevalJson(`${POSITIVE_PANES}.length`);
  pcli('eval', `${EDITOR}.shadowRoot.querySelector('.close-btn').click()`);
  waitFor(`!${EDITOR}`);
  pcli('eval', `window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'y', ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
  }))`);
  waitFor(`${POSITIVE_PANES}?.length === ${paneCount + 1}`);

  console.log('PASS: edited Keybinding applies immediately and persists in this browser');

  const activePaneId = pevalJson(`${STORE}.activePaneId`);
  const leakMarkerStart = 'keybinding-input-';
  const leakMarkerEnd = `leak-${Date.now()}`;
  const leakMarker = `${leakMarkerStart}${leakMarkerEnd}`;
  pcli('eval', `(() => {
    ${APP}._socket.sendPaneInput(
      ${activePaneId},
      new TextEncoder().encode(${JSON.stringify(`stty -echo -icanon min 1 time 0; dd bs=1 count=1 of=/dev/null 2>/dev/null; stty echo icanon; printf '\n%s%s\n' '${leakMarkerStart}' '${leakMarkerEnd}'\r`)}),
    );
  })()`);
  sleep(500);
  openEditor();
  const panesBeforeConflict = pevalJson(`${POSITIVE_PANES}.length`);
  recordShortcut('w', { ctrlKey: true });
  waitFor(`${EDITOR}?.shadowRoot?.querySelector('[role="alert"]')?.textContent?.includes('already assigned to Close tab')`);
  sleep(500);
  const conflict = pevalJson(`(() => ({
    error: ${EDITOR}.shadowRoot.querySelector('[role="alert"]')?.textContent?.trim() ?? '',
    shortcut: ${EDITOR}.shadowRoot.querySelector('[data-command-id="pane.create-tab"] .shortcut-value')?.textContent?.trim() ?? '',
    panes: ${POSITIVE_PANES}.length,
    leaked: ${DOCK}.getTerminalContent(${activePaneId}).includes(${JSON.stringify(leakMarker)}),
  }))()`);
  assert(conflict.error === 'Ctrl+W is already assigned to Close tab.', `unexpected conflict: ${conflict.error}`);
  assert(conflict.shortcut === 'Ctrl+Alt+Y', `conflict replaced the working shortcut: ${conflict.shortcut}`);
  assert(conflict.panes === panesBeforeConflict, `conflicting Ctrl+W closed a pane: ${conflict.panes}`);
  assert(conflict.leaked === false, 'recorded shortcut sent input to the active PTY');
  pcli('eval', `${APP}._socket.sendPaneInput(${activePaneId}, new TextEncoder().encode('x'))`);
  waitFor(`${DOCK}.getTerminalContent(${activePaneId}).includes(${JSON.stringify(leakMarker)})`);
  pcli('eval', `(() => {
    const button = ${EDITOR}.shadowRoot.querySelector('[data-command-id="pane.create-tab"] .edit-shortcut');
    button.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, composed: true, cancelable: true,
    }));
  })()`);
  pcli('eval', `${EDITOR}.shadowRoot.querySelector('.close-btn').click()`);
  waitFor(`!${EDITOR}`);

  console.log('PASS: conflicts are rejected before dispatch and recording sends no PTY input');

  const panesBeforeReload = pevalJson(`${POSITIVE_PANES}.length`);
  pcli('reload');
  waitFor(`${DOCK} && ${POSITIVE_PANES}?.length === ${panesBeforeReload}`, 15_000);
  const restored = pevalJson(`JSON.parse(localStorage.getItem('just-terminal.keybindings.v1') ?? '{}')`);
  assert(restored['pane.create-tab'] === 'ctrl+alt+y', `Keybinding did not survive reload: ${JSON.stringify(restored)}`);
  pcli('eval', `window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'y', ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
  }))`);
  waitFor(`${POSITIVE_PANES}?.length === ${panesBeforeReload + 1}`);

  const otherUrl = new URL(url);
  otherUrl.hostname = otherUrl.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  pcli('eval', `location.href = ${JSON.stringify(otherUrl.href)}`);
  waitFor(`${DOCK} && ${STORE}?.activePaneId > 0`, 15_000);
  const isolated = pevalJson(`localStorage.getItem('just-terminal.keybindings.v1')`);
  assert(isolated === null, `another browser origin received the Keybinding: ${isolated}`);
  openEditor();
  const isolatedLabel = pevalJson(`${EDITOR}.shadowRoot.querySelector('[data-command-id="pane.create-tab"] .shortcut-value')?.textContent?.trim()`);
  assert(isolatedLabel.includes('Ctrl+T'), `another browser origin did not retain defaults: ${isolatedLabel}`);

  pcli('eval', `location.href = ${JSON.stringify(url)}`);
  waitFor(`${DOCK} && ${STORE}?.activePaneId > 0`, 15_000);
  openEditor();
  const returnedLabel = pevalJson(`${EDITOR}.shadowRoot.querySelector('[data-command-id="pane.create-tab"] .shortcut-value')?.textContent?.trim()`);
  assert(returnedLabel === 'Ctrl+Alt+Y', `original browser preference was lost: ${returnedLabel}`);

  console.log('PASS: reload retains the local preference and another browser origin keeps defaults');

  pcli('eval', `${EDITOR}.shadowRoot.querySelector('[data-command-id="pane.create-tab"] .reset-shortcut').click()`);
  waitFor(`${EDITOR}.shadowRoot.querySelector('[data-command-id="pane.create-tab"] .shortcut-value')?.textContent?.includes('Ctrl+T')`);
  assert(pevalJson(`localStorage.getItem('just-terminal.keybindings.v1')`) === null, 'individual reset left persisted overrides');
  const panesBeforeOldChord = pevalJson(`${POSITIVE_PANES}.length`);
  pcli('eval', `${EDITOR}.shadowRoot.querySelector('.close-btn').click()`);
  pcli('eval', `window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'y', ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
  }))`);
  sleep(500);
  assert(pevalJson(`${POSITIVE_PANES}.length`) === panesBeforeOldChord, 'individual reset left the custom chord active');

  openEditor();
  recordShortcut('u', { ctrlKey: true, altKey: true });
  waitFor(`${EDITOR}.shadowRoot.querySelector('[data-command-id="pane.create-tab"] .shortcut-value')?.textContent?.trim() === 'Ctrl+Alt+U'`);
  pcli('eval', `${EDITOR}.shadowRoot.querySelector('.reset-all').click()`);
  waitFor(`${EDITOR}.shadowRoot.querySelector('[data-command-id="pane.create-tab"] .shortcut-value')?.textContent?.includes('Ctrl+T')`);
  assert(pevalJson(`localStorage.getItem('just-terminal.keybindings.v1')`) === null, 'restore-all left persisted overrides');

  console.log('PASS: individual and all-default resets restore product Keybindings');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = error instanceof Error ? 1 : 2;
} finally {
  try { pcli('close'); } catch { /* best-effort browser cleanup */ }
}
