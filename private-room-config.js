'use strict';

/**
 * Private PvP room settings are normalised in one place before a match starts.
 * Classic rooms retain their exact legacy rules.  Expanded rooms receive a
 * frozen deck and an explicitly derived Blank policy.
 */
const { CARD_DEFINITIONS } = require('./game-rules');
const {
  CLASSIC_PRIVATE_RULESET_ID,
  EXPANDED_PRIVATE_RULESET_ID,
  createClassicPrivateRuleset,
  createExpandedPrivateRuleset
} = require('./private-ruleset');
const { normalizePrivateDeckEntries } = require('./private-deck');
const { getPrivateCardDefinition } = require('./private-card-definitions');

const CLASSIC_PRIVATE_DECK = Object.freeze(CARD_DEFINITIONS.map((card) => Object.freeze({
  definitionId: card.id,
  copies: 1
})));
const DEFAULT_EXPANDED_PRIVATE_DECK = CLASSIC_PRIVATE_DECK;

function cloneDeck(deck) {
  return Object.freeze(deck.map((entry) => Object.freeze({ ...entry })));
}

function deckRequiresBlankFallback(deck) {
  if (!Array.isArray(deck)) return false;
  return deck.some((entry) => {
    const definition = getPrivateCardDefinition(entry.definitionId);
    return definition.playabilityRisk === 'temporary-all-hand-lock'
      || definition.playabilityRisk === 'persistent-all-hand-lock'
      || definition.mayPreventAllLegalPlays === true;
  });
}

function getBlankRequiredBy(deck) {
  if (!Array.isArray(deck)) return Object.freeze([]);
  return Object.freeze(deck
    .map((entry) => getPrivateCardDefinition(entry.definitionId))
    .filter((definition) => definition.playabilityRisk === 'temporary-all-hand-lock'
      || definition.playabilityRisk === 'persistent-all-hand-lock'
      || definition.mayPreventAllLegalPlays === true)
    .map((definition) => definition.id));
}

function createClassicPrivateRoomConfig(settings = {}) {
  return Object.freeze({
    ...createClassicPrivateRuleset(settings),
    blankRequired: false,
    blankRequiredBy: Object.freeze([]),
    deck: cloneDeck(CLASSIC_PRIVATE_DECK)
  });
}

function createExpandedPrivateRoomConfig(settings = {}) {
  const preliminaryRules = createExpandedPrivateRuleset(settings);
  const deckInput = Array.isArray(settings?.deck) ? settings.deck : DEFAULT_EXPANDED_PRIVATE_DECK;
  const deck = normalizePrivateDeckEntries(deckInput, preliminaryRules);
  const blankRequiredBy = getBlankRequiredBy(deck);
  const blankRequired = blankRequiredBy.length > 0;
  // Adding a card that may lock every physical choice must never leave a
  // stale `blankEnabled: false` configuration behind.  The canonical config
  // forces it on; the UI can then explain why its checkbox is unavailable.
  const blankEnabled = blankRequired || settings?.blankEnabled === true;
  const rules = createExpandedPrivateRuleset({ ...settings, blankEnabled });
  return Object.freeze({
    ...rules,
    blankRequired,
    blankRequiredBy,
    deck: cloneDeck(deck)
  });
}

function createPrivateRoomConfig(settings = {}) {
  if (settings?.ruleset === EXPANDED_PRIVATE_RULESET_ID) {
    return createExpandedPrivateRoomConfig(settings);
  }
  return createClassicPrivateRoomConfig(settings);
}

function isExpandedPrivateRoomConfig(config) {
  return config?.ruleset === EXPANDED_PRIVATE_RULESET_ID;
}

function isClassicPrivateRoomConfig(config) {
  return config?.ruleset === CLASSIC_PRIVATE_RULESET_ID;
}

module.exports = {
  CLASSIC_PRIVATE_DECK,
  DEFAULT_EXPANDED_PRIVATE_DECK,
  createClassicPrivateRoomConfig,
  createExpandedPrivateRoomConfig,
  createPrivateRoomConfig,
  deckRequiresBlankFallback,
  getBlankRequiredBy,
  isClassicPrivateRoomConfig,
  isExpandedPrivateRoomConfig
};
