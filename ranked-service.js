'use strict';

const crypto = require('crypto');
const {
  CARD_IDS,
  INITIAL_HAND_SIZE,
  RANKED_RULES_VERSION,
  applyRound,
  cardIdFromIndex,
  createInitialRankedState,
  getLegalCardIds,
  isTerminalState,
  popcount,
  stateFromKey
} = require('./ranked-engine');
const { decryptSeed, encryptSeed } = require('./ranked-crypto');
const { RANKED_AI_POLICY_VERSION, createGameSeed, deriveAiCardId, deriveTimeoutPlayerCardId, seedCommitment, seedToPublicString } = require('./ranked-rng');
const { RANKED_EVALUATION_VERSION, VALUE_SCALE } = require('./ranked-solver');
const {
  INITIAL_DECISION_EV,
  INITIAL_EV_DENOMINATOR,
  INITIAL_EV_NUMERATOR,
  calculateRating,
  createEmptyRatingProfile,
  effectiveSampleSize,
  isEligibleForLeaderboard,
  standardError,
  updateRatingProfile
} = require('./rating');

const RANKED_RATING_VERSION = 'ewma-half-life-50-v1';
const TURN_TIME_LIMIT_MS = 90_000;
const FINAL_ROUND_TIME_LIMIT_MS = 15_000;
const DEFAULT_ABANDON_AFTER_MS = 24 * 60 * 60_000;
const HANDLE_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60_000;
const INITIAL_VALUE_SCALED = (BigInt(INITIAL_EV_NUMERATOR) * VALUE_SCALE + BigInt(INITIAL_EV_DENOMINATOR) / 2n)
  / BigInt(INITIAL_EV_DENOMINATOR);

class RankedError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'RankedError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function assertUuid(value, label = 'requestId') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RankedError(400, 'INVALID_REQUEST_ID', `${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('invalid persisted date');
  return date;
}

function dateAfter(now, milliseconds) {
  return new Date(asDate(now).getTime() + milliseconds);
}

function scaledToNumber(value) {
  return Number(BigInt(value)) / Number(VALUE_SCALE);
}

function resultName(matchScore) {
  if (matchScore === 1) return 'win';
  if (matchScore === 0.5) return 'draw';
  return 'loss';
}

function buildRoundHistory(move) {
  const state = stateFromKey(move.stateKey);
  const applied = applyRound(state, move.playerCardId, move.aiCardId);
  return {
    round: move.round,
    playerCardId: move.playerCardId,
    aiCardId: move.aiCardId,
    winner: applied.winner,
    awardedCards: applied.awardedCards,
    timeout: move.timeout
  };
}

function buildCurrentSeasonSpec(valueLookup) {
  if (!valueLookup?.table?.metadata?.checksum) throw new TypeError('a validated Ranked value lookup is required');
  return {
    rulesVersion: RANKED_RULES_VERSION,
    aiPolicyVersion: RANKED_AI_POLICY_VERSION,
    evaluationVersion: RANKED_EVALUATION_VERSION,
    ratingVersion: RANKED_RATING_VERSION,
    valueTableChecksum: valueLookup.table.metadata.checksum,
    initialEv: INITIAL_DECISION_EV,
    initialEvNumerator: INITIAL_EV_NUMERATOR,
    initialEvDenominator: INITIAL_EV_DENOMINATOR
  };
}

class RankedService {
  constructor({
    repository,
    valueLookup,
    seedEncryptionKey,
    now = () => new Date(),
    turnTimeLimitMs = TURN_TIME_LIMIT_MS,
    finalRoundTimeLimitMs = FINAL_ROUND_TIME_LIMIT_MS,
    abandonAfterMs = DEFAULT_ABANDON_AFTER_MS,
    leaderboardCacheTtlMs = 15_000
  }) {
    if (!repository) throw new TypeError('ranked repository is required');
    if (!valueLookup) throw new TypeError('ranked value lookup is required');
    if (!seedEncryptionKey) throw new TypeError('ranked seed encryption key is required');
    this.repository = repository;
    this.valueLookup = valueLookup;
    this.seedEncryptionKey = seedEncryptionKey;
    this.now = now;
    this.turnTimeLimitMs = turnTimeLimitMs;
    this.finalRoundTimeLimitMs = finalRoundTimeLimitMs;
    this.abandonAfterMs = abandonAfterMs;
    this.leaderboardCacheTtlMs = leaderboardCacheTtlMs;
    this.leaderboardCache = new Map();
    this.leaderboardInFlight = new Map();
    this.leaderboardCacheVersion = 0;
  }

  nowDate() {
    return asDate(this.now());
  }

  seasonSpec() {
    return buildCurrentSeasonSpec(this.valueLookup);
  }

  turnTimeLimitForRound(round) {
    return round === INITIAL_HAND_SIZE ? this.finalRoundTimeLimitMs : this.turnTimeLimitMs;
  }

  async ensureCurrentSeasonInTransaction(tx, { lockActive = false } = {}) {
    const expected = this.seasonSpec();
    let active = await tx.getActiveSeason({ forUpdate: lockActive });
    if (!active) {
      await tx.lockSeason?.();
      active = await tx.getActiveSeason({ forUpdate: true });
    }
    if (!active) return tx.createSeason(expected);
    const matches = active.rulesVersion === expected.rulesVersion
      && active.aiPolicyVersion === expected.aiPolicyVersion
      && active.evaluationVersion === expected.evaluationVersion
      && active.ratingVersion === expected.ratingVersion
      && active.valueTableChecksum === expected.valueTableChecksum
      && active.initialEvNumerator === expected.initialEvNumerator
      && active.initialEvDenominator === expected.initialEvDenominator;
    if (!matches) {
      throw new RankedError(503, 'SEASON_VERSION_MISMATCH', 'Ranked season must be rotated before this version can accept games.');
    }
    return active;
  }

  async assertActiveProfile(tx, userId) {
    const profile = await tx.ensureProfile(userId);
    if (!profile || profile.status !== 'active') {
      throw new RankedError(403, 'PROFILE_UNAVAILABLE', 'This account cannot use Ranked mode.');
    }
    return profile;
  }

  assertGameOwner(game, userId) {
    if (!game || game.userId !== userId) throw new RankedError(404, 'GAME_NOT_FOUND', 'Ranked game was not found.');
  }

  async createOrResumeGame(userId) {
    const createOrResume = async (tx) => {
      await this.assertActiveProfile(tx, userId);
      const existing = await tx.findActiveGameForUser(userId, { forUpdate: true });
      if (existing) {
        const settled = await this.settleDueGameInTransaction(tx, existing);
        return this.getGameView(settled, await tx.listMoves(settled.id));
      }

      const season = await this.ensureCurrentSeasonInTransaction(tx, { lockActive: true });
      const now = this.nowDate();
      const seed = createGameSeed();
      const state = createInitialRankedState();
      const created = await tx.createGame({
        id: crypto.randomUUID(),
        userId,
        seasonId: season.id,
        rulesVersion: season.rulesVersion,
        aiPolicyVersion: season.aiPolicyVersion,
        evaluationVersion: season.evaluationVersion,
        ratingVersion: season.ratingVersion,
        valueTableChecksum: season.valueTableChecksum,
        state,
        currentRound: 1,
        turnStartedAt: now,
        deadline: dateAfter(now, this.turnTimeLimitForRound(1)),
        encryptedSeed: encryptSeed(seed, this.seedEncryptionKey),
        seedCommitment: seedCommitment(seed)
      });
      return this.getGameView(created, []);
    };

    try {
      return await this.repository.transaction(createOrResume);
    } catch (error) {
      // A unique partial index is the final authority for the one-active-game
      // invariant.  Two first requests can both observe no row before one of
      // them commits; the loser returns that committed game instead of turning
      // a harmless double-click into a 500 response.
      if (error?.code !== '23505') throw error;
      return this.repository.transaction(async (tx) => {
        const existing = await tx.findActiveGameForUser(userId, { forUpdate: true });
        if (!existing) throw error;
        const settled = await this.settleDueGameInTransaction(tx, existing);
        return this.getGameView(settled, await tx.listMoves(settled.id));
      });
    }
  }

  async getActiveGame(userId) {
    return this.repository.transaction(async (tx) => {
      await this.assertActiveProfile(tx, userId);
      const game = await tx.findActiveGameForUser(userId, { forUpdate: true });
      if (!game) return null;
      const settled = await this.settleDueGameInTransaction(tx, game);
      return this.getGameView(settled, await tx.listMoves(settled.id));
    });
  }

  validateMovePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new RankedError(400, 'INVALID_MOVE', 'Move body must be an object.');
    }
    if (Object.keys(payload).some((key) => !['expectedRound', 'cardId', 'requestId'].includes(key))) {
      throw new RankedError(400, 'INVALID_MOVE', 'Move body contains unsupported fields.');
    }
    const { expectedRound, cardId, requestId } = payload;
    if (!Number.isSafeInteger(expectedRound) || expectedRound < 1 || expectedRound > 7) {
      throw new RankedError(400, 'INVALID_ROUND', 'expectedRound must be between 1 and 7.');
    }
    if (typeof cardId !== 'string' || !CARD_IDS.includes(cardId)) {
      throw new RankedError(400, 'INVALID_CARD', 'cardId is invalid.');
    }
    return { expectedRound, cardId, requestId: assertUuid(requestId) };
  }

  async submitMove(userId, gameId, payload) {
    const move = this.validateMovePayload(payload);
    const safeGameId = assertUuid(gameId, 'gameId');
    return this.repository.transaction(async (tx) => {
      await this.assertActiveProfile(tx, userId);
      let game = await tx.findGameById(safeGameId, { forUpdate: true });
      this.assertGameOwner(game, userId);

      const duplicate = await tx.findMoveByRequestId(game.id, move.requestId);
      if (duplicate) return { ...duplicate.response, idempotent: true };

      if (game.status !== 'active') throw new RankedError(409, 'GAME_FINISHED', 'This Ranked game is already finished.');
      const now = this.nowDate();
      if (asDate(game.deadline).getTime() <= now.getTime()) {
        game = await this.settleDueGameInTransaction(tx, game, now);
        throw new RankedError(409, 'ROUND_EXPIRED', 'The turn expired before this move was accepted.', {
          game: this.getGameView(game, await tx.listMoves(game.id))
        });
      }
      if (move.expectedRound !== game.currentRound) {
        throw new RankedError(409, 'ROUND_MISMATCH', 'The client round is stale.', {
          game: this.getGameView(game, await tx.listMoves(game.id))
        });
      }
      if (!getLegalCardIds(game.state.playerMask).includes(move.cardId)) {
        throw new RankedError(400, 'ILLEGAL_CARD', 'That card is not available in this game state.');
      }
      return this.executeRoundInTransaction(tx, game, {
        playerCardId: move.cardId,
        requestId: move.requestId,
        timeout: false,
        thinkingTimeMs: Math.max(0, Math.min(this.turnTimeLimitForRound(game.currentRound), now.getTime() - asDate(game.turnStartedAt).getTime())),
        now
      });
    });
  }

  async settleDueGameInTransaction(tx, game, now = this.nowDate()) {
    if (game.status !== 'active' || asDate(game.deadline).getTime() > now.getTime()) return game;
    if (now.getTime() - asDate(game.deadline).getTime() >= this.abandonAfterMs) {
      return this.finalizeForfeitInTransaction(tx, game, now);
    }
    const seed = decryptSeed(game.encryptedSeed, this.seedEncryptionKey);
    const playerCardId = deriveTimeoutPlayerCardId(seed, {
      gameId: game.id,
      round: game.currentRound,
      state: game.state
    });
    const result = await this.executeRoundInTransaction(tx, game, {
      playerCardId,
      requestId: null,
      timeout: true,
      thinkingTimeMs: this.turnTimeLimitForRound(game.currentRound),
      now,
      responseForTimeout: false
    });
    return await tx.findGameById(result.game.id, { forUpdate: true });
  }

  async executeRoundInTransaction(tx, game, { playerCardId, requestId, timeout, thinkingTimeMs, now, responseForTimeout = true }) {
    const decision = this.valueLookup.getDecision(game.state, playerCardId);
    const seed = decryptSeed(game.encryptedSeed, this.seedEncryptionKey);
    const aiCardId = deriveAiCardId(seed, { gameId: game.id, round: game.currentRound, state: game.state });
    const applied = applyRound(game.state, playerCardId, aiCardId);
    let nextGame = {
      ...game,
      state: applied.state,
      totalRegret: game.totalRegret + decision.regret
    };

    if (applied.terminal) {
      nextGame = await this.finalizeCompletedGameInTransaction(tx, nextGame, applied.matchScore, now);
    } else {
      nextGame.currentRound = game.currentRound + 1;
      nextGame.turnStartedAt = now;
      nextGame.deadline = dateAfter(now, this.turnTimeLimitForRound(nextGame.currentRound));
      nextGame = await tx.saveGame(nextGame);
    }

    const moveRecord = {
      gameId: game.id,
      round: game.currentRound,
      requestId,
      stateKey: decision.stateKey,
      playerCardId,
      aiCardId,
      optimalV: decision.value,
      chosenQ: decision.q,
      regret: decision.regret,
      timeout,
      thinkingTimeMs,
      response: null
    };
    const priorMoves = await tx.listMoves(game.id);
    const response = {
      game: this.getGameView(nextGame, [...priorMoves, moveRecord]),
      round: buildRoundHistory(moveRecord),
      idempotent: false
    };
    moveRecord.response = responseForTimeout ? response : { game: response.game, round: response.round };
    await tx.insertMove(moveRecord);
    return response;
  }

  async finalizeCompletedGameInTransaction(tx, game, matchScore, now) {
    const decisionPerformance = INITIAL_VALUE_SCALED - game.totalRegret;
    return this.finalizeRatingInTransaction(tx, game, {
      status: 'completed',
      actualResult: resultName(matchScore),
      matchScore,
      decisionPerformance,
      luck: matchScore - scaledToNumber(decisionPerformance),
      forfeit: false,
      now
    });
  }

  async finalizeForfeitInTransaction(tx, game, now = this.nowDate()) {
    if (game.status !== 'active') return game;
    return this.finalizeRatingInTransaction(tx, game, {
      status: 'forfeited',
      actualResult: 'forfeit',
      matchScore: 0,
      decisionPerformance: 0n,
      luck: 0,
      forfeit: true,
      now
    });
  }

  async finalizeRatingInTransaction(tx, game, details) {
    if (game.ratingFinalizedAt) return game;
    const profile = await tx.getOrCreateRankedProfile(game.userId, game.seasonId, { forUpdate: true });
    const previousRating = profile.rating === null || profile.rating === undefined ? 1000 : profile.rating;
    const updatedProfile = updateRatingProfile({ ...createEmptyRatingProfile(), ...profile }, {
      decisionPerformance: scaledToNumber(details.decisionPerformance),
      matchScore: details.matchScore,
      forfeit: details.forfeit,
      now: details.now
    });
    updatedProfile.userId = game.userId;
    updatedProfile.seasonId = game.seasonId;
    await tx.saveRankedProfile(updatedProfile);
    this.clearLeaderboardCache(game.seasonId);

    const finalized = {
      ...game,
      status: details.status,
      decisionPerformance: details.decisionPerformance,
      actualResult: details.actualResult,
      matchScore: details.matchScore,
      luck: details.luck,
      ratingBefore: previousRating,
      ratingAfter: updatedProfile.rating,
      ratingFinalizedAt: details.now,
      finishedAt: details.now,
      deadline: details.now,
      turnStartedAt: game.turnStartedAt
    };
    return tx.saveGame(finalized);
  }

  async forfeitGame(userId, gameId) {
    const safeGameId = assertUuid(gameId, 'gameId');
    return this.repository.transaction(async (tx) => {
      await this.assertActiveProfile(tx, userId);
      const game = await tx.findGameById(safeGameId, { forUpdate: true });
      this.assertGameOwner(game, userId);
      const finalized = await this.finalizeForfeitInTransaction(tx, game, this.nowDate());
      return this.getGameView(finalized, await tx.listMoves(finalized.id));
    });
  }

  getGameView(game, moves) {
    const active = game.status === 'active';
    const base = {
      id: game.id,
      seasonId: game.seasonId,
      status: game.status,
      currentRound: game.currentRound,
      playerHand: getLegalCardIds(game.state.playerMask),
      // This is not hidden information: every opponent card is revealed when
      // played, and the Random Opponent's hand therefore remains derivable.
      // Returning it directly makes that essential tactical context clear.
      opponentHand: getLegalCardIds(game.state.aiMask),
      aiRemainingCards: popcount(game.state.aiMask),
      playerScore: game.state.playerScore,
      aiScore: game.state.aiScore,
      stackCount: game.state.stackCount,
      deadline: active ? asDate(game.deadline).toISOString() : null,
      seedCommitment: game.seedCommitment,
      history: moves.map(buildRoundHistory)
    };
    if (active) return base;
    const seed = decryptSeed(game.encryptedSeed, this.seedEncryptionKey);
    return {
      ...base,
      seed: seedToPublicString(seed),
      actualResult: game.actualResult,
      matchScore: game.matchScore,
      decisionPerformance: scaledToNumber(game.decisionPerformance ?? 0n),
      totalRegret: scaledToNumber(game.totalRegret),
      luck: game.luck,
      ratingBefore: game.ratingBefore,
      ratingAfter: game.ratingAfter
    };
  }

  async getProfileSummary(userId) {
    return this.repository.transaction(async (tx) => {
      const profile = await this.assertActiveProfile(tx, userId);
      const season = await this.ensureCurrentSeasonInTransaction(tx);
      const rankedProfile = await tx.getOrCreateRankedProfile(userId, season.id, { forUpdate: true });
      const rank = isEligibleForLeaderboard(rankedProfile)
        ? await tx.getLeaderboardRank(season.id, userId)
        : null;
      return this.publicProfileSummary(profile, rankedProfile, rank);
    });
  }

  async updateHandle(userId, handle) {
    if (typeof handle !== 'string' || !/^[A-Za-z0-9_-]{3,20}$/.test(handle)) {
      throw new RankedError(400, 'INVALID_HANDLE', 'Handle must be 3–20 ASCII letters, numbers, _ or -.');
    }
    const normalizedHandle = handle.toLowerCase();
    return this.repository.transaction(async (tx) => {
      const profile = await this.assertActiveProfile(tx, userId);
      const now = this.nowDate();
      if (profile.handleChangedAt && now.getTime() - asDate(profile.handleChangedAt).getTime() < HANDLE_CHANGE_COOLDOWN_MS) {
        throw new RankedError(429, 'HANDLE_COOLDOWN', 'Handle can only be changed once every 30 days.');
      }
      let updated;
      try {
        updated = await tx.updateHandle(userId, handle, normalizedHandle, now);
      } catch (error) {
        if (error?.code === '23505') throw new RankedError(409, 'HANDLE_TAKEN', 'That handle is already in use.');
        throw error;
      }
      const season = await this.ensureCurrentSeasonInTransaction(tx);
      const rankedProfile = await tx.getOrCreateRankedProfile(userId, season.id, { forUpdate: true });
      const rank = isEligibleForLeaderboard(rankedProfile)
        ? await tx.getLeaderboardRank(season.id, userId)
        : null;
      return this.publicProfileSummary(updated, rankedProfile, rank);
    });
  }

  publicProfileSummary(profile, rankedProfile, rank) {
    const eligible = isEligibleForLeaderboard(rankedProfile);
    return {
      publicId: profile.publicId,
      handle: profile.handle,
      status: profile.status,
      ratedGames: rankedProfile.ratedGames,
      wins: rankedProfile.wins,
      draws: rankedProfile.draws,
      losses: rankedProfile.losses,
      forfeits: rankedProfile.forfeits,
      decisionEv: rankedProfile.decisionEv,
      rating: rankedProfile.rating,
      provisional: !eligible,
      provisionalProgress: Math.min(50, rankedProfile.ratedGames),
      rank: eligible ? rank : null,
      effectiveSampleSize: effectiveSampleSize(rankedProfile),
      standardError: standardError(rankedProfile)
    };
  }

  clearLeaderboardCache() {
    this.leaderboardCache.clear();
    this.leaderboardCacheVersion += 1;
  }

  async getLeaderboard({ limit = 25, offset = 0 } = {}) {
    const safeLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 25;
    const safeOffset = Number.isSafeInteger(offset) ? Math.min(Math.max(offset, 0), 10_000) : 0;
    const key = `${safeLimit}:${safeOffset}`;
    const now = this.nowDate().getTime();
    const cached = this.leaderboardCache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const inFlight = this.leaderboardInFlight.get(key);
    if (inFlight) return inFlight;

    const cacheVersion = this.leaderboardCacheVersion;
    const query = this.repository.transaction(async (tx) => {
      const season = await this.ensureCurrentSeasonInTransaction(tx);
      const leaderboard = await tx.getLeaderboard(season.id, { limit: safeLimit, offset: safeOffset });
      const value = {
        season: {
          id: season.id,
          rulesVersion: season.rulesVersion,
          aiPolicyVersion: season.aiPolicyVersion,
          evaluationVersion: season.evaluationVersion,
          ratingVersion: season.ratingVersion
        },
        pagination: { limit: safeLimit, offset: safeOffset, total: leaderboard.total },
        entries: leaderboard.entries.map((entry) => ({
          rank: entry.rank,
          publicId: entry.publicId,
          handle: entry.handle,
          rating: entry.rating,
          decisionEv: entry.decisionEv,
          ratedGames: entry.ratedGames,
          wins: entry.wins,
          draws: entry.draws,
          losses: entry.losses,
          forfeits: entry.forfeits,
          effectiveSampleSize: effectiveSampleSize(entry),
          standardError: standardError(entry)
        }))
      };
      if (this.leaderboardCacheVersion === cacheVersion) {
        this.leaderboardCache.set(key, { value, expiresAt: this.nowDate().getTime() + this.leaderboardCacheTtlMs });
      }
      return value;
    });
    this.leaderboardInFlight.set(key, query);
    try {
      return await query;
    } finally {
      if (this.leaderboardInFlight.get(key) === query) this.leaderboardInFlight.delete(key);
    }
  }

  async expireDueGames(limit = 100) {
    const now = this.nowDate();
    const gameIds = await this.repository.findDueGameIds(now, limit);
    let settled = 0;
    for (const gameId of gameIds) {
      try {
        await this.repository.transaction(async (tx) => {
          const game = await tx.findGameById(gameId, { forUpdate: true });
          if (!game) return;
          await this.settleDueGameInTransaction(tx, game, now);
          settled += 1;
        });
      } catch {
        // A later sweep/reconnect retries transient database errors; do not take PvP down.
      }
    }
    return settled;
  }
}

module.exports = {
  DEFAULT_ABANDON_AFTER_MS,
  HANDLE_CHANGE_COOLDOWN_MS,
  INITIAL_VALUE_SCALED,
  RANKED_RATING_VERSION,
  FINAL_ROUND_TIME_LIMIT_MS,
  RankedError,
  RankedService,
  TURN_TIME_LIMIT_MS,
  assertUuid,
  buildCurrentSeasonSpec,
  buildRoundHistory,
  scaledToNumber
};
