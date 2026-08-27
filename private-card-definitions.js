'use strict';

/**
 * Private PvP 拡張側から参照するカード定義の読取専用窓口。
 *
 * 現行のクラシック定義は game-rules.js が唯一の正本である。ここでは
 * その定義を複製・変更せず参照するだけに留め、将来の Private 限定札を
 * 追加する際も Ranked / Random に混入させない境界とする。
 */
const { CARD_DEFINITIONS } = require('./game-rules');

const CLASSIC_PRIVATE_CARD_DEFINITIONS = Object.freeze([...CARD_DEFINITIONS]);
const CLASSIC_PRIVATE_CARD_DEFINITION_BY_ID = new Map(
  CLASSIC_PRIVATE_CARD_DEFINITIONS.map((definition) => [definition.id, definition])
);

function getClassicPrivateCardDefinition(definitionId) {
  const definition = typeof definitionId === 'string'
    ? CLASSIC_PRIVATE_CARD_DEFINITION_BY_ID.get(definitionId)
    : null;
  if (!definition) throw new RangeError('unknown private card definition');
  return definition;
}

module.exports = {
  CLASSIC_PRIVATE_CARD_DEFINITIONS,
  CLASSIC_PRIVATE_CARD_DEFINITION_BY_ID,
  getClassicPrivateCardDefinition
};
