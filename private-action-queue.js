'use strict';

/**
 * Server-only contract for the one-at-a-time target choices used by the
 * advanced Private Tarot cards.  It deliberately has no Socket.IO or room
 * mutation dependency: callers keep the engine action private, expose only a
 * recipient-specific view, and atomically consume a validated choice.
 */
const crypto = require('crypto');

const PRIVATE_ACTION_TIMEOUT_MS = 20_000;
const MAX_PRIVATE_ACTION_CANDIDATES = 32;
const ACTION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const TARGET_PATTERN = /^[A-Za-z0-9:_-]{1,96}$/;
const PRIVATE_SEATS = new Set(['p1', 'p2']);

function assertSeat(value, name) {
  if (!PRIVATE_SEATS.has(value)) throw new RangeError(`private action ${name} is invalid`);
  return value;
}

function normalizeTarget(value) {
  if (typeof value !== 'string' || !TARGET_PATTERN.test(value)) {
    throw new RangeError('private action target is invalid');
  }
  return value;
}

function randomToken(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(16);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
    throw new Error('private action token source is invalid');
  }
  return bytes.toString('base64url');
}

function normalizeEngineAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)
    || typeof action.type !== 'string' || action.type.length < 1 || action.type.length > 64
    || typeof action.sourceDefinitionId !== 'string' || action.sourceDefinitionId.length < 1
    || action.sourceDefinitionId.length > 64
    || !Number.isSafeInteger(action.round) || action.round < 1 || action.round > 20) {
    throw new TypeError('private engine action is invalid');
  }
  const candidates = Array.isArray(action.candidates) ? action.candidates.map(normalizeTarget) : [];
  if (candidates.length > MAX_PRIVATE_ACTION_CANDIDATES || new Set(candidates).size !== candidates.length) {
    throw new RangeError('private action candidates are invalid');
  }
  return Object.freeze({
    type: action.type,
    round: action.round,
    sourceSeat: assertSeat(action.sourceSeat, 'source seat'),
    sourceDefinitionId: action.sourceDefinitionId,
    actorSeat: assertSeat(action.actorSeat, 'actor seat'),
    targetSeat: assertSeat(action.targetSeat, 'target seat'),
    actionKey: typeof action.actionKey === 'string' && action.actionKey.length > 0 && action.actionKey.length <= 128
      ? action.actionKey
      : `${action.round}:${action.sourceSeat}:${action.sourceDefinitionId}:${action.type}`,
    candidates: Object.freeze(candidates)
  });
}

function createPrivatePendingAction({
  roomId,
  gameRevision,
  phase = 'post-result',
  action,
  now = Date.now(),
  timeoutMs = PRIVATE_ACTION_TIMEOUT_MS,
  randomBytes = crypto.randomBytes
} = {}) {
  if (typeof roomId !== 'string' || roomId.length < 1 || roomId.length > 24
    || !Number.isSafeInteger(gameRevision) || gameRevision < 1
    || !['pre-commit', 'post-result'].includes(phase)
    || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PRIVATE_ACTION_TIMEOUT_MS) {
    throw new RangeError('private pending action parameters are invalid');
  }
  const engineAction = normalizeEngineAction(action);
  const id = randomToken(randomBytes);
  const nonce = randomToken(randomBytes);
  return Object.freeze({
    id,
    nonce,
    roomId,
    gameRevision,
    phase,
    action: engineAction,
    createdAt: now,
    expiresAt: now + timeoutMs
  });
}

function isPrivatePendingActionExpired(pending, now = Date.now()) {
  return Boolean(pending && Number.isSafeInteger(pending.expiresAt)
    && Number.isSafeInteger(now) && now >= pending.expiresAt);
}

function resolvePrivatePendingAction(pending, {
  actionId,
  nonce,
  target,
  actorSeat,
  gameRevision,
  now = Date.now()
} = {}) {
  if (!pending || typeof pending !== 'object') return { ok: false, code: 'missing' };
  if (isPrivatePendingActionExpired(pending, now)) return { ok: false, code: 'expired' };
  if (actionId !== pending.id || nonce !== pending.nonce) return { ok: false, code: 'stale' };
  if (actorSeat !== pending.action.actorSeat || gameRevision !== pending.gameRevision) {
    return { ok: false, code: 'forbidden' };
  }
  try {
    const normalizedTarget = normalizeTarget(target);
    if (!pending.action.candidates.includes(normalizedTarget)) return { ok: false, code: 'target' };
    return { ok: true, target: normalizedTarget };
  } catch {
    return { ok: false, code: 'target' };
  }
}

function chooseExpiredPrivateActionTarget(pending, randomInt = crypto.randomInt) {
  if (!pending?.action || !Array.isArray(pending.action.candidates) || pending.action.candidates.length === 0) {
    return null;
  }
  const index = randomInt(pending.action.candidates.length);
  if (!Number.isSafeInteger(index) || index < 0 || index >= pending.action.candidates.length) {
    throw new RangeError('private action random selector is invalid');
  }
  return pending.action.candidates[index];
}

function publicPrivatePendingAction(pending, viewerSeat) {
  if (!pending?.action) return null;
  const base = {
    active: true,
    expiresAt: pending.expiresAt,
    phase: pending.phase
  };
  if (viewerSeat !== pending.action.actorSeat) {
    return Object.freeze({ ...base, message: '能力の対象を選択中です。' });
  }
  return Object.freeze({
    ...base,
    id: pending.id,
    nonce: pending.nonce,
    gameRevision: pending.gameRevision,
    type: pending.action.type,
    candidates: Object.freeze([...pending.action.candidates]),
    message: '能力の対象を選んでください。選択後は取り消せません。'
  });
}

module.exports = {
  MAX_PRIVATE_ACTION_CANDIDATES,
  PRIVATE_ACTION_TIMEOUT_MS,
  chooseExpiredPrivateActionTarget,
  createPrivatePendingAction,
  isPrivatePendingActionExpired,
  normalizeEngineAction,
  publicPrivatePendingAction,
  resolvePrivatePendingAction
};
