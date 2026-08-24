'use strict';

const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_CHAT_IPS_PER_ROOM, app, buildDefaultAllowedOrigins, consumeChatIpQuota, createRoom } = require('./server');

function start(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('Guest chatのIP補助quotaはroom内の追跡IP数を上限で抑える', () => {
  const room = createRoom('chat-cap-test');
  const now = Date.now();
  for (let index = 0; index < MAX_CHAT_IPS_PER_ROOM; index += 1) {
    assert.equal(consumeChatIpQuota(room, `192.0.2.${index}`, now).ok, true);
  }
  const overflow = consumeChatIpQuota(room, '198.51.100.1', now);
  assert.equal(overflow.ok, false);
  assert.equal(room.chatIpUsage.size, MAX_CHAT_IPS_PER_ROOM);
});

test('Originの既定値はNODE_ENV未設定・productionでlocalhostを許可しない', () => {
  for (const environment of [{}, { NODE_ENV: 'production' }]) {
    const origins = buildDefaultAllowedOrigins(environment);
    assert.equal(origins.includes('http://localhost:3000'), false);
    assert.equal(origins.includes('http://127.0.0.1:3000'), false);
  }
  assert.equal(buildDefaultAllowedOrigins({ NODE_ENV: 'development' }).includes('http://localhost:3000'), true);
  assert.equal(buildDefaultAllowedOrigins({ NODE_ENV: 'test' }).includes('http://127.0.0.1:3000'), true);
});

test('legacy applicationはRanked未設定でも起動し、Ranked入口を安全に配信する', async (t) => {
  const localServer = http.createServer(app);
  const port = await start(localServer);
  t.after(() => new Promise((resolve) => localServer.close(resolve)));

  const [health, ranked, rankedUi, legacyIndex, oauthRecovery] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/health`),
    fetch(`http://127.0.0.1:${port}/ranked`),
    fetch(`http://127.0.0.1:${port}/ranked-ui.js`),
    fetch(`http://127.0.0.1:${port}/`),
    fetch(`http://127.0.0.1:${port}/oauth-recovery.js`)
  ]);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  assert.equal(ranked.status, 200);
  assert.match(ranked.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(ranked.headers.get('content-security-policy'), /script-src 'self'/);
  const rankedHtml = await ranked.text();
  assert.match(rankedHtml, /ランク戦/);
  assert.match(rankedHtml, /ranked-ui\.js/);
  assert.match(rankedHtml, /href="https:\/\/evs-k\.github\.io\/overthinking_eBS\/"/);
  assert.equal(rankedUi.status, 200);
  assert.match(await rankedUi.text(), /HANDLE_PATTERN/);
  const legacyHtml = await legacyIndex.text();
  assert.match(legacyHtml, /overthinking-ebs\.onrender\.com\/socket\.io\/socket\.io\.js/);
  assert.doesNotMatch(legacyHtml, /cdn\.socket\.io/);
  assert.equal(oauthRecovery.status, 200);
  assert.match(await oauthRecovery.text(), /HttpOnly transaction cookie/);
});
