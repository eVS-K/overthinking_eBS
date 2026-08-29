'use strict';

const express = require('express');
const { CSRF_COOKIE_NAME, OAUTH_TRANSACTION_COOKIE_NAME, SESSION_COOKIE_NAME, createAuthMiddleware, normalizeOAuthReturnPath, parseCookies } = require('./auth');
const { createFixedWindowLimiter } = require('./security');
const { RankedError } = require('./ranked-service');

const RETRYABLE_OAUTH_FAILURE_CODES = new Set([
  'INVALID_OAUTH_CALLBACK',
  'OAUTH_TRANSACTION_INVALID',
  'OAUTH_EXCHANGE_FAILED',
  'OAUTH_USER_LOOKUP_FAILED',
  'IDENTITY_PROVIDER_RESPONSE_INVALID'
]);

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function noStore(response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Pragma', 'no-cache');
}

function isRetryableOAuthFailure(error) {
  return error instanceof RankedError && RETRYABLE_OAUTH_FAILURE_CODES.has(error.code);
}

function sendError(response, error) {
  // A public leaderboard route normally permits a short cache lifetime, but
  // never allow an outage/schema error to be cached and shown after recovery.
  noStore(response);
  if (error instanceof RankedError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
    return;
  }
  if (error?.type === 'entity.too.large' || error?.status === 413) {
    response.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request payload is too large.' } });
    return;
  }
  if (error instanceof SyntaxError || error?.status === 400) {
    response.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } });
    return;
  }
  response.status(500).json({ error: { code: 'RANKED_REQUEST_FAILED', message: 'Ranked request could not be completed.' } });
}

function createRateLimit({ limit, windowMs, getKey, maxEntries = 20_000, store = null }) {
  // `store` intentionally has the tiny { consume(key) } interface. The local
  // fixed-window implementation is safe for one Render instance; a Redis or
  // other shared implementation can be supplied during horizontal scaling and
  // may return either a boolean or Promise<boolean>.
  const limiter = store || createFixedWindowLimiter({ limit, windowMs, maxEntries });
  return (request, _response, next) => {
    let key;
    try { key = getKey(request); } catch (error) { next(error); return; }
    Promise.resolve(limiter.consume(key)).then((allowed) => {
      if (!allowed) {
        next(new RankedError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.'));
        return;
      }
      next();
    }).catch(next);
  };
}

function requireEmptyObject(request, _response, next) {
  const body = request.body;
  if (body === undefined || (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0)) {
    next();
    return;
  }
  next(new RankedError(400, 'INVALID_REQUEST', 'This request does not accept client-supplied fields.'));
}

function registerUnavailableRankedRoutes(app) {
  const unavailable = (_request, response) => {
    noStore(response);
    response.status(503).json({ error: { code: 'RANKED_UNAVAILABLE', message: 'Ranked mode is temporarily unavailable.' } });
  };
  app.use('/api/ranked', unavailable);
  app.use('/api/leaderboard', unavailable);
  app.use('/api/profile', unavailable);
  app.use('/api/private-presets', unavailable);
  app.use('/api/auth', unavailable);
  app.get('/auth/login/:provider', unavailable);
  app.get('/auth/callback', unavailable);
}

function oauthResultPath(returnPath, result) {
  const safePath = normalizeOAuthReturnPath(returnPath);
  return `${safePath}?login=${encodeURIComponent(result)}`;
}

function registerRankedRoutes(app, { runtime, getClientIp, logger = console }) {
  if (!runtime?.available) {
    registerUnavailableRankedRoutes(app);
    return;
  }

  const router = express.Router();
  const { auth, service, privatePresetService } = runtime;
  const { requireAuth, requireStateChange } = createAuthMiddleware(auth);
  const byIp = (request) => `ip:${getClientIp(request)}`;
  const byUser = (request) => `user:${request.auth.userId}`;
  const authLoginLimit = createRateLimit({ limit: 12, windowMs: 10 * 60_000, getKey: byIp });
  const authCallbackLimit = createRateLimit({ limit: 30, windowMs: 10 * 60_000, getKey: byIp });
  const gameCreateLimit = createRateLimit({ limit: 12, windowMs: 60 * 60_000, getKey: byUser });
  const gameReadLimit = createRateLimit({ limit: 120, windowMs: 60_000, getKey: byUser });
  const gameSettleLimit = createRateLimit({ limit: 30, windowMs: 60_000, getKey: byUser });
  const moveLimit = createRateLimit({ limit: 90, windowMs: 60_000, getKey: byUser });
  const forfeitLimit = createRateLimit({ limit: 12, windowMs: 60 * 60_000, getKey: byUser });
  const profileLimit = createRateLimit({ limit: 12, windowMs: 60 * 60_000, getKey: byUser });
  const leaderboardLimit = createRateLimit({ limit: 120, windowMs: 60_000, getKey: byIp });
  const authSessionLimit = createRateLimit({ limit: 120, windowMs: 60_000, getKey: byUser });
  const privatePresetReadLimit = createRateLimit({ limit: 60, windowMs: 60_000, getKey: byUser });
  const privatePresetWriteLimit = createRateLimit({ limit: 30, windowMs: 10 * 60_000, getKey: byUser });

  const redirectOAuthFailure = (response, error, returnPath = '/ranked') => {
    // Only validation/exchange failures are actionable by immediately trying
    // OAuth again. Database/provider outages need a distinct path so users do
    // not mistake a server incident for a bad Google/GitHub account.
    const retryableSignInFailure = isRetryableOAuthFailure(error);
    logger.warn?.(`Ranked OAuth request failed: ${error?.code || error?.name || 'unknown'}`);
    // If an earlier sign-in transaction cookie exists, do not leave it usable
    // after a new sign-in attempt could not even start.  The database record
    // remains short lived and hashed, but the browser can no longer present
    // an accidental stale transaction on a later callback.
    response.append('Set-Cookie', auth.clearOAuthTransactionCookie());
    response.redirect(303, oauthResultPath(returnPath, retryableSignInFailure ? 'failed' : 'unavailable'));
  };

  router.get('/auth/login/:provider', authLoginLimit, asyncRoute(async (request, response) => {
    noStore(response);
    const returnPath = normalizeOAuthReturnPath(request.query.returnTo);
    let result;
    try {
      result = await auth.beginOAuth(request.params.provider, { returnPath });
    } catch (error) {
      if (error instanceof RankedError && error.code === 'UNSUPPORTED_PROVIDER') throw error;
      redirectOAuthFailure(response, error, returnPath);
      return;
    }
    response.setHeader('Set-Cookie', auth.oauthTransactionCookie(result.transactionToken));
    response.redirect(303, result.authorizationUrl);
  }));

  router.get('/auth/callback', authCallbackLimit, asyncRoute(async (request, response) => {
    noStore(response);
    response.setHeader('Referrer-Policy', 'no-referrer');
    const cookies = parseCookies(request.headers.cookie || '');
    let result;
    try {
      result = await auth.completeOAuth({
        code: request.query.code,
        oauthTransactionToken: cookies[OAUTH_TRANSACTION_COOKIE_NAME],
        previousSessionToken: cookies[SESSION_COOKIE_NAME]
      });
    } catch (error) {
      // Keep the browser response intentionally generic, but retain a safe
      // classification in operator logs. This distinguishes provider, schema,
      // and callback failures without exposing implementation details.
      logger.warn?.(`Ranked OAuth callback failed: ${error?.code || error?.name || 'unknown'}`);
      response.append('Set-Cookie', auth.clearOAuthTransactionCookie());
      // OAuth failures should return the user to the sign-in UI, not leave a
      // raw provider error or a Private PvP-looking backend root page.
      const retryableSignInFailure = isRetryableOAuthFailure(error);
      response.redirect(303, oauthResultPath(error?.returnPath, retryableSignInFailure ? 'failed' : 'unavailable'));
      return;
    }
    response.append('Set-Cookie', auth.sessionCookie(result.sessionToken));
    response.append('Set-Cookie', auth.csrfCookie(result.csrfToken));
    response.append('Set-Cookie', auth.clearOAuthTransactionCookie());
    response.redirect(303, normalizeOAuthReturnPath(result.returnPath));
  }));

  router.use('/api', express.json({ limit: '4kb', strict: true, type: 'application/json' }));

  router.get('/api/auth/me', requireAuth, authSessionLimit, asyncRoute(async (request, response) => {
    noStore(response);
    try {
      const profile = await service.getProfileSummary(request.auth.userId);
      response.json({ authenticated: true, profile, csrfCookieName: CSRF_COOKIE_NAME });
    } catch (error) {
      // Authentication has already succeeded. Preserve that fact for the
      // browser while withholding database details, so a schema outage is not
      // misrepresented as a failed Google/GitHub login.
      if (error instanceof RankedError) throw error;
      logger.warn?.(`Ranked authenticated profile read failed: ${error?.code || error?.name || 'unknown'}`);
      response.status(503).json({
        authenticated: true,
        error: {
          code: 'RANKED_PROFILE_UNAVAILABLE',
          message: 'Ranked profile is temporarily unavailable.'
        }
      });
    }
  }));

  router.post('/api/auth/logout', requireAuth, requireStateChange, requireEmptyObject, authSessionLimit, asyncRoute(async (request, response) => {
    noStore(response);
    const cookies = parseCookies(request.headers.cookie || '');
    await auth.logout(cookies[SESSION_COOKIE_NAME]);
    response.setHeader('Set-Cookie', auth.clearCookies());
    response.status(204).end();
  }));

  const requirePrivatePresetService = (_request, _response, next) => {
    if (!privatePresetService) {
      next(new RankedError(503, 'PRIVATE_PRESETS_UNAVAILABLE', 'Saved Private settings are temporarily unavailable.'));
      return;
    }
    next();
  };

  router.get('/api/private-presets', requireAuth, requirePrivatePresetService, privatePresetReadLimit, asyncRoute(async (request, response) => {
    noStore(response);
    response.json({ presets: await privatePresetService.listPresets(request.auth.userId) });
  }));

  router.post('/api/private-presets', requireAuth, requireStateChange, requirePrivatePresetService, privatePresetWriteLimit, asyncRoute(async (request, response) => {
    noStore(response);
    response.status(201).json({ preset: await privatePresetService.createPreset(request.auth.userId, request.body) });
  }));

  router.put('/api/private-presets/:id', requireAuth, requireStateChange, requirePrivatePresetService, privatePresetWriteLimit, asyncRoute(async (request, response) => {
    noStore(response);
    response.json({ preset: await privatePresetService.updatePreset(request.auth.userId, request.params.id, request.body) });
  }));

  router.delete('/api/private-presets/:id', requireAuth, requireStateChange, requireEmptyObject, requirePrivatePresetService, privatePresetWriteLimit, asyncRoute(async (request, response) => {
    noStore(response);
    await privatePresetService.deletePreset(request.auth.userId, request.params.id);
    response.status(204).end();
  }));

  router.post('/api/ranked/games', requireAuth, requireStateChange, requireEmptyObject, gameCreateLimit, asyncRoute(async (request, response) => {
    noStore(response);
    response.status(200).json({ game: await service.createOrResumeGame(request.auth.userId) });
  }));

  router.get('/api/ranked/games/active', requireAuth, gameReadLimit, asyncRoute(async (request, response) => {
    noStore(response);
    response.json({ game: await service.getActiveGame(request.auth.userId) });
  }));

  // GET stays read-only. Deadline settlement is a state-changing operation
  // and therefore receives the same CSRF / Origin protection as a move.
  router.post('/api/ranked/games/active/settle', requireAuth, requireStateChange, requireEmptyObject, gameSettleLimit, asyncRoute(async (request, response) => {
    noStore(response);
    response.json({ game: await service.settleActiveGame(request.auth.userId) });
  }));

  router.get('/api/ranked/games/resume', requireAuth, gameReadLimit, asyncRoute(async (request, response) => {
    noStore(response);
    response.json({ game: await service.getResumeGame(request.auth.userId) });
  }));

  router.post('/api/ranked/games/:id/moves', requireAuth, requireStateChange, moveLimit, asyncRoute(async (request, response) => {
    noStore(response);
    response.json(await service.submitMove(request.auth.userId, request.params.id, request.body));
  }));

  router.post('/api/ranked/games/:id/forfeit', requireAuth, requireStateChange, requireEmptyObject, forfeitLimit, asyncRoute(async (request, response) => {
    noStore(response);
    response.json({ game: await service.forfeitGame(request.auth.userId, request.params.id) });
  }));

  router.get('/api/leaderboard', leaderboardLimit, asyncRoute(async (request, response) => {
    response.setHeader('Cache-Control', 'public, max-age=15');
    const limit = Number.parseInt(request.query.limit, 10);
    const offset = Number.parseInt(request.query.offset, 10);
    response.json(await service.getLeaderboard({ limit, offset }));
  }));

  router.get('/api/profile', requireAuth, authSessionLimit, asyncRoute(async (request, response) => {
    noStore(response);
    response.json({ profile: await service.getProfileSummary(request.auth.userId) });
  }));

  router.patch('/api/profile', requireAuth, requireStateChange, profileLimit, asyncRoute(async (request, response) => {
    noStore(response);
    response.json({ profile: await service.updateProfileSettings(request.auth.userId, request.body) });
  }));

  router.use((error, _request, response, _next) => sendError(response, error));
  app.use(router);
}

module.exports = {
  createRateLimit,
  noStore,
  oauthResultPath,
  registerRankedRoutes,
  sendError
};
