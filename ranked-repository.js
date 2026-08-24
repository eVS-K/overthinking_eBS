'use strict';

const crypto = require('crypto');

function cloneValue(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function cloneMap(map) {
  return new Map([...map].map(([key, value]) => [key, cloneValue(value)]));
}

function defaultHandleForUser(userId) {
  // 13 hexadecimal characters plus "player-" fills the 20-character public
  // handle limit while keeping collision probability negligible before a user
  // chooses a real handle.
  return `player-${String(userId).replace(/[^a-z0-9]/gi, '').slice(0, 13).toLowerCase()}`;
}

function mapProfile(row) {
  if (!row) return null;
  return {
    userId: row.user_id ?? row.userId,
    publicId: row.public_id ?? row.publicId,
    handle: row.handle,
    normalizedHandle: row.normalized_handle ?? row.normalizedHandle,
    status: row.status,
    handleChangedAt: row.handle_changed_at ?? row.handleChangedAt ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null
  };
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id ?? row.userId,
    sessionTokenHash: row.session_token_hash ?? row.sessionTokenHash,
    csrfTokenHash: row.csrf_token_hash ?? row.csrfTokenHash,
    createdAt: row.created_at ?? row.createdAt,
    lastSeenAt: row.last_seen_at ?? row.lastSeenAt,
    expiresAt: row.expires_at ?? row.expiresAt,
    idleExpiresAt: row.idle_expires_at ?? row.idleExpiresAt,
    revokedAt: row.revoked_at ?? row.revokedAt ?? null,
    profile: row.profile ? mapProfile(row.profile) : row.handle ? mapProfile(row) : null
  };
}

function mapSeason(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    rulesVersion: row.rules_version ?? row.rulesVersion,
    aiPolicyVersion: row.ai_policy_version ?? row.aiPolicyVersion,
    evaluationVersion: row.evaluation_version ?? row.evaluationVersion,
    ratingVersion: row.rating_version ?? row.ratingVersion,
    valueTableChecksum: row.value_table_checksum ?? row.valueTableChecksum,
    initialEv: Number(row.initial_ev ?? row.initialEv),
    initialEvNumerator: Number(row.initial_ev_numerator ?? row.initialEvNumerator),
    initialEvDenominator: Number(row.initial_ev_denominator ?? row.initialEvDenominator),
    startedAt: row.started_at ?? row.startedAt,
    endedAt: row.ended_at ?? row.endedAt ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null
  };
}

function mapRankedProfile(row) {
  if (!row) return null;
  return {
    userId: row.user_id ?? row.userId,
    seasonId: row.season_id ?? row.seasonId,
    ratedGames: Number(row.rated_games ?? row.ratedGames ?? 0),
    wins: Number(row.wins ?? 0),
    draws: Number(row.draws ?? 0),
    losses: Number(row.losses ?? 0),
    forfeits: Number(row.forfeits ?? 0),
    ewWeight: Number(row.ew_weight ?? row.ewWeight ?? 0),
    ewWeightSq: Number(row.ew_weight_sq ?? row.ewWeightSq ?? 0),
    ewSum: Number(row.ew_sum ?? row.ewSum ?? 0),
    ewSumSq: Number(row.ew_sum_sq ?? row.ewSumSq ?? 0),
    decisionEv: row.decision_ev ?? row.decisionEv ?? null,
    rating: row.rating ?? null,
    lastRankedAt: row.last_ranked_at ?? row.lastRankedAt ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null
  };
}

function mapGame(row) {
  if (!row) return null;
  const value = (name) => row[name] ?? row[name.replace(/_([a-z])/g, (_all, letter) => letter.toUpperCase())];
  return {
    id: value('id'),
    userId: value('user_id'),
    seasonId: value('season_id'),
    status: value('status'),
    rulesVersion: value('rules_version'),
    aiPolicyVersion: value('ai_policy_version'),
    evaluationVersion: value('evaluation_version'),
    ratingVersion: value('rating_version'),
    valueTableChecksum: value('value_table_checksum'),
    state: {
      playerMask: Number(value('player_hand_mask')),
      aiMask: Number(value('ai_hand_mask')),
      playerScore: Number(value('player_score')),
      aiScore: Number(value('ai_score')),
      stackCount: Number(value('stack_count'))
    },
    currentRound: Number(value('current_round')),
    turnStartedAt: value('turn_started_at'),
    deadline: value('deadline'),
    encryptedSeed: value('encrypted_seed') ? {
      ciphertext: Buffer.from(value('encrypted_seed')),
      iv: Buffer.from(value('seed_iv')),
      authTag: Buffer.from(value('seed_auth_tag'))
    } : null,
    seedCommitment: value('seed_commitment'),
    totalRegret: BigInt(value('total_regret') ?? 0),
    decisionPerformance: value('decision_performance') === null || value('decision_performance') === undefined
      ? null : BigInt(value('decision_performance')),
    actualResult: value('actual_result') ?? null,
    matchScore: value('match_score') === null || value('match_score') === undefined ? null : Number(value('match_score')),
    luck: value('luck') === null || value('luck') === undefined ? null : Number(value('luck')),
    ratingBefore: value('rating_before') === null || value('rating_before') === undefined ? null : Number(value('rating_before')),
    ratingAfter: value('rating_after') === null || value('rating_after') === undefined ? null : Number(value('rating_after')),
    ratingFinalizedAt: value('rating_finalized_at') ?? null,
    finishedAt: value('finished_at') ?? null,
    createdAt: value('created_at') ?? null,
    updatedAt: value('updated_at') ?? null
  };
}

function mapMove(row) {
  if (!row) return null;
  return {
    id: row.id,
    gameId: row.game_id ?? row.gameId,
    round: Number(row.round),
    requestId: row.request_id ?? row.requestId ?? null,
    stateKey: row.state_key ?? row.stateKey,
    playerCardId: row.player_card_id ?? row.playerCardId,
    aiCardId: row.ai_card_id ?? row.aiCardId,
    optimalV: BigInt(row.optimal_v ?? row.optimalV),
    chosenQ: BigInt(row.chosen_q ?? row.chosenQ),
    regret: BigInt(row.regret),
    timeout: Boolean(row.timeout),
    thinkingTimeMs: Number(row.thinking_time_ms ?? row.thinkingTimeMs ?? 0),
    response: row.response_json ?? row.response ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null
  };
}

function rankedProfileKey(userId, seasonId) {
  return `${userId}:${seasonId}`;
}

class PostgresRankedRepository {
  constructor(queryable, { inTransaction = false } = {}) {
    this.queryable = queryable;
    this.inTransaction = inTransaction;
  }

  async query(sql, params = []) {
    return this.queryable.query(sql, params);
  }

  async transaction(operation) {
    if (this.inTransaction) return operation(this);
    const client = await this.queryable.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(new PostgresRankedRepository(client, { inTransaction: true }));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async lockSeason() {
    // Serialize only the no-active-season/bootstrap/rotation path. A fixed
    // transaction-scoped PostgreSQL advisory lock avoids the empty-result race
    // that a regular SELECT ... FOR UPDATE cannot protect.
    await this.query('SELECT pg_advisory_xact_lock($1)', [741_902_317]);
  }

  async getActiveSeason({ forUpdate = false } = {}) {
    const result = await this.query(`SELECT * FROM seasons WHERE status = 'active'${forUpdate ? ' FOR UPDATE' : ''}`);
    return mapSeason(result.rows[0]);
  }

  async createSeason(spec) {
    const result = await this.query(
      `INSERT INTO seasons (status, rules_version, ai_policy_version, evaluation_version, rating_version, value_table_checksum, initial_ev, initial_ev_numerator, initial_ev_denominator)
       VALUES ('active', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [spec.rulesVersion, spec.aiPolicyVersion, spec.evaluationVersion, spec.ratingVersion, spec.valueTableChecksum,
        spec.initialEv, spec.initialEvNumerator, spec.initialEvDenominator]
    );
    return mapSeason(result.rows[0]);
  }

  async closeActiveSeason(endedAt = new Date()) {
    await this.query(`UPDATE seasons SET status = 'closed', ended_at = $1 WHERE status = 'active'`, [endedAt]);
  }

  async getProfile(userId, { forUpdate = false } = {}) {
    const result = await this.query(`SELECT * FROM profiles WHERE user_id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [userId]);
    return mapProfile(result.rows[0]);
  }

  async ensureProfile(userId) {
    const handle = defaultHandleForUser(userId);
    await this.query(
      `INSERT INTO profiles (user_id, handle, normalized_handle)
       VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
      [userId, handle, handle]
    );
    return this.getProfile(userId);
  }

  async updateHandle(userId, handle, normalizedHandle, changedAt = new Date()) {
    const result = await this.query(
      `UPDATE profiles
       SET handle = $2, normalized_handle = $3, handle_changed_at = $4, updated_at = now()
       WHERE user_id = $1
       RETURNING *`,
      [userId, handle, normalizedHandle, changedAt]
    );
    return mapProfile(result.rows[0]);
  }

  async createSession(session) {
    const result = await this.query(
      `INSERT INTO app_sessions (id, user_id, session_token_hash, csrf_token_hash, expires_at, idle_expires_at, user_agent_hash, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [session.id, session.userId, session.sessionTokenHash, session.csrfTokenHash, session.expiresAt, session.idleExpiresAt,
        session.userAgentHash || null, session.ipHash || null]
    );
    return mapSession(result.rows[0]);
  }

  async findActiveSessionByTokenHash(sessionTokenHash, now = new Date()) {
    const result = await this.query(
      `SELECT s.*, p.public_id, p.handle, p.normalized_handle, p.status
       FROM app_sessions s JOIN profiles p ON p.user_id = s.user_id
       WHERE s.session_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.idle_expires_at > $2`,
      [sessionTokenHash, now]
    );
    return mapSession(result.rows[0]);
  }

  async touchSession(id, lastSeenAt, idleExpiresAt) {
    await this.query(`UPDATE app_sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1 AND revoked_at IS NULL`, [id, lastSeenAt, idleExpiresAt]);
  }

  async revokeSession(id, revokedAt = new Date()) {
    await this.query(`UPDATE app_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1`, [id, revokedAt]);
  }

  async createOAuthTransaction(transaction) {
    await this.query(
      `INSERT INTO oauth_transactions (state_hash, provider, code_verifier, redirect_uri, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [transaction.stateHash, transaction.provider, transaction.codeVerifier, transaction.redirectUri, transaction.expiresAt]
    );
  }

  async consumeOAuthTransaction(stateHash, now = new Date()) {
    const result = await this.query(
      `DELETE FROM oauth_transactions WHERE state_hash = $1 AND expires_at > $2 RETURNING *`,
      [stateHash, now]
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      stateHash: row.state_hash,
      provider: row.provider,
      codeVerifier: row.code_verifier,
      redirectUri: row.redirect_uri,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    } : null;
  }

  async createGame(game) {
    const state = game.state;
    const result = await this.query(
      `INSERT INTO ranked_games (
        id, user_id, season_id, rules_version, ai_policy_version, evaluation_version, rating_version, value_table_checksum,
        player_hand_mask, ai_hand_mask, player_score, ai_score, stack_count, current_round, turn_started_at, deadline,
        encrypted_seed, seed_iv, seed_auth_tag, seed_commitment
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING *`,
      [game.id, game.userId, game.seasonId, game.rulesVersion, game.aiPolicyVersion, game.evaluationVersion, game.ratingVersion,
        game.valueTableChecksum, state.playerMask, state.aiMask, state.playerScore, state.aiScore, state.stackCount,
        game.currentRound, game.turnStartedAt, game.deadline, game.encryptedSeed.ciphertext, game.encryptedSeed.iv,
        game.encryptedSeed.authTag, game.seedCommitment]
    );
    return mapGame(result.rows[0]);
  }

  async findActiveGameForUser(userId, { forUpdate = false } = {}) {
    const result = await this.query(
      `SELECT * FROM ranked_games WHERE user_id = $1 AND status = 'active'${forUpdate ? ' FOR UPDATE' : ''}`,
      [userId]
    );
    return mapGame(result.rows[0]);
  }

  async findGameById(gameId, { forUpdate = false } = {}) {
    const result = await this.query(`SELECT * FROM ranked_games WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [gameId]);
    return mapGame(result.rows[0]);
  }

  async findDueGameIds(now = new Date(), limit = 100) {
    const result = await this.query(
      `SELECT id FROM ranked_games WHERE status = 'active' AND deadline <= $1 ORDER BY deadline ASC LIMIT $2`,
      [now, limit]
    );
    return result.rows.map((row) => row.id);
  }

  async countActiveGames() {
    const result = await this.query(`SELECT count(*)::integer AS total FROM ranked_games WHERE status = 'active'`);
    return Number(result.rows[0]?.total || 0);
  }

  async saveGame(game) {
    const state = game.state;
    const result = await this.query(
      `UPDATE ranked_games SET
        status = $2, player_hand_mask = $3, ai_hand_mask = $4, player_score = $5, ai_score = $6, stack_count = $7,
        current_round = $8, turn_started_at = $9, deadline = $10, total_regret = $11, decision_performance = $12,
        actual_result = $13, match_score = $14, luck = $15, rating_before = $16, rating_after = $17,
        rating_finalized_at = $18, finished_at = $19, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [game.id, game.status, state.playerMask, state.aiMask, state.playerScore, state.aiScore, state.stackCount,
        game.currentRound, game.turnStartedAt, game.deadline, game.totalRegret.toString(),
        game.decisionPerformance === null ? null : game.decisionPerformance.toString(), game.actualResult, game.matchScore,
        game.luck, game.ratingBefore, game.ratingAfter, game.ratingFinalizedAt, game.finishedAt]
    );
    return mapGame(result.rows[0]);
  }

  async findMoveByRequestId(gameId, requestId) {
    const result = await this.query(`SELECT * FROM ranked_moves WHERE game_id = $1 AND request_id = $2`, [gameId, requestId]);
    return mapMove(result.rows[0]);
  }

  async findMoveByRound(gameId, round) {
    const result = await this.query(`SELECT * FROM ranked_moves WHERE game_id = $1 AND round = $2`, [gameId, round]);
    return mapMove(result.rows[0]);
  }

  async listMoves(gameId) {
    const result = await this.query(`SELECT * FROM ranked_moves WHERE game_id = $1 ORDER BY round ASC`, [gameId]);
    return result.rows.map(mapMove);
  }

  async insertMove(move) {
    const result = await this.query(
      `INSERT INTO ranked_moves (
        game_id, round, request_id, state_key, player_card_id, ai_card_id, optimal_v, chosen_q, regret, timeout,
        thinking_time_ms, response_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [move.gameId, move.round, move.requestId || null, move.stateKey, move.playerCardId, move.aiCardId,
        move.optimalV.toString(), move.chosenQ.toString(), move.regret.toString(), move.timeout, move.thinkingTimeMs,
        move.response || null]
    );
    return mapMove(result.rows[0]);
  }

  async getOrCreateRankedProfile(userId, seasonId, { forUpdate = false } = {}) {
    await this.query(
      `INSERT INTO ranked_profiles (user_id, season_id) VALUES ($1, $2) ON CONFLICT (user_id, season_id) DO NOTHING`,
      [userId, seasonId]
    );
    const result = await this.query(
      `SELECT * FROM ranked_profiles WHERE user_id = $1 AND season_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [userId, seasonId]
    );
    return mapRankedProfile(result.rows[0]);
  }

  async saveRankedProfile(profile) {
    const result = await this.query(
      `UPDATE ranked_profiles SET
        rated_games = $3, wins = $4, draws = $5, losses = $6, forfeits = $7,
        ew_weight = $8, ew_weight_sq = $9, ew_sum = $10, ew_sum_sq = $11,
        decision_ev = $12, rating = $13, last_ranked_at = $14, updated_at = now()
       WHERE user_id = $1 AND season_id = $2 RETURNING *`,
      [profile.userId, profile.seasonId, profile.ratedGames, profile.wins, profile.draws, profile.losses, profile.forfeits,
        profile.ewWeight, profile.ewWeightSq, profile.ewSum, profile.ewSumSq, profile.decisionEv, profile.rating,
        profile.lastRankedAt]
    );
    return mapRankedProfile(result.rows[0]);
  }

  async getLeaderboard(seasonId, { limit, offset }) {
    const count = await this.query(
      `SELECT count(*)::integer AS total
       FROM ranked_profiles rp JOIN profiles p ON p.user_id = rp.user_id
       WHERE rp.season_id = $1 AND rp.rated_games >= 50 AND p.status = 'active'`,
      [seasonId]
    );
    const result = await this.query(
      `SELECT row_number() OVER (ORDER BY rp.decision_ev DESC, rp.rating DESC, p.public_id ASC) AS rank,
              p.public_id, p.handle, rp.rated_games, rp.wins, rp.draws, rp.losses, rp.forfeits,
              rp.decision_ev, rp.rating, rp.ew_weight, rp.ew_weight_sq, rp.ew_sum_sq
       FROM ranked_profiles rp JOIN profiles p ON p.user_id = rp.user_id
       WHERE rp.season_id = $1 AND rp.rated_games >= 50 AND p.status = 'active'
       ORDER BY rp.decision_ev DESC, rp.rating DESC, p.public_id ASC
       LIMIT $2 OFFSET $3`,
      [seasonId, limit, offset]
    );
    return {
      total: Number(count.rows[0].total),
      entries: result.rows.map((row) => ({
        rank: Number(row.rank), publicId: row.public_id, handle: row.handle,
        ratedGames: Number(row.rated_games), wins: Number(row.wins), draws: Number(row.draws),
        losses: Number(row.losses), forfeits: Number(row.forfeits), decisionEv: Number(row.decision_ev),
        rating: Number(row.rating), ewWeight: Number(row.ew_weight), ewWeightSq: Number(row.ew_weight_sq),
        ewSumSq: Number(row.ew_sum_sq)
      }))
    };
  }

  async getLeaderboardRank(seasonId, userId) {
    const result = await this.query(
      `WITH ranked AS (
        SELECT rp.user_id, row_number() OVER (ORDER BY rp.decision_ev DESC, rp.rating DESC, p.public_id ASC) AS rank
        FROM ranked_profiles rp JOIN profiles p ON p.user_id = rp.user_id
        WHERE rp.season_id = $1 AND rp.rated_games >= 50 AND p.status = 'active'
      ) SELECT rank FROM ranked WHERE user_id = $2`,
      [seasonId, userId]
    );
    return result.rows[0] ? Number(result.rows[0].rank) : null;
  }
}

/**
 * Test-only in-memory repository. It implements the same transaction boundary
 * as the PostgreSQL repository, but it is never selected by production setup.
 */
class MemoryRankedRepository {
  constructor() {
    this.profiles = new Map();
    this.sessions = new Map();
    this.sessionByHash = new Map();
    this.oauthTransactions = new Map();
    this.seasons = new Map();
    this.activeSeasonId = null;
    this.games = new Map();
    this.activeGameByUser = new Map();
    this.movesByGame = new Map();
    this.rankedProfiles = new Map();
    this._queue = Promise.resolve();
  }

  _snapshot() {
    return {
      profiles: cloneMap(this.profiles), sessions: cloneMap(this.sessions), sessionByHash: new Map(this.sessionByHash),
      oauthTransactions: cloneMap(this.oauthTransactions), seasons: cloneMap(this.seasons), activeSeasonId: this.activeSeasonId,
      games: cloneMap(this.games), activeGameByUser: new Map(this.activeGameByUser), movesByGame: cloneMap(this.movesByGame),
      rankedProfiles: cloneMap(this.rankedProfiles)
    };
  }

  _restore(snapshot) {
    Object.assign(this, snapshot);
  }

  async transaction(operation) {
    const execute = async () => {
      const snapshot = this._snapshot();
      try {
        return await operation(this);
      } catch (error) {
        this._restore(snapshot);
        throw error;
      }
    };
    const next = this._queue.then(execute, execute);
    this._queue = next.catch(() => {});
    return next;
  }

  async lockSeason() {
    // Memory transactions are already serialized by _queue.
  }

  async getActiveSeason() {
    return this.activeSeasonId ? cloneValue(this.seasons.get(this.activeSeasonId)) : null;
  }

  async createSeason(spec) {
    if (this.activeSeasonId) {
      const error = new Error('only one active season is allowed');
      error.code = '23505';
      throw error;
    }
    const season = { id: crypto.randomUUID(), status: 'active', ...cloneValue(spec), startedAt: new Date(), createdAt: new Date(), endedAt: null };
    this.seasons.set(season.id, season);
    this.activeSeasonId = season.id;
    return cloneValue(season);
  }

  async closeActiveSeason(endedAt = new Date()) {
    if (!this.activeSeasonId) return;
    const season = this.seasons.get(this.activeSeasonId);
    season.status = 'closed';
    season.endedAt = new Date(endedAt);
    this.activeSeasonId = null;
  }

  async getProfile(userId) {
    return cloneValue(this.profiles.get(userId) || null);
  }

  async ensureProfile(userId) {
    let profile = this.profiles.get(userId);
    if (!profile) {
      const handle = defaultHandleForUser(userId);
      profile = {
        userId, publicId: crypto.randomUUID(), handle, normalizedHandle: handle, status: 'active', handleChangedAt: null,
        createdAt: new Date(), updatedAt: new Date()
      };
      this.profiles.set(userId, profile);
    }
    return cloneValue(profile);
  }

  async updateHandle(userId, handle, normalizedHandle, changedAt = new Date()) {
    for (const profile of this.profiles.values()) {
      if (profile.userId !== userId && profile.normalizedHandle === normalizedHandle) {
        const error = new Error('handle already exists');
        error.code = '23505';
        throw error;
      }
    }
    const profile = this.profiles.get(userId);
    if (!profile) return null;
    profile.handle = handle;
    profile.normalizedHandle = normalizedHandle;
    profile.handleChangedAt = new Date(changedAt);
    profile.updatedAt = new Date();
    return cloneValue(profile);
  }

  async createSession(session) {
    const stored = { ...cloneValue(session), createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null };
    this.sessions.set(stored.id, stored);
    this.sessionByHash.set(stored.sessionTokenHash, stored.id);
    return cloneValue(stored);
  }

  async findActiveSessionByTokenHash(hash, now = new Date()) {
    const id = this.sessionByHash.get(hash);
    const session = id ? this.sessions.get(id) : null;
    if (!session || session.revokedAt || new Date(session.expiresAt) <= now || new Date(session.idleExpiresAt) <= now) return null;
    const profile = this.profiles.get(session.userId);
    return cloneValue({ ...session, profile });
  }

  async touchSession(id, lastSeenAt, idleExpiresAt) {
    const session = this.sessions.get(id);
    if (!session || session.revokedAt) return;
    session.lastSeenAt = new Date(lastSeenAt);
    session.idleExpiresAt = new Date(idleExpiresAt);
  }

  async revokeSession(id, revokedAt = new Date()) {
    const session = this.sessions.get(id);
    if (session && !session.revokedAt) session.revokedAt = new Date(revokedAt);
  }

  async createOAuthTransaction(transaction) {
    this.oauthTransactions.set(transaction.stateHash, { id: crypto.randomUUID(), ...cloneValue(transaction), createdAt: new Date() });
  }

  async consumeOAuthTransaction(stateHash, now = new Date()) {
    const transaction = this.oauthTransactions.get(stateHash);
    this.oauthTransactions.delete(stateHash);
    if (!transaction || new Date(transaction.expiresAt) <= now) return null;
    return cloneValue(transaction);
  }

  async createGame(game) {
    if (this.activeGameByUser.has(game.userId)) {
      const error = new Error('active game exists');
      error.code = '23505';
      throw error;
    }
    const stored = {
      ...cloneValue(game), status: 'active', totalRegret: 0n, decisionPerformance: null, actualResult: null,
      matchScore: null, luck: null, ratingBefore: null, ratingAfter: null, ratingFinalizedAt: null, finishedAt: null,
      createdAt: new Date(), updatedAt: new Date()
    };
    this.games.set(stored.id, stored);
    this.activeGameByUser.set(stored.userId, stored.id);
    this.movesByGame.set(stored.id, []);
    return cloneValue(stored);
  }

  async findActiveGameForUser(userId) {
    const id = this.activeGameByUser.get(userId);
    return cloneValue(id ? this.games.get(id) : null);
  }

  async findGameById(gameId) {
    return cloneValue(this.games.get(gameId) || null);
  }

  async findDueGameIds(now = new Date(), limit = 100) {
    return [...this.games.values()]
      .filter((game) => game.status === 'active' && new Date(game.deadline) <= now)
      .sort((left, right) => new Date(left.deadline) - new Date(right.deadline))
      .slice(0, limit).map((game) => game.id);
  }

  async countActiveGames() {
    return [...this.games.values()].filter((game) => game.status === 'active').length;
  }

  async saveGame(game) {
    const previous = this.games.get(game.id);
    if (!previous) return null;
    const stored = { ...cloneValue(game), updatedAt: new Date(), encryptedSeed: previous.encryptedSeed || game.encryptedSeed };
    this.games.set(game.id, stored);
    if (stored.status === 'active') this.activeGameByUser.set(stored.userId, stored.id);
    else this.activeGameByUser.delete(stored.userId);
    return cloneValue(stored);
  }

  async findMoveByRequestId(gameId, requestId) {
    return cloneValue((this.movesByGame.get(gameId) || []).find((move) => move.requestId === requestId) || null);
  }

  async findMoveByRound(gameId, round) {
    return cloneValue((this.movesByGame.get(gameId) || []).find((move) => move.round === round) || null);
  }

  async listMoves(gameId) {
    return cloneValue(this.movesByGame.get(gameId) || []);
  }

  async insertMove(move) {
    const moves = this.movesByGame.get(move.gameId) || [];
    if (moves.some((existing) => existing.round === move.round || (move.requestId && existing.requestId === move.requestId))) {
      const error = new Error('duplicate move');
      error.code = '23505';
      throw error;
    }
    const stored = { id: moves.length + 1, ...cloneValue(move), createdAt: new Date() };
    moves.push(stored);
    this.movesByGame.set(move.gameId, moves);
    return cloneValue(stored);
  }

  async getOrCreateRankedProfile(userId, seasonId) {
    const key = rankedProfileKey(userId, seasonId);
    if (!this.rankedProfiles.has(key)) {
      this.rankedProfiles.set(key, {
        userId, seasonId, ratedGames: 0, wins: 0, draws: 0, losses: 0, forfeits: 0,
        ewWeight: 0, ewWeightSq: 0, ewSum: 0, ewSumSq: 0, decisionEv: null, rating: null,
        lastRankedAt: null, createdAt: new Date(), updatedAt: new Date()
      });
    }
    return cloneValue(this.rankedProfiles.get(key));
  }

  async saveRankedProfile(profile) {
    const key = rankedProfileKey(profile.userId, profile.seasonId);
    const stored = { ...cloneValue(profile), updatedAt: new Date() };
    this.rankedProfiles.set(key, stored);
    return cloneValue(stored);
  }

  async getLeaderboard(seasonId, { limit, offset }) {
    const entries = [...this.rankedProfiles.values()]
      .filter((profile) => profile.seasonId === seasonId && profile.ratedGames >= 50 && this.profiles.get(profile.userId)?.status === 'active')
      .sort((left, right) => right.decisionEv - left.decisionEv || right.rating - left.rating || left.userId.localeCompare(right.userId))
      .map((profile, index) => ({
        rank: index + 1, publicId: this.profiles.get(profile.userId).publicId, handle: this.profiles.get(profile.userId).handle,
        ...cloneValue(profile)
      }));
    return { total: entries.length, entries: entries.slice(offset, offset + limit) };
  }

  async getLeaderboardRank(seasonId, userId) {
    const entries = (await this.getLeaderboard(seasonId, { limit: 10_000, offset: 0 })).entries;
    return entries.find((entry) => entry.userId === userId)?.rank || null;
  }
}

module.exports = {
  MemoryRankedRepository,
  PostgresRankedRepository,
  defaultHandleForUser,
  mapGame,
  mapMove,
  mapProfile,
  mapRankedProfile,
  mapSeason
};
