'use strict';

const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./server');

function start(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('legacy applicationはRanked未設定でも起動し、Ranked入口を安全に配信する', async (t) => {
  const localServer = http.createServer(app);
  const port = await start(localServer);
  t.after(() => new Promise((resolve) => localServer.close(resolve)));

  const [health, ranked, oauthRecovery] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/health`),
    fetch(`http://127.0.0.1:${port}/ranked`),
    fetch(`http://127.0.0.1:${port}/oauth-recovery.js`)
  ]);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  assert.equal(ranked.status, 200);
  assert.match(ranked.headers.get('content-security-policy'), /default-src 'self'/);
  const rankedHtml = await ranked.text();
  assert.match(rankedHtml, /RANKED vs RANDOM/);
  assert.match(rankedHtml, /href="https:\/\/evs-k\.github\.io\/overthinking_eBS\/"/);
  assert.equal(oauthRecovery.status, 200);
  assert.match(await oauthRecovery.text(), /HttpOnly state cookie/);
});
