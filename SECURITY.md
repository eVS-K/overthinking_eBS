# Security, Ranked deployment, and operations

## Scope and trust boundary

The legacy two-player game remains `Browser <-> Socket.IO <-> server.js` and
does not require an account. It may continue to be served from GitHub Pages.

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
   SQL migration before enabling Ranked:

   ```text
   npm ci
   npm run generate-ranked-values
   npm run migrate
   npm start
   ```

   `data/ranked-values.v1.json` is a backend build artifact and is intentionally
   git-ignored so a root-published GitHub Pages deployment cannot expose it as
   a static asset. Configure Render's build command as `npm ci && npm run
   generate-ranked-values`; do not deploy the generated `data/` directory to
   GitHub Pages. [`_config.yml`](_config.yml) additionally excludes all
   backend/solver files from the Jekyll Pages artifact. At startup Ranked
   validates its rule/evaluation versions, checksum, and exact initial value. A
   bad/missing table disables Ranked only; Guest PvP still starts.

5. Use the backend-origin `/ranked` link for Rank and leaderboard. The GitHub
   Pages entry page links there automatically; the Ranked header's Private PvP
   and logo links deliberately return to the canonical GitHub Pages guest PvP
   URL, rather than the backend root. If an OAuth provider falls back to that
   Pages URL with a short-lived `code` and `state`, the Pages client immediately
   forwards them to the backend callback; the backend still enforces its
   HttpOnly state cookie, PKCE, and one-time transaction validation.

An example configuration is included in [`.env.example`](.env.example). Do
not commit a real `.env` file.

## Environment variables

| Variable | Required for | Description |
| --- | --- | --- |
| `DATABASE_URL` | Ranked | PostgreSQL connection URL. Keep it server-only. |
| `DATABASE_SSL` | Ranked | Set `disable`/`false` only for an explicitly trusted local database; production defaults to certificate verification. |
| `APP_ORIGIN` | Ranked/Auth | Exact HTTPS origin of this backend application, for example `https://overthinking-ebs.onrender.com`. |
| `SUPABASE_URL` | Ranked/Auth | Supabase project URL. |
| `SUPABASE_ANON_KEY` | Ranked/Auth | Supabase publishable/anon key. It is not a service-role key. |
| `RANKED_SEED_ENCRYPTION_KEY` | Ranked | 32-byte AES-256 key as 64 hex characters or base64. This is a secret. |
| `RANKED_VALUES_FILE` | Ranked | Optional absolute path to a reviewed generated value table. Defaults to the checked-in artifact. |
| `RANKED_TURN_TIME_LIMIT_MS` | Ranked | Per-turn deadline; defaults to `90000`. |
| `RANKED_ABANDON_AFTER_MS` | Ranked | Delay after a missed deadline before automatic forfeit; defaults to 24 hours. |
| `SESSION_ABSOLUTE_MS` | Ranked/Auth | Absolute app-session lifetime; defaults to 30 days. |
| `SESSION_IDLE_MS` | Ranked/Auth | Idle app-session lifetime; defaults to 7 days. |
| `COOKIE_SECURE` | Local development only | Use `true` when testing over HTTPS. Production always uses secure cookies. |
| `ALLOWED_ORIGINS` | Legacy Socket.IO | Comma-separated approved frontend origins. Defaults include the current GitHub Pages and Render URLs. |
| `TRUST_PROXY` | Hosting | Set to `true` only when the hosting network is a known reverse proxy that sanitizes `X-Forwarded-For` (such as the configured Render deployment). |
| `MAX_ACTIVE_ROOMS`, `MAX_SPECTATORS_PER_ROOM`, `MAX_SOCKETS_PER_IP`, `MAX_HTTP_CONNECTIONS`, `SOCKET_EVENT_LIMIT`, `RATE_LIMIT_TRACKED_IPS` | Legacy PvP | Resource limits described below. |

Never put `DATABASE_URL`, `RANKED_SEED_ENCRYPTION_KEY`, a Supabase
service-role key, or an OAuth provider secret in frontend code, GitHub Pages,
or a committed configuration file.

## Authentication and sessions

- v1 supports only Supabase-mediated Google and GitHub OAuth Authorization
  Code + PKCE. This application does not store or implement passwords.
- OAuth `state` is one-time and stored hashed, and is also bound to a short
  lived HttpOnly SameSite browser cookie; PKCE verifier data expires after 10
  minutes. This prevents a cross-browser login callback/session swap. The
  provider access token is used only for the immediate user lookup and then
  discarded.
- After OAuth, the backend creates a new 256-bit opaque session and CSRF token.
  PostgreSQL stores only SHA-256 hashes of them.
- Production responses set `__Host-overthinking-session` with `Secure`,
  `HttpOnly`, `SameSite=Lax`, `Path=/`, and no Domain attribute. The separate
  readable CSRF cookie is not an authentication credential.
- Login rotates a prior application session. Logout revokes it server-side;
  expired, idle, banned, and deactivated sessions are rejected.
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
  Random AI card independently of the player's selected card.
- The seed is revealed only after completion/forfeit, making a completed game
  replayable. An active game's seed and AI hand remain private.
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

## DoS and abuse controls

The server applies the following application-layer controls while preserving
normal two-player play:

- Socket.IO rejects unapproved and originless production connections, limits
  connection attempts/events/IP concurrency/rooms/spectators, caps payloads at
  16 KB, and disables WebSocket compression.
- HTTP has connection, header, and request timeouts, bounded per-IP tracking,
  conservative global request limits, and security response headers.
- Ranked JSON bodies are capped at 4 KB. Creation, moves, forfeits, profile
  updates, session reads, OAuth paths, and leaderboard requests have focused
  IP and/or authenticated-user limits. The rate-limit wrapper has a small
  `{ consume(key) }` interface so a shared Redis-backed store can replace the
  in-process store when running more than one instance.
- One account can have at most one active Ranked game, and solver work is done
  only in the reviewed generation step—not on a move request.
- Legacy room chat is limited to 50 characters, no newlines, 50 messages per
  participant session, with cadence and history limits.

`ALLOW_ORIGINLESS_SOCKET_CONNECTIONS=true` is for narrow local testing only;
do not enable it publicly. Do not set `TRUST_PROXY=true` on a directly exposed
process, since that would let a client forge the rate-limit IP via
`X-Forwarded-For`.

Application-level limits do **not** stop a volumetric DDoS attack that fills
the network before the process is reached. Put production behind the host's
DDoS protection and, where appropriate, a CDN/WAF such as Cloudflare with
edge-level rate limiting.
