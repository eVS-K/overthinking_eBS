'use strict';

const express = require('express');
const { CSRF_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME, createAuthMiddleware, parseCookies } = require('./auth');
const { createFixedWindowLimiter } = require('./security');
const { RankedError } = require('./ranked-service');

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function noStore(response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Pragma', 'no-cache');
}

function sendError(response, error) {
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
  app.use('/api/auth', unavailable);
  app.get('/auth/login/:provider', unavailable);
  app.get('/auth/callback', unavailable);
}

function registerRankedRoutes(app, { runtime, getClientIp }) {
  if (!runtime?.available) {
    registerUnavailableRankedRoutes(app);
    return;
  }

  const router = express.Router();
  const { auth, service } = runtime;
  const { requireAuth, requireStateChange } = createAuthMiddleware(auth);
  const byIp = (request) => `ip:${getClientIp(request)}`;
  const byUser = (request) => `user:${request.auth.userId}`;
  const authLoginLimit = createRateLimit({ limit: 12, windowMs: 10 * 60_000, getKey: byIp });
  const authCallbackLimit = createRateLimit({ limit: 30, windowMs: 10 * 60_000, getKey: byIp });
  const gameCreateLimit = createRateLimit({ limit: 12, windowMs: 60 * 60_000, getKey: byUser });
  const gameReadLimit = createRateLimit({ limit: 120, windowMs: 60_000, getKey: byUser });
  const moveLimit = createRateLimit({ limit: 90, windowMs: 60_000, getKey: byUser });
  const forfeitLimit = createRateLimit({ limit: 12, windowMs: 60 * 60_000, getKey: byUser });
  const profileLimit = createRateLimit({ limit: 12, windowMs: 60 * 60_000, getKey: byUser });
  const leaderboardLimit = createRateLimit({ limit: 120, windowMs: 60_000, getKey: byIp });
  const authSessionLimit = createRateLimit({ limit: 120, windowMs: 60_000, getKey: byUser });

  router.get('/auth/login/:provider', authLoginLimit, asyncRoute(async (request, response) => {
    noStore(response);
    const result = await auth.beginOAuth(request.params.provider);
    response.setHeader('Set-Cookie', auth.oauthStateCookie(result.state));
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
        state: request.query.state,
        oauthStateToken: cookies[OAUTH_STATE_COOKIE_NAME],
        previousSessionToken: cookies[SESSION_COOKIE_NAME]
      });
    } catch (error) {
      response.append('Set-Cookie', auth.clearOAuthStateCookie());
      throw error;
    }
    response.append('Set-Cookie', auth.sessionCookie(result.sessionToken));
    response.append('Set-Cookie', auth.csrfCookie(result.csrfToken));
    response.append('Set-Cookie', auth.clearOAuthStateCookie());
    response.redirect(303, '/ranked');
  }));

  router.use('/api', express.json({ limit: '4kb', strict: true, type: 'application/json' }));

  router.get('/api/auth/me', requireAuth, authSessionLimit, asyncRoute(async (request, response) => {
    noStore(response);
    const profile = await service.getProfileSummary(request.auth.userId);
    response.json({ authenticated: true, profile, csrfCookieName: CSRF_COOKIE_NAME });
  }));

  router.post('/api/auth/logout', requireAuth, requireStateChange, requireEmptyObject, authSessionLimit, asyncRoute(async (request, response) => {
    noStore(response);
    const cookies = parseCookies(request.headers.cookie || '');
    await auth.logout(cookies[SESSION_COOKIE_NAME]);
    response.setHeader('Set-Cookie', auth.clearCookies());
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

  router.get('/api/profile', requireAuth, asyncRoute(async (request, response) => {
    noStore(response);
    response.json({ profile: await service.getProfileSummary(request.auth.userId) });
  }));

  router.patch('/api/profile', requireAuth, requireStateChange, profileLimit, asyncRoute(async (request, response) => {
    noStore(response);
    response.json({ profile: await service.updateHandle(request.auth.userId, request.body?.handle) });
  }));

  router.use((error, _request, response, _next) => sendError(response, error));
  app.use(router);
}

module.exports = {
  createRateLimit,
  noStore,
  registerRankedRoutes,
  sendError
};
