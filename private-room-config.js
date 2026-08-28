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
  return deck.some((entry) => getPrivateCardDefinition(entry.definitionId).mayPreventAllLegalPlays === true);
}

function createClassicPrivateRoomConfig(settings = {}) {
  return Object.freeze({
    ...createClassicPrivateRuleset(settings),
    blankRequired: false,
    deck: cloneDeck(CLASSIC_PRIVATE_DECK)
  });
}

function createExpandedPrivateRoomConfig(settings = {}) {
  const preliminaryRules = createExpandedPrivateRuleset(settings);
  const deckInput = Array.isArray(settings?.deck) ? settings.deck : DEFAULT_EXPANDED_PRIVATE_DECK;
  const deck = normalizePrivateDeckEntries(deckInput, preliminaryRules);
  const blankRequired = deckRequiresBlankFallback(deck);
  if (blankRequired && settings?.blankEnabled === false) {
    throw new RangeError('this expanded deck requires the virtual Blank fallback');
  }
  const blankEnabled = blankRequired || settings?.blankEnabled === true;
  const rules = createExpandedPrivateRuleset({ ...settings, blankEnabled });
  return Object.freeze({
    ...rules,
    blankRequired,
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
  isClassicPrivateRoomConfig,
  isExpandedPrivateRoomConfig
};
