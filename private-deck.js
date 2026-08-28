'use strict';

/**
 * Private拡張用デッキの正規化とサーバー側検証。
 *
 * UIはdefinitionIdと枚数だけを送る。カードの強さ、能力、公開範囲や
 * 互換性はすべてprivate-card-definitions.jsのカタログから導出する。
 */
const {
  EXPANDED_PRIVATE_RULESET_ID,
  MAX_PRIVATE_INITIAL_CARDS_PER_SIDE,
  assertPrivateRuleset,
  getPrivateRulesetFeatures
} = require('./private-ruleset');
const { PRIVATE_CARD_CATALOG, getPrivateCardDefinition } = require('./private-card-definitions');

const EXPANDED_DECK_MINIMUM_CARDS = 5;
const EXPANDED_DECK_MAXIMUM_CARDS = MAX_PRIVATE_INITIAL_CARDS_PER_SIDE;
const CATALOG_ORDER = new Map(PRIVATE_CARD_CATALOG.map((definition, index) => [definition.id, index]));

function isAvailableDefinition(definition, ruleset, features) {
  return definition.status === 'available'
    && definition.availability.includes(ruleset.ruleset)
    && definition.requiresFeatures.every((feature) => features.has(feature));
}

function normalizePrivateDeckEntries(entries, ruleset) {
  assertPrivateRuleset(ruleset);
  if (ruleset.ruleset !== EXPANDED_PRIVATE_RULESET_ID) {
    throw new RangeError('deck editing is available only for the expanded private ruleset');
  }
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > PRIVATE_CARD_CATALOG.length) {
    throw new RangeError('invalid private deck entry list');
  }

  const features = new Set(getPrivateRulesetFeatures(ruleset));
  const copiesByDefinitionId = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some((key) => key !== 'definitionId' && key !== 'copies')) {
      throw new TypeError('invalid private deck entry');
    }
    if (typeof entry.definitionId !== 'string' || !Number.isSafeInteger(entry.copies) || entry.copies < 1) {
      throw new RangeError('invalid private deck entry values');
    }
    const definition = getPrivateCardDefinition(entry.definitionId);
    if (!isAvailableDefinition(definition, ruleset, features)) {
      throw new RangeError(`private deck card is unavailable: ${entry.definitionId}`);
    }
    const nextCopies = (copiesByDefinitionId.get(definition.id) || 0) + entry.copies;
    if (nextCopies > definition.maxCopiesPerDeck) {
      throw new RangeError(`private deck card exceeds its copy limit: ${entry.definitionId}`);
    }
    copiesByDefinitionId.set(definition.id, nextCopies);
  }

  const normalized = [...copiesByDefinitionId]
    .sort(([leftId], [rightId]) => CATALOG_ORDER.get(leftId) - CATALOG_ORDER.get(rightId))
    .map(([definitionId, copies]) => Object.freeze({ definitionId, copies }));
  const totalCards = normalized.reduce((total, entry) => total + entry.copies, 0);
  if (totalCards < EXPANDED_DECK_MINIMUM_CARDS || totalCards > EXPANDED_DECK_MAXIMUM_CARDS) {
    throw new RangeError('private expanded deck size is outside the supported range');
  }
  if (ruleset.roundLimit > totalCards) {
    throw new RangeError('private expanded round limit cannot exceed deck size');
  }
  if (ruleset.scoreTarget !== null && ruleset.scoreTarget > ruleset.roundLimit * 2) {
    throw new RangeError('private expanded score target cannot exceed obtainable cards');
  }
  return Object.freeze(normalized);
}

function expandPrivateDeckEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError('private deck entries must be an array');
  return entries.flatMap((entry) => Array.from({ length: entry.copies }, () => entry.definitionId));
}

module.exports = {
  EXPANDED_DECK_MAXIMUM_CARDS,
  EXPANDED_DECK_MINIMUM_CARDS,
  expandPrivateDeckEntries,
  normalizePrivateDeckEntries
};
