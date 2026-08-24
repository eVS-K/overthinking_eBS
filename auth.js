'use strict';

const crypto = require('crypto');
const { RankedError } = require('./ranked-service');

const SESSION_COOKIE_NAME = '__Host-overthinking-session';
const CSRF_COOKIE_NAME = '__Host-overthinking-csrf';
const OAUTH_TRANSACTION_COOKIE_NAME = '__Host-overthinking-oauth-transaction';
const OAUTH_TRANSACTION_TTL_MS = 10 * 60_000;
const DEFAULT_SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_SESSION_IDLE_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS = 8_000;

function base64urlRandom(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function timingSafeEqualText(left, right) {
  const first = Buffer.from(String(left));
  const second = Buffer.from(String(right));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function readDuration(value, fallback, { min = 60_000, max = 365 * 24 * 60 * 60_000 } = {}) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function createAuthConfig(environment = process.env) {
  const appOrigin = normalizeOrigin(environment.APP_ORIGIN || environment.RANKED_APP_ORIGIN);
  const production = environment.NODE_ENV === 'production';
  const configuredOrigin = appOrigin || (production ? '' : 'http://localhost:3000');
  return {
    appOrigin: configuredOrigin,
    supabaseUrl: normalizeOrigin(environment.SUPABASE_URL),
    supabaseAnonKey: environment.SUPABASE_ANON_KEY || environment.SUPABASE_PUBLISHABLE_KEY || '',
    sessionAbsoluteMs: readDuration(environment.SESSION_ABSOLUTE_MS, DEFAULT_SESSION_ABSOLUTE_MS),
    sessionIdleMs: readDuration(environment.SESSION_IDLE_MS, DEFAULT_SESSION_IDLE_MS),
    supabaseRequestTimeoutMs: readDuration(environment.SUPABASE_REQUEST_TIMEOUT_MS, DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS, { min: 1_000, max: 30_000 }),
    cookieSecure: production || configuredOrigin.startsWith('https://') || environment.COOKIE_SECURE === 'true',
    production
  };
}

function isAuthConfigured(config) {
  return Boolean(
    config?.appOrigin
    && config?.supabaseUrl
    && config?.supabaseAnonKey
    && (!config.production || (config.appOrigin.startsWith('https://') && config.supabaseUrl.startsWith('https://')))
  );
}

function parseCookies(header) {
  if (typeof header !== 'string' || header.length > 8_192) return {};
  const cookies = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!name || rawValue.length > 4_096) continue;
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      // Ignore malformed individual cookie values.
    }
  }
  return cookies;
}

function serializeCookie(name, value, {
  maxAge,
  httpOnly = true,
  secure = true,
  sameSite = 'Lax',
  path = '/'
} = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (Number.isSafeInteger(maxAge)) parts.push(`Max-Age=${Math.max(0, maxAge)}`);
  return parts.join('; ');
}

function generatePkce() {
  const codeVerifier = base64urlRandom(48);
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
  return { codeVerifier, codeChallenge };
}

function makeAuthorizationUrl(config, { provider, codeChallenge, redirectUri }) {
  if (!['google', 'github'].includes(provider)) throw new RankedError(400, 'UNSUPPORTED_PROVIDER', 'Unsupported sign-in provider.');
  const url = new URL('/auth/v1/authorize', config.supabaseUrl);
  url.searchParams.set('provider', provider);
  url.searchParams.set('redirect_to', redirectUri);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function ensureUuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RankedError(502, 'IDENTITY_PROVIDER_RESPONSE_INVALID', 'Identity provider returned an invalid user identity.');
  }
  return value.toLowerCase();
}

async function fetchWithTimeout(fetchImpl, input, init, timeoutMs = DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS) {
  if (typeof fetchImpl !== 'function') {
    throw new RankedError(503, 'AUTH_RUNTIME_UNAVAILABLE', 'The authentication runtime is unavailable.');
  }
  if (typeof AbortController !== 'function') return fetchImpl(input, init);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    // Do not allow a stalled identity-provider request to occupy a Node worker
    // forever.  The provider token is never persisted, so a user can safely
    // restart the OAuth flow after this bounded failure.
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new RankedError(503, 'IDENTITY_PROVIDER_UNAVAILABLE', 'The identity provider did not respond in time.');
    }
    throw new RankedError(503, 'IDENTITY_PROVIDER_UNAVAILABLE', 'The identity provider could not be reached.');
  } finally {
    clearTimeout(timer);
  }
}

async function readProviderJson(response, message, timeoutMs = DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS) {
  let timer;
  try {
    const body = response.json();
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new RankedError(503, 'IDENTITY_PROVIDER_UNAVAILABLE', 'The identity provider response timed out.')), timeoutMs);
      timer.unref?.();
    });
    return await Promise.race([body, timedOut]);
  } catch (error) {
    if (error instanceof RankedError) throw error;
    throw new RankedError(502, 'IDENTITY_PROVIDER_RESPONSE_INVALID', message);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchSupabaseUser(config, { authCode, codeVerifier, fetchImpl = globalThis.fetch }) {
  const tokenResponse = await fetchWithTimeout(fetchImpl, `${config.supabaseUrl}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseAnonKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ auth_code: authCode, code_verifier: codeVerifier })
  }, config.supabaseRequestTimeoutMs);
  if (!tokenResponse.ok) throw new RankedError(401, 'OAUTH_EXCHANGE_FAILED', 'Sign-in could not be completed.');
  const tokenPayload = await readProviderJson(tokenResponse, 'Identity provider returned an invalid session.', config.supabaseRequestTimeoutMs);
  if (!tokenPayload || typeof tokenPayload.access_token !== 'string' || tokenPayload.access_token.length > 8_192) {
    throw new RankedError(502, 'IDENTITY_PROVIDER_RESPONSE_INVALID', 'Identity provider returned an invalid session.');
  }
  const userResponse = await fetchWithTimeout(fetchImpl, `${config.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${tokenPayload.access_token}` }
  }, config.supabaseRequestTimeoutMs);
  // Provider tokens are intentionally discarded immediately after this request.
  if (!userResponse.ok) throw new RankedError(401, 'OAUTH_USER_LOOKUP_FAILED', 'Sign-in could not be completed.');
  const user = await readProviderJson(userResponse, 'Identity provider returned an invalid user identity.', config.supabaseRequestTimeoutMs);
  return { userId: ensureUuid(user?.id) };
}

class AuthService {
  constructor({ repository, config = createAuthConfig(), fetchImpl = globalThis.fetch, now = () => new Date() }) {
    if (!repository) throw new TypeError('auth repository is required');
    this.repository = repository;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  nowDate() {
    const now = this.now();
    const date = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(date.getTime())) throw new Error('invalid clock');
    return date;
  }

  assertConfigured() {
    if (!isAuthConfigured(this.config)) {
      throw new RankedError(503, 'AUTH_UNAVAILABLE', 'Ranked sign-in is not configured.');
    }
  }

  async beginOAuth(provider) {
    this.assertConfigured();
    if (!['google', 'github'].includes(provider)) {
      throw new RankedError(404, 'UNSUPPORTED_PROVIDER', 'Unsupported sign-in provider.');
    }
    // Supabase owns the OAuth provider `state` value. Supplying our own state
    // to its /authorize endpoint makes GoTrue reject the request as
    // bad_oauth_state. The application uses this separate opaque transaction
    // token only in its HttpOnly cookie and hashed database record.
    const transactionToken = base64urlRandom(32);
    const pkce = generatePkce();
    const now = this.nowDate();
    const redirectUri = `${this.config.appOrigin}/auth/callback`;
    await this.repository.createOAuthTransaction({
      stateHash: sha256(transactionToken),
      provider,
      codeVerifier: pkce.codeVerifier,
      redirectUri,
      expiresAt: new Date(now.getTime() + OAUTH_TRANSACTION_TTL_MS)
    });
    return {
      transactionToken,
      authorizationUrl: makeAuthorizationUrl(this.config, {
        provider,
        codeChallenge: pkce.codeChallenge,
        redirectUri
      })
    };
  }

  async completeOAuth({ code, oauthTransactionToken, previousSessionToken }) {
    this.assertConfigured();
    if (typeof code !== 'string' || code.length < 1 || code.length > 2_048) {
      throw new RankedError(400, 'INVALID_OAUTH_CALLBACK', 'The sign-in callback is invalid.');
    }
    // Bind this one-time PKCE transaction to the browser that started it.
    // Supabase validates its own OAuth `state`; this HttpOnly cookie prevents
    // cross-browser callback/session swap at the application boundary.
    if (typeof oauthTransactionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(oauthTransactionToken)) {
      throw new RankedError(400, 'OAUTH_TRANSACTION_INVALID', 'The sign-in flow could not be verified.');
    }
    const transaction = await this.repository.transaction((tx) => tx.consumeOAuthTransaction(sha256(oauthTransactionToken), this.nowDate()));
    if (!transaction) throw new RankedError(400, 'OAUTH_TRANSACTION_INVALID', 'The sign-in flow expired or was already used.');
    const identity = await fetchSupabaseUser(this.config, {
      authCode: code,
      codeVerifier: transaction.codeVerifier,
      fetchImpl: this.fetchImpl
    });
    const now = this.nowDate();
    return this.repository.transaction(async (tx) => {
      const profile = await tx.ensureProfile(identity.userId);
      if (!profile || profile.status !== 'active') {
        throw new RankedError(403, 'PROFILE_UNAVAILABLE', 'This account cannot use Ranked mode.');
      }
      if (previousSessionToken && /^[A-Za-z0-9_-]{43}$/.test(previousSessionToken)) {
        const previous = await tx.findActiveSessionByTokenHash(sha256(previousSessionToken), now);
        if (previous) await tx.revokeSession(previous.id, now);
      }
      const sessionToken = base64urlRandom(32);
      const csrfToken = base64urlRandom(32);
      const absoluteExpiry = new Date(now.getTime() + this.config.sessionAbsoluteMs);
      const idleExpiry = new Date(Math.min(absoluteExpiry.getTime(), now.getTime() + this.config.sessionIdleMs));
      const session = await tx.createSession({
        id: crypto.randomUUID(),
        userId: identity.userId,
        sessionTokenHash: sha256(sessionToken),
        csrfTokenHash: sha256(csrfToken),
        expiresAt: absoluteExpiry,
        idleExpiresAt: idleExpiry
      });
      return { session, sessionToken, csrfToken, profile };
    });
  }

  async authenticate(sessionToken) {
    if (typeof sessionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) {
      throw new RankedError(401, 'AUTH_REQUIRED', 'Sign-in is required for Ranked mode.');
    }
    const now = this.nowDate();
    const session = await this.repository.findActiveSessionByTokenHash(sha256(sessionToken), now);
    if (!session || !session.profile || session.profile.status !== 'active') {
      throw new RankedError(401, 'AUTH_REQUIRED', 'Sign-in is required for Ranked mode.');
    }
    const absoluteExpiry = new Date(session.expiresAt);
    const idleExpiry = new Date(Math.min(absoluteExpiry.getTime(), now.getTime() + this.config.sessionIdleMs));
    await this.repository.touchSession(session.id, now, idleExpiry);
    return { ...session, idleExpiresAt: idleExpiry };
  }

  async logout(sessionToken) {
    if (typeof sessionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return;
    const session = await this.repository.findActiveSessionByTokenHash(sha256(sessionToken), this.nowDate());
    if (session) await this.repository.revokeSession(session.id, this.nowDate());
  }

  validateCsrf(session, csrfToken) {
    if (typeof csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrfToken)
      || !timingSafeEqualText(sha256(csrfToken), session.csrfTokenHash)) {
      throw new RankedError(403, 'CSRF_REJECTED', 'The request could not be verified.');
    }
  }

  validateOrigin(origin) {
    if (!this.config.appOrigin || normalizeOrigin(origin) !== this.config.appOrigin) {
      throw new RankedError(403, 'ORIGIN_REJECTED', 'The request origin is not allowed.');
    }
  }

  sessionCookie(sessionToken) {
    return serializeCookie(SESSION_COOKIE_NAME, sessionToken, {
      maxAge: Math.floor(this.config.sessionAbsoluteMs / 1_000),
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'Lax',
      path: '/'
    });
  }

  csrfCookie(csrfToken) {
    return serializeCookie(CSRF_COOKIE_NAME, csrfToken, {
      maxAge: Math.floor(this.config.sessionAbsoluteMs / 1_000),
      httpOnly: false,
      secure: this.config.cookieSecure,
      sameSite: 'Lax',
      path: '/'
    });
  }

  oauthTransactionCookie(transactionToken) {
    if (typeof transactionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(transactionToken)) throw new TypeError('OAuth transaction is invalid');
    return serializeCookie(OAUTH_TRANSACTION_COOKIE_NAME, transactionToken, {
      maxAge: Math.floor(OAUTH_TRANSACTION_TTL_MS / 1_000),
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'Lax',
      path: '/'
    });
  }

  clearOAuthTransactionCookie() {
    return serializeCookie(OAUTH_TRANSACTION_COOKIE_NAME, '', {
      maxAge: 0,
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'Lax',
      path: '/'
    });
  }

  clearCookies() {
    return [
      serializeCookie(SESSION_COOKIE_NAME, '', { maxAge: 0, httpOnly: true, secure: this.config.cookieSecure, sameSite: 'Lax', path: '/' }),
      serializeCookie(CSRF_COOKIE_NAME, '', { maxAge: 0, httpOnly: false, secure: this.config.cookieSecure, sameSite: 'Lax', path: '/' }),
      this.clearOAuthTransactionCookie()
    ];
  }
}

function createAuthMiddleware(authService) {
  async function requireAuth(request, _response, next) {
    try {
      const sessionToken = parseCookies(request.headers.cookie || '')[SESSION_COOKIE_NAME];
      request.auth = await authService.authenticate(sessionToken);
      next();
    } catch (error) {
      next(error);
    }
  }

  function requireStateChange(request, _response, next) {
    try {
      authService.validateOrigin(request.headers.origin);
      authService.validateCsrf(request.auth, request.headers['x-csrf-token']);
      next();
    } catch (error) {
      next(error);
    }
  }

  return { requireAuth, requireStateChange };
}

module.exports = {
  AuthService,
  CSRF_COOKIE_NAME,
  DEFAULT_SESSION_ABSOLUTE_MS,
  DEFAULT_SESSION_IDLE_MS,
  DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS,
  OAUTH_TRANSACTION_TTL_MS,
  OAUTH_TRANSACTION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  base64urlRandom,
  createAuthConfig,
  createAuthMiddleware,
  fetchWithTimeout,
  fetchSupabaseUser,
  generatePkce,
  isAuthConfigured,
  makeAuthorizationUrl,
  normalizeOrigin,
  parseCookies,
  readProviderJson,
  serializeCookie,
  sha256,
  timingSafeEqualText
};
