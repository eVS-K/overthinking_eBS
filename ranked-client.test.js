'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'ranked-client.js'), 'utf8');

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  constructor() {
    this.attributes = new Map();
    this.children = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.listeners = new Map();
    this.parentElement = null;
    this.textContent = '';
  }
  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type, event = { preventDefault() {} }) { return this.listeners.get(type)?.(event); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, force) { if (force) this.setAttribute(name, ''); else this.removeAttribute(name); }
  querySelector(selector) {
    const cardId = /^\[data-card-id="(.+)"\]$/.exec(selector)?.[1];
    return cardId ? this.children.find((child) => child.dataset?.cardId === cardId) || null : null;
  }
  focus() {}
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
  }
}

function makeProfile(overrides = {}) {
  return {
    handle: 'audit_player', rating: 1000, rank: null, decisionEv: 0.5,
    ratedGames: 0, wins: 0, draws: 0, losses: 0, forfeits: 0,
    leaderboardThreshold: 10, leaderboardVisible: true, provisional: true,
    provisionalProgress: 0, effectiveSampleSize: 0,
    ...overrides
  };
}

function activeGame({ deadline = new Date(Date.now() + 60_000).toISOString() } = {}) {
  return {
    id: 'game-1', status: 'active', currentRound: 1, deadline,
    playerHand: ['ace'], opponentHand: ['king'], playerScore: 0, aiScore: 0,
    aiRemainingCards: 1, stackCount: 0, history: [], versionMismatch: false
  };
}

function completedGame() {
  return {
    id: 'game-1', status: 'completed', actualResult: 'win', playerScore: 9, aiScore: 0,
    history: [], decisionPerformance: 0.75, totalRegret: 0, ratingBefore: 1000,
    ratingAfter: 1001, luck: 0.25, seed: null
  };
}

function response(status, payload) {
  return { status, ok: status >= 200 && status < 300, json: async () => payload };
}

function createClient({ initialGame = null, moveResult = null, settleResult = null } = {}) {
  const elements = new Map();
  const requests = [];
  const document = {
    cookie: '__Host-overthinking-csrf=test-token',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    createElement() { return new FakeElement(); },
    querySelectorAll() { return []; }
  };
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/auth/me') return response(200, { csrfCookieName: '__Host-overthinking-csrf', profile: makeProfile() });
    if (url === '/api/ranked/games/resume') return response(200, { game: initialGame });
    if (url === '/api/ranked/games') return response(200, { game: activeGame() });
    if (url === '/api/ranked/games/game-1/moves') return moveResult || response(200, { game: activeGame() });
    if (url === '/api/ranked/games/active/settle') return settleResult || response(200, { game: initialGame });
    if (url === '/api/profile') return response(200, { profile: makeProfile({ ratedGames: 1, rating: 1001 }) });
    if (url === '/api/leaderboard?limit=25&offset=0') return response(200, { season: { id: 'season-1' }, entries: [], eligibilityGames: 10 });
    throw new Error(`Unexpected request: ${url}`);
  };
  const window = {
    OverthinkingRankedUi: {
      HANDLE_PATTERN: /^[A-Za-z0-9_-]{3,20}$/,
      errorMessage: (code) => code || 'unknown error',
      errorKind: () => 'error'
    },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    location: { href: 'http://localhost/ranked' },
    history: { replaceState() {} },
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval() { return 1; }, clearInterval() {},
    requestAnimationFrame(callback) { callback(); },
    matchMedia() { return { matches: true }; },
    addEventListener() {}, confirm() { return true; }
  };
  vm.runInNewContext(source, { window, document, fetch, URL, console, Date, Promise, Intl, Uint8Array });
  return { elements, requests };
}

async function settleClient() {
  // The browser client has a small chain of async fetch continuations at boot.
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('期限切れmoveが終局を返した場合、成績と公式ランキングを再読み込みする', async () => {
  const client = createClient({
    moveResult: response(409, { error: { code: 'ROUND_EXPIRED', details: { game: completedGame() } } })
  });
  await settleClient();
  client.requests.length = 0;

  await client.elements.get('ranked-start').dispatch('click');
  await client.elements.get('ranked-player-hand').children[0].dispatch('click');
  await client.elements.get('ranked-confirm').dispatch('click');

  assert.equal(client.requests.filter((request) => request.url === '/api/ranked/games/game-1/moves').length, 1);
  assert.equal(client.requests.filter((request) => request.url === '/api/profile').length, 1);
  assert.equal(client.requests.filter((request) => request.url === '/api/leaderboard?limit=25&offset=0').length, 1);
  assert.equal(client.elements.get('ranked-games').textContent, '1');
});

test('タイマーによる終局でも成績と公式ランキングを同時に再読み込みする', async () => {
  const client = createClient({
    initialGame: activeGame({ deadline: new Date(0).toISOString() }),
    settleResult: response(200, { game: completedGame() })
  });
  await settleClient();

  assert.equal(client.requests.filter((request) => request.url === '/api/ranked/games/active/settle').length, 1);
  assert.equal(client.requests.filter((request) => request.url === '/api/profile').length, 1);
  // The initial active-game boot fetch and the terminal settlement each need
  // their own snapshot; the latter is the regression guard.
  assert.equal(client.requests.filter((request) => request.url === '/api/leaderboard?limit=25&offset=0').length, 2);
  assert.equal(client.elements.get('ranked-games').textContent, '1');
});
