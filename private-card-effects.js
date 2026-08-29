'use strict';

/**
 * Private拡張カードの、対象選択を伴わない比較用効果。
 *
 * ここでは現在の局面から「このラウンドの強さ」を導くだけで、手札・得点・
 * 履歴は変更しない。状態遷移は private-game-engine.js の責務に残す。
 */
const { resolveRound } = require('./game-rules');
const { getPrivateCardDefinition } = require('./private-card-definitions');

// Every comparison is performed in integer half-strength units. This keeps
// Strength's ×1.5 rule exact without admitting floating-point values into the
// game engine or persisted round validation.
const STRENGTH_SCALE = 2;
const CONDITIONAL_STRENGTH_DEFINITION_IDS = Object.freeze([
  'death',
  'temperance',
  'the-devil',
  'the-tower',
  'strength'
]);
const CONDITIONAL_STRENGTH_DEFINITION_ID_SET = new Set(CONDITIONAL_STRENGTH_DEFINITION_IDS);
const COMPARE_OVERRIDE_DEFINITION_IDS = Object.freeze(['the-chariot']);
const CHARIOT_THRESHOLD_UNITS = 15 * STRENGTH_SCALE;

function assertStrengthUnits(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('private card comparison strength is invalid');
  }
  return value;
}

function toStrengthUnits(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('private card base strength is invalid');
  }
  return assertStrengthUnits(value * STRENGTH_SCALE);
}

function formatStrengthUnits(value) {
  const units = assertStrengthUnits(value);
  return units % STRENGTH_SCALE === 0
    ? units / STRENGTH_SCALE
    : `${Math.floor(units / STRENGTH_SCALE)}.5`;
}

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
  let comparisonStrengthUnits = toStrengthUnits(definition.strength ?? 0);
  let displayStrength = definition.id === 'joker' ? null : formatStrengthUnits(comparisonStrengthUnits);
  let conditionDetail = '';
  let isConditional = false;

  if (definition.id === 'death') {
    isConditional = true;
    const isTrailingOrTied = context.ownScore <= context.opponentScore;
    comparisonStrengthUnits = toStrengthUnits(isTrailingOrTied ? 13 : 0);
    displayStrength = formatStrengthUnits(comparisonStrengthUnits);
    conditionDetail = isTrailingOrTied
      ? `現在の獲得札は ${context.ownScore}枚 ≤ 相手 ${context.opponentScore}枚のため、強さ13です。`
      : `現在の獲得札は ${context.ownScore}枚 ＞ 相手 ${context.opponentScore}枚のため、強さ0です。`;
  } else if (definition.id === 'temperance') {
    isConditional = true;
    const isOddRound = context.round % 2 === 1;
    comparisonStrengthUnits = toStrengthUnits(isOddRound ? 14 : 0);
    displayStrength = formatStrengthUnits(comparisonStrengthUnits);
    conditionDetail = isOddRound
      ? `第${context.round}ラウンドは奇数のため、強さ14です。`
      : `第${context.round}ラウンドは偶数のため、強さ0です。`;
  } else if (definition.id === 'the-devil') {
    isConditional = true;
    const hasStack = context.stackCount > 0;
    comparisonStrengthUnits = toStrengthUnits(hasStack ? 15 : 0);
    displayStrength = formatStrengthUnits(comparisonStrengthUnits);
    conditionDetail = hasStack
      ? `持ち越し札が ${context.stackCount}枚あるため、強さ15です。`
      : '持ち越し札がないため、強さ0です。';
  } else if (definition.id === 'the-tower') {
    isConditional = true;
    comparisonStrengthUnits = toStrengthUnits(context.round * 2);
    displayStrength = formatStrengthUnits(comparisonStrengthUnits);
    conditionDetail = `第${context.round}ラウンド × 2 により、強さ${displayStrength}です。`;
  } else if (definition.id === 'strength') {
    isConditional = true;
    comparisonStrengthUnits = assertStrengthUnits(context.ownScore * 3);
    displayStrength = formatStrengthUnits(comparisonStrengthUnits);
    conditionDetail = `現在の獲得札 ${context.ownScore}枚 × 1.5 により、強さ${displayStrength}です。`;
  } else if (definition.id === 'the-chariot') {
    isConditional = true;
    // The card keeps its base strength 0. Its comparison override is applied
    // only after both cards (including Joker copies) have a settled strength.
    conditionDetail = '相手の確定した強さが15以上なら、数値比較より先に勝利します。';
  }

  return {
    definitionId: definition.id,
    category: definition.category,
    // Keep the old display-oriented property for callers that only need a
    // preview; all game resolution uses comparisonStrengthUnits instead.
    comparisonStrength: displayStrength,
    comparisonStrengthUnits,
    displayStrength,
    conditionDetail,
    isConditional: isConditional
      || CONDITIONAL_STRENGTH_DEFINITION_ID_SET.has(definition.id)
      || COMPARE_OVERRIDE_DEFINITION_IDS.includes(definition.id)
  };
}

function actualComparedStrengthUnits(preview, opponentPreview) {
  if (preview.definitionId !== 'joker') return preview.comparisonStrengthUnits;
  return opponentPreview.definitionId === 'joker' ? 0 : opponentPreview.comparisonStrengthUnits;
}

function resolveComparisonResult(p1Preview, p2Preview) {
  const p1StrengthUnits = actualComparedStrengthUnits(p1Preview, p2Preview);
  const p2StrengthUnits = actualComparedStrengthUnits(p2Preview, p1Preview);
  // The Chariot's threshold checks an opponent's settled strength, including
  // a copied Joker strength, before normal card-strength comparison. If both
  // conditions were ever true, the round is a draw rather than a double win.
  const p1ChariotWins = p1Preview.definitionId === 'the-chariot'
    && p2StrengthUnits >= CHARIOT_THRESHOLD_UNITS;
  const p2ChariotWins = p2Preview.definitionId === 'the-chariot'
    && p1StrengthUnits >= CHARIOT_THRESHOLD_UNITS;
  if (p1ChariotWins && !p2ChariotWins) return 'p1';
  if (p2ChariotWins && !p1ChariotWins) return 'p2';
  if (p1ChariotWins && p2ChariotWins) return 'draw';
  return resolveRound(
    { id: p1Preview.definitionId, strength: p1StrengthUnits },
    { id: p2Preview.definitionId, strength: p2StrengthUnits }
  );
}

function resolvePrivateRoundWithContext(state, p1Card, p2Card) {
  const p1Preview = getPrivateCardRoundPreview(state, 'p1', p1Card);
  const p2Preview = getPrivateCardRoundPreview(state, 'p2', p2Card);
  const canonicalResult = resolveComparisonResult(p1Preview, p2Preview);
  const p1StrengthUnits = actualComparedStrengthUnits(p1Preview, p2Preview);
  const p2StrengthUnits = actualComparedStrengthUnits(p2Preview, p1Preview);
  return {
    canonicalResult,
    p1: {
      ...p1Preview,
      resolvedStrengthUnits: p1StrengthUnits,
      resolvedStrength: formatStrengthUnits(p1StrengthUnits)
    },
    p2: {
      ...p2Preview,
      resolvedStrengthUnits: p2StrengthUnits,
      resolvedStrength: formatStrengthUnits(p2StrengthUnits)
    }
  };
}

module.exports = {
  CHARIOT_THRESHOLD_UNITS,
  CONDITIONAL_STRENGTH_DEFINITION_IDS,
  STRENGTH_SCALE,
  actualComparedStrengthUnits,
  formatStrengthUnits,
  getPrivateCardRoundPreview,
  resolveComparisonResult,
  resolvePrivateRoundWithContext
};
