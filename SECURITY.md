# Security, Ranked deployment, and operations

## Scope and trust boundary

The legacy two-player game remains `Browser <-> Socket.IO <-> server.js` and
does not require an account. The historical GitHub Pages URL remains a stable
entry link, but it immediately transfers interactive Guest PvP to the backend
origin. GitHub Pages cannot attach project-controlled security response
headers; the backend origin is therefore the only place where the game board
is executed publicly.

Ranked is deliberately separate: the user enters the backend-origin
`/ranked` application, where it uses cookie-authenticated REST endpoints.
Only that same-origin application can hold the authenticated app session.
The GitHub Pages client never receives the Ranked solver table, game seed,
session token, provider token, database URL, or encryption key.

The Ranked server, not the browser, owns the hand masks, scores, stack, AI
card, round resolution, Regret, Decision Performance, result, and Rating.
The only move fields accepted from a client are `expectedRound`, `cardId`, and
an idempotency `requestId` UUID; the game id is in the path.

## Production setup

1. Create a PostgreSQL database (Supabase PostgreSQL is suitable) and set
   `DATABASE_URL` only in the backend host.
2. Configure Supabase Auth with Google and/or GitHub. Add this exact redirect
   URL to each provider and Supabase's redirect allow-list:

   ```text
   https://your-ranked-origin.example/auth/callback
   ```

3. Set `APP_ORIGIN` to that same HTTPS origin. It must not be the GitHub Pages
   URL, because browser app sessions are same-origin cookies.
4. Generate the value table as part of a controlled release, then apply the
   SQL migrations **before** enabling Ranked:

   ```text
   npm ci
   npm run generate-ranked-values
   npm run migrate
   npm start
   ```

   `npm run migrate` takes a PostgreSQL advisory lock and records each numbered
   migration in the same transaction as its schema change. In particular,
   `002_harden_ranked_database_access.sql` enables RLS and revokes the
   Supabase `anon` / `authenticated` Data API roles from every Ranked table.
   This is mandatory in production; do not expose these tables through the
   Supabase Data API. The backend's direct database role must own the tables
   or otherwise be explicitly authorized to bypass RLS—do not solve that by
   granting public roles access.

   `data/ranked-values.v1.json` is a backend build artifact and is intentionally
   git-ignored so a root-published GitHub Pages deployment cannot expose it as
   a static asset. Configure Render's build command as `npm ci && npm run
   generate-ranked-values`; do not deploy the generated `data/` directory to
   GitHub Pages. [`_config.yml`](_config.yml) additionally excludes all
   backend/solver files from the Jekyll Pages artifact. At startup Ranked
   validates its rule/evaluation versions, checksum, and exact initial value. A
   bad/missing table disables Ranked only; Guest PvP still starts.

5. Use the backend-origin `/ranked` link for Rank and leaderboard. The
   historical GitHub Pages entry page immediately transfers to the backend
   Guest PvP page, where response headers are enforced. If an OAuth provider
   falls back to the old Pages URL with a short-lived `code`, the page forwards
   it to the backend callback; the backend still enforces its HttpOnly
   transaction cookie, PKCE, and one-time transaction validation.

An example configuration is included in [`.env.example`](.env.example). Do
not commit a real `.env` file.

## Environment variables

| Variable | Required for | Description |
| --- | --- | --- |
| `DATABASE_URL` | Ranked | PostgreSQL connection URL. Keep it server-only. |
| `DATABASE_SSL` | Ranked | Set `disable`/`false` only for an explicitly trusted local database; production defaults to certificate verification. |
| `DATABASE_QUERY_TIMEOUT_MS` | Ranked | PostgreSQL statement/client query bound; defaults to 8 seconds (1–60 seconds allowed). Raise only temporarily for a reviewed migration. |
| `APP_ORIGIN` | Ranked/Auth | Exact HTTPS origin of this backend application, for example `https://overthinking-ebs.onrender.com`. |
| `SUPABASE_URL` | Ranked/Auth | Supabase project URL. |
| `SUPABASE_ANON_KEY` | Ranked/Auth | Supabase publishable/anon key. It is not a service-role key. |
| `SUPABASE_REQUEST_TIMEOUT_MS` | Ranked/Auth | Bound for a Supabase token/user request; defaults to 8 seconds (1–30 seconds allowed). |
| `RANKED_SEED_ENCRYPTION_KEY` | Ranked | 32-byte AES-256 key as 64 hex characters or base64. This is a secret. |
| `RANKED_VALUES_FILE` | Ranked | Optional absolute path to a reviewed generated value table. Defaults to the checked-in artifact. |
| `RANKED_TURN_TIME_LIMIT_MS` | Ranked | Rounds 1–6 deadline; defaults to `90000`. The forced final round is always `15000` ms. |
| `RANKED_ABANDON_AFTER_MS` | Ranked | Delay after a missed deadline before automatic forfeit; defaults to 24 hours. |
| `SESSION_ABSOLUTE_MS` | Ranked/Auth | Absolute app-session lifetime; defaults to 30 days. |
| `SESSION_IDLE_MS` | Ranked/Auth | Idle app-session lifetime; defaults to 7 days. |
| `COOKIE_SECURE` | Local development only | Use `true` when testing over HTTPS. Production always uses secure cookies. |
| `ALLOWED_ORIGINS` | Legacy Socket.IO | Comma-separated approved frontend origins. Defaults include the current GitHub Pages and Render URLs; localhost is added only when `NODE_ENV` is explicitly `development` or `test`. |
| `TRUST_PROXY` | Hosting | Set to `true` only for the public Render Web Service. With this enabled, the server accepts only `CF-Connecting-IP`, not `X-Forwarded-For`. Do not enable on a directly exposed process. |
| `TRUSTED_PROXY_IP_HEADER` | Hosting | Must remain `cf-connecting-ip` in the Render/Cloudflare deployment. Any other value safely falls back to the proxy peer address, but should be treated as a configuration error and investigated. |
| `MAX_ACTIVE_ROOMS`, `MAX_PRIVATE_ROOMS_PER_IP`, `PRIVATE_ROOM_IDLE_TTL_MS`, `MAX_SPECTATORS_PER_ROOM`, `MAX_SOCKETS_PER_IP`, `MAX_HTTP_CONNECTIONS`, `SOCKET_EVENT_LIMIT`, `RATE_LIMIT_TRACKED_IPS` | Legacy PvP | Resource limits described below. A private room that is waiting for consent or left on its result screen is reclaimed after the idle TTL; active/reconnecting games are never expired by this limit. |
| `MAX_RANDOM_MATCH_QUEUE`, `MAX_RANDOM_QUEUE_PER_IP`, `RANDOM_MATCH_REQUEST_LIMIT` | Guest random match | Bounded queue size, per-IP queued sessions, and random-match search requests per minute. |

Never put `DATABASE_URL`, `RANKED_SEED_ENCRYPTION_KEY`, a Supabase
service-role key, or an OAuth provider secret in frontend code, GitHub Pages,
or a committed configuration file.

`RANKED_SEED_ENCRYPTION_KEY` has no key-version envelope in v1. Keep the same
key for as long as active games or retained completed-game seed verification
must be readable. Plan a data migration before rotating it; changing it in
place makes those encrypted seeds unrecoverable.

## Authentication and sessions

- v1 supports only Supabase-mediated Google and GitHub OAuth Authorization
  Code + PKCE. This application does not store or implement passwords.
- Supabase owns the provider OAuth `state`; this application does not inject a
  second value into Supabase's `/authorize` URL. A separate one-time opaque
  transaction token is stored only as a hash and bound to a short-lived
  HttpOnly SameSite browser cookie. Its PKCE verifier expires after 10 minutes,
  preventing cross-browser callback/session swap. The provider access token is
  used only for the immediate user lookup and then discarded.
- After OAuth, the backend creates a new 256-bit opaque session and CSRF token.
  PostgreSQL stores only SHA-256 hashes of them.
- Production responses set `__Host-overthinking-session` with `Secure`,
  `HttpOnly`, `SameSite=Lax`, `Path=/`, and no Domain attribute. The separate
  readable CSRF cookie is not an authentication credential.
- Login rotates a prior application session. Logout revokes it server-side;
  expired, idle, banned, and deactivated sessions are rejected.
- Supabase token/user calls have a short AbortController timeout and become a
  recoverable 503 response when the identity provider is unavailable. The
  deadline sweeper also prunes expired OAuth transactions and expired/revoked
  sessions from the database.
- Every cookie-authenticated state change requires exact `Origin` matching and
  the per-session `X-CSRF-Token` header. There is no wildcard REST CORS.

Public leaderboard responses use a separate safe handle and public profile id;
they never return email addresses, provider subjects, internal auth UUIDs,
session hashes, or an unrevealed Ranked seed.

## Ranked game integrity

- Canonical card resolution comes only from `game-rules.js`.
- The server uses a generated exact dynamic-programming table. It is not
  explored on the request path and is not bundled to the browser.
- A 256-bit CSPRNG seed is encrypted at rest. Its SHA-256 commitment is shown
  when a game starts. HMAC-SHA-256 plus rejection sampling chooses the uniform
  random-opponent card independently of the player's selected card.
- The seed is revealed only after completion/forfeit, making a completed game
  replayable. The active seed remains private; the random opponent's remaining
  hand is intentionally shown as tactical information.
- PostgreSQL row locks, `(game_id, round)`, `(game_id, request_id)`, and a
  partial one-active-game-per-user index prevent duplicate moves, rerolls, and
  duplicate Rating finalization. Browser closure/restart resumes the persisted
  game; deadline settlement is server-side.

The public leaderboard is **server-authoritative and automation-resistant, not
solver-assistance-proof**. Because the AI policy and rules are fully known, the
service cannot truthfully claim to distinguish a player using an external
solver from a player making the same decisions unaided.

When any game-rule, AI-policy, evaluation, Rating, or value-table checksum
changes incompatibly, close the active season and create a new one through a
reviewed deployment:

```text
npm run rotate-ranked-season
```

The command intentionally requires the package-script `--confirm` guard and
uses the checked value table. It refuses to rotate while a Ranked game is
active, so a deployment never evaluates an in-progress game with a different
table. Existing games and Rating records are not rewritten.

If an old active game is nevertheless encountered after an interrupted or
incorrect deployment, its view is marked incompatible and all solver-backed
moves/timeouts fail closed. The player can still explicitly forfeit it; a
forfeit does not consult the value table and safely releases the one-active-
game constraint. Do not alter persisted game versions manually as a shortcut.

## DoS and abuse controls

The server applies the following application-layer controls while preserving
normal two-player play:

- Socket.IO rejects unapproved and originless production connections, limits
  connection attempts/events/IP concurrency/rooms/spectators, caps payloads at
  16 KB, and disables WebSocket compression. A network can hold at most three
  private rooms it created at once, and inactive private waiting/result rooms
  are ended after 15 minutes by default.
- HTTP has connection, header, and request timeouts, bounded per-IP tracking,
  conservative global request limits, and security response headers.
- Ranked JSON bodies are capped at 4 KB. Creation, moves, forfeits, profile
  updates, session reads, OAuth paths, and leaderboard requests have focused
  IP and/or authenticated-user limits. The rate-limit wrapper has a small
  `{ consume(key) }` interface so a shared Redis-backed store can replace the
  in-process store when running more than one instance.
- One account can have at most one active Ranked game, and solver work is done
  only in the reviewed generation step—not on a move request.
- Ranked read endpoints (profile, leaderboard, active game, and resume) do
  not create seasons, profiles, or game state (normal session last-seen
  maintenance aside). Deadline settlement uses a separate Origin- and
  CSRF-protected POST endpoint. The leaderboard cache has both a short TTL
  and a bounded entry count.
- Legacy room chat is limited to 50 characters, no newlines, 50 messages per
  participant session, with cadence/history limits and a room/IP safety quota
  that limits reconnect-id rotation abuse. The room's tracked IP entries are
  capped as well, so reconnecting through many addresses cannot grow its
  in-memory bookkeeping without bound.
- Spectating is an explicit server-side role. Observers may use the bounded
  room chat and see the public PvP board, but cannot submit cards, surrender,
  start/restart a match, or obtain a player seat unless they explicitly opted
  in before a vacancy occurs. A player who switches to spectating is not
  silently promoted back into a seat.
- Random matching uses a bounded FIFO queue with a short per-IP queue cap,
  dedicated per-IP request limiter, disconnect removal, and stale-entry
  cleanup. It creates CSPRNG room ids and only the paired players may join a
  random room; a copied room id does not become a public spectator link. The
  client supplies only its transient reconnect id and bounded display name;
  it cannot choose an opponent, room id, game state, or result.
- The displayed online and queue counts intentionally contain only aggregate
  counts, never IP addresses, client ids, or names. They represent the active
  process. Guest PvP rooms and random matching are in-memory today, so a
  multi-instance deployment must add a shared Socket.IO adapter and a shared
  queue/presence store (for example Redis) before presenting a global count.

`ALLOW_ORIGINLESS_SOCKET_CONNECTIONS=true` is for narrow local testing only;
do not enable it publicly. Do not set `TRUST_PROXY=true` on a directly exposed
process. When it is enabled on Render, the implementation deliberately uses
only Cloudflare's `CF-Connecting-IP` and ignores `X-Forwarded-For`, so a
client-supplied forwarding chain cannot select its rate-limit identity.

Set `NODE_ENV=production` in the deployed service and configure
`ALLOWED_ORIGINS` explicitly. If `NODE_ENV` is omitted, the safe production
origin set is still used; localhost is never enabled by default.

Application-level limits do **not** stop a volumetric DDoS attack that fills
the network before the process is reached. Put production behind the host's
DDoS protection and, where appropriate, a CDN/WAF such as Cloudflare with
edge-level rate limiting.

## Health, readiness, and monitoring

- `GET /health` is a liveness endpoint. It is intentionally independent of
  PostgreSQL so Guest PvP stays available if the optional Ranked stack is
  unavailable. Configure Render's deployment health check to use this path.
- `GET /readyz` verifies the Ranked runtime, all required Ranked tables, and
  every checked-in SQL migration. It caches a successful/failed result for ten
  seconds. It returns `503` with only `status`, `guestPvp`, and Ranked state
  when Ranked is configured but not usable; it never returns database errors
  or secrets. Monitor this endpoint externally and alert on a `503`; do not
  use it as a restart trigger for Guest PvP.
- Record and retain Render request identifiers (`Rndr-Id`) and Cloudflare
  request identifiers (`CF-Ray`) in the hosting log explorer when diagnosing
  production incidents. Alert at minimum on sustained `5xx`, readiness
  failures, restart loops, high latency, connection saturation, and database
  pool wait/timeout errors.
- Guest rooms, random matching, online presence, and the default rate-limit
  store are intentionally single-process. Keep one application instance until
  a shared Socket.IO adapter, shared queue/presence store, and shared limiter
  are deployed together.
