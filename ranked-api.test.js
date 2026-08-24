'use strict';

const express = require('express');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService, createAuthConfig, sha256 } = require('./auth');
const { registerRankedRoutes } = require('./ranked-api');
const { MemoryRankedRepository } = require('./ranked-repository');
const { RankedService } = require('./ranked-service');
const { RankedValueLookup, createSignedRankedValueTable } = require('./ranked-values');

const USER_A = '00000000-0000-4000-8000-0000000000d4';
const USER_B = '00000000-0000-4000-8000-0000000000e5';
const TOKEN_A = 'a'.repeat(43);
const CSRF_A = 'c'.repeat(43);
const TOKEN_B = 'b'.repeat(43);
const CSRF_B = 'd'.repeat(43);
const REQUEST_A = '20000000-0000-4000-8000-000000000001';

async function startApi() {
  const repository = new MemoryRankedRepository();
  const config = createAuthConfig({
    NODE_ENV: 'test', APP_ORIGIN: 'http://ranked.test', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'public'
  });
  const auth = new AuthService({ repository, config, fetchImpl: async () => { throw new Error('not used'); } });
  const service = new RankedService({
    repository,
    valueLookup: new RankedValueLookup(createSignedRankedValueTable()),
    seedEncryptionKey: Buffer.alloc(32, 12)
  });
  await repository.ensureProfile(USER_A);
  await repository.ensureProfile(USER_B);
  const farFuture = new Date(Date.now() + 86_400_000);
  await repository.createSession({ id: '30000000-0000-4000-8000-000000000001', userId: USER_A, sessionTokenHash: sha256(TOKEN_A), csrfTokenHash: sha256(CSRF_A), expiresAt: farFuture, idleExpiresAt: farFuture });
  await repository.createSession({ id: '30000000-0000-4000-8000-000000000002', userId: USER_B, sessionTokenHash: sha256(TOKEN_B), csrfTokenHash: sha256(CSRF_B), expiresAt: farFuture, idleExpiresAt: farFuture });

  const app = express();
  registerRankedRoutes(app, {
    runtime: { available: true, service, auth },
    getClientIp: () => '127.0.0.1'
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    repository,
    service,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function headers(token = TOKEN_A, csrf = CSRF_A, origin = 'http://ranked.test') {
  return {
    Origin: origin,
    Cookie: `__Host-overthinking-session=${token}; __Host-overthinking-csrf=${csrf}`,
    'X-CSRF-Token': csrf,
    'Content-Type': 'application/json'
  };
}

async function json(response) {
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('Ranked REST APIはauth/CSRF/Origin/ownership/idempotency/payload境界を強制する', async (t) => {
  const runtime = await startApi();
  t.after(runtime.close);

  const unauthenticated = await fetch(`${runtime.baseUrl}/api/ranked/games/active`);
  assert.equal(unauthenticated.status, 401);

  const login = await fetch(`${runtime.baseUrl}/auth/login/github`, { redirect: 'manual' });
  assert.equal(login.status, 303);
  assert.match(login.headers.get('set-cookie'), /__Host-overthinking-oauth-transaction=.*HttpOnly/);
  assert.equal(new URL(login.headers.get('location')).searchParams.has('state'), false);
  const crossBrowserCallback = await fetch(`${runtime.baseUrl}/auth/callback?code=short`, { redirect: 'manual' });
  assert.equal(crossBrowserCallback.status, 303);
  assert.equal(crossBrowserCallback.headers.get('location'), '/ranked?login=failed');
  assert.match(crossBrowserCallback.headers.get('set-cookie'), /__Host-overthinking-oauth-transaction=.*Max-Age=0/);

  const missingCsrf = await fetch(`${runtime.baseUrl}/api/ranked/games`, { method: 'POST', headers: { Cookie: headers().Cookie, Origin: 'http://ranked.test', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(missingCsrf.status, 403);
  const badOrigin = await fetch(`${runtime.baseUrl}/api/ranked/games`, { method: 'POST', headers: headers(TOKEN_A, CSRF_A, 'https://evil.test'), body: '{}' });
  assert.equal(badOrigin.status, 403);
  const clientSuppliedState = await fetch(`${runtime.baseUrl}/api/ranked/games`, { method: 'POST', headers: headers(), body: JSON.stringify({ score: 999 }) });
  assert.equal(clientSuppliedState.status, 400);

  const created = await json(await fetch(`${runtime.baseUrl}/api/ranked/games`, { method: 'POST', headers: headers(), body: '{}' }));
  assert.equal(created.status, 200);
  assert.equal(created.body.game.status, 'active');
  assert.equal(Object.hasOwn(created.body.game, 'seed'), false);
  assert.equal(JSON.stringify(created.body).includes('encryptedSeed'), false);
  const gameId = created.body.game.id;
  const resumed = await json(await fetch(`${runtime.baseUrl}/api/ranked/games`, { method: 'POST', headers: headers(), body: '{}' }));
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.game.id, gameId);

  const requestBody = JSON.stringify({ expectedRound: 1, cardId: 'ace', requestId: REQUEST_A });
  const [first, duplicate] = await Promise.all([
    json(await fetch(`${runtime.baseUrl}/api/ranked/games/${gameId}/moves`, { method: 'POST', headers: headers(), body: requestBody })),
    json(await fetch(`${runtime.baseUrl}/api/ranked/games/${gameId}/moves`, { method: 'POST', headers: headers(), body: requestBody }))
  ]);
  assert.deepEqual([first.status, duplicate.status].sort(), [200, 200]);
  assert.equal([first.body.idempotent, duplicate.body.idempotent].filter(Boolean).length, 1);
  assert.equal((await runtime.repository.listMoves(gameId)).length, 1);

  const foreign = await fetch(`${runtime.baseUrl}/api/ranked/games/${gameId}/moves`, {
    method: 'POST', headers: headers(TOKEN_B, CSRF_B), body: JSON.stringify({ expectedRound: 2, cardId: 'ace', requestId: '20000000-0000-4000-8000-000000000002' })
  });
  assert.equal(foreign.status, 404);

  const malformedGameId = await fetch(`${runtime.baseUrl}/api/ranked/games/not-a-uuid/moves`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ expectedRound: 2, cardId: 'ace', requestId: '20000000-0000-4000-8000-000000000002' })
  });
  assert.equal(malformedGameId.status, 400);

  const oversized = await fetch(`${runtime.baseUrl}/api/ranked/games/${gameId}/moves`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ junk: 'x'.repeat(5_000) })
  });
  assert.equal(oversized.status, 413);
});

test('leaderboard responseはprivate session/auth identityを返さない', async (t) => {
  const runtime = await startApi();
  t.after(runtime.close);
  const response = await json(await fetch(`${runtime.baseUrl}/api/leaderboard?limit=10`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=15');
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes('sessionTokenHash'), false);
  assert.equal(serialized.includes('userId'), false);
  assert.equal(serialized.includes('email'), false);
});
