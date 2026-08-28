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
  // State is deliberately narrow until lock/flip mechanics are defined. A
  // caller cannot smuggle arbitrary effect data through an instance.
  return {
    instanceId,
    definitionId,
    state: {
      locked: state.locked === true,
      flipped: state.flipped === true
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
    state: { ...normalized.state }
  };
}

const publicPrivateCard = publicClassicCard;

module.exports = {
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
