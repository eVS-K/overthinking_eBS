'use strict';

/**
 * Private PvP 拡張側から参照するカード定義の読取専用窓口。
 *
 * 現行のクラシック定義は game-rules.js が唯一の正本である。ここでは
 * その定義を複製・変更せず参照し、Private限定の拡張カタログへメタ情報を
 * 加える。Ranked / Randomはこのカタログを参照しない。
 */
const { CARD_DEFINITIONS } = require('./game-rules');
const {
  CLASSIC_PRIVATE_RULESET_ID,
  EXPANDED_PRIVATE_RULESET_ID
} = require('./private-ruleset');

const CLASSIC_PRIVATE_CARD_DEFINITIONS = Object.freeze([...CARD_DEFINITIONS]);
const CLASSIC_PRIVATE_CARD_DEFINITION_BY_ID = new Map(
  CLASSIC_PRIVATE_CARD_DEFINITIONS.map((definition) => [definition.id, definition])
);

const PRIVATE_CARD_STATUSES = Object.freeze([
  'draft',
  'specified',
  'engine-ready',
  'experimental',
  'available',
  'retired'
]);
// A Tarot glyph is a private-expansion identifier, not the original major
// arcana number.  The first playable Tarot therefore begins at α; later
// additions keep their assigned glyph so existing room history stays legible.
// Keep the playable Tarot in Greek-glyph order.  This array is also the
// deck-editor order: newly added cards must not jump ahead of an earlier
// playable Tarot simply because their implementation landed first.
const AVAILABLE_TAROT_DISPLAY_ORDER = Object.freeze([
  'death',
  'temperance',
  'the-devil',
  'the-tower',
  'the-chariot',
  'strength',
  'the-magician',
  'the-lovers',
  'wheel-of-fortune',
  'the-fool',
  'the-high-priestess',
  'the-empress',
  'the-emperor',
  'the-hierophant',
  'the-hermit',
  'justice',
  'the-hanged-man',
  'the-star',
  'the-moon',
  'the-sun',
  'judgement',
  'the-world'
]);
const AVAILABLE_TAROT_IDS = new Set(AVAILABLE_TAROT_DISPLAY_ORDER);
// The display sequence reflects the order in which the Private expansion
// makes the cards playable. It deliberately starts with the first available
// card instead of the original major arcana's Roman-numeral positions.
const TAROT_GREEK_MARKS_BY_ID = Object.freeze({
  death: 'α',
  temperance: 'β',
  'the-devil': 'γ',
  'the-tower': 'δ',
  'the-chariot': 'ε',
  strength: 'ζ',
  'the-magician': 'η',
  'the-lovers': 'θ',
  'wheel-of-fortune': 'ι',
  'the-fool': 'κ',
  'the-high-priestess': 'λ',
  'the-empress': 'μ',
  'the-emperor': 'ν',
  'the-hierophant': 'ξ',
  'the-hermit': 'ο',
  justice: 'π',
  'the-hanged-man': 'ρ',
  'the-star': 'σ',
  'the-moon': 'τ',
  'the-sun': 'υ',
  judgement: 'φ',
  'the-world': 'χ'
});

// Presentation metadata deliberately lives alongside the immutable card
// definition, rather than being inferred from the Japanese description in
// the browser. It is descriptive only: neither the client nor the game
// engine may use it to decide which effect is legal.
//
// `faceLabel` is the compact name intended for the centre of a physical card;
// the full `name` remains available for accessible labels and detailed text.
// `visualRole` gives the UI a stable semantic hook even as more Tarot cards
// are added. Do not turn it into gameplay branching.
const TAROT_PRESENTATION_BY_ID = Object.freeze({
  death: Object.freeze({ faceLabel: 'Death', visualRole: 'conditional', ruleConceptIds: ['conditional-strength'] }),
  temperance: Object.freeze({ faceLabel: 'Temperance', visualRole: 'conditional', ruleConceptIds: ['conditional-strength'] }),
  'the-devil': Object.freeze({ faceLabel: 'Devil', visualRole: 'conditional', ruleConceptIds: ['conditional-strength'] }),
  'the-tower': Object.freeze({ faceLabel: 'Tower', visualRole: 'conditional', ruleConceptIds: ['conditional-strength'] }),
  'the-chariot': Object.freeze({ faceLabel: 'Chariot', visualRole: 'conditional', ruleConceptIds: ['conditional-strength'] }),
  strength: Object.freeze({ faceLabel: 'Strength', visualRole: 'conditional', ruleConceptIds: ['conditional-strength'] }),
  'the-magician': Object.freeze({ faceLabel: 'Magician', visualRole: 'generation', ruleConceptIds: ['card-duplication'] }),
  'the-lovers': Object.freeze({ faceLabel: 'Lovers', visualRole: 'generation', ruleConceptIds: ['card-addition'] }),
  'wheel-of-fortune': Object.freeze({ faceLabel: 'Wheel', visualRole: 'other', ruleConceptIds: ['round-limit-change'] }),
  'the-fool': Object.freeze({ faceLabel: 'Fool', visualRole: 'conditional', ruleConceptIds: ['ability-echo'] }),
  'the-high-priestess': Object.freeze({ faceLabel: 'High Priestess', visualRole: 'generation', ruleConceptIds: ['card-duplication', 'target-selection'] }),
  'the-empress': Object.freeze({ faceLabel: 'Empress', visualRole: 'lock', ruleConceptIds: ['lock'] }),
  'the-emperor': Object.freeze({ faceLabel: 'Emperor', visualRole: 'emperor', ruleConceptIds: ['tarot-negation'] }),
  'the-hierophant': Object.freeze({ faceLabel: 'Hierophant', visualRole: 'generation', ruleConceptIds: ['card-duplication', 'target-selection'] }),
  'the-hermit': Object.freeze({ faceLabel: 'Hermit', visualRole: 'conditional', ruleConceptIds: ['ability-echo'] }),
  justice: Object.freeze({ faceLabel: 'Justice', visualRole: 'lock', ruleConceptIds: ['lock', 'target-selection'] }),
  'the-hanged-man': Object.freeze({ faceLabel: 'Hanged Man', visualRole: 'generation', ruleConceptIds: ['card-addition', 'target-selection'] }),
  'the-star': Object.freeze({ faceLabel: 'Star', visualRole: 'generation', ruleConceptIds: ['card-addition', 'noise', 'target-selection'] }),
  'the-moon': Object.freeze({ faceLabel: 'Moon', visualRole: 'other', ruleConceptIds: ['destroy-discard', 'won-pile-operation'] }),
  'the-sun': Object.freeze({ faceLabel: 'Sun', visualRole: 'other', ruleConceptIds: ['destroy-discard', 'target-selection'] }),
  judgement: Object.freeze({ faceLabel: 'Judgement', visualRole: 'generation', ruleConceptIds: ['card-duplication'] }),
  'the-world': Object.freeze({ faceLabel: 'World', visualRole: 'other', ruleConceptIds: ['card-duplication', 'destroy-discard', 'won-pile-operation', 'target-selection'] })
});

function freezeDefinition(definition) {
  return Object.freeze({
    ...definition,
    availability: Object.freeze([...(definition.availability || [])]),
    requiresFeatures: Object.freeze([...(definition.requiresFeatures || [])]),
    excludesTags: Object.freeze([...(definition.excludesTags || [])]),
    providesTags: Object.freeze([...(definition.providesTags || [])]),
    // This is deliberately descriptive metadata, not client-provided rule
    // code. It lets the preset require a virtual Blank fallback only when a
    // selected card could leave a player with no legal hand selection.
    mayPreventAllLegalPlays: definition.mayPreventAllLegalPlays === true,
    playabilityRisk: typeof definition.playabilityRisk === 'string'
      ? definition.playabilityRisk
      : definition.mayPreventAllLegalPlays === true
        ? 'temporary-all-hand-lock'
        : 'none',
    effectProfileId: typeof definition.effectProfileId === 'string' ? definition.effectProfileId : '',
    uniqueGroup: typeof definition.uniqueGroup === 'string' ? definition.uniqueGroup : '',
    ruleConceptIds: Object.freeze([...(definition.ruleConceptIds || [])]),
    visualRole: typeof definition.visualRole === 'string' ? definition.visualRole : '',
    faceLabel: typeof definition.faceLabel === 'string' && definition.faceLabel.length > 0
      ? definition.faceLabel
      : definition.name
  });
}

const CLASSIC_PRIVATE_CARD_CATALOG = Object.freeze(CLASSIC_PRIVATE_CARD_DEFINITIONS.map((definition) => freezeDefinition({
  ...definition,
  category: 'classic',
  status: 'available',
  availability: [CLASSIC_PRIVATE_RULESET_ID, EXPANDED_PRIVATE_RULESET_ID],
  maxCopiesPerDeck: 3,
  requiresFeatures: ['public-cards-v1'],
  excludesTags: [],
  ruleConceptIds: [],
  visualRole: 'standard',
  visibilityModel: 'public'
})));

const EXTRA_NORMAL_CARD_CATALOG = Object.freeze([
  ['ten', 'Ten', 10],
  ['nine', 'Nine', 9],
  ['eight', 'Eight', 8],
  ['seven', 'Seven', 7],
  ['six', 'Six', 6],
  ['five', 'Five', 5],
  ['four', 'Four', 4]
].map(([id, name, strength]) => freezeDefinition({
  id,
  name,
  strength,
  desc: '能力なし',
  category: 'normal-extra',
  status: 'available',
  availability: [EXPANDED_PRIVATE_RULESET_ID],
  maxCopiesPerDeck: 3,
  requiresFeatures: ['public-cards-v1'],
  excludesTags: [],
  ruleConceptIds: [],
  visualRole: 'standard',
  visibilityModel: 'public'
})));

// Blank is implemented as a virtual, hand-external choice rather than a deck
// entry. Tarot availability is derived from the required, server-owned effect
// components in the current expanded ruleset; the browser cannot enable a
// mechanic merely by naming a card definition.
const FUTURE_PRIVATE_CARD_CATALOG = Object.freeze([
  {
    id: 'blank', name: 'Blank', strength: 0, desc: '能力なし', category: 'blank',
    requiresFeatures: ['blank-semantics-v1'], excludesTags: [], visualRole: 'blank', ruleConceptIds: ['blank']
  },
  {
    id: 'the-fool', name: 'The Fool', strength: null, desc: '自分の直前の実カードとして、このラウンドの強さ・能力を引き継ぐ', category: 'tarot',
    requiresFeatures: ['round-snapshot-v1', 'echo-profile-v1'], excludesTags: [], effectProfileId: 'echo-own-v1'
  },
  {
    id: 'the-magician', name: 'The Magician', strength: 1, desc: '相手が出した実カードを、自分の手札へ2枚複製', category: 'tarot',
    requiresFeatures: ['card-generation-v1'], excludesTags: []
  },
  {
    id: 'the-high-priestess', name: 'The High Priestess', strength: 2, desc: '敗北時、相手札を1枚選び自分の手札へ複製', category: 'tarot',
    requiresFeatures: ['target-actions-v1', 'card-generation-v1'], excludesTags: [], effectProfileId: 'copy-opponent-hand-v1'
  },
  {
    id: 'the-empress', name: 'The Empress', strength: 3, desc: '勝利時、相手の非Tarot札を全てロック', category: 'tarot',
    requiresFeatures: ['lock-state-v1'], excludesTags: [],
    // Keep the original boolean for older preset/configuration readers while
    // the richer risk tag tells new code why Blank is compulsory.
    mayPreventAllLegalPlays: true,
    playabilityRisk: 'temporary-all-hand-lock', effectProfileId: 'lock-all-non-tarot-v1'
  },
  {
    id: 'the-emperor', name: 'The Emperor', strength: 0, desc: 'Tarot効果を無効化して勝利', category: 'tarot',
    requiresFeatures: ['tarot-negation-v1'], excludesTags: [], effectProfileId: 'emperor-override-v1'
  },
  {
    id: 'the-hierophant', name: 'The Hierophant', strength: 5, desc: '敗北時、自分札を1枚選び複製', category: 'tarot',
    requiresFeatures: ['target-actions-v1', 'card-generation-v1'], excludesTags: [], effectProfileId: 'copy-own-hand-v1'
  },
  {
    id: 'the-lovers', name: 'The Lovers', strength: 6, desc: '勝利時は自分へKing、敗北時は相手へQueenを1枚加える', category: 'tarot',
    requiresFeatures: ['card-generation-v1'], excludesTags: []
  },
  {
    id: 'the-chariot', name: 'The Chariot', strength: 0, desc: '強さ15以上のカードに勝利', category: 'tarot',
    requiresFeatures: ['compare-override-v1'], excludesTags: []
  },
  {
    id: 'strength', name: 'Strength', strength: null, desc: '獲得枚数×1.5の強さ', category: 'tarot',
    requiresFeatures: ['scaled-strength-v1'], excludesTags: []
  },
  {
    id: 'the-hermit', name: 'The Hermit', strength: null, desc: '相手の直前の実カードとして、このラウンドの強さ・能力を引き継ぐ', category: 'tarot',
    requiresFeatures: ['round-snapshot-v1', 'echo-profile-v1'], excludesTags: [], effectProfileId: 'echo-opponent-v1'
  },
  {
    id: 'wheel-of-fortune', name: 'Wheel of Fortune', strength: 10, desc: '勝利時は総ラウンド数+1、敗北時は-1', category: 'tarot',
    requiresFeatures: ['round-extension-v1'], excludesTags: []
  },
  {
    id: 'justice', name: 'Justice', strength: 11, desc: '勝利時、相手札1枚をロック', category: 'tarot',
    requiresFeatures: ['target-actions-v1', 'lock-state-v1'], excludesTags: [],
    mayPreventAllLegalPlays: true,
    playabilityRisk: 'temporary-all-hand-lock', effectProfileId: 'lock-one-v1'
  },
  {
    id: 'the-hanged-man', name: 'The Hanged Man', strength: 12, desc: '敗北時、相手が望む札を相手手札へ加える', category: 'tarot',
    requiresFeatures: ['target-actions-v1', 'card-generation-v1'], excludesTags: [], effectProfileId: 'opponent-choose-copy-v1'
  },
  {
    id: 'death', name: 'Death', strength: null, desc: '獲得札が相手以下なら13、上回ると0', category: 'tarot',
    requiresFeatures: ['conditional-strength-v1'], excludesTags: []
  },
  {
    id: 'temperance', name: 'Temperance', strength: null, desc: '奇数ラウンドは14、偶数ラウンドは0', category: 'tarot',
    requiresFeatures: ['conditional-strength-v1'], excludesTags: []
  },
  {
    id: 'the-devil', name: 'The Devil', strength: null, desc: '持ち越し札があれば15、なければ0', category: 'tarot',
    requiresFeatures: ['conditional-strength-v1'], excludesTags: []
  },
  {
    id: 'the-tower', name: 'The Tower', strength: null, desc: '現在ラウンド数 × 2 の強さ', category: 'tarot',
    requiresFeatures: ['conditional-strength-v1'], excludesTags: []
  },
  {
    id: 'the-star', name: 'The Star', strength: 17, desc: '敗北時、相手が望む札をノイズ状態で相手手札へ加える', category: 'tarot',
    requiresFeatures: ['target-actions-v1', 'card-generation-v1', 'recipient-view-v1', 'noise-state-v1'], excludesTags: [], effectProfileId: 'opponent-choose-noise-v1'
  },
  {
    id: 'the-moon', name: 'The Moon', strength: 18, desc: '引き分け時・敗北時に獲得カードを全て失う', category: 'tarot',
    requiresFeatures: ['won-pile-ledger-v1', 'acquired-card-discard-v1'], excludesTags: [], effectProfileId: 'discard-own-won-pile-v1'
  },
  {
    id: 'the-sun', name: 'The Sun', strength: 19, desc: '自分札を1枚選び破壊', category: 'tarot',
    requiresFeatures: ['pre-commit-target-v1', 'destroy-card-v1'], excludesTags: [],
    playabilityRisk: 'hand-exhaustion-ends-game', effectProfileId: 'destroy-own-hand-v1'
  },
  {
    id: 'judgement', name: 'Judgement', strength: 0, desc: '過去に出した全札を手札へ複製', category: 'tarot',
    requiresFeatures: ['played-card-ledger-v1', 'card-generation-v1'], excludesTags: [], effectProfileId: 'copy-played-history-v1'
  },
  {
    id: 'the-world', name: 'The World', strength: 0, desc: '相手の獲得札を1枚破棄し、その札を自分の手札へ複製', category: 'tarot',
    requiresFeatures: ['target-actions-v1', 'won-pile-ledger-v1', 'acquired-card-transfer-v1', 'card-generation-v1'], excludesTags: [], effectProfileId: 'transfer-won-card-v1'
  }
].map((definition) => freezeDefinition({
  ...definition,
  ...(definition.category === 'tarot' ? TAROT_PRESENTATION_BY_ID[definition.id] : {}),
  displayMark: definition.category === 'tarot'
    ? TAROT_GREEK_MARKS_BY_ID[definition.id]
    : '',
  status: definition.id === 'blank'
    ? 'engine-ready'
    : AVAILABLE_TAROT_IDS.has(definition.id)
      ? 'available'
      : 'specified',
  availability: [EXPANDED_PRIVATE_RULESET_ID],
  maxCopiesPerDeck: definition.category === 'tarot' ? 1 : 3,
  visibilityModel: definition.id === 'the-star' ? 'recipient-specific' : 'public'
})));

const FUTURE_PRIVATE_CARD_DEFINITION_BY_ID = new Map(
  FUTURE_PRIVATE_CARD_CATALOG.map((definition) => [definition.id, definition])
);

// The same catalog order drives both the deck editor and canonical deck
// summaries.  Put the familiar base deck first, playable Tarot in α–χ order,
// then the optional no-ability Four–Ten cards that are less commonly used.
// Unavailable designs remain in the catalog after those visible choices so
// they cannot alter a live deck's presentation before implementation.
const PRIVATE_CARD_CATALOG = Object.freeze([
  ...CLASSIC_PRIVATE_CARD_CATALOG,
  ...AVAILABLE_TAROT_DISPLAY_ORDER.map((definitionId) => (
    FUTURE_PRIVATE_CARD_DEFINITION_BY_ID.get(definitionId)
  )),
  ...EXTRA_NORMAL_CARD_CATALOG,
  ...FUTURE_PRIVATE_CARD_CATALOG.filter((definition) => !AVAILABLE_TAROT_IDS.has(definition.id))
]);
const PRIVATE_CARD_DEFINITION_BY_ID = new Map(
  PRIVATE_CARD_CATALOG.map((definition) => [definition.id, definition])
);

function getClassicPrivateCardDefinition(definitionId) {
  const definition = typeof definitionId === 'string'
    ? CLASSIC_PRIVATE_CARD_DEFINITION_BY_ID.get(definitionId)
    : null;
  if (!definition) throw new RangeError('unknown private card definition');
  return definition;
}

function getPrivateCardDefinition(definitionId) {
  const definition = typeof definitionId === 'string'
    ? PRIVATE_CARD_DEFINITION_BY_ID.get(definitionId)
    : null;
  if (!definition) throw new RangeError('unknown private card definition');
  return definition;
}

module.exports = {
  CLASSIC_PRIVATE_CARD_DEFINITIONS,
  CLASSIC_PRIVATE_CARD_DEFINITION_BY_ID,
  CLASSIC_PRIVATE_CARD_CATALOG,
  EXTRA_NORMAL_CARD_CATALOG,
  FUTURE_PRIVATE_CARD_CATALOG,
  PRIVATE_CARD_CATALOG,
  PRIVATE_CARD_DEFINITION_BY_ID,
  PRIVATE_CARD_STATUSES,
  AVAILABLE_TAROT_DISPLAY_ORDER,
  AVAILABLE_TAROT_IDS,
  TAROT_GREEK_MARKS_BY_ID,
  TAROT_PRESENTATION_BY_ID,
  getClassicPrivateCardDefinition,
  getPrivateCardDefinition
};
