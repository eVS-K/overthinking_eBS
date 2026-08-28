'use strict';

/**
 * Private拡張カードの、対象選択を伴わない比較用効果。
 *
 * ここでは現在の局面から「このラウンドの強さ」を導くだけで、手札・得点・
 * 履歴は変更しない。状態遷移は private-game-engine.js の責務に残す。
 */
const { resolveRound } = require('./game-rules');
const { getPrivateCardDefinition } = require('./private-card-definitions');

const CONDITIONAL_STRENGTH_DEFINITION_IDS = Object.freeze([
  'death',
  'temperance',
  'the-devil',
  'the-tower'
]);
const CONDITIONAL_STRENGTH_DEFINITION_ID_SET = new Set(CONDITIONAL_STRENGTH_DEFINITION_IDS);

function getRoundContext(state, seat) {
  if (seat !== 'p1' && seat !== 'p2') throw new RangeError('unknown private seat');
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('private state must be an object');
  }
  const opponentSeat = seat === 'p1' ? 'p2' : 'p1';
  const ownScore = state[seat]?.score;
  const opponentScore = state[opponentSeat]?.score;
  if (!Number.isSafeInteger(state.round) || state.round < 1
    || !Number.isSafeInteger(ownScore) || ownScore < 0
    || !Number.isSafeInteger(opponentScore) || opponentScore < 0
    || !Array.isArray(state.stack)) {
    throw new TypeError('private state cannot provide a round context');
  }
  return {
    round: state.round,
    ownScore,
    opponentScore,
    stackCount: state.stack.length
  };
}

function getPrivateCardRoundPreview(state, seat, card) {
  if (!card || typeof card.definitionId !== 'string') throw new TypeError('private card requires a definition id');
  const definition = getPrivateCardDefinition(card.definitionId);
  const context = getRoundContext(state, seat);
  let comparisonStrength = definition.strength;
  let displayStrength = definition.id === 'joker' ? null : definition.strength;
  let conditionDetail = '';
  let isConditional = false;

  if (definition.id === 'death') {
    isConditional = true;
    const isTrailingOrTied = context.ownScore <= context.opponentScore;
    comparisonStrength = isTrailingOrTied ? 13 : 0;
    displayStrength = comparisonStrength;
    conditionDetail = isTrailingOrTied
      ? `現在の獲得札は ${context.ownScore}枚 ≤ 相手 ${context.opponentScore}枚のため、強さ13です。`
      : `現在の獲得札は ${context.ownScore}枚 ＞ 相手 ${context.opponentScore}枚のため、強さ0です。`;
  } else if (definition.id === 'temperance') {
    isConditional = true;
    const isOddRound = context.round % 2 === 1;
    comparisonStrength = isOddRound ? 14 : 0;
    displayStrength = comparisonStrength;
    conditionDetail = isOddRound
      ? `第${context.round}ラウンドは奇数のため、強さ14です。`
      : `第${context.round}ラウンドは偶数のため、強さ0です。`;
  } else if (definition.id === 'the-devil') {
    isConditional = true;
    const hasStack = context.stackCount > 0;
    comparisonStrength = hasStack ? 15 : 0;
    displayStrength = comparisonStrength;
    conditionDetail = hasStack
      ? `持ち越し札が ${context.stackCount}枚あるため、強さ15です。`
      : '持ち越し札がないため、強さ0です。';
  } else if (definition.id === 'the-tower') {
    isConditional = true;
    comparisonStrength = context.round * 2;
    displayStrength = comparisonStrength;
    conditionDetail = `第${context.round}ラウンド × 2 により、強さ${comparisonStrength}です。`;
  }

  if (!Number.isSafeInteger(comparisonStrength) || comparisonStrength < 0) {
    throw new RangeError('private card comparison strength is invalid');
  }
  return {
    definitionId: definition.id,
    category: definition.category,
    comparisonStrength,
    displayStrength,
    conditionDetail,
    isConditional: isConditional || CONDITIONAL_STRENGTH_DEFINITION_ID_SET.has(definition.id)
  };
}

function actualComparedStrength(preview, opponentPreview) {
  if (preview.definitionId !== 'joker') return preview.comparisonStrength;
  return opponentPreview.definitionId === 'joker' ? 0 : opponentPreview.comparisonStrength;
}

function resolvePrivateRoundWithContext(state, p1Card, p2Card) {
  const p1Preview = getPrivateCardRoundPreview(state, 'p1', p1Card);
  const p2Preview = getPrivateCardRoundPreview(state, 'p2', p2Card);
  const canonicalResult = resolveRound(
    { id: p1Preview.definitionId, strength: p1Preview.comparisonStrength },
    { id: p2Preview.definitionId, strength: p2Preview.comparisonStrength }
  );
  return {
    canonicalResult,
    p1: {
      ...p1Preview,
      resolvedStrength: actualComparedStrength(p1Preview, p2Preview)
    },
    p2: {
      ...p2Preview,
      resolvedStrength: actualComparedStrength(p2Preview, p1Preview)
    }
  };
}

module.exports = {
  CONDITIONAL_STRENGTH_DEFINITION_IDS,
  getPrivateCardRoundPreview,
  resolvePrivateRoundWithContext
};
