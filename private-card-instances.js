'use strict';

/**
 * Private拡張用のカード実体。
 *
 * definitionId は能力・強さの定義を指すだけで、実際に手札から選ぶ
 * ときは server-issued instanceId を使う。これにより同名コピーが
 * 増えても一枚だけを正確に消費できる。
 */
const { MAX_PRIVATE_CARD_INSTANCES } = require('./private-ruleset');
const {
  CLASSIC_PRIVATE_CARD_DEFINITION_BY_ID,
  PRIVATE_CARD_DEFINITION_BY_ID,
  getClassicPrivateCardDefinition,
  getPrivateCardDefinition
} = require('./private-card-definitions');

const CARD_DEFINITION_BY_ID = PRIVATE_CARD_DEFINITION_BY_ID;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}:[A-Za-z0-9_-]{1,16}:[1-9][0-9]{0,5}$/;
// Lock ids are server generated and include the card instance id. Instance
// ids intentionally use ':' to separate their namespace/seat/ordinal.
const LOCK_ID_PATTERN = /^[A-Za-z0-9:_-]{1,96}$/;
const CARD_VISIBILITY_VALUES = new Set(['public', 'noise-owner-only']);

function normalizeCardLocks(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new RangeError('private card locks are invalid');
  const seen = new Set();
  return value.map((lock) => {
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)
      || typeof lock.id !== 'string' || !LOCK_ID_PATTERN.test(lock.id)
      || !Number.isSafeInteger(lock.releaseAfterRound) || lock.releaseAfterRound < 1 || lock.releaseAfterRound > 64
      || seen.has(lock.id)) {
      throw new RangeError('private card lock is invalid');
    }
    seen.add(lock.id);
    return Object.freeze({ id: lock.id, releaseAfterRound: lock.releaseAfterRound });
  });
}

function getClassicCardDefinition(definitionId) {
  return getClassicPrivateCardDefinition(definitionId);
}

function getPrivateCardDefinitionById(definitionId) {
  return getPrivateCardDefinition(definitionId);
}

function assertInstanceId(instanceId) {
  if (typeof instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new RangeError('invalid private card instance id');
  }
  return instanceId;
}

function createPrivateCardInstance({ instanceId, definitionId, state = {} } = {}) {
  assertInstanceId(instanceId);
  getPrivateCardDefinitionById(definitionId);
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('private card state must be an object');
  }
  const locks = state.locks === undefined && state.locked === true
    // Older in-memory fixtures only had a boolean.  Preserve their locked
    // interpretation without allowing a client to pick a release time.
    ? [Object.freeze({ id: 'legacy-lock', releaseAfterRound: 64 })]
    : normalizeCardLocks(state.locks);
  const visibility = state.visibility === undefined ? 'public' : state.visibility;
  const revealOn = state.revealOn === undefined || state.revealOn === null ? null : state.revealOn;
  if (!CARD_VISIBILITY_VALUES.has(visibility)
    || (revealOn !== null && revealOn !== 'play')
    || (visibility === 'noise-owner-only' && revealOn !== 'play')) {
    throw new RangeError('private card visibility state is invalid');
  }
  // State is intentionally structured and closed.  A client cannot smuggle
  // an ability, target list, arbitrary metadata, or code through a card.
  return {
    instanceId,
    definitionId,
    state: {
      locked: locks.length > 0 || state.locked === true,
      flipped: state.flipped === true,
      // A generated card is still an ordinary, server-issued card for game
      // logic. This closed flag supports a shared visual treatment without
      // accepting arbitrary display data from a client. Omit false so old
      // pre-feature room snapshots remain canonical on reconnect.
      ...(state.generated === true ? { generated: true } : {}),
      locks,
      visibility,
      revealOn
    }
  };
}

function clonePrivateCardInstance(instance) {
  return createPrivateCardInstance(instance);
}

function createPrivateCardInstances({ namespace, seat, definitionIds } = {}) {
  if (typeof namespace !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(namespace)) {
    throw new RangeError('invalid private instance namespace');
  }
  if (typeof seat !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(seat)) {
    throw new RangeError('invalid private instance seat');
  }
  if (!Array.isArray(definitionIds) || definitionIds.length < 1 || definitionIds.length > MAX_PRIVATE_CARD_INSTANCES) {
    throw new RangeError('invalid private card definition list');
  }
  return definitionIds.map((definitionId, index) => createPrivateCardInstance({
    instanceId: `${namespace}:${seat}:${index + 1}`,
    definitionId
  }));
}

// Kept as an alias for the classic-only factory and existing callers.  The
// generic function above is the only instance construction path for future
// Private-only cards as well.
const createClassicPrivateCardInstances = createPrivateCardInstances;

function publicClassicCard(instance) {
  const normalized = clonePrivateCardInstance(instance);
  const definition = getPrivateCardDefinitionById(normalized.definitionId);
  return {
    instanceId: normalized.instanceId,
    definitionId: normalized.definitionId,
    name: definition.name,
    desc: definition.desc,
    // Base strength is descriptive, server-authored metadata. Conditional
    // cards still receive their authoritative current-round value separately
    // in a recipient-safe round preview.
    baseStrength: Number.isSafeInteger(definition.strength) ? definition.strength : null,
    category: definition.category || '',
    displayMark: definition.displayMark || '',
    faceLabel: definition.faceLabel || definition.name,
    visualRole: definition.visualRole || '',
    generated: normalized.state.generated === true,
    state: { ...normalized.state }
  };
}

const publicPrivateCard = publicClassicCard;

module.exports = {
  CARD_VISIBILITY_VALUES,
  CARD_DEFINITION_BY_ID,
  INSTANCE_ID_PATTERN,
  assertInstanceId,
  clonePrivateCardInstance,
  createClassicPrivateCardInstances,
  createPrivateCardInstances,
  createPrivateCardInstance,
  getClassicCardDefinition,
  getPrivateCardDefinition: getPrivateCardDefinitionById,
  publicPrivateCard,
  publicClassicCard
};
