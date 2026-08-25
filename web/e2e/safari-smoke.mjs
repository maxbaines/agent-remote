#!/usr/bin/env node
/**
 * Basic macOS Safari serious-regression smoke using Safari's W3C WebDriver.
 * Safari parity is not a desktop v1 release requirement; loading the real app,
 * attaching a Pane, reaching health, and resolving the fixed desktop surfaces are.
 */

import { spawn } from 'node:child_process';

let url = 'http://127.0.0.1:8313';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url' && i + 1 < argv.length) url = argv[++i];
  else if (argv[i].startsWith('--url=')) url = argv[i].slice('--url='.length);
}

const driverPort = 19431 + (process.pid % 1000);
const driverURL = `http://127.0.0.1:${driverPort}`;
const driver = spawn('safaridriver', ['--port', String(driverPort)], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let driverError = '';
driver.stderr.on('data', (chunk) => { driverError += chunk.toString(); });
let sessionId = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${driverURL}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) {
    const message = payload.value?.message ?? JSON.stringify(payload);
    throw new Error(`Safari WebDriver ${method} ${path}: ${message}`);
  }
  return payload.value;
}

async function waitForDriver() {
  for (let i = 0; i < 80; i++) {
    try {
      await request('/status');
      return;
    } catch { /* driver still starting */ }
    if (driver.exitCode !== null) {
      throw new Error(`safaridriver exited during startup: ${driverError.trim()}`);
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for safaridriver: ${driverError.trim()}`);
}

async function execute(script) {
  return request(`/session/${sessionId}/execute/sync`, {
    method: 'POST',
    body: { script, args: [] },
  });
}

async function waitForApp() {
  for (let i = 0; i < 80; i++) {
    const ready = await execute(`
      const app = document.querySelector('mux-app');
      const dock = app?.shadowRoot?.querySelector('mux-dock');
      return Boolean(dock?.__store?.activePaneId > 0);
    `);
    if (ready) return;
    await sleep(250);
  }
  throw new Error('Safari did not attach an Active Pane within 20 seconds');
}

try {
  if (process.platform !== 'darwin') throw new Error('Safari smoke requires macOS');
  await waitForDriver();
  const session = await request('/session', {
    method: 'POST',
    body: { capabilities: { alwaysMatch: { browserName: 'safari' } } },
  });
  sessionId = session.sessionId;
  await request(`/session/${sessionId}/window/rect`, {
    method: 'POST',
    body: { width: 1440, height: 900 },
  });
  await request(`/session/${sessionId}/url`, { method: 'POST', body: { url } });
  await waitForApp();

  const health = await fetch(`${url}/api/health`);
  if (!health.ok) throw new Error(`health endpoint returned ${health.status}`);

  const state = await execute(`
    const app = document.querySelector('mux-app');
    const dock = app.shadowRoot.querySelector('mux-dock');
    const style = getComputedStyle(document.documentElement);
    return {
      title: document.title,
      activePaneId: dock.__store.activePaneId,
      commandIds: app.commands.list().map((command) => command.id).sort(),
      background: style.getPropertyValue('--mux-bg').trim(),
      accent: style.getPropertyValue('--chrome-accent').trim(),
    };
  `);
  if (state.title !== 'Agent Remote') throw new Error(`unexpected title: ${state.title}`);
  if (!(state.activePaneId > 0)) throw new Error('Safari has no Active Pane');
  if (!state.commandIds.includes('terminal.clear-to-start')) {
    throw new Error(`Safari Command registry incomplete: ${JSON.stringify(state.commandIds)}`);
  }
  if (state.background !== '#1a1b26' || state.accent !== '#7aa2f7') {
    throw new Error(`Safari default theme unresolved: ${JSON.stringify(state)}`);
  }

  console.log('PASS: Safari loads Agent Remote, attaches a Pane, and reaches health');
  console.log('PASS: Safari resolves the desktop v1 Command registry and default theme');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  if (/Allow Remote Automation|automation session/i.test(error.message)) {
    console.error('Enable Safari > Develop > Allow Remote Automation, then rerun the smoke.');
  }
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try { await request(`/session/${sessionId}`, { method: 'DELETE' }); } catch { /* best effort */ }
  }
  driver.kill('SIGTERM');
}
