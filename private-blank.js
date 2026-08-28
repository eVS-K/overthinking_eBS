'use strict';

/**
 * Blank is intentionally a reusable, hand-external card.  It is not a deck
 * entry, never consumes an instanceId, and never becomes an acquired/stacked
 * card.  The only identifier a client may submit for it is this fixed value.
 */
const { getPrivateCardDefinition } = require('./private-card-definitions');

const VIRTUAL_BLANK_SELECTION_ID = 'virtual-blank';

function isVirtualBlankSelectionId(value) {
  return value === VIRTUAL_BLANK_SELECTION_ID;
}

function createVirtualBlankCard() {
  const definition = getPrivateCardDefinition('blank');
  return {
    virtual: true,
    definitionId: definition.id,
    name: definition.name,
    strength: definition.strength,
    desc: '手札を消費しないBlank。獲得札・持ち越し札にはなりません。'
  };
}

function publicVirtualBlankCard() {
  return {
    id: VIRTUAL_BLANK_SELECTION_ID,
    ...createVirtualBlankCard()
  };
}

function isVirtualBlankCard(card) {
  return Boolean(card && card.virtual === true && card.definitionId === 'blank');
}

module.exports = {
  VIRTUAL_BLANK_SELECTION_ID,
  createVirtualBlankCard,
  isVirtualBlankCard,
  isVirtualBlankSelectionId,
  publicVirtualBlankCard
};
