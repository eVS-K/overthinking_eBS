'use strict';

const { isDeepStrictEqual } = require('node:util');

/**
 * Private拡張用の純粋ゲーム状態遷移。
 *
 * 追加通常札・仮想Blankを含むPrivate設定を、既存クラシックとは別の
 * immutable stateとして扱う。UIやSocket.IOはここに入れず、複製札・
 * Blank・得点・終了判定を独立して検証できるようにする。
 */
const { CARD_DEFINITIONS, resolveRound } = require('./game-rules');
const {
  CLASSIC_PRIVATE_RULESET,
  EXPANDED_PRIVATE_RULESET_ID,
  MAX_PRIVATE_CARD_INSTANCES,
  MAX_PRIVATE_HAND_SIZE,
  MAX_PRIVATE_HISTORY_RECORDS,
  MAX_PRIVATE_INITIAL_CARDS_PER_SIDE,
  MAX_PRIVATE_ROUNDS,
  assertPrivateRuleset,
  createClassicPrivateRuleset,
  createExpandedPrivateRuleset
} = require('./private-ruleset');
const {
  clonePrivateCardInstance,
  createClassicPrivateCardInstances,
  createPrivateCardInstance,
  createPrivateCardInstances,
  getClassicCardDefinition,
  getPrivateCardDefinition
} = require('./private-card-instances');
const { expandPrivateDeckEntries, normalizePrivateDeckEntries } = require('./private-deck');
const {
  createEchoProfile,
  resolvePrivateRoundWithContext
} = require('./private-card-effects');
const {
  VIRTUAL_BLANK_SELECTION_ID,
  createVirtualBlankCard,
  isVirtualBlankCard,
  isVirtualBlankSelectionId
} = require('./private-blank');
const { materializePrivatePostRoundEffects } = require('./private-card-post-effects');

const CLASSIC_DEFINITION_IDS = Object.freeze(CARD_DEFINITIONS.map((card) => card.id));
const INSTANCE_NAMESPACE_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
const ADVANCED_TAROT_IDS = new Set([
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
const PRIVATE_SEATS = Object.freeze(['p1', 'p2']);

function recordedStrengthToUnits(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value * 2;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)\.5$/.test(value)) return null;
  const wholePart = Number(value.slice(0, -2));
  return Number.isSafeInteger(wholePart) ? wholePart * 2 + 1 : null;
}

function cloneHand(hand) {
  if (!Array.isArray(hand)) throw new TypeError('private hand must be an array');
  return hand.map(clonePrivateCardInstance);
}

function clonePlayedPrivateCard(card) {
  return isVirtualBlankCard(card) ? createVirtualBlankCard() : clonePrivateCardInstance(card);
}

function clonePrivateRoundEffects(effects) {
  if (!Array.isArray(effects)) return [];
  return effects.map((effect) => ({
    ...effect,
    ...(Array.isArray(effect?.cardInstanceIds) ? { cardInstanceIds: [...effect.cardInstanceIds] } : {})
  }));
}

function cloneAdvancedAction(action) {
  if (!action || typeof action !== 'object') return action;
  return {
    ...action,
    ...(Array.isArray(action.candidates) ? { candidates: [...action.candidates] } : {})
  };
}

function cloneDiscardPile(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => ({
    card: clonePrivateCardInstance(entry.card),
    reason: entry.reason,
    round: entry.round
  }));
}

function cloneIssuedCards(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => ({ ...entry }));
}

function clonePrivateGameStateUnchecked(state) {
  return {
    rules: { ...state.rules },
    ...(state.deck ? { deck: state.deck.map((entry) => ({ ...entry })) } : {}),
    ...(state.rules.ruleset === EXPANDED_PRIVATE_RULESET_ID ? {
      instanceNamespace: state.instanceNamespace,
      nextInstanceOrdinalBySeat: { ...state.nextInstanceOrdinalBySeat },
      effectiveRoundLimit: state.effectiveRoundLimit
    } : {}),
    initialCardsPerSide: state.initialCardsPerSide,
    round: state.round,
    p1: {
      hand: cloneHand(state.p1.hand),
      score: state.p1.score,
      ...(Array.isArray(state.p1.wonPile) ? { wonPile: cloneHand(state.p1.wonPile) } : {})
    },
    p2: {
      hand: cloneHand(state.p2.hand),
      score: state.p2.score,
      ...(Array.isArray(state.p2.wonPile) ? { wonPile: cloneHand(state.p2.wonPile) } : {})
    },
    stack: cloneHand(state.stack),
    ...(Array.isArray(state.discardPile) ? { discardPile: cloneDiscardPile(state.discardPile) } : {}),
    ...(Array.isArray(state.issuedCards) ? { issuedCards: cloneIssuedCards(state.issuedCards) } : {}),
    history: state.history.map((record) => ({
      ...record,
      p1Card: clonePlayedPrivateCard(record.p1Card),
      p2Card: clonePlayedPrivateCard(record.p2Card),
      effects: clonePrivateRoundEffects(record.effects),
      ...(record.roundSnapshot ? { roundSnapshot: { ...record.roundSnapshot } } : {}),
      ...(Array.isArray(record.actionPlan) ? { actionPlan: record.actionPlan.map(cloneAdvancedAction) } : {}),
      ...(Array.isArray(record.resolvedActionKeys) ? { resolvedActionKeys: [...record.resolvedActionKeys] } : {})
    }))
  };
}

function clonePrivateGameState(state) {
  assertPrivateGameState(state);
  return clonePrivateGameStateUnchecked(state);
}

function resolvePrivateRound(p1Card, p2Card) {
  return resolveRound(
    getPrivateCardDefinition(p1Card.definitionId),
    getPrivateCardDefinition(p2Card.definitionId)
  );
}

function assertCardIsAllowedByRuleset(card, ruleset) {
  if (isVirtualBlankCard(card)) {
    if (ruleset.ruleset !== EXPANDED_PRIVATE_RULESET_ID || ruleset.blankEnabled !== true) {
      throw new RangeError('virtual Blank is not enabled for this private ruleset');
    }
    return createVirtualBlankCard();
  }
  const normalized = clonePrivateCardInstance(card);
  if (ruleset.ruleset === EXPANDED_PRIVATE_RULESET_ID) {
    getPrivateCardDefinition(normalized.definitionId);
  } else {
    // Do not let a forged extended definition alter the classic engine.
    getClassicCardDefinition(normalized.definitionId);
  }
  return normalized;
}

function getEffectivePrivateRoundLimitUnchecked(state) {
  return state.rules.ruleset === EXPANDED_PRIVATE_RULESET_ID
    ? state.effectiveRoundLimit
    : state.rules.roundLimit;
}

function getPrivateTerminalReasonUnchecked(state) {
  if (state.rules.scoreTarget !== null
    && (state.p1.score >= state.rules.scoreTarget || state.p2.score >= state.rules.scoreTarget)) {
    return 'score-target';
  }
  const playedRounds = state.history.length;
  if (playedRounds >= getEffectivePrivateRoundLimitUnchecked(state)) return 'round-limit';
  if (state.p1.hand.length === 0 || state.p2.hand.length === 0) return 'hand-exhausted';
  return null;
}

function getPrivateTerminalReason(state) {
  assertPrivateGameState(state);
  return getPrivateTerminalReasonUnchecked(state);
}

function initializeExpandedCardLedger(state) {
  const definitions = expandPrivateDeckEntries(state.deck);
  const expectedCardsByInstanceId = new Map();
  for (const seat of ['p1', 'p2']) {
    definitions.forEach((definitionId, index) => {
      expectedCardsByInstanceId.set(`${state.instanceNamespace}:${seat}:${index + 1}`, {
        seat,
        definitionId
      });
    });
  }
  return {
    expectedCardsByInstanceId,
    handCounts: { p1: definitions.length, p2: definitions.length },
    generatedCounts: { p1: 0, p2: 0 },
    totalCardInstances: definitions.length * 2,
    nextInstanceOrdinalBySeat: { p1: definitions.length + 1, p2: definitions.length + 1 },
    effectiveRoundLimit: state.rules.roundLimit
  };
}

function createInitialIssuedCards({ instanceNamespace, definitionIds }) {
  const entries = [];
  for (const seat of PRIVATE_SEATS) {
    definitionIds.forEach((definitionId, index) => {
      entries.push({
        instanceId: `${instanceNamespace}:${seat}:${index + 1}`,
        seat,
        definitionId,
        generated: false
      });
    });
  }
  return entries;
}

function isAdvancedTarotCard(card) {
  return Boolean(card && ADVANCED_TAROT_IDS.has(card.definitionId));
}

function stateUsesAdvancedMechanics(state) {
  if (state?.rules?.ruleset !== EXPANDED_PRIVATE_RULESET_ID) return false;
  // Keep ordinary expanded rooms on the established replay validator until
  // an advanced Tarot enters their history.  This preserves resumption of
  // pre-ledger rooms while every advanced transition itself upgrades into
  // the stricter card-location ledger below.
  return (state.history || []).some((record) => isAdvancedTarotCard(record?.p1Card)
    || isAdvancedTarotCard(record?.p2Card)
    || (Array.isArray(record?.effects) && record.effects.some((effect) => effect?.advanced === true)));
}

function isCardLocked(card) {
  return Boolean(card?.state?.locked === true || (Array.isArray(card?.state?.locks) && card.state.locks.length > 0));
}

function isNoiseCard(card) {
  return card?.state?.visibility === 'noise-owner-only';
}

function requiresAdvancedPrivateRound(state, p1InstanceId, p2InstanceId) {
  if (state?.rules?.ruleset !== EXPANDED_PRIVATE_RULESET_ID) return false;
  return stateUsesAdvancedMechanics(state)
    || isAdvancedTarotCard(getHandCardById(state, 'p1', p1InstanceId))
    || isAdvancedTarotCard(getHandCardById(state, 'p2', p2InstanceId));
}

function makeDiscardEntry(card, reason, round) {
  return {
    card: clonePrivateCardInstance(card),
    reason,
    round
  };
}

function addIssuedCard(state, { seat, definitionId, generated = true }) {
  if (!PRIVATE_SEATS.includes(seat)) throw new RangeError('unknown recipient seat');
  const ordinal = state.nextInstanceOrdinalBySeat[seat];
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 999_999) {
    throw new RangeError('private generated card ordinal is invalid');
  }
  const instanceId = `${state.instanceNamespace}:${seat}:${ordinal}`;
  state.nextInstanceOrdinalBySeat[seat] = ordinal + 1;
  const instance = createPrivateCardInstance({ instanceId, definitionId, state: { generated: generated === true } });
  state.issuedCards.push({ instanceId, seat, definitionId, generated: generated === true });
  return instance;
}

function addGeneratedCard(state, { seat, definitionId, noise = false }) {
  if (state[seat].hand.length >= MAX_PRIVATE_HAND_SIZE || state.issuedCards.length >= MAX_PRIVATE_CARD_INSTANCES) {
    return null;
  }
  const instance = addIssuedCard(state, { seat, definitionId });
  if (noise) {
    instance.state.visibility = 'noise-owner-only';
    instance.state.revealOn = 'play';
  }
  state[seat].hand.push(instance);
  return instance;
}

function syncScoreFromWonPile(state, seat) {
  if (Array.isArray(state?.[seat]?.wonPile)) state[seat].score = state[seat].wonPile.length;
  return state?.[seat]?.score;
}

function appendEffect(record, effect) {
  if (!record || !effect) return;
  if (!Array.isArray(record.effects)) record.effects = [];
  if (record.effects.length >= 24) throw new RangeError('private round effect limit exceeded');
  record.effects.push(effect);
}

function assertExpectedExpandedCard(ledger, card, seat) {
  if (isVirtualBlankCard(card)) return;
  const expected = ledger.expectedCardsByInstanceId.get(card.instanceId);
  if (!expected || expected.seat !== seat || expected.definitionId !== card.definitionId) {
    throw new RangeError('expanded private card does not match its server-issued source');
  }
}

function countAllocatedPhysicalCards(state) {
  if (Array.isArray(state?.issuedCards)) return state.issuedCards.length;
  const instanceIds = new Set();
  for (const card of [...state.p1.hand, ...state.p2.hand]) {
    if (!isVirtualBlankCard(card)) instanceIds.add(card.instanceId);
  }
  for (const record of state.history) {
    for (const card of [record.p1Card, record.p2Card]) {
      if (!isVirtualBlankCard(card)) instanceIds.add(card.instanceId);
    }
  }
  return instanceIds.size;
}

function assertAdvancedPrivateGameState(state) {
  if (state.rules.ruleset !== EXPANDED_PRIVATE_RULESET_ID) {
    throw new RangeError('advanced mechanics require the expanded private ruleset');
  }
  const normalizedDeck = normalizePrivateDeckEntries(state.deck, state.rules);
  if (JSON.stringify(normalizedDeck) !== JSON.stringify(state.deck)) {
    throw new RangeError('expanded private deck snapshot is not normalized');
  }
  const totalDeckCards = normalizedDeck.reduce((total, entry) => total + entry.copies, 0);
  if (state.initialCardsPerSide !== totalDeckCards
    || typeof state.instanceNamespace !== 'string'
    || !INSTANCE_NAMESPACE_PATTERN.test(state.instanceNamespace)
    || !Number.isSafeInteger(state.effectiveRoundLimit)
    || state.effectiveRoundLimit < 1
    || state.effectiveRoundLimit > MAX_PRIVATE_ROUNDS) {
    throw new RangeError('advanced private state has an invalid fixed snapshot');
  }
  if (!state.nextInstanceOrdinalBySeat || typeof state.nextInstanceOrdinalBySeat !== 'object'
    || !Number.isSafeInteger(state.nextInstanceOrdinalBySeat.p1)
    || !Number.isSafeInteger(state.nextInstanceOrdinalBySeat.p2)
    || !Array.isArray(state.issuedCards)
    || state.issuedCards.length < totalDeckCards * 2
    || state.issuedCards.length > MAX_PRIVATE_CARD_INSTANCES
    || !Array.isArray(state.discardPile)
    || !Array.isArray(state.stack)
    || !Array.isArray(state.history)
    || state.history.length > MAX_PRIVATE_HISTORY_RECORDS) {
    throw new RangeError('advanced private state has invalid card ledgers');
  }
  const issuedById = new Map();
  for (const issued of state.issuedCards) {
    if (!issued || typeof issued !== 'object'
      || !PRIVATE_SEATS.includes(issued.seat)
      || typeof issued.instanceId !== 'string'
      || typeof issued.definitionId !== 'string'
      || (issued.generated !== undefined && typeof issued.generated !== 'boolean')
      || issuedById.has(issued.instanceId)) {
      throw new RangeError('advanced private issued card is invalid');
    }
    const card = createPrivateCardInstance({
      instanceId: issued.instanceId,
      definitionId: issued.definitionId,
      state: { generated: issued.generated === true }
    });
    if (card.instanceId !== issued.instanceId || card.definitionId !== issued.definitionId
      || (card.state.generated === true) !== (issued.generated === true)) {
      throw new RangeError('advanced private issued card is malformed');
    }
    issuedById.set(issued.instanceId, issued);
  }
  for (const seat of PRIVATE_SEATS) {
    const player = state[seat];
    if (!player || typeof player !== 'object' || !Array.isArray(player.hand)
      || !Array.isArray(player.wonPile) || !Number.isSafeInteger(player.score)
      || player.hand.length > MAX_PRIVATE_HAND_SIZE
      || player.score !== player.wonPile.length) {
      throw new RangeError(`advanced private ${seat} state is invalid`);
    }
  }
  const occupied = new Map();
  const occupy = (card, location, { expectedSeat = null } = {}) => {
    const normalized = assertCardIsAllowedByRuleset(card, state.rules);
    if (isVirtualBlankCard(normalized)) throw new RangeError('virtual Blank cannot enter advanced card ledgers');
    if (!isDeepStrictEqual(normalized, card)) {
      throw new RangeError('advanced private card state is not canonical');
    }
    const issued = issuedById.get(normalized.instanceId);
    if (!issued || issued.definitionId !== normalized.definitionId
      || (normalized.state.generated === true) !== (issued.generated === true)
      || (expectedSeat && issued.seat !== expectedSeat)
      || occupied.has(normalized.instanceId)) {
      throw new RangeError('advanced private card location is invalid');
    }
    occupied.set(normalized.instanceId, location);
    return normalized;
  };
  for (const seat of PRIVATE_SEATS) {
    for (const card of state[seat].hand) occupy(card, `${seat}:hand`, { expectedSeat: seat });
    for (const card of state[seat].wonPile) occupy(card, `${seat}:won`);
  }
  for (const card of state.stack) occupy(card, 'stack');
  for (const entry of state.discardPile) {
    if (!entry || typeof entry !== 'object' || typeof entry.reason !== 'string'
      || !Number.isSafeInteger(entry.round) || entry.round < 1 || entry.round > MAX_PRIVATE_ROUNDS) {
      throw new RangeError('advanced private discard entry is invalid');
    }
    occupy(entry.card, 'discard');
  }
  if (occupied.size !== issuedById.size) {
    throw new RangeError('advanced private cards are missing from a ledger location');
  }
  const playedIds = new Set();
  for (let index = 0; index < state.history.length; index += 1) {
    const record = state.history[index];
    if (!record || typeof record !== 'object' || record.round !== index + 1
      || !['p1', 'p2', 'draw'].includes(record.canonicalResult)
      || ![null, 'p1', 'p2'].includes(record.winnerSeat)
      || !Number.isSafeInteger(record.awardedCards) || record.awardedCards < 0
      || !Array.isArray(record.effects) || record.effects.length > 24) {
      throw new RangeError('advanced private history record is invalid');
    }
    const hasAdvancedMetadata = record.roundSnapshot !== undefined
      || record.actionPlan !== undefined
      || record.resolvedActionKeys !== undefined
      || isAdvancedTarotCard(record.p1Card)
      || isAdvancedTarotCard(record.p2Card)
      || record.effects.some((effect) => effect?.advanced === true);
    if (hasAdvancedMetadata && (!record.roundSnapshot || typeof record.roundSnapshot !== 'object'
      || !Number.isSafeInteger(record.roundSnapshot.p1Score) || record.roundSnapshot.p1Score < 0
      || !Number.isSafeInteger(record.roundSnapshot.p2Score) || record.roundSnapshot.p2Score < 0
      || !Number.isSafeInteger(record.roundSnapshot.stackCount) || record.roundSnapshot.stackCount < 0
      || !Array.isArray(record.actionPlan) || !Array.isArray(record.resolvedActionKeys))) {
      throw new RangeError('advanced private round snapshot is invalid');
    }
    const actionKeys = new Set();
    if (hasAdvancedMetadata) {
      for (const action of record.actionPlan) {
        if (!action || typeof action !== 'object'
          || typeof action.actionKey !== 'string' || action.actionKey.length < 1 || actionKeys.has(action.actionKey)
          || !PRIVATE_SEATS.includes(action.sourceSeat)
          || !PRIVATE_SEATS.includes(action.actorSeat)
          || !PRIVATE_SEATS.includes(action.targetSeat)
          || typeof action.type !== 'string' || !Array.isArray(action.candidates)
          || action.candidates.length > 32 || new Set(action.candidates).size !== action.candidates.length) {
          throw new RangeError('advanced private action plan is invalid');
        }
        actionKeys.add(action.actionKey);
      }
      if (new Set(record.resolvedActionKeys).size !== record.resolvedActionKeys.length
        || record.resolvedActionKeys.some((key) => !actionKeys.has(key))) {
        throw new RangeError('advanced private resolved action ledger is invalid');
      }
    }
    for (const [seat, card] of [['p1', record.p1Card], ['p2', record.p2Card]]) {
      const normalized = assertCardIsAllowedByRuleset(card, state.rules);
      if (isVirtualBlankCard(normalized)) continue;
      const issued = issuedById.get(normalized.instanceId);
      if (!issued || issued.seat !== seat || issued.definitionId !== normalized.definitionId
        || (normalized.state.generated === true) !== (issued.generated === true)
        || playedIds.has(normalized.instanceId)
        || occupied.get(normalized.instanceId) === `${seat}:hand`) {
        throw new RangeError('advanced private history card is invalid');
      }
      playedIds.add(normalized.instanceId);
    }
    if (hasAdvancedMetadata) {
      const snapshotContext = {
        round: record.round,
        p1: { score: record.roundSnapshot.p1Score },
        p2: { score: record.roundSnapshot.p2Score },
        stack: Array.from({ length: record.roundSnapshot.stackCount }),
        history: state.history.slice(0, index)
      };
      const resolution = resolvePrivateRoundWithContext(snapshotContext, record.p1Card, record.p2Card);
      const expectedWinnerSeat = resolution.canonicalResult === 'p1'
        ? 'p1' : resolution.canonicalResult === 'p2' ? 'p2' : null;
      const physicalCards = [record.p1Card, record.p2Card].filter((card) => !isVirtualBlankCard(card));
      const expectedAwardedCards = expectedWinnerSeat
        ? record.roundSnapshot.stackCount + physicalCards.length
        : 0;
      if (record.canonicalResult !== resolution.canonicalResult
        || record.winnerSeat !== expectedWinnerSeat
        || record.awardedCards !== expectedAwardedCards
        || recordedStrengthToUnits(record.p1Strength) !== resolution.p1.resolvedStrengthUnits
        || recordedStrengthToUnits(record.p2Strength) !== resolution.p2.resolvedStrengthUnits) {
        throw new RangeError('advanced private history outcome does not match the canonical rules');
      }
      const expectedP1Echo = createEchoProfile({
        card: record.p1Card,
        resolvedStrengthUnits: resolution.p1.resolvedStrengthUnits,
        copiedProfile: isAdvancedTarotCard(record.p1Card) ? resolution.p1 : null
      });
      const expectedP2Echo = createEchoProfile({
        card: record.p2Card,
        resolvedStrengthUnits: resolution.p2.resolvedStrengthUnits,
        copiedProfile: isAdvancedTarotCard(record.p2Card) ? resolution.p2 : null
      });
      if (!isDeepStrictEqual(record.p1EchoProfile ?? null, expectedP1Echo)
        || !isDeepStrictEqual(record.p2EchoProfile ?? null, expectedP2Echo)) {
        throw new RangeError('advanced private echo profile is invalid');
      }
    }
    for (const effect of record.effects) {
      if (!effect || typeof effect !== 'object') throw new RangeError('advanced private round effect is invalid');
      if (Array.isArray(effect.cardInstanceIds)) {
        for (const instanceId of effect.cardInstanceIds) {
          if (!issuedById.has(instanceId)) throw new RangeError('advanced private effect refers to an unknown card');
        }
      }
    }
  }
  for (const seat of PRIVATE_SEATS) {
    if (!Number.isSafeInteger(state.nextInstanceOrdinalBySeat[seat])
      || state.nextInstanceOrdinalBySeat[seat] < state.initialCardsPerSide + 1
      || state.nextInstanceOrdinalBySeat[seat] > 999_999) {
      throw new RangeError('advanced private generated card ordinal is invalid');
    }
  }
  const terminal = getPrivateTerminalReasonUnchecked(state) !== null;
  const expectedRound = terminal ? state.history.length : state.history.length + 1;
  if (!Number.isSafeInteger(state.round) || state.round !== expectedRound || state.round < 1
    || state.round > state.effectiveRoundLimit) {
    throw new RangeError('advanced private round does not match the game state');
  }
  return state;
}

function assertPrivateGameState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('private state must be an object');
  assertPrivateRuleset(state.rules);
  if (stateUsesAdvancedMechanics(state)) return assertAdvancedPrivateGameState(state);
  if (!Number.isSafeInteger(state.initialCardsPerSide)
    || state.initialCardsPerSide < 1
    || state.initialCardsPerSide > MAX_PRIVATE_INITIAL_CARDS_PER_SIDE
    || state.initialCardsPerSide > MAX_PRIVATE_HAND_SIZE
    || state.initialCardsPerSide * 2 > MAX_PRIVATE_CARD_INSTANCES) {
    throw new RangeError('invalid private initial card count');
  }
  if (state.rules.ruleset === EXPANDED_PRIVATE_RULESET_ID) {
    if (!Array.isArray(state.deck)) throw new TypeError('expanded private state requires a deck snapshot');
    const normalizedDeck = normalizePrivateDeckEntries(state.deck, state.rules);
    if (JSON.stringify(normalizedDeck) !== JSON.stringify(state.deck)) {
      throw new RangeError('expanded private deck snapshot is not normalized');
    }
    const totalDeckCards = normalizedDeck.reduce((total, entry) => total + entry.copies, 0);
    if (state.initialCardsPerSide !== totalDeckCards) {
      throw new RangeError('expanded private deck does not match initial card count');
    }
    if (typeof state.instanceNamespace !== 'string' || !INSTANCE_NAMESPACE_PATTERN.test(state.instanceNamespace)) {
      throw new RangeError('expanded private state has an invalid instance namespace');
    }
    if (!state.nextInstanceOrdinalBySeat || typeof state.nextInstanceOrdinalBySeat !== 'object'
      || !Number.isSafeInteger(state.nextInstanceOrdinalBySeat.p1)
      || !Number.isSafeInteger(state.nextInstanceOrdinalBySeat.p2)
      || state.nextInstanceOrdinalBySeat.p1 < state.initialCardsPerSide + 1
      || state.nextInstanceOrdinalBySeat.p2 < state.initialCardsPerSide + 1
      || state.nextInstanceOrdinalBySeat.p1 > 999_999
      || state.nextInstanceOrdinalBySeat.p2 > 999_999) {
      throw new RangeError('expanded private state has invalid generated card allocation');
    }
    if (!Number.isSafeInteger(state.effectiveRoundLimit)
      || state.effectiveRoundLimit < 1
      || state.effectiveRoundLimit > MAX_PRIVATE_ROUNDS) {
      throw new RangeError('expanded private state has an invalid effective round limit');
    }
  } else if (state.deck !== undefined) {
    throw new RangeError('classic private state cannot carry an expanded deck snapshot');
  }
  if (!Number.isSafeInteger(state.round) || state.round < 1 || state.round > getEffectivePrivateRoundLimitUnchecked(state)) {
    throw new RangeError('invalid private round');
  }
  for (const seat of ['p1', 'p2']) {
    const player = state[seat];
    if (!player || typeof player !== 'object' || !Array.isArray(player.hand) || !Number.isSafeInteger(player.score)) {
      throw new TypeError(`invalid private ${seat} state`);
    }
    const maximumHand = state.rules.ruleset === EXPANDED_PRIVATE_RULESET_ID
      ? MAX_PRIVATE_HAND_SIZE
      : state.initialCardsPerSide;
    if (player.score < 0 || player.hand.length > maximumHand) {
      throw new RangeError(`invalid private ${seat} cards or score`);
    }
  }
  if (!Array.isArray(state.stack)) {
    throw new TypeError('private stack must be an array');
  }
  if (state.rules.ruleset !== EXPANDED_PRIVATE_RULESET_ID
    && (state.p1.hand.length !== state.p2.hand.length || state.stack.length % 2 !== 0)) {
    throw new RangeError('classic private hands must be balanced and stack must be even');
  }
  if (!Array.isArray(state.history) || state.history.length > MAX_PRIVATE_HISTORY_RECORDS) {
    throw new RangeError('invalid private history');
  }

  const isExpanded = state.rules.ruleset === EXPANDED_PRIVATE_RULESET_ID;
  const expandedLedger = isExpanded ? initializeExpandedCardLedger(state) : null;
  const activeHandInstanceIds = new Set();
  const actualPhysicalCardsByInstanceId = new Map();
  for (const seat of ['p1', 'p2']) {
    for (const card of state[seat].hand) {
      const normalized = assertCardIsAllowedByRuleset(card, state.rules);
      if (isVirtualBlankCard(normalized)) throw new RangeError('virtual Blank cannot be held in a hand');
      if (activeHandInstanceIds.has(normalized.instanceId)) throw new RangeError('duplicate private card instance');
      activeHandInstanceIds.add(normalized.instanceId);
      actualPhysicalCardsByInstanceId.set(normalized.instanceId, {
        seat,
        definitionId: normalized.definitionId
      });
    }
  }
  const stackInstanceIds = new Set();
  for (const card of state.stack) {
    const normalized = assertCardIsAllowedByRuleset(card, state.rules);
    if (isVirtualBlankCard(normalized)) throw new RangeError('virtual Blank cannot enter the stack');
    if (activeHandInstanceIds.has(normalized.instanceId) || stackInstanceIds.has(normalized.instanceId)) {
      throw new RangeError('duplicate private card instance');
    }
    stackInstanceIds.add(normalized.instanceId);
  }
  let reconstructedP1Score = 0;
  let reconstructedP2Score = 0;
  let reconstructedStack = 0;
  const historicalInstanceIds = new Set();
  let unresolvedStackInstanceIds = new Set();
  for (let index = 0; index < state.history.length; index += 1) {
    const record = state.history[index];
    if (!record || typeof record !== 'object' || record.round !== index + 1) {
      throw new TypeError('invalid private history record');
    }
    const p1Card = assertCardIsAllowedByRuleset(record.p1Card, state.rules);
    const p2Card = assertCardIsAllowedByRuleset(record.p2Card, state.rules);
    for (const [seat, card] of [['p1', p1Card], ['p2', p2Card]]) {
      if (isVirtualBlankCard(card)) continue;
      if (activeHandInstanceIds.has(card.instanceId) || historicalInstanceIds.has(card.instanceId)) {
        throw new RangeError('duplicate private card instance');
      }
      if (isExpanded) assertExpectedExpandedCard(expandedLedger, card, seat);
      historicalInstanceIds.add(card.instanceId);
      actualPhysicalCardsByInstanceId.set(card.instanceId, { seat, definitionId: card.definitionId });
    }
    const historicalContext = {
      round: record.round,
      p1: { score: reconstructedP1Score },
      p2: { score: reconstructedP2Score },
      stack: Array.from({ length: reconstructedStack })
    };
    const resolution = resolvePrivateRoundWithContext(historicalContext, p1Card, p2Card);
    const canonicalResult = resolution.canonicalResult;
    if (record.canonicalResult !== canonicalResult) throw new RangeError('private history outcome does not match canonical rules');
    const hasStrengthSnapshot = record.p1Strength !== undefined || record.p2Strength !== undefined;
    if (hasStrengthSnapshot) {
      const p1StrengthUnits = recordedStrengthToUnits(record.p1Strength);
      const p2StrengthUnits = recordedStrengthToUnits(record.p2Strength);
      if (p1StrengthUnits === null
        || p2StrengthUnits === null
        || p1StrengthUnits !== resolution.p1.resolvedStrengthUnits
        || p2StrengthUnits !== resolution.p2.resolvedStrengthUnits) {
        throw new RangeError('private history strength does not match the round context');
      }
    }
    const expectedWinnerSeat = canonicalResult === 'p1' ? 'p1' : canonicalResult === 'p2' ? 'p2' : null;
    const physicalPlayedCards = [p1Card, p2Card].filter((card) => !isVirtualBlankCard(card));
    const expectedAwardedCards = expectedWinnerSeat ? physicalPlayedCards.length + reconstructedStack : 0;
    if (record.winnerSeat !== expectedWinnerSeat || record.awardedCards !== expectedAwardedCards) {
      throw new RangeError('private history award is inconsistent');
    }
    if (expectedWinnerSeat === 'p1') {
      reconstructedP1Score += expectedAwardedCards;
      reconstructedStack = 0;
    } else if (expectedWinnerSeat === 'p2') {
      reconstructedP2Score += expectedAwardedCards;
      reconstructedStack = 0;
    } else {
      reconstructedStack += physicalPlayedCards.length;
      for (const card of physicalPlayedCards) unresolvedStackInstanceIds.add(card.instanceId);
    }
    if (expectedWinnerSeat) unresolvedStackInstanceIds = new Set();

    if (isExpanded) {
      if (!isVirtualBlankCard(p1Card)) expandedLedger.handCounts.p1 -= 1;
      if (!isVirtualBlankCard(p2Card)) expandedLedger.handCounts.p2 -= 1;
      if (expandedLedger.handCounts.p1 < 0 || expandedLedger.handCounts.p2 < 0) {
        throw new RangeError('expanded private history consumes more cards than exist');
      }
      const postRound = materializePrivatePostRoundEffects({
        p1Card,
        p2Card,
        winnerSeat: expectedWinnerSeat,
        instanceNamespace: state.instanceNamespace,
        round: record.round,
        effectiveRoundLimit: expandedLedger.effectiveRoundLimit,
        handCounts: expandedLedger.handCounts,
        totalCardInstances: expandedLedger.totalCardInstances,
        nextInstanceOrdinalBySeat: expandedLedger.nextInstanceOrdinalBySeat
      });
      const recordedEffects = record.effects === undefined ? [] : record.effects;
      if (!Array.isArray(recordedEffects)
        || !isDeepStrictEqual(recordedEffects, postRound.effects)) {
        throw new RangeError('expanded private history effects do not match the canonical result');
      }
      for (const addition of postRound.additions) {
        if (expandedLedger.expectedCardsByInstanceId.has(addition.instanceId)) {
          throw new RangeError('expanded private generated card instance is duplicated');
        }
        expandedLedger.expectedCardsByInstanceId.set(addition.instanceId, {
          seat: addition.recipientSeat,
          definitionId: addition.definitionId
        });
        expandedLedger.generatedCounts[addition.recipientSeat] += 1;
      }
      expandedLedger.handCounts = postRound.handCounts;
      expandedLedger.totalCardInstances = postRound.totalCardInstances;
      expandedLedger.nextInstanceOrdinalBySeat = postRound.nextInstanceOrdinalBySeat;
      expandedLedger.effectiveRoundLimit = postRound.effectiveRoundLimit;
    } else if (record.effects !== undefined
      && (!Array.isArray(record.effects) || record.effects.length !== 0)) {
      throw new RangeError('classic private history cannot contain expanded effects');
    }
  }

  if (isExpanded) {
    // A stack entry is a view of a previously played physical card.  Its
    // instanceId alone is not enough: an altered definition must not survive
    // a reconnect/persistence round-trip and affect a later award.
    for (const card of state.stack) {
      const normalized = clonePrivateCardInstance(card);
      const historical = actualPhysicalCardsByInstanceId.get(normalized.instanceId);
      const expected = expandedLedger.expectedCardsByInstanceId.get(normalized.instanceId);
      if (!historical
        || !expected
        || historical.seat !== expected.seat
        || historical.definitionId !== expected.definitionId
        || normalized.definitionId !== expected.definitionId) {
        throw new RangeError('expanded private stack cards do not match their played source');
      }
    }
  }

  const p1PhysicalPlayed = (state.initialCardsPerSide + (expandedLedger?.generatedCounts.p1 || 0)) - state.p1.hand.length;
  const p2PhysicalPlayed = (state.initialCardsPerSide + (expandedLedger?.generatedCounts.p2 || 0)) - state.p2.hand.length;
  const playedPhysicalCards = p1PhysicalPlayed + p2PhysicalPlayed;
  const accountedCards = state.p1.score + state.p2.score + state.stack.length;
  if (accountedCards !== playedPhysicalCards
    || reconstructedP1Score !== state.p1.score
    || reconstructedP2Score !== state.p2.score
    || reconstructedStack !== state.stack.length
    || unresolvedStackInstanceIds.size !== stackInstanceIds.size
    || [...unresolvedStackInstanceIds].some((instanceId) => !stackInstanceIds.has(instanceId))) {
    throw new RangeError('private score and stack do not account for played cards');
  }
  if (state.rules.ruleset !== EXPANDED_PRIVATE_RULESET_ID
    && (p1PhysicalPlayed !== p2PhysicalPlayed || state.history.length !== p1PhysicalPlayed)) {
    throw new RangeError('classic private history must consume one card per side per round');
  }
  if (isExpanded) {
    if (state.effectiveRoundLimit !== expandedLedger.effectiveRoundLimit
      || state.nextInstanceOrdinalBySeat.p1 !== expandedLedger.nextInstanceOrdinalBySeat.p1
      || state.nextInstanceOrdinalBySeat.p2 !== expandedLedger.nextInstanceOrdinalBySeat.p2
      || state.p1.hand.length !== expandedLedger.handCounts.p1
      || state.p2.hand.length !== expandedLedger.handCounts.p2
      || actualPhysicalCardsByInstanceId.size !== expandedLedger.expectedCardsByInstanceId.size
      || expandedLedger.totalCardInstances !== expandedLedger.expectedCardsByInstanceId.size) {
      throw new RangeError('expanded private generated cards do not match the canonical state');
    }
    for (const [instanceId, actual] of actualPhysicalCardsByInstanceId) {
      const expected = expandedLedger.expectedCardsByInstanceId.get(instanceId);
      if (!expected || expected.seat !== actual.seat || expected.definitionId !== actual.definitionId) {
        throw new RangeError('expanded private cards do not match their generated history');
      }
    }
  }
  const terminal = getPrivateTerminalReasonUnchecked(state) !== null;
  const expectedRound = terminal ? state.history.length : state.history.length + 1;
  if (state.round !== expectedRound) throw new RangeError('private round does not match the game state');
  return state;
}

function createClassicPrivateGameState({ rules = CLASSIC_PRIVATE_RULESET, instanceNamespace = 'private' } = {}) {
  const snapshot = createClassicPrivateRuleset(rules);
  const p1Hand = createClassicPrivateCardInstances({
    namespace: instanceNamespace,
    seat: 'p1',
    definitionIds: CLASSIC_DEFINITION_IDS
  });
  const p2Hand = createClassicPrivateCardInstances({
    namespace: instanceNamespace,
    seat: 'p2',
    definitionIds: CLASSIC_DEFINITION_IDS
  });
  const state = {
    rules: snapshot,
    initialCardsPerSide: CLASSIC_DEFINITION_IDS.length,
    round: 1,
    p1: { hand: p1Hand, score: 0 },
    p2: { hand: p2Hand, score: 0 },
    stack: [],
    history: []
  };
  assertPrivateGameState(state);
  return state;
}

function createExpandedPrivateGameState({ rules, deck, instanceNamespace = 'private-expanded' } = {}) {
  const snapshot = createExpandedPrivateRuleset(rules);
  const normalizedDeck = normalizePrivateDeckEntries(deck, snapshot);
  const definitionIds = expandPrivateDeckEntries(normalizedDeck);
  const state = {
    rules: snapshot,
    deck: normalizedDeck,
    instanceNamespace,
    nextInstanceOrdinalBySeat: {
      p1: definitionIds.length + 1,
      p2: definitionIds.length + 1
    },
    effectiveRoundLimit: snapshot.roundLimit,
    initialCardsPerSide: definitionIds.length,
    round: 1,
    p1: {
      hand: createPrivateCardInstances({ namespace: instanceNamespace, seat: 'p1', definitionIds }),
      score: 0,
      wonPile: []
    },
    p2: {
      hand: createPrivateCardInstances({ namespace: instanceNamespace, seat: 'p2', definitionIds }),
      score: 0,
      wonPile: []
    },
    stack: [],
    discardPile: [],
    issuedCards: createInitialIssuedCards({ instanceNamespace, definitionIds }),
    history: []
  };
  assertPrivateGameState(state);
  return state;
}

function isTerminalPrivateGameState(state) {
  assertPrivateGameState(state);
  return getPrivateTerminalReasonUnchecked(state) !== null;
}

function findLegalCardIndex(hand, instanceId) {
  if (typeof instanceId !== 'string') return -1;
  return hand.findIndex((card) => card.instanceId === instanceId && !isCardLocked(card));
}

function legalPrivateCardInstanceIds(state, seat) {
  assertPrivateGameState(state);
  if (seat !== 'p1' && seat !== 'p2') throw new RangeError('unknown private seat');
  const legalHandIds = state[seat].hand
    .filter((card) => !isCardLocked(card))
    .map((card) => card.instanceId);
  return state.rules.ruleset === EXPANDED_PRIVATE_RULESET_ID && state.rules.blankEnabled
    ? [...legalHandIds, VIRTUAL_BLANK_SELECTION_ID]
    : legalHandIds;
}

function privateMatchScore(state) {
  assertPrivateGameState(state);
  if (!isTerminalPrivateGameState(state)) throw new Error('private state is not terminal');
  if (state.p1.score > state.p2.score) return 1;
  if (state.p1.score < state.p2.score) return 0;
  return 0.5;
}

function seatOpponent(seat) {
  if (seat === 'p1') return 'p2';
  if (seat === 'p2') return 'p1';
  throw new RangeError('unknown private seat');
}

function getHandCardById(state, seat, instanceId) {
  if (!PRIVATE_SEATS.includes(seat) || typeof instanceId !== 'string') return null;
  return state[seat].hand.find((card) => card.instanceId === instanceId) || null;
}

function getSeatCardForSelection(state, seat, instanceId) {
  if (isVirtualBlankSelectionId(instanceId)) return state.rules.blankEnabled ? createVirtualBlankCard() : null;
  const card = getHandCardById(state, seat, instanceId);
  return card && !isCardLocked(card) ? card : null;
}

function addLockToCard(card, { id, releaseAfterRound }) {
  if (!card || !card.state || typeof id !== 'string' || !Number.isSafeInteger(releaseAfterRound)) {
    throw new RangeError('private lock data is invalid');
  }
  const locks = Array.isArray(card.state.locks) ? card.state.locks.filter((lock) => lock.id !== id) : [];
  locks.push({ id, releaseAfterRound });
  card.state.locks = locks;
  card.state.locked = true;
}

function releaseLocksAfterRound(state, completedRound) {
  for (const seat of PRIVATE_SEATS) {
    for (const card of state[seat].hand) {
      const locks = Array.isArray(card.state?.locks) ? card.state.locks : [];
      const remaining = locks.filter((lock) => lock.releaseAfterRound > completedRound);
      card.state.locks = remaining;
      card.state.locked = remaining.length > 0;
    }
  }
}

function cloneEffectForRecord(effect, overrides = {}) {
  return {
    ...effect,
    ...overrides,
    ...(Array.isArray(effect?.cardInstanceIds) ? { cardInstanceIds: [...effect.cardInstanceIds] } : {})
  };
}

function materializeSafePostEffects(next, {
  p1Card,
  p2Card,
  resolution,
  winnerSeat,
  record
}) {
  const behaviorCard = (card, preview, seat) => {
    if (resolution.suppressedSeats.includes(seat)) return { definitionId: '__suppressed__' };
    return preview.safePostEffectId ? { ...card, definitionId: preview.safePostEffectId } : card;
  };
  const postRound = materializePrivatePostRoundEffects({
    p1Card: behaviorCard(p1Card, resolution.p1, 'p1'),
    p2Card: behaviorCard(p2Card, resolution.p2, 'p2'),
    winnerSeat,
    instanceNamespace: next.instanceNamespace,
    round: next.round,
    effectiveRoundLimit: next.effectiveRoundLimit,
    handCounts: { p1: next.p1.hand.length, p2: next.p2.hand.length },
    totalCardInstances: next.issuedCards.length,
    nextInstanceOrdinalBySeat: next.nextInstanceOrdinalBySeat
  });
  for (const addition of postRound.additions) {
    next[addition.recipientSeat].hand.push(createPrivateCardInstance({
      instanceId: addition.instanceId,
      definitionId: addition.definitionId,
      state: { generated: true }
    }));
    next.issuedCards.push({
      instanceId: addition.instanceId,
      seat: addition.recipientSeat,
      definitionId: addition.definitionId,
      generated: true
    });
  }
  next.nextInstanceOrdinalBySeat = postRound.nextInstanceOrdinalBySeat;
  next.effectiveRoundLimit = postRound.effectiveRoundLimit;
  postRound.effects.forEach((effect) => {
    const sourceCard = effect.sourceSeat === 'p1' ? p1Card : p2Card;
    const preview = effect.sourceSeat === 'p1' ? resolution.p1 : resolution.p2;
    appendEffect(record, cloneEffectForRecord(effect, {
      ...(preview.safePostEffectId && preview.safePostEffectId !== sourceCard.definitionId
        ? { copiedFromDefinitionId: preview.safePostEffectId }
        : {}),
      advanced: true
    }));
  });
}

function applyAutomaticAdvancedEffects(next, {
  p1Card,
  p2Card,
  resolution,
  winnerSeat,
  record,
  previousHistory
}) {
  materializeSafePostEffects(next, { p1Card, p2Card, resolution, winnerSeat, record });
  const played = [
    { seat: 'p1', card: p1Card, preview: resolution.p1 },
    { seat: 'p2', card: p2Card, preview: resolution.p2 }
  ];
  for (const { seat, card } of played) {
    if (resolution.suppressedSeats.includes(seat)) continue;
    const opponent = seatOpponent(seat);
    if (card.definitionId === 'the-moon' && winnerSeat !== seat) {
      const discarded = next[seat].wonPile.splice(0).map((wonCard) => makeDiscardEntry(wonCard, 'moon', next.round));
      next.discardPile.push(...discarded);
      syncScoreFromWonPile(next, seat);
      appendEffect(record, {
        type: 'discard-won-cards', advanced: true, sourceSeat: seat,
        sourceDefinitionId: card.definitionId, targetSeat: seat, discardedCount: discarded.length
      });
    }
    if (card.definitionId === 'the-empress' && winnerSeat === seat) {
      const targets = next[opponent].hand.filter((target) => getPrivateCardDefinition(target.definitionId).category !== 'tarot');
      targets.forEach((target) => addLockToCard(target, {
        id: `empress-${next.round}-${seat}-${target.instanceId}`,
        releaseAfterRound: next.round + 1
      }));
      appendEffect(record, {
        type: 'lock-cards', advanced: true, sourceSeat: seat,
        sourceDefinitionId: card.definitionId, targetSeat: opponent, lockedCount: targets.length,
        releaseAfterRound: next.round + 1
      });
    }
    if (card.definitionId === 'judgement') {
      const copiedIds = [];
      for (const previous of previousHistory) {
        const previousCard = seat === 'p1' ? previous.p1Card : previous.p2Card;
        if (isVirtualBlankCard(previousCard)) continue;
        const created = addGeneratedCard(next, { seat, definitionId: previousCard.definitionId });
        if (!created) break;
        copiedIds.push(created.instanceId);
      }
      appendEffect(record, {
        type: 'copy-played-history', advanced: true, sourceSeat: seat,
        sourceDefinitionId: card.definitionId, cardInstanceIds: copiedIds
      });
    }
  }
}

function getTargetActionsForAdvancedRound(next, {
  p1Card,
  p2Card,
  resolution,
  winnerSeat,
  roundStartWonPileIds
}) {
  const actions = [];
  const played = [
    { seat: 'p1', card: p1Card },
    { seat: 'p2', card: p2Card }
  ];
  for (const { seat, card } of played) {
    if (resolution.suppressedSeats.includes(seat)) continue;
    const opponent = seatOpponent(seat);
    const base = {
      round: next.round,
      sourceSeat: seat,
      sourceDefinitionId: card.definitionId
    };
    if (card.definitionId === 'the-high-priestess' && winnerSeat === opponent) {
      const candidates = next[opponent].hand
        .filter((target) => !isNoiseCard(target))
        .map((target) => target.instanceId);
      if (candidates.length) actions.push({ ...base, type: 'copy-opponent-hand', actorSeat: seat, targetSeat: opponent, candidates });
    }
    if (card.definitionId === 'the-hierophant' && winnerSeat === opponent) {
      const candidates = next[seat].hand.map((target) => target.instanceId);
      if (candidates.length) actions.push({ ...base, type: 'copy-own-hand', actorSeat: seat, targetSeat: seat, candidates });
    }
    if (card.definitionId === 'justice' && winnerSeat === seat) {
      const candidates = next[opponent].hand.map((target) => target.instanceId);
      if (candidates.length) actions.push({ ...base, type: 'lock-one', actorSeat: seat, targetSeat: opponent, candidates });
    }
    if ((card.definitionId === 'the-hanged-man' || card.definitionId === 'the-star') && winnerSeat === opponent) {
      const candidates = [...new Set(next.deck.map((entry) => entry.definitionId))]
        .filter((definitionId) => definitionId !== 'blank');
      if (candidates.length) actions.push({
        ...base,
        type: card.definitionId === 'the-star' ? 'opponent-choose-noise' : 'opponent-choose-copy',
        actorSeat: opponent,
        targetSeat: opponent,
        candidates
      });
    }
    if (card.definitionId === 'the-world') {
      const candidates = (roundStartWonPileIds[opponent] || []).filter((instanceId) =>
        next[opponent].wonPile.some((wonCard) => wonCard.instanceId === instanceId));
      if (candidates.length) actions.push({ ...base, type: 'transfer-won-card', actorSeat: seat, targetSeat: opponent, candidates });
    }
  }
  return actions.map((action, index) => ({
    ...action,
    // A deterministic key is stored in the immutable round record.  The
    // server later wraps it in a fresh opaque action id/nonce, while the
    // engine still refuses a duplicated or substituted effect internally.
    actionKey: `${next.round}:${action.sourceSeat}:${action.sourceDefinitionId}:${action.type}:${index}`
  }));
}

function applyAdvancedTargetAction(state, action, target) {
  if (!action || typeof action !== 'object' || !Array.isArray(action.candidates)
    || !action.candidates.includes(target) || !PRIVATE_SEATS.includes(action.sourceSeat)
    || !PRIVATE_SEATS.includes(action.actorSeat) || !PRIVATE_SEATS.includes(action.targetSeat)) {
    throw new RangeError('private target action is invalid');
  }
  const next = clonePrivateGameStateUnchecked(state);
  const record = next.history.at(-1);
  if (!record || record.round !== action.round || next.round !== action.round) {
    throw new RangeError('private target action is stale');
  }
  const expectedAction = Array.isArray(record.actionPlan)
    ? record.actionPlan.find((candidate) => candidate.actionKey === action.actionKey)
    : null;
  if (!expectedAction || !isDeepStrictEqual(expectedAction, cloneAdvancedAction(action))) {
    throw new RangeError('private target action does not match the round plan');
  }
  if (record.resolvedActionKeys.includes(action.actionKey)) {
    throw new RangeError('private target action has already been resolved');
  }
  const addCopyFromCard = (sourceCard, recipientSeat, noise = false) => {
    const created = addGeneratedCard(next, { seat: recipientSeat, definitionId: sourceCard.definitionId, noise });
    appendEffect(record, {
      type: noise ? 'add-noise-card' : 'add-card-copy', advanced: true,
      sourceSeat: action.sourceSeat, sourceDefinitionId: action.sourceDefinitionId,
      actorSeat: action.actorSeat, recipientSeat, definitionId: sourceCard.definitionId,
      cardInstanceIds: created ? [created.instanceId] : [], capped: !created
    });
  };
  if (action.type === 'copy-opponent-hand' || action.type === 'copy-own-hand') {
    const sourceCard = getHandCardById(next, action.targetSeat, target);
    if (!sourceCard || (action.type === 'copy-opponent-hand' && isNoiseCard(sourceCard))) {
      throw new RangeError('private target card is no longer legal');
    }
    addCopyFromCard(sourceCard, action.sourceSeat);
  } else if (action.type === 'lock-one') {
    const targetCard = getHandCardById(next, action.targetSeat, target);
    if (!targetCard) throw new RangeError('private lock target is no longer legal');
    addLockToCard(targetCard, {
      id: `justice-${next.round}-${action.sourceSeat}-${targetCard.instanceId}`,
      releaseAfterRound: next.round + 1
    });
    appendEffect(record, {
      type: 'lock-card', advanced: true, sourceSeat: action.sourceSeat,
      sourceDefinitionId: action.sourceDefinitionId, targetSeat: action.targetSeat,
      lockedCount: 1, releaseAfterRound: next.round + 1
    });
  } else if (action.type === 'opponent-choose-copy' || action.type === 'opponent-choose-noise') {
    if (!next.deck.some((entry) => entry.definitionId === target)) {
      throw new RangeError('private generated definition is not in the frozen deck');
    }
    const created = addGeneratedCard(next, {
      seat: action.targetSeat,
      definitionId: target,
      noise: action.type === 'opponent-choose-noise'
    });
    appendEffect(record, {
      type: action.type === 'opponent-choose-noise' ? 'add-noise-card' : 'add-card-copy',
      advanced: true, sourceSeat: action.sourceSeat, sourceDefinitionId: action.sourceDefinitionId,
      actorSeat: action.actorSeat, recipientSeat: action.targetSeat, definitionId: target,
      cardInstanceIds: created ? [created.instanceId] : [], capped: !created
    });
  } else if (action.type === 'transfer-won-card') {
    const sourcePile = next[action.targetSeat].wonPile;
    const targetIndex = sourcePile.findIndex((card) => card.instanceId === target);
    if (targetIndex < 0) throw new RangeError('private won-card target is no longer legal');
    const [taken] = sourcePile.splice(targetIndex, 1);
    next.discardPile.push(makeDiscardEntry(taken, 'world', next.round));
    syncScoreFromWonPile(next, action.targetSeat);
    const created = addGeneratedCard(next, { seat: action.sourceSeat, definitionId: taken.definitionId });
    appendEffect(record, {
      type: 'transfer-won-card', advanced: true, sourceSeat: action.sourceSeat,
      sourceDefinitionId: action.sourceDefinitionId, targetSeat: action.targetSeat,
      definitionId: taken.definitionId, cardInstanceIds: created ? [created.instanceId] : [], capped: !created
    });
  } else {
    throw new RangeError('unknown private target action');
  }
  record.resolvedActionKeys.push(action.actionKey);
  return { state: next, record: next.history.at(-1) };
}

function skipAdvancedTargetAction(state, action, reason = 'skipped-no-legal-target') {
  const next = clonePrivateGameStateUnchecked(state);
  const record = next.history.at(-1);
  const expectedAction = record && Array.isArray(record.actionPlan)
    ? record.actionPlan.find((candidate) => candidate.actionKey === action?.actionKey)
    : null;
  if (!record || !expectedAction || !isDeepStrictEqual(expectedAction, cloneAdvancedAction(action))
    || !Array.isArray(record.resolvedActionKeys) || record.resolvedActionKeys.includes(action.actionKey)) {
    throw new RangeError('private target action cannot be skipped');
  }
  appendEffect(record, {
    type: 'skipped-target-action', advanced: true,
    sourceSeat: action.sourceSeat,
    sourceDefinitionId: action.sourceDefinitionId,
    actionKey: action.actionKey,
    reason
  });
  record.resolvedActionKeys.push(action.actionKey);
  return { state: next, record };
}

// A score/round/hand terminal state is authoritative before any optional
// post-result target picker. Preserve the generated plan in the immutable
// round record for auditability, but resolve every item as skipped so a
// finished game never waits for a player to choose a target.
function skipAllAdvancedTargetActions(state, actions, reason = 'game-ended-before-target-selection') {
  if (!Array.isArray(actions)) throw new TypeError('private target action list is invalid');
  let next = state;
  for (const action of actions) {
    next = skipAdvancedTargetAction(next, action, reason).state;
  }
  return {
    state: next,
    record: next.history.at(-1),
    skippedCount: actions.length
  };
}

function materializeSunPreCommitEffects(next, p1InstanceId, p2InstanceId, preCommitEffects) {
  if (!Array.isArray(preCommitEffects) || preCommitEffects.length > 2) {
    throw new RangeError('private Sun pre-commit effects are invalid');
  }
  const selectionBySeat = { p1: p1InstanceId, p2: p2InstanceId };
  const usedSeats = new Set();
  const materialized = [];
  for (const effect of preCommitEffects) {
    if (!effect || typeof effect !== 'object'
      || effect.type !== 'destroy-card' || effect.sourceDefinitionId !== 'the-sun'
      || !PRIVATE_SEATS.includes(effect.sourceSeat) || effect.targetSeat !== effect.sourceSeat
      || typeof effect.sunInstanceId !== 'string' || typeof effect.targetInstanceId !== 'string'
      || usedSeats.has(effect.sourceSeat) || selectionBySeat[effect.sourceSeat] !== effect.sunInstanceId) {
      throw new RangeError('private Sun pre-commit effect is invalid');
    }
    const sun = getHandCardById(next, effect.sourceSeat, effect.sunInstanceId);
    const targetIndex = next[effect.sourceSeat].hand.findIndex((card) => card.instanceId === effect.targetInstanceId);
    if (!sun || sun.definitionId !== 'the-sun' || targetIndex < 0 || effect.targetInstanceId === effect.sunInstanceId) {
      throw new RangeError('private Sun target is invalid');
    }
    const [destroyed] = next[effect.sourceSeat].hand.splice(targetIndex, 1);
    next.discardPile.push(makeDiscardEntry(destroyed, 'sun', next.round));
    materialized.push({
      type: 'destroy-card', advanced: true, sourceSeat: effect.sourceSeat,
      sourceDefinitionId: 'the-sun', targetSeat: effect.sourceSeat,
      targetInstanceId: destroyed.instanceId, destroyedCount: 1
    });
    usedSeats.add(effect.sourceSeat);
  }
  for (const seat of PRIVATE_SEATS) {
    const selectedId = selectionBySeat[seat];
    const selected = getHandCardById(next, seat, selectedId);
    if (selected?.definitionId !== 'the-sun') continue;
    const hasOtherPhysicalCard = next[seat].hand.some((card) => card.instanceId !== selected.instanceId);
    if (hasOtherPhysicalCard && !usedSeats.has(seat)) {
      throw new RangeError('private Sun requires a pre-commit target');
    }
  }
  return materialized;
}

function beginAdvancedPrivateRound(state, p1InstanceId, p2InstanceId, { preCommitEffects = [] } = {}) {
  assertPrivateGameState(state);
  if (isTerminalPrivateGameState(state)) throw new Error('cannot begin an advanced private round in a terminal state');
  const p1Card = getSeatCardForSelection(state, 'p1', p1InstanceId);
  const p2Card = getSeatCardForSelection(state, 'p2', p2InstanceId);
  if (!p1Card || !p2Card) throw new RangeError('selected private card is not legal');
  const next = clonePrivateGameStateUnchecked(state);
  const materializedPreCommitEffects = materializeSunPreCommitEffects(next, p1InstanceId, p2InstanceId, preCommitEffects);
  const p1Index = isVirtualBlankSelectionId(p1InstanceId) ? -1 : findLegalCardIndex(next.p1.hand, p1InstanceId);
  const p2Index = isVirtualBlankSelectionId(p2InstanceId) ? -1 : findLegalCardIndex(next.p2.hand, p2InstanceId);
  const playedP1 = p1Index < 0 ? createVirtualBlankCard() : next.p1.hand.splice(p1Index, 1)[0];
  const playedP2 = p2Index < 0 ? createVirtualBlankCard() : next.p2.hand.splice(p2Index, 1)[0];
  if (isNoiseCard(playedP1)) {
    playedP1.state.visibility = 'public';
    playedP1.state.revealOn = null;
  }
  if (isNoiseCard(playedP2)) {
    playedP2.state.visibility = 'public';
    playedP2.state.revealOn = null;
  }
  const roundStartWonPileIds = {
    p1: next.p1.wonPile.map((card) => card.instanceId),
    p2: next.p2.wonPile.map((card) => card.instanceId)
  };
  const previousHistory = next.history.map((record) => ({
    ...record,
    p1Card: clonePlayedPrivateCard(record.p1Card),
    p2Card: clonePlayedPrivateCard(record.p2Card)
  }));
  const resolution = resolvePrivateRoundWithContext(state, playedP1, playedP2);
  const canonicalResult = resolution.canonicalResult;
  const physicalPlayedCards = [playedP1, playedP2].filter((card) => !isVirtualBlankCard(card));
  const awardedCards = physicalPlayedCards.length + next.stack.length;
  const winnerSeat = canonicalResult === 'p1' ? 'p1' : canonicalResult === 'p2' ? 'p2' : null;
  if (winnerSeat) {
    const won = [...next.stack, ...physicalPlayedCards].map(clonePrivateCardInstance);
    next[winnerSeat].wonPile.push(...won);
    syncScoreFromWonPile(next, winnerSeat);
    next.stack = [];
  } else {
    next.stack.push(...physicalPlayedCards);
  }
  const record = {
    round: state.round,
    roundSnapshot: {
      p1Score: state.p1.score,
      p2Score: state.p2.score,
      stackCount: state.stack.length
    },
    p1Card: clonePlayedPrivateCard(playedP1),
    p2Card: clonePlayedPrivateCard(playedP2),
    canonicalResult,
    p1Strength: resolution.p1.resolvedStrength,
    p2Strength: resolution.p2.resolvedStrength,
    p1EchoProfile: createEchoProfile({
      card: playedP1,
      resolvedStrengthUnits: resolution.p1.resolvedStrengthUnits,
      copiedProfile: isAdvancedTarotCard(playedP1) ? resolution.p1 : null
    }),
    p2EchoProfile: createEchoProfile({
      card: playedP2,
      resolvedStrengthUnits: resolution.p2.resolvedStrengthUnits,
      copiedProfile: isAdvancedTarotCard(playedP2) ? resolution.p2 : null
    }),
    winnerSeat,
    awardedCards: winnerSeat ? awardedCards : 0,
    effects: materializedPreCommitEffects.map((effect) => cloneEffectForRecord(effect)),
    actionPlan: [],
    resolvedActionKeys: []
  };
  next.history = [...next.history, record].slice(-MAX_PRIVATE_HISTORY_RECORDS);
  applyAutomaticAdvancedEffects(next, {
    p1Card: playedP1,
    p2Card: playedP2,
    resolution,
    winnerSeat,
    record,
    previousHistory
  });
  const plannedTargetActions = getTargetActionsForAdvancedRound(next, {
    p1Card: playedP1,
    p2Card: playedP2,
    resolution,
    winnerSeat,
    roundStartWonPileIds
  });
  record.actionPlan = plannedTargetActions.map(cloneAdvancedAction);
  const terminalReasonBeforeTargetActions = getPrivateTerminalReasonUnchecked(next);
  const skipped = terminalReasonBeforeTargetActions !== null
    ? skipAllAdvancedTargetActions(next, plannedTargetActions, 'game-ended-before-target-selection')
    : null;
  const resultState = skipped ? skipped.state : next;
  return {
    state: resultState,
    record: resultState.history.at(-1),
    targetActions: skipped ? [] : plannedTargetActions,
    terminalReasonBeforeTargetActions,
    skippedTargetActionCount: skipped ? skipped.skippedCount : 0,
    canonicalResult,
    winnerSeat,
    awardedCards: winnerSeat ? awardedCards : 0
  };
}

function finalizeAdvancedPrivateRound(state) {
  const next = clonePrivateGameStateUnchecked(state);
  const record = next.history.at(-1);
  if (!record || record.round !== next.round) throw new RangeError('private advanced round cannot be finalized');
  if (!Array.isArray(record.actionPlan) || !Array.isArray(record.resolvedActionKeys)
    || record.actionPlan.length !== record.resolvedActionKeys.length) {
    throw new RangeError('private advanced round still has unresolved target actions');
  }
  releaseLocksAfterRound(next, next.round);
  const terminalReason = getPrivateTerminalReasonUnchecked(next);
  const terminal = terminalReason !== null;
  if (!terminal) next.round += 1;
  assertPrivateGameState(next);
  return {
    state: next,
    ...record,
    terminal,
    terminalReason,
    matchScore: terminal ? privateMatchScore(next) : null
  };
}

function applySunPreCommitAction(state, seat, sunInstanceId, targetInstanceId) {
  assertPrivateGameState(state);
  if (!PRIVATE_SEATS.includes(seat)) throw new RangeError('unknown private seat');
  const sun = getHandCardById(state, seat, sunInstanceId);
  const target = getHandCardById(state, seat, targetInstanceId);
  if (!sun || sun.definitionId !== 'the-sun' || !target || target.instanceId === sun.instanceId) {
    throw new RangeError('private Sun target is invalid');
  }
  // Do not mutate the durable game state while the player is still choosing
  // a pre-commit target.  beginAdvancedPrivateRound materializes this intent
  // atomically alongside both simultaneous card commitments.
  return {
    state: clonePrivateGameStateUnchecked(state),
    effect: {
      type: 'destroy-card', advanced: true, sourceSeat: seat,
      sourceDefinitionId: 'the-sun', targetSeat: seat,
      sunInstanceId: sun.instanceId,
      targetInstanceId: target.instanceId,
      destroyedCount: 1
    }
  };
}

function applyAdvancedPrivateRound(state, p1InstanceId, p2InstanceId) {
  let working = state;
  const preCommitEffects = [];
  for (const [seat, instanceId] of [['p1', p1InstanceId], ['p2', p2InstanceId]]) {
    const card = getHandCardById(working, seat, instanceId);
    if (card?.definitionId === 'the-sun') {
      const target = working[seat].hand.find((candidate) => candidate.instanceId !== card.instanceId);
      if (target) {
        const sun = applySunPreCommitAction(working, seat, instanceId, target.instanceId);
        preCommitEffects.push(sun.effect);
      }
    }
  }
  const started = beginAdvancedPrivateRound(working, p1InstanceId, p2InstanceId, { preCommitEffects });
  let resolvedState = started.state;
  for (const action of started.targetActions) {
    const target = action.candidates[0];
    if (target !== undefined) resolvedState = applyAdvancedTargetAction(resolvedState, action, target).state;
  }
  return finalizeAdvancedPrivateRound(resolvedState);
}

function applyPrivateRound(state, p1InstanceId, p2InstanceId) {
  assertPrivateGameState(state);
  if (isTerminalPrivateGameState(state)) throw new Error('cannot apply a private round to a terminal state');

  const p1SelectedCard = getHandCardById(state, 'p1', p1InstanceId);
  const p2SelectedCard = getHandCardById(state, 'p2', p2InstanceId);
  if (state.rules.ruleset === EXPANDED_PRIVATE_RULESET_ID
    && (stateUsesAdvancedMechanics(state) || isAdvancedTarotCard(p1SelectedCard) || isAdvancedTarotCard(p2SelectedCard))) {
    return applyAdvancedPrivateRound(state, p1InstanceId, p2InstanceId);
  }

  const p1IsVirtualBlank = isVirtualBlankSelectionId(p1InstanceId);
  const p2IsVirtualBlank = isVirtualBlankSelectionId(p2InstanceId);
  const p1Index = p1IsVirtualBlank ? -1 : findLegalCardIndex(state.p1.hand, p1InstanceId);
  const p2Index = p2IsVirtualBlank ? -1 : findLegalCardIndex(state.p2.hand, p2InstanceId);
  if ((p1IsVirtualBlank && !state.rules.blankEnabled)
    || (p2IsVirtualBlank && !state.rules.blankEnabled)
    || (!p1IsVirtualBlank && p1Index < 0)
    || (!p2IsVirtualBlank && p2Index < 0)) {
    throw new RangeError('selected private card is not legal');
  }

  const next = clonePrivateGameState(state);
  const p1Card = p1IsVirtualBlank ? createVirtualBlankCard() : next.p1.hand.splice(p1Index, 1)[0];
  const p2Card = p2IsVirtualBlank ? createVirtualBlankCard() : next.p2.hand.splice(p2Index, 1)[0];
  const resolution = resolvePrivateRoundWithContext(state, p1Card, p2Card);
  const canonicalResult = resolution.canonicalResult;
  const physicalPlayedCards = [p1Card, p2Card].filter((card) => !isVirtualBlankCard(card));
  const awardedCards = physicalPlayedCards.length + next.stack.length;
  let winnerSeat = null;
  if (canonicalResult === 'p1') {
    const awarded = [...next.stack, ...physicalPlayedCards].map(clonePrivateCardInstance);
    if (Array.isArray(next.p1.wonPile)) {
      next.p1.wonPile.push(...awarded);
      syncScoreFromWonPile(next, 'p1');
    } else {
      next.p1.score += awardedCards;
    }
    next.stack = [];
    winnerSeat = 'p1';
  } else if (canonicalResult === 'p2') {
    const awarded = [...next.stack, ...physicalPlayedCards].map(clonePrivateCardInstance);
    if (Array.isArray(next.p2.wonPile)) {
      next.p2.wonPile.push(...awarded);
      syncScoreFromWonPile(next, 'p2');
    } else {
      next.p2.score += awardedCards;
    }
    next.stack = [];
    winnerSeat = 'p2';
  } else {
    next.stack.push(...physicalPlayedCards);
  }

  const postRound = state.rules.ruleset === EXPANDED_PRIVATE_RULESET_ID
    ? materializePrivatePostRoundEffects({
      p1Card,
      p2Card,
      winnerSeat,
      instanceNamespace: next.instanceNamespace,
      round: state.round,
      effectiveRoundLimit: next.effectiveRoundLimit,
      handCounts: { p1: next.p1.hand.length, p2: next.p2.hand.length },
      totalCardInstances: countAllocatedPhysicalCards(state),
      nextInstanceOrdinalBySeat: next.nextInstanceOrdinalBySeat
    })
    : null;
  if (postRound) {
    for (const addition of postRound.additions) {
      next[addition.recipientSeat].hand.push(createPrivateCardInstance({
        instanceId: addition.instanceId,
        definitionId: addition.definitionId,
        state: { generated: true }
      }));
      if (Array.isArray(next.issuedCards)) {
        next.issuedCards.push({
          instanceId: addition.instanceId,
          seat: addition.recipientSeat,
          definitionId: addition.definitionId,
          generated: true
        });
      }
    }
    next.nextInstanceOrdinalBySeat = postRound.nextInstanceOrdinalBySeat;
    next.effectiveRoundLimit = postRound.effectiveRoundLimit;
  }

  const record = {
    round: state.round,
    p1Card: clonePlayedPrivateCard(p1Card),
    p2Card: clonePlayedPrivateCard(p2Card),
    canonicalResult,
    p1Strength: resolution.p1.resolvedStrength,
    p2Strength: resolution.p2.resolvedStrength,
    p1EchoProfile: createEchoProfile({
      card: p1Card,
      resolvedStrengthUnits: resolution.p1.resolvedStrengthUnits,
      copiedProfile: p1Card.definitionId === 'the-fool' || p1Card.definitionId === 'the-hermit'
        ? {
          resolvedStrengthUnits: resolution.p1.resolvedStrengthUnits,
          comparisonOverride: resolution.p1.comparisonOverride,
          safePostEffectId: resolution.p1.safePostEffectId
        }
        : null
    }),
    p2EchoProfile: createEchoProfile({
      card: p2Card,
      resolvedStrengthUnits: resolution.p2.resolvedStrengthUnits,
      copiedProfile: p2Card.definitionId === 'the-fool' || p2Card.definitionId === 'the-hermit'
        ? {
          resolvedStrengthUnits: resolution.p2.resolvedStrengthUnits,
          comparisonOverride: resolution.p2.comparisonOverride,
          safePostEffectId: resolution.p2.safePostEffectId
        }
        : null
    }),
    winnerSeat,
    awardedCards: winnerSeat ? awardedCards : 0,
    effects: postRound?.effects || []
  };
  next.history = [...next.history, record].slice(-MAX_PRIVATE_HISTORY_RECORDS);
  const terminalReason = getPrivateTerminalReasonUnchecked(next);
  const terminal = terminalReason !== null;
  if (!terminal) next.round += 1;
  assertPrivateGameState(next);
  return {
    state: next,
    ...record,
    terminal,
    terminalReason,
    matchScore: terminal ? privateMatchScore(next) : null
  };
}

module.exports = {
  ADVANCED_TAROT_IDS,
  CLASSIC_DEFINITION_IDS,
  applyAdvancedTargetAction,
  applyPrivateRound,
  applySunPreCommitAction,
  assertPrivateGameState,
  beginAdvancedPrivateRound,
  clonePrivateGameState,
  createClassicPrivateGameState,
  createExpandedPrivateGameState,
  findLegalCardIndex,
  finalizeAdvancedPrivateRound,
  getPrivateTerminalReason,
  getTargetActionsForAdvancedRound,
  isTerminalPrivateGameState,
  isAdvancedTarotCard,
  isCardLocked,
  isNoiseCard,
  legalPrivateCardInstanceIds,
  privateMatchScore,
  requiresAdvancedPrivateRound,
  resolvePrivateRound,
  skipAdvancedTargetAction,
  skipAllAdvancedTargetActions
};
