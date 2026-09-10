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
const { io: connectSocketIo } = require('socket.io-client');

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

async function openLocalGame({ chromePath, debugPort, viewport, roomId, onReady = null }) {
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
    if (typeof onReady === 'function') await onReady({ cdp, viewport, roomId });

    const metrics = await evaluate(cdp, `(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      };
      const game = document.getElementById('game-screen');
      const reveal = document.getElementById('reveal-area');
      reveal.classList.add('effect-burst-noise');
      const noiseBurst = getComputedStyle(reveal, '::before');
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
        chat: rect('.chat-panel'),
        noiseAnimationName: noiseBurst.animationName,
        noiseAnimationTiming: noiseBurst.animationTimingFunction
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

function connectLocalSocket() {
  return new Promise((resolve, reject) => {
    const socket = connectSocketIo(`http://localhost:${APP_PORT}`, {
      transports: ['websocket'],
      forceNew: true,
      extraHeaders: { Origin: `http://localhost:${APP_PORT}` }
    });
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('local Socket.IO player connection timed out'));
    }, STARTUP_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      socket.disconnect();
      reject(error);
    });
  });
}

function emitWithAck(socket, eventName, payload, timeoutMs = 6_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${eventName} acknowledgement timed out`)), timeoutMs);
    socket.emit(eventName, payload, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

async function runPrivateActionInteractionSmoke(chromePath) {
  const roomId = `ui-action-${process.pid}`;
  const host = await connectLocalSocket();
  let hostRoom = null;
  host.on('room_updated', (room) => {
    hostRoom = room;
  });
  try {
    host.emit('join_room', {
      roomId,
      playerName: 'UI host',
      clientId: `ui-action-host-${process.pid}`,
      joinAsSpectator: false
    });
    await waitFor('UI対象選択用のホスト入室', () => hostRoom?.players?.length === 1);

    const viewport = { name: 'desktop-target-action', width: 1280, height: 720, desktop: true };
    const debugPort = await getFreePort();
    const metrics = await openLocalGame({
      chromePath,
      debugPort,
      viewport,
      roomId,
      onReady: async ({ cdp }) => {
        await waitFor('UI対象選択用の二人目の入室', () => hostRoom?.players?.length === 2);
        const begin = await emitWithAck(host, 'begin_private_settings_edit', { roomId });
        assert.equal(begin?.ok, true, 'the local host must be able to open settings editing');
        await waitFor('設定編集状態', () => hostRoom?.settingsEditing === true);
        const update = await emitWithAck(host, 'update_private_settings', {
          roomId,
          configRevision: hostRoom.rules?.configRevision,
          ruleset: 'private-expanded-v1',
          turnTimeLimitMs: 90_000,
          roundLimit: 5,
          scoreTarget: null,
          blankEnabled: false,
          deck: [
            { definitionId: 'the-high-priestess', copies: 1 },
            { definitionId: 'ace', copies: 1 },
            { definitionId: 'king', copies: 1 },
            { definitionId: 'queen', copies: 1 },
            { definitionId: 'jack', copies: 1 }
          ]
        });
        assert.equal(update?.ok, true, 'the isolated action deck must be accepted by the server');
        const finish = await emitWithAck(host, 'finish_private_settings_edit', { roomId });
        assert.equal(finish?.ok, true, 'the local host must be able to finish settings editing');

        await waitFor('ブラウザ側の開始同意', async () => evaluate(cdp, `
          !document.getElementById('restartBtn').classList.contains('hidden')
          && !document.getElementById('restartBtn').disabled
        `));
        await evaluate(cdp, `document.getElementById('restartBtn').click()`);
        host.emit('agree_to_start', { roomId });
        await waitFor('拡張Private対局の開始', async () => (
          hostRoom?.gameState === 'playing'
          && await evaluate(cdp, `document.querySelectorAll('#my-hand .card').length === 5`)
        ));

        const priestessSelection = await evaluate(cdp, `(() => {
          const card = Array.from(document.querySelectorAll('#my-hand .card.card-action'))
            .find((element) => element.textContent.includes('High Priestess'));
          if (!card) {
            return {
              selected: false,
              cards: Array.from(document.querySelectorAll('#my-hand .card')).map((element) => ({
                text: element.textContent.trim(), className: element.className
              }))
            };
          }
          card.click();
          return {
            selected: Boolean(document.querySelector('#my-hand .card.selected')),
            confirmDisabled: document.getElementById('confirmBtn').disabled,
            className: document.querySelector('#my-hand .card.selected')?.className || ''
          };
        })()`);
        assert.equal(
          priestessSelection?.selected && priestessSelection.confirmDisabled === false,
          true,
          `the browser player must be able to select The High Priestess (${JSON.stringify(priestessSelection)})`
        );
        await evaluate(cdp, `document.getElementById('confirmBtn').click()`);

        await waitFor('ホスト側の拡張手札', () => (
          hostRoom?.gameState === 'playing'
          && hostRoom.players?.[0]?.hand?.some((card) => card.definitionId === 'ace')
        ));
        const hostAce = hostRoom.players[0].hand.find((card) => card.definitionId === 'ace');
        host.emit('confirm_card', { roomId, cardId: hostAce.id });

        await waitFor('High Priestessの盤面対象候補', async () => evaluate(cdp, `
          document.querySelectorAll('#opp-hand button.card-effect-target').length > 0
          && !document.getElementById('private-action-confirm').classList.contains('hidden')
        `));
        const targetMeta = await evaluate(cdp, `(() => {
          const target = document.querySelector('#opp-hand button.card-effect-target');
          if (!target) return null;
          target.focus();
          return {
            tag: target.tagName,
            pressed: target.getAttribute('aria-pressed'),
            candidateId: target.dataset.effectTargetId || ''
          };
        })()`);
        assert.equal(targetMeta?.tag, 'BUTTON', 'a physical hand target must be a native button');
        assert.equal(targetMeta?.pressed, 'false', 'the target must begin unselected');
        assert.ok(targetMeta?.candidateId, 'the authorized candidate must retain its opaque id locally');

        // Native buttons already synthesize one click for Enter. This catches
        // the regression where a second manual key handler immediately toggled
        // the target back off, leaving the confirmation control disabled.
        await cdp.call('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r',
          windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
        });
        await cdp.call('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
        });
        await waitFor('キーボードで選んだ能力対象', async () => evaluate(cdp, `(() => {
          const selected = document.querySelector('#opp-hand button.effect-target-selected');
          return Boolean(selected)
            && selected.getAttribute('aria-pressed') === 'true'
            && !document.getElementById('private-action-confirm').disabled;
        })()`));
        await evaluate(cdp, `document.getElementById('private-action-confirm').click()`);
        await waitFor('能力対象の確定と複製札の表示', async () => evaluate(cdp, `
          document.querySelectorAll('.card-effect-target').length === 0
          && document.querySelectorAll('#my-hand .card-generated').length >= 1
        `));
      }
    });
    assertLayout(viewport, metrics);
    console.log('✓ desktop-target-action: High Priestess target selection works by keyboard and resolves once');
  } finally {
    host.disconnect();
  }
}

function assertLayout(viewport, metrics) {
  assert.ok(metrics.shell && metrics.sidebar && metrics.history && metrics.chat, `${viewport.name}: required layout regions are present`);
  assert.ok(
    metrics.scrollWidth <= metrics.innerWidth + 1,
    `${viewport.name}: page must not horizontally overflow (${metrics.scrollWidth}px > ${metrics.innerWidth}px)`
  );
  assert.equal(
    metrics.noiseAnimationName,
    'effect-burst-noise',
    `${viewport.name}: the public Noise cue must use its dedicated result animation`
  );
  assert.doesNotMatch(
    metrics.noiseAnimationTiming,
    /steps/i,
    `${viewport.name}: the Noise cue must animate smoothly rather than jump between frames`
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
    assert.ok(
      metrics.history.height < Math.max(180, metrics.sidebar.height * .45),
      `${viewport.name}: an empty history must keep its content height instead of stretching down the rail`
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
    await runPrivateActionInteractionSmoke(chromePath);
  } finally {
    app.kill();
    await new Promise((resolve) => app.once('exit', resolve));
  }
}

main().catch((error) => {
  console.error(`UI layout smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
