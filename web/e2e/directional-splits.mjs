#!/usr/bin/env node
/**
 * directional-splits.mjs — real-browser/sessiond coverage for explicit layout Commands.
 *
 * Usage: node web/e2e/directional-splits.mjs [--url http://127.0.0.1:8313]
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
const COMMAND_IDS = [
  'pane.create-tab',
  'pane.split-left',
  'pane.split-right',
  'pane.split-up',
  'pane.split-down',
];

function positivePaneIds() {
  return pevalJson(`${POSITIVE_PANES}.map((pane) => pane.paneId)`);
}

function activePaneId() {
  return pevalJson(`${STORE}.activePaneId`);
}

function paneRect(paneId) {
  return pevalJson(`(() => {
    const panel = ${DOCK}._panels.get(${paneId});
    const rect = panel.group._element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  })()`);
}

function waitForFocusedPane(paneId) {
  waitFor(`(() => {
    const app = ${APP};
    const dock = ${DOCK};
    const panel = dock?._panels?.get(${paneId});
    return dock?.__store?.activePaneId === ${paneId} && panel?.api?.isActive === true &&
      panel.group._element.contains(app?.shadowRoot?.activeElement);
  })()`, 15_000);
}

function waitForNewPane(beforeIds) {
  waitFor(`${POSITIVE_PANES}?.length === ${beforeIds.length + 1}`, 15_000);
  const afterIds = positivePaneIds();
  const created = afterIds.find((paneId) => !beforeIds.includes(paneId));
  assert(created !== undefined, `could not identify created Pane: before=${beforeIds} after=${afterIds}`);
  waitForFocusedPane(created);
  return created;
}

function clickActiveHeaderButton(title) {
  pcli('eval', `(() => {
    const dock = ${DOCK};
    const panel = dock._panels.get(dock.__store.activePaneId);
    const button = panel.group._element.querySelector('.mux-header-btn[title=${JSON.stringify(title)}]');
    if (!button) throw new Error(${JSON.stringify(`${title} header button not found`)});
    button.click();
  })()`);
}

function clickActiveSplitCommand(commandId) {
  pcli('eval', `(() => {
    const dock = ${DOCK};
    const panel = dock._panels.get(dock.__store.activePaneId);
    const group = panel.group._element;
    group.querySelector('.mux-header-btn[title="Split pane"]').click();
    const item = group.querySelector('[data-command-id=${JSON.stringify(commandId)}]');
    if (!item) throw new Error(${JSON.stringify(`${commandId} menu item not found`)});
    item.click();
  })()`);
}

function assertDirection(direction, createdId, referenceId) {
  const created = paneRect(createdId);
  const reference = paneRect(referenceId);
  const tolerance = 2;
  const placed = {
    left: created.right <= reference.left + tolerance,
    right: created.left >= reference.right - tolerance,
    up: created.bottom <= reference.top + tolerance,
    down: created.top >= reference.bottom - tolerance,
  }[direction];
  assert(
    placed,
    `${createdId} was not split ${direction} of ${referenceId}: created=${JSON.stringify(created)} reference=${JSON.stringify(reference)}`,
  );
}

try {
  pcli('open', url);
  waitFor(`${DOCK} && ${POSITIVE_PANES}?.length === 1 && ${STORE}?.activePaneId > 0`, 15_000);
  pcli('eval', `${APP}.keybindings.resetAll()`);

  const commands = pevalJson(`${APP}.commands.list()`);
  const expected = [
    ['pane.create-tab', 'Create tab'],
    ['pane.split-left', 'Split left'],
    ['pane.split-right', 'Split right'],
    ['pane.split-up', 'Split up'],
    ['pane.split-down', 'Split down'],
  ];
  for (const [id, title] of expected) {
    const command = commands.find((candidate) => candidate.id === id);
    assert(command?.title === title, `missing registered Command ${id}: ${JSON.stringify(commands)}`);
    assert(command.available === true, `${id} should be available with an Active Pane`);
    assert(command.configurable === true, `${id} should have browser-local configurable Keybindings`);
  }

  const menuCommands = pevalJson(`(() => {
    const dock = ${DOCK};
    const panel = dock._panels.get(dock.__store.activePaneId);
    return [...panel.group._element.querySelectorAll('.mux-split-menu-item')]
      .map((item) => item.dataset.commandId);
  })()`);
  assert(
    JSON.stringify(menuCommands) === JSON.stringify(COMMAND_IDS.slice(1)),
    `desktop Split menu did not expose every directional Command: ${JSON.stringify(menuCommands)}`,
  );

  const guardResult = pevalJson(`(() => {
    const app = ${APP};
    const store = ${STORE};
    const previousActive = store.activePaneId;
    store.setActivePane(-1);
    const withoutPane = ${JSON.stringify(COMMAND_IDS)}.map((id) => ({
      id,
      available: app.commands.get(id).available,
      invoked: app.commands.invoke(id),
    }));
    store.setActivePane(previousActive);
    const previousWorkspace = store._attached;
    store._attached = null;
    const withoutWorkspace = ${JSON.stringify(COMMAND_IDS)}.map((id) => ({
      id,
      available: app.commands.get(id).available,
      invoked: app.commands.invoke(id),
    }));
    store._attached = previousWorkspace;
    return { withoutPane, withoutWorkspace };
  })()`);
  assert(
    [...guardResult.withoutPane, ...guardResult.withoutWorkspace]
      .every((result) => result.available === false && result.invoked === false),
    `a layout Command escaped its context guard: ${JSON.stringify(guardResult)}`,
  );

  const basePaneId = activePaneId();
  const baseMarker = `directional-splits-base-${Date.now()}`;
  pcli('eval', `${APP}._socket.sendPaneInput(${basePaneId}, new TextEncoder().encode(${JSON.stringify(`printf '%s\\n' '${baseMarker}'\r`)}))`);
  waitFor(`${DOCK}.getTerminalContent(${basePaneId}).includes(${JSON.stringify(baseMarker)})`);

  const beforeTabIds = positivePaneIds();
  clickActiveHeaderButton('Create tab');
  const tabPaneId = waitForNewPane(beforeTabIds);
  assert(
    pevalJson(`${DOCK}._panels.get(${basePaneId}).group === ${DOCK}._panels.get(${tabPaneId}).group`) === true,
    'Create tab created a Split instead of a tab in the focused Pane Group',
  );

  pcli('eval', `(() => {
    const app = ${APP};
    app._overlayPanel = 'shortcuts';
    app.requestUpdate();
  })()`);
  const EDITOR = `${APP}?.shadowRoot?.querySelector('mux-keybindings-surface')`;
  waitFor(`${EDITOR}?.shadowRoot?.querySelectorAll('.command-row').length === 6`);
  pcli('eval', `(() => {
    const editor = ${EDITOR};
    const button = editor.shadowRoot.querySelector('[data-command-id="pane.split-left"] .edit-shortcut');
    button.click();
    button.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'l', ctrlKey: true, altKey: true, bubbles: true, composed: true, cancelable: true,
    }));
  })()`);
  waitFor(`JSON.parse(localStorage.getItem('agent-remote.keybindings.v1'))['pane.split-left'] === 'ctrl+alt+l'`);
  pcli('eval', `(() => { ${APP}._overlayPanel = null; ${APP}.requestUpdate(); })()`);

  const beforeLeftIds = positivePaneIds();
  const leftReferenceId = activePaneId();
  pcli('eval', `window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'l', ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
  }))`);
  const leftPaneId = waitForNewPane(beforeLeftIds);
  assertDirection('left', leftPaneId, leftReferenceId);

  const beforeRightIds = positivePaneIds();
  const rightReferenceId = activePaneId();
  clickActiveSplitCommand('pane.split-right');
  const rightPaneId = waitForNewPane(beforeRightIds);
  assertDirection('right', rightPaneId, rightReferenceId);

  const beforeDownIds = positivePaneIds();
  const downReferenceId = activePaneId();
  clickActiveSplitCommand('pane.split-down');
  const downPaneId = waitForNewPane(beforeDownIds);
  assertDirection('down', downPaneId, downReferenceId);

  const beforeUpIds = positivePaneIds();
  const upReferenceId = activePaneId();
  clickActiveSplitCommand('pane.split-up');
  const upPaneId = waitForNewPane(beforeUpIds);
  assertDirection('up', upPaneId, upReferenceId);

  const nestedLeft = paneRect(leftPaneId);
  const nestedDown = paneRect(downPaneId);
  assert(
    nestedDown.left >= nestedLeft.right - 2 && nestedDown.top > paneRect(downReferenceId).top,
    `perpendicular Split was not nested in the right-hand branch: left=${JSON.stringify(nestedLeft)} down=${JSON.stringify(nestedDown)}`,
  );
  assert(
    pevalJson(`${DOCK}.getTerminalContent(${basePaneId}).includes(${JSON.stringify(baseMarker)})`) === true,
    'creating tabs and nested Splits lost the original Terminal Session output',
  );

  const reconnectMarker = `directional-splits-reconnect-${Date.now()}`;
  pcli('eval', `${APP}._socket.sendPaneInput(${upPaneId}, new TextEncoder().encode(${JSON.stringify(`printf '%s\\n' '${reconnectMarker}'\r`)}))`);
  waitFor(`${DOCK}.getTerminalContent(${upPaneId}).includes(${JSON.stringify(reconnectMarker)})`);

  sleep(1_000);
  const idsBeforeReload = positivePaneIds();
  pcli('reload');
  waitFor(`${DOCK} && ${POSITIVE_PANES}?.length === ${idsBeforeReload.length}`, 15_000);
  waitFor(`${DOCK}.getTerminalContent(${upPaneId}).includes(${JSON.stringify(reconnectMarker)})`, 15_000);
  waitFor(`${STORE}.activePaneId === ${upPaneId} && ${DOCK}._panels.get(${upPaneId})?.api?.isActive === true`, 15_000);
  assert(
    JSON.stringify(positivePaneIds()) === JSON.stringify(idsBeforeReload),
    `persistent Terminal Session identities changed across reconnect: before=${idsBeforeReload} after=${positivePaneIds()}`,
  );
  assertDirection('left', leftPaneId, leftReferenceId);
  assertDirection('right', rightPaneId, rightReferenceId);
  assertDirection('down', downPaneId, downReferenceId);
  assertDirection('up', upPaneId, upReferenceId);

  console.log('PASS: explicit tab and directional-split Command metadata');
  console.log('PASS: desktop Command surfaces and browser-local split Keybinding');
  console.log('PASS: guarded tab and split availability without required context');
  console.log('PASS: tab focus plus left/right/up/down and nested Split placement');
  console.log('PASS: Terminal Sessions, layout, and focus persist across reconnect');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = error instanceof Error ? 1 : 2;
} finally {
  try { pcli('close'); } catch { /* best-effort browser cleanup */ }
}
