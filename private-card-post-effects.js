'use strict';

/**
 * Private拡張の比較後に解決する、対象選択を伴わないカード効果。
 *
 * この層は「どの効果が起動するか」と、固定上限の範囲で発行できる
 * カード実体IDを純粋に決める。手札やSocketの更新は game engine 側だけ
 * が行うため、クライアントは効果内容・追加札・総ラウンド数を決定できない。
 */
const {
  MAX_PRIVATE_CARD_INSTANCES,
  MAX_PRIVATE_HAND_SIZE,
  MAX_PRIVATE_ROUNDS
} = require('./private-ruleset');
const { isVirtualBlankCard } = require('./private-blank');

const GENERATION_TAROT_IDS = Object.freeze(['the-magician', 'the-lovers']);
const ROUND_LIMIT_TAROT_IDS = Object.freeze(['wheel-of-fortune']);

function opponentSeat(seat) {
  if (seat === 'p1') return 'p2';
  if (seat === 'p2') return 'p1';
  throw new RangeError('unknown private seat');
}

function assertSeat(value) {
  if (value !== 'p1' && value !== 'p2') throw new RangeError('unknown private seat');
  return value;
}

function assertCard(card) {
  if (!card || typeof card !== 'object' || typeof card.definitionId !== 'string') {
    throw new TypeError('private post-round effect requires a card definition');
  }
  return card;
}

function getPrivatePostRoundEffectRequests({ p1Card, p2Card, winnerSeat } = {}) {
  assertCard(p1Card);
  assertCard(p2Card);
  if (winnerSeat !== null && winnerSeat !== 'p1' && winnerSeat !== 'p2') {
    throw new RangeError('private post-round winner seat is invalid');
  }
  const requests = [];
  const played = [
    { seat: 'p1', card: p1Card, opponentCard: p2Card },
    { seat: 'p2', card: p2Card, opponentCard: p1Card }
  ];
  for (const { seat, card, opponentCard } of played) {
    if (card.definitionId === 'the-magician' && !isVirtualBlankCard(opponentCard)) {
      requests.push({
        type: 'add-cards',
        sourceSeat: seat,
        sourceDefinitionId: card.definitionId,
        recipientSeat: seat,
        definitionId: opponentCard.definitionId,
        requestedCopies: 2
      });
    }
    if (card.definitionId === 'the-lovers' && winnerSeat !== null) {
      const won = winnerSeat === seat;
      requests.push({
        type: 'add-cards',
        sourceSeat: seat,
        sourceDefinitionId: card.definitionId,
        recipientSeat: won ? seat : opponentSeat(seat),
        definitionId: won ? 'king' : 'queen',
        requestedCopies: 1
      });
    }
    if (card.definitionId === 'wheel-of-fortune' && winnerSeat !== null) {
      requests.push({
        type: 'round-limit-adjustment',
        sourceSeat: seat,
        sourceDefinitionId: card.definitionId,
        requestedDelta: winnerSeat === seat ? 1 : -1
      });
    }
  }
  return requests;
}

function assertRuntime(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('private post-round runtime is invalid');
  }
  if (typeof value.instanceNamespace !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(value.instanceNamespace)) {
    throw new RangeError('private post-round instance namespace is invalid');
  }
  if (!Number.isSafeInteger(value.round) || value.round < 1 || value.round > MAX_PRIVATE_ROUNDS) {
    throw new RangeError('private post-round round is invalid');
  }
  if (!Number.isSafeInteger(value.effectiveRoundLimit)
    || value.effectiveRoundLimit < value.round
    || value.effectiveRoundLimit > MAX_PRIVATE_ROUNDS) {
    throw new RangeError('private post-round effective round limit is invalid');
  }
  if (!Number.isSafeInteger(value.totalCardInstances)
    || value.totalCardInstances < 2
    || value.totalCardInstances > MAX_PRIVATE_CARD_INSTANCES) {
    throw new RangeError('private post-round total card count is invalid');
  }
  for (const seat of ['p1', 'p2']) {
    if (!Number.isSafeInteger(value.handCounts?.[seat])
      || value.handCounts[seat] < 0
      || value.handCounts[seat] > MAX_PRIVATE_HAND_SIZE
      || !Number.isSafeInteger(value.nextInstanceOrdinalBySeat?.[seat])
      || value.nextInstanceOrdinalBySeat[seat] < 1
      || value.nextInstanceOrdinalBySeat[seat] > 999_999) {
      throw new RangeError('private post-round card allocation is invalid');
    }
  }
  return value;
}

function materializePrivatePostRoundEffects({
  p1Card,
  p2Card,
  winnerSeat,
  instanceNamespace,
  round,
  effectiveRoundLimit,
  handCounts,
  totalCardInstances,
  nextInstanceOrdinalBySeat
} = {}) {
  const runtime = assertRuntime({
    instanceNamespace,
    round,
    effectiveRoundLimit,
    handCounts,
    totalCardInstances,
    nextInstanceOrdinalBySeat
  });
  const requests = getPrivatePostRoundEffectRequests({ p1Card, p2Card, winnerSeat });
  const nextHandCounts = { ...runtime.handCounts };
  const nextOrdinals = { ...runtime.nextInstanceOrdinalBySeat };
  const additions = [];
  const effects = [];
  let nextTotalCardInstances = runtime.totalCardInstances;
  let nextRoundLimit = runtime.effectiveRoundLimit;

  for (const request of requests) {
    if (request.type === 'add-cards') {
      const roomInHand = MAX_PRIVATE_HAND_SIZE - nextHandCounts[request.recipientSeat];
      const roomInGame = MAX_PRIVATE_CARD_INSTANCES - nextTotalCardInstances;
      const createdCopies = Math.max(0, Math.min(request.requestedCopies, roomInHand, roomInGame));
      const cardInstanceIds = [];
      for (let index = 0; index < createdCopies; index += 1) {
        const instanceId = `${runtime.instanceNamespace}:${request.recipientSeat}:${nextOrdinals[request.recipientSeat]}`;
        nextOrdinals[request.recipientSeat] += 1;
        cardInstanceIds.push(instanceId);
        additions.push({
          recipientSeat: request.recipientSeat,
          definitionId: request.definitionId,
          instanceId
        });
      }
      nextHandCounts[request.recipientSeat] += createdCopies;
      nextTotalCardInstances += createdCopies;
      effects.push({ ...request, cardInstanceIds });
    } else if (request.type === 'round-limit-adjustment') {
      const next = request.requestedDelta > 0
        ? Math.min(MAX_PRIVATE_ROUNDS, nextRoundLimit + 1)
        // A loss can end the game this round, but cannot retroactively make
        // already completed rounds invalid.
        : Math.max(runtime.round, nextRoundLimit - 1);
      effects.push({
        ...request,
        previousRoundLimit: nextRoundLimit,
        nextRoundLimit: next,
        appliedDelta: next - nextRoundLimit
      });
      nextRoundLimit = next;
    }
  }

  return {
    effects,
    additions,
    handCounts: nextHandCounts,
    totalCardInstances: nextTotalCardInstances,
    nextInstanceOrdinalBySeat: nextOrdinals,
    effectiveRoundLimit: nextRoundLimit
  };
}

module.exports = {
  GENERATION_TAROT_IDS,
  ROUND_LIMIT_TAROT_IDS,
  getPrivatePostRoundEffectRequests,
  materializePrivatePostRoundEffects,
  opponentSeat
};
