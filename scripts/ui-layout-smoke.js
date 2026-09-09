'use strict';

/*
 * Local, opt-in visual layout smoke test.
 *
 * This deliberately uses a fresh headless Chrome profile and a local
 * development server. It never opens the production origin, authenticates,
 * or writes game data outside the temporary in-memory Private room it creates.
 *
 * Run with: npm run test:ui
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = Number(process.env.OVERTHINKING_UI_PORT || 3000);
const STARTUP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;
const VIEWPORTS = Object.freeze([
  { name: 'desktop-1280', width: 1280, height: 720, desktop: true },
  { name: 'desktop-1440', width: 1440, height: 900, desktop: true },
  { name: 'mobile-360', width: 360, height: 800, desktop: false },
  { name: 'mobile-390', width: 390, height: 844, desktop: false }
]);

function getChromePath() {
  const configured = process.env.OVERTHINKING_UI_CHROME_BIN;
  const candidates = [
    configured,
    process.platform === 'win32' ? path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.platform === 'win32' ? path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function getFreePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function canBindPort(port) {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise((resolve) => probe.close(() => resolve()));
  }
}

async function waitFor(description, predicate, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  const suffix = lastError ? ` (${lastError.message})` : '';
  throw new Error(`${description} を${Math.ceil(timeoutMs / 1000)}秒以内に確認できませんでした${suffix}`);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function openCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl, { origin: 'http://localhost' });
    const pending = new Map();
    let nextId = 1;
    let connected = false;
    const rejectPending = (error) => {
      for (const { reject: fail } of pending.values()) fail(error);
      pending.clear();
    };
    socket.once('open', () => {
      connected = true;
      resolve({
        call(method, params = {}) {
          return new Promise((done, fail) => {
            const id = nextId++;
            pending.set(id, { resolve: done, reject: fail });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        }
      });
    });
    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!Number.isSafeInteger(message.id)) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || 'Chrome DevTools Protocol error'));
      else request.resolve(message.result);
    });
    socket.once('error', (error) => {
      const failure = new Error(`Chrome DevTools Protocol connection failed: ${error.message}`);
      if (!connected) reject(failure);
      else rejectPending(failure);
    });
    socket.on('close', () => rejectPending(new Error('Chrome DevTools Protocol connection closed')));
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
  }
  return result.result.value;
}

async function openLocalGame({ chromePath, debugPort, viewport, roomId }) {
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'overthinking-ui-'));
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-extensions',
    // The CDP client is this local Node process only. Chrome otherwise rejects
    // its WebSocket Origin before the isolated smoke test can inspect layout.
    '--remote-allow-origins=*',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDirectory}`,
    '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  let cdp = null;
  try {
    const targets = await waitFor(
      'headless Chrome',
      async () => fetchJson(`http://127.0.0.1:${debugPort}/json/list`)
    );
    const target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
    if (!target) throw new Error('headless Chrome page target was not found');
    cdp = await openCdp(target.webSocketDebuggerUrl);
    await cdp.call('Page.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      // Narrow checks use Chrome's mobile emulation too, rather than merely
      // shrinking a desktop window. This catches viewport-meta and touch
      // layout regressions that a desktop media-query check can miss.
      mobile: !viewport.desktop,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      screenOrientation: { type: 'portraitPrimary', angle: 0 }
    });
    await cdp.call('Page.navigate', { url: `http://localhost:${APP_PORT}/` });
    await waitFor('対戦ページの初期化', async () => evaluate(cdp, `
      Boolean(document.getElementById('joinBtn'))
      && document.readyState === 'complete'
      && !document.getElementById('joinBtn').disabled
    `));
    await evaluate(cdp, `(() => {
      const room = document.getElementById('roomIdInput');
      const name = document.getElementById('playerNameInput');
      const spectator = document.getElementById('spectate-mode-input');
      if (spectator.checked) spectator.click();
      room.value = ${JSON.stringify(roomId)};
      name.value = ${JSON.stringify(`UI ${viewport.name}`)};
      room.dispatchEvent(new Event('input', { bubbles: true }));
      name.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('joinBtn').click();
    })()`);
    await waitFor('Privateルームへの入室', async () => evaluate(cdp, `
      !document.getElementById('game-screen').classList.contains('hidden')
      && document.querySelector('.sidebar') !== null
    `));

    const metrics = await evaluate(cdp, `(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      };
      const game = document.getElementById('game-screen');
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        gameColumns: getComputedStyle(game).gridTemplateColumns,
        sidebarColumns: getComputedStyle(document.querySelector('.sidebar')).gridTemplateColumns,
        sidebarParent: document.querySelector('.sidebar').parentElement?.id || null,
        gameChildren: Array.from(game.children).map((child) => ({
          id: child.id || null,
          tagName: child.tagName,
          className: child.className,
          display: getComputedStyle(child).display
        })),
        shell: rect('.game-shell'),
        sidebar: rect('.sidebar'),
        history: rect('.history-list'),
        chat: rect('.chat-panel')
      };
    })()`);
    return metrics;
  } finally {
    cdp?.close();
    chrome.kill();
    await new Promise((resolve) => chrome.once('exit', resolve));
    fs.rmSync(profileDirectory, { recursive: true, force: true });
  }
}

function assertLayout(viewport, metrics) {
  assert.ok(metrics.shell && metrics.sidebar && metrics.history && metrics.chat, `${viewport.name}: required layout regions are present`);
  assert.ok(
    metrics.scrollWidth <= metrics.innerWidth + 1,
    `${viewport.name}: page must not horizontally overflow (${metrics.scrollWidth}px > ${metrics.innerWidth}px)`
  );
  if (viewport.desktop) {
    assert.ok(
      Math.abs(metrics.sidebar.top - metrics.shell.top) <= 2,
      `${viewport.name}: sidebar must begin beside the board, not below it`
    );
    assert.ok(
      metrics.sidebar.left >= metrics.shell.right + 8,
      `${viewport.name}: sidebar must occupy the right-hand information rail`
    );
    assert.ok(
      Math.abs(metrics.chat.top - metrics.history.top) <= 2 && metrics.chat.left >= metrics.history.right + 8,
      `${viewport.name}: history and chat must be separate side-by-side columns`
    );
  } else {
    assert.ok(
      metrics.sidebar.top >= metrics.shell.bottom + 8,
      `${viewport.name}: narrow screens must stack the sidebar after the board`
    );
  }
}

async function main() {
  const chromePath = getChromePath();
  if (!chromePath) {
    throw new Error('Chrome was not found. Set OVERTHINKING_UI_CHROME_BIN to a local Chrome executable.');
  }
  if (!await canBindPort(APP_PORT)) {
    throw new Error(`port ${APP_PORT} is already in use. Stop the local game server before running test:ui.`);
  }

  const app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    // Four isolated browser profiles create four disposable rooms. Raise this
    // local-only ceiling so the abuse guard being tested elsewhere cannot make
    // the last viewport look like a layout failure.
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(APP_PORT),
      MAX_PRIVATE_ROOMS_PER_IP: '10'
    },
    stdio: 'ignore',
    windowsHide: true
  });
  try {
    await waitFor('ローカルゲームサーバー', async () => {
      const response = await fetch(`http://localhost:${APP_PORT}/`, { cache: 'no-store' });
      return response.ok;
    });
    for (const viewport of VIEWPORTS) {
      const debugPort = await getFreePort();
      const roomId = `ui-${process.pid}-${viewport.width}`;
      const metrics = await openLocalGame({ chromePath, debugPort, viewport, roomId });
      if (process.env.OVERTHINKING_UI_DEBUG === 'true') {
        console.log(`${viewport.name}: ${JSON.stringify(metrics)}`);
      }
      assertLayout(viewport, metrics);
      console.log(`✓ ${viewport.name}: board/sidebar geometry and overflow are valid`);
    }
  } finally {
    app.kill();
    await new Promise((resolve) => app.once('exit', resolve));
  }
}

main().catch((error) => {
  console.error(`UI layout smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
