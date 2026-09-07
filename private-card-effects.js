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
const ECHOABLE_SAFE_POST_EFFECT_IDS = new Set(['the-magician', 'the-lovers', 'wheel-of-fortune']);
// An echo may carry only a settled comparison profile plus one of the three
// explicitly safe, non-interactive post-round effects.  Targeting, locks,
// hidden information, pile mutation, destruction, and recursive echoing are
// deliberately not a "partial copy": treating their strength as copyable
// would make the user-visible rule ambiguous and lets later card additions
// accidentally become echoable by omission.
const NON_ECHOABLE_DEFINITION_IDS = new Set([
  'the-fool',
  'the-hermit',
  'the-emperor',
  'the-high-priestess',
  'the-empress',
  'the-hierophant',
  'justice',
  'the-hanged-man',
  'the-star',
  'the-moon',
  'the-sun',
  'judgement',
  'the-world'
]);

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

function opponentSeat(seat) {
  if (seat === 'p1') return 'p2';
  if (seat === 'p2') return 'p1';
  throw new RangeError('unknown private seat');
}

function isTarotDefinitionId(definitionId) {
  try {
    return getPrivateCardDefinition(definitionId).category === 'tarot';
  } catch {
    return false;
  }
}

function normalizeEchoProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Number.isSafeInteger(value.resolvedStrengthUnits) || value.resolvedStrengthUnits < 0) return null;
  const comparisonOverride = value.comparisonOverride === 'chariot' ? 'chariot' : '';
  const safePostEffectId = ECHOABLE_SAFE_POST_EFFECT_IDS.has(value.safePostEffectId)
    ? value.safePostEffectId
    : '';
  return {
    resolvedStrengthUnits: value.resolvedStrengthUnits,
    comparisonOverride,
    safePostEffectId
  };
}

function getEchoProfileFromHistory(state, seat) {
  const history = Array.isArray(state?.history) ? state.history : [];
  const previous = history.at(-1);
  if (!previous || typeof previous !== 'object') return null;
  const card = seat === 'p1' ? previous.p1Card : seat === 'p2' ? previous.p2Card : null;
  if (!card || NON_ECHOABLE_DEFINITION_IDS.has(card.definitionId) || card.virtual === true) return null;
  const stored = normalizeEchoProfile(seat === 'p1' ? previous.p1EchoProfile : previous.p2EchoProfile);
  if (stored) return stored;
  const strength = seat === 'p1' ? previous.p1Strength : previous.p2Strength;
  const units = typeof strength === 'number'
    ? strength * STRENGTH_SCALE
    : typeof strength === 'string' && /^(?:0|[1-9][0-9]*)\.5$/.test(strength)
      ? Number(strength.slice(0, -2)) * STRENGTH_SCALE + 1
      : null;
  if (!Number.isSafeInteger(units) || units < 0) return null;
  return {
    resolvedStrengthUnits: units,
    comparisonOverride: card.definitionId === 'the-chariot' ? 'chariot' : '',
    safePostEffectId: ECHOABLE_SAFE_POST_EFFECT_IDS.has(card.definitionId) ? card.definitionId : ''
  };
}

function createEchoProfile({ card, resolvedStrengthUnits, copiedProfile = null } = {}) {
  if (!card || NON_ECHOABLE_DEFINITION_IDS.has(card.definitionId) || isVirtualBlankLike(card)) return null;
  if (!Number.isSafeInteger(resolvedStrengthUnits) || resolvedStrengthUnits < 0) return null;
  const copied = normalizeEchoProfile(copiedProfile);
  return {
    resolvedStrengthUnits,
    comparisonOverride: copied?.comparisonOverride || (card.definitionId === 'the-chariot' ? 'chariot' : ''),
    safePostEffectId: copied?.safePostEffectId
      || (ECHOABLE_SAFE_POST_EFFECT_IDS.has(card.definitionId) ? card.definitionId : '')
  };
}

function isVirtualBlankLike(card) {
  return card?.virtual === true || card?.definitionId === 'blank';
}

// An echo must never recurse through a previous Fool/Hermit. Besides making
// the answer ambiguous, recursion would make state validation depend on an
// unbounded history walk. Every other real card is copied as its *current*
// behaviour, not as the strength it happened to resolve to last round.
const ECHO_RECURSION_DEFINITION_IDS = new Set(['the-fool', 'the-hermit']);

function getPreviousPlayedCard(state, seat) {
  const previous = Array.isArray(state?.history) ? state.history.at(-1) : null;
  if (!previous || typeof previous !== 'object') return null;
  if (seat === 'p1') return previous.p1Card || null;
  if (seat === 'p2') return previous.p2Card || null;
  throw new RangeError('unknown private seat');
}

function getLiveEchoDefinitionId(state, seat) {
  const previousCard = getPreviousPlayedCard(state, seat);
  if (!previousCard || isVirtualBlankLike(previousCard)
    || ECHO_RECURSION_DEFINITION_IDS.has(previousCard.definitionId)) return '';
  try {
    return getPrivateCardDefinition(previousCard.definitionId).id;
  } catch {
    return '';
  }
}

function getDefinitionRoundPreview(state, seat, definition) {
  const context = getRoundContext(state, seat);
  let comparisonStrengthUnits = toStrengthUnits(definition.strength ?? 0);
  let displayStrength = definition.id === 'joker' ? null : formatStrengthUnits(comparisonStrengthUnits);
  let conditionDetail = '';
  let isConditional = false;
  let comparisonOverride = definition.id === 'the-chariot' ? 'chariot' : '';
  let safePostEffectId = ECHOABLE_SAFE_POST_EFFECT_IDS.has(definition.id) ? definition.id : '';

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
    behaviorDefinitionId: definition.id,
    category: definition.category,
    // Keep the old display-oriented property for callers that only need a
    // preview; all game resolution uses comparisonStrengthUnits instead.
    comparisonStrength: displayStrength,
    comparisonStrengthUnits,
    displayStrength,
    conditionDetail,
    comparisonOverride,
    safePostEffectId,
    isConditional: isConditional
      || CONDITIONAL_STRENGTH_DEFINITION_ID_SET.has(definition.id)
      || COMPARE_OVERRIDE_DEFINITION_IDS.includes(definition.id)
  };
}

function getPrivateCardRoundPreview(state, seat, card) {
  if (!card || typeof card.definitionId !== 'string') throw new TypeError('private card requires a definition id');
  const definition = getPrivateCardDefinition(card.definitionId);
  if (definition.id === 'the-fool') {
    const inheritedDefinitionId = getLiveEchoDefinitionId(state, seat);
    if (inheritedDefinitionId) {
      const inheritedDefinition = getPrivateCardDefinition(inheritedDefinitionId);
      const inherited = getDefinitionRoundPreview(state, seat, inheritedDefinition);
      const inheritedDetail = inherited.conditionDetail ? ` ${inherited.conditionDetail}` : '';
      return {
        ...inherited,
        // The physical card remains Fool for the hand/history, while all
        // comparison and effect dispatch uses the inherited identity below.
        definitionId: definition.id,
        behaviorDefinitionId: inherited.behaviorDefinitionId,
        inheritedDefinitionId,
        category: definition.category,
        isConditional: true,
        conditionDetail: `直前に出した ${inheritedDefinition.name} として、このラウンドの性質・能力を引き継ぎます。${inheritedDetail}`
      };
    }
    const empty = getDefinitionRoundPreview(state, seat, definition);
    return {
      ...empty,
      isConditional: true,
      conditionDetail: '引き継げる直前の実カードがないため、強さ0・能力なしです。'
    };
  }

  if (definition.id === 'the-hermit') {
    const echo = getEchoProfileFromHistory(state, opponentSeat(seat));
    const comparisonStrengthUnits = echo?.resolvedStrengthUnits || 0;
    return {
      ...getDefinitionRoundPreview(state, seat, definition),
      comparisonStrength: formatStrengthUnits(comparisonStrengthUnits),
      comparisonStrengthUnits,
      displayStrength: formatStrengthUnits(comparisonStrengthUnits),
      comparisonOverride: echo?.comparisonOverride || '',
      safePostEffectId: echo?.safePostEffectId || '',
      isConditional: true,
      conditionDetail: echo
        ? `相手の直前ラウンドの解決済み強さ${formatStrengthUnits(comparisonStrengthUnits)}と、コピー可能な勝敗判定能力を反響します。`
        : '反響できる直前の実カードがないため、強さ0・能力なしです。'
    };
  }

  return getDefinitionRoundPreview(state, seat, definition);
}

function getBehaviorDefinitionId(preview) {
  return typeof preview?.behaviorDefinitionId === 'string' && preview.behaviorDefinitionId.length > 0
    ? preview.behaviorDefinitionId
    : preview?.definitionId;
}

function actualComparedStrengthUnits(preview, opponentPreview) {
  if (getBehaviorDefinitionId(preview) !== 'joker') return preview.comparisonStrengthUnits;
  return getBehaviorDefinitionId(opponentPreview) === 'joker' ? 0 : opponentPreview.comparisonStrengthUnits;
}

function resolveComparisonResult(p1Preview, p2Preview) {
  const p1StrengthUnits = actualComparedStrengthUnits(p1Preview, p2Preview);
  const p2StrengthUnits = actualComparedStrengthUnits(p2Preview, p1Preview);
  // The Chariot's threshold checks an opponent's settled strength, including
  // a copied Joker strength, before normal card-strength comparison. If both
  // conditions were ever true, the round is a draw rather than a double win.
  const p1ChariotWins = p1Preview.comparisonOverride === 'chariot'
    && p2StrengthUnits >= CHARIOT_THRESHOLD_UNITS;
  const p2ChariotWins = p2Preview.comparisonOverride === 'chariot'
    && p1StrengthUnits >= CHARIOT_THRESHOLD_UNITS;
  if (p1ChariotWins && !p2ChariotWins) return 'p1';
  if (p2ChariotWins && !p1ChariotWins) return 'p2';
  if (p1ChariotWins && p2ChariotWins) return 'draw';
  return resolveRound(
    { id: getBehaviorDefinitionId(p1Preview), strength: p1StrengthUnits },
    { id: getBehaviorDefinitionId(p2Preview), strength: p2StrengthUnits }
  );
}

function resolvePrivateRoundWithContext(state, p1Card, p2Card) {
  const p1Preview = getPrivateCardRoundPreview(state, 'p1', p1Card);
  const p2Preview = getPrivateCardRoundPreview(state, 'p2', p2Card);
  const p1Emperor = getBehaviorDefinitionId(p1Preview) === 'the-emperor';
  const p2Emperor = getBehaviorDefinitionId(p2Preview) === 'the-emperor';
  const p1OpponentIsTarot = isTarotDefinitionId(getBehaviorDefinitionId(p2Preview));
  const p2OpponentIsTarot = isTarotDefinitionId(getBehaviorDefinitionId(p1Preview));
  let canonicalResult;
  let suppressedSeats = [];
  if (p1Emperor && p2Emperor) {
    canonicalResult = 'draw';
    suppressedSeats = ['p1', 'p2'];
  } else if (p1Emperor && p1OpponentIsTarot) {
    canonicalResult = 'p1';
    suppressedSeats = ['p2'];
  } else if (p2Emperor && p2OpponentIsTarot) {
    canonicalResult = 'p2';
    suppressedSeats = ['p1'];
  } else {
    canonicalResult = resolveComparisonResult(p1Preview, p2Preview);
  }
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
    },
    suppressedSeats
  };
}

module.exports = {
  CHARIOT_THRESHOLD_UNITS,
  CONDITIONAL_STRENGTH_DEFINITION_IDS,
  ECHOABLE_SAFE_POST_EFFECT_IDS,
  STRENGTH_SCALE,
  actualComparedStrengthUnits,
  formatStrengthUnits,
  getBehaviorDefinitionId,
  getPrivateCardRoundPreview,
  getEchoProfileFromHistory,
  createEchoProfile,
  isTarotDefinitionId,
  resolveComparisonResult,
  resolvePrivateRoundWithContext
};
