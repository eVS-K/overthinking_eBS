'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RankedError } = require('./ranked-service');
const { MemoryRankedRepository } = require('./ranked-repository');
const {
  AuthService,
  DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS,
  OAUTH_TRANSACTION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  createAuthConfig,
  fetchWithTimeout,
  isAuthConfigured,
  normalizeOAuthReturnPath,
  parseCookies,
  readProviderJson,
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
  assert.equal(new URL(begin.authorizationUrl).searchParams.has('state'), false);
  return service.completeOAuth({ code: 'short-lived-auth-code', oauthTransactionToken: begin.transactionToken, previousSessionToken });
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
  const profile = await repository.getProfile(USER_ID);
  assert.equal(profile.handle.includes('player-'), true);
  assert.equal(profile.handle.includes(USER_ID.replace(/-/g, '').slice(0, 13)), false);
});

test('OAuth transactionは一回限りで、session rotationは古いsessionを失効させる', async () => {
  const { service } = makeRuntime();
  const first = await finishLogin(service);
  const begin = await service.beginOAuth('google');
  const second = await service.completeOAuth({ code: 'another-code', oauthTransactionToken: begin.transactionToken, previousSessionToken: first.sessionToken });
  await assert.rejects(service.authenticate(first.sessionToken), (error) => error instanceof RankedError && error.code === 'AUTH_REQUIRED');
  assert.equal((await service.authenticate(second.sessionToken)).userId, USER_ID);
  await assert.rejects(service.completeOAuth({ code: 'another-code', oauthTransactionToken: begin.transactionToken }), (error) => error instanceof RankedError && error.code === 'OAUTH_TRANSACTION_INVALID');
});

test('OAuth callbackは開始したbrowserのHttpOnly transaction cookieなしには完了しない', async () => {
  const { service } = makeRuntime();
  const begin = await service.beginOAuth('github');
  await assert.rejects(
    service.completeOAuth({ code: 'short-lived-auth-code', oauthTransactionToken: 'x'.repeat(43) }),
    (error) => error instanceof RankedError && error.code === 'OAUTH_TRANSACTION_INVALID'
  );
  // A rejected cross-browser callback does not consume the legitimate flow.
  const completed = await service.completeOAuth({ code: 'short-lived-auth-code', oauthTransactionToken: begin.transactionToken });
  assert.equal((await service.authenticate(completed.sessionToken)).userId, USER_ID);
});

test('OAuthの復帰先はPrivate画面またはRanked画面だけに固定される', async () => {
  const { service } = makeRuntime();
  const privateBegin = await service.beginOAuth('google', { returnPath: '/' });
  const privateLogin = await service.completeOAuth({ code: 'short-lived-auth-code', oauthTransactionToken: privateBegin.transactionToken });
  assert.equal(privateLogin.returnPath, '/');

  const externalBegin = await service.beginOAuth('github', { returnPath: 'https://evil.example/steal' });
  const rankedLogin = await service.completeOAuth({ code: 'short-lived-auth-code', oauthTransactionToken: externalBegin.transactionToken });
  assert.equal(rankedLogin.returnPath, '/ranked');
  assert.equal(normalizeOAuthReturnPath('/'), '/');
  assert.equal(normalizeOAuthReturnPath('/ranked'), '/ranked');
  assert.equal(normalizeOAuthReturnPath('//evil.example'), '/ranked');
});

test('OAuthの後段保存が失敗しても、検証済みのPrivate復帰先だけを引き継ぐ', async () => {
  const { service, repository } = makeRuntime();
  const begin = await service.beginOAuth('google', { returnPath: '/' });
  repository.ensureProfile = async () => {
    throw new Error('profile persistence failed');
  };
  await assert.rejects(
    service.completeOAuth({ code: 'short-lived-auth-code', oauthTransactionToken: begin.transactionToken }),
    (error) => error instanceof Error && error.returnPath === '/'
  );
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
  const oauthCookie = runtime.service.oauthTransactionCookie('c'.repeat(43));
  assert.match(sessionCookie, /^__Host-overthinking-session=/);
  assert.match(sessionCookie, /; Path=\//);
  assert.match(sessionCookie, /; Secure/);
  assert.match(sessionCookie, /; HttpOnly/);
  assert.doesNotMatch(csrfCookie, /HttpOnly/);
  assert.match(oauthCookie, new RegExp(`^${OAUTH_TRANSACTION_COOKIE_NAME}=`));
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

test('identity provider呼び出しには短い上限時間を設け、停止時は503扱いにする', async () => {
  const config = createAuthConfig({
    NODE_ENV: 'test', APP_ORIGIN: 'http://localhost:3000', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'public', SUPABASE_REQUEST_TIMEOUT_MS: '3000'
  });
  assert.equal(config.supabaseRequestTimeoutMs, 3000);
  assert.equal(createAuthConfig({}).supabaseRequestTimeoutMs, DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS);

  let aborted = false;
  await assert.rejects(
    fetchWithTimeout(async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }), 'https://example.supabase.co/auth/v1/user', {}, 20),
    (error) => error instanceof RankedError && error.code === 'IDENTITY_PROVIDER_UNAVAILABLE'
  );
  assert.equal(aborted, true);

  await assert.rejects(
    readProviderJson({ json: async () => new Promise(() => {}) }, 'invalid response', 20),
    (error) => error instanceof RankedError && error.code === 'IDENTITY_PROVIDER_UNAVAILABLE'
  );
});
