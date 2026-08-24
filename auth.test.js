'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RankedError } = require('./ranked-service');
const { MemoryRankedRepository } = require('./ranked-repository');
const {
  AuthService,
  SESSION_COOKIE_NAME,
  createAuthConfig,
  isAuthConfigured,
  parseCookies,
  sha256
} = require('./auth');

const USER_ID = '00000000-0000-4000-8000-0000000000c3';

function makeFetch() {
  return async (url) => {
    if (url.includes('/token?grant_type=pkce')) {
      return { ok: true, json: async () => ({ access_token: 'provider-token-that-is-not-persisted' }) };
    }
    if (url.endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ id: USER_ID, email: 'private@example.test' }) };
    throw new Error(`unexpected URL ${url}`);
  };
}

function makeRuntime() {
  let current = new Date('2026-08-24T00:00:00.000Z');
  const repository = new MemoryRankedRepository();
  const config = createAuthConfig({
    NODE_ENV: 'test',
    APP_ORIGIN: 'http://localhost:3000',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'public-anon-key',
    SESSION_ABSOLUTE_MS: String(30 * 24 * 60 * 60_000),
    SESSION_IDLE_MS: String(7 * 24 * 60 * 60_000)
  });
  const service = new AuthService({ repository, config, fetchImpl: makeFetch(), now: () => new Date(current) });
  return { repository, service, config, advance(ms) { current = new Date(current.getTime() + ms); } };
}

async function finishLogin(service, previousSessionToken) {
  const begin = await service.beginOAuth('github');
  const state = new URL(begin.authorizationUrl).searchParams.get('state');
  return service.completeOAuth({ code: 'short-lived-auth-code', state, oauthStateToken: state, previousSessionToken });
}

test('OAuth PKCE callbackはprovider tokenを保持せずhash化したapp sessionへ交換する', async () => {
  const { repository, service } = makeRuntime();
  const result = await finishLogin(service);
  const session = await service.authenticate(result.sessionToken);
  assert.equal(session.userId, USER_ID);
  assert.equal(repository.sessions.size, 1);
  const persisted = [...repository.sessions.values()][0];
  assert.equal(persisted.sessionTokenHash, sha256(result.sessionToken));
  assert.notEqual(persisted.sessionTokenHash, result.sessionToken);
  assert.equal(JSON.stringify(persisted).includes('provider-token'), false);
  assert.equal((await repository.getProfile(USER_ID)).handle.includes('player-'), true);
});

test('OAuth stateは一回限りで、session rotationは古いsessionを失効させる', async () => {
  const { service } = makeRuntime();
  const first = await finishLogin(service);
  const begin = await service.beginOAuth('google');
  const state = new URL(begin.authorizationUrl).searchParams.get('state');
  const second = await service.completeOAuth({ code: 'another-code', state, oauthStateToken: state, previousSessionToken: first.sessionToken });
  await assert.rejects(service.authenticate(first.sessionToken), (error) => error instanceof RankedError && error.code === 'AUTH_REQUIRED');
  assert.equal((await service.authenticate(second.sessionToken)).userId, USER_ID);
  await assert.rejects(service.completeOAuth({ code: 'another-code', state, oauthStateToken: state }), (error) => error instanceof RankedError && error.code === 'OAUTH_STATE_INVALID');
});

test('OAuth callbackは開始したbrowserのHttpOnly state cookieなしには完了しない', async () => {
  const { service } = makeRuntime();
  const begin = await service.beginOAuth('github');
  const state = new URL(begin.authorizationUrl).searchParams.get('state');
  await assert.rejects(
    service.completeOAuth({ code: 'short-lived-auth-code', state, oauthStateToken: 'x'.repeat(43) }),
    (error) => error instanceof RankedError && error.code === 'OAUTH_STATE_INVALID'
  );
  // A rejected cross-browser callback does not consume the legitimate flow.
  const completed = await service.completeOAuth({ code: 'short-lived-auth-code', state, oauthStateToken: state });
  assert.equal((await service.authenticate(completed.sessionToken)).userId, USER_ID);
});

test('CSRF / Origin / logout / expiry / banned account を拒否する', async () => {
  const runtime = makeRuntime();
  const result = await finishLogin(runtime.service);
  const session = await runtime.service.authenticate(result.sessionToken);
  assert.throws(() => runtime.service.validateOrigin('https://evil.example'), (error) => error instanceof RankedError && error.code === 'ORIGIN_REJECTED');
  assert.throws(() => runtime.service.validateCsrf(session, 'bad'), (error) => error instanceof RankedError && error.code === 'CSRF_REJECTED');
  runtime.service.validateOrigin('http://localhost:3000');
  runtime.service.validateCsrf(session, result.csrfToken);
  await runtime.service.logout(result.sessionToken);
  await assert.rejects(runtime.service.authenticate(result.sessionToken), (error) => error instanceof RankedError && error.code === 'AUTH_REQUIRED');

  const expiring = await finishLogin(runtime.service);
  runtime.advance(runtime.config.sessionIdleMs + 1);
  await assert.rejects(runtime.service.authenticate(expiring.sessionToken), (error) => error instanceof RankedError && error.code === 'AUTH_REQUIRED');

  const renewed = await finishLogin(runtime.service);
  runtime.repository.profiles.get(USER_ID).status = 'banned';
  await assert.rejects(runtime.service.authenticate(renewed.sessionToken), (error) => error instanceof RankedError && error.code === 'AUTH_REQUIRED');
});

test('production cookieは__Host session属性を満たし、CSRF値は認証cookieと分離する', () => {
  const runtime = makeRuntime();
  runtime.service.config.cookieSecure = true;
  const sessionCookie = runtime.service.sessionCookie('a'.repeat(43));
  const csrfCookie = runtime.service.csrfCookie('b'.repeat(43));
  const oauthCookie = runtime.service.oauthStateCookie('c'.repeat(43));
  assert.match(sessionCookie, /^__Host-overthinking-session=/);
  assert.match(sessionCookie, /; Path=\//);
  assert.match(sessionCookie, /; Secure/);
  assert.match(sessionCookie, /; HttpOnly/);
  assert.doesNotMatch(csrfCookie, /HttpOnly/);
  assert.match(oauthCookie, /^__Host-overthinking-oauth-state=/);
  assert.match(oauthCookie, /; HttpOnly/);
  assert.equal(parseCookies(`${SESSION_COOKIE_NAME}=token; other=value`)[SESSION_COOKIE_NAME], 'token');
});

test('production AuthはHTTPS originなしではfail closedする', () => {
  const config = createAuthConfig({
    NODE_ENV: 'production', APP_ORIGIN: 'http://ranked.test', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'public'
  });
  assert.equal(config.cookieSecure, true);
  assert.equal(isAuthConfigured(config), false);
});
