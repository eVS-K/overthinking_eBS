'use strict';

/**
 * Recipient-specific, read-only projection of an expanded Private game.
 *
 * `privateGameState` remains server-owned.  In particular The Star's noise
 * card must be redacted before a Socket payload is created; CSS hiding would
 * still leak its definition and ability through the transport.
 */
const { getPrivateCardRoundPreview } = require('./private-card-effects');
const { publicPrivateCard } = require('./private-card-instances');
const { getPrivateCardDefinition } = require('./private-card-definitions');
const { publicVirtualBlankCard } = require('./private-blank');
const { isCardLocked, isNoiseCard } = require('./private-game-engine');
const { publicPrivatePendingAction } = require('./private-action-queue');

function isSeat(value) {
  return value === 'p1' || value === 'p2';
}

function publicCardState(card, { owner = false } = {}) {
  return {
    locked: isCardLocked(card),
    ...(owner && isNoiseCard(card) ? { ownerOnlyNoise: true } : {})
  };
}

function publicExpandedCardForViewer(card, {
  state = null,
  ownerSeat = '',
  viewerSeat = null,
  includeRoundPreview = true
} = {}) {
  if (card?.virtual === true) {
    return {
      ...publicVirtualBlankCard(),
      category: 'blank',
      faceLabel: 'Blank',
      visualRole: 'blank',
      state: { locked: false },
      ...(state && isSeat(ownerSeat) && includeRoundPreview ? {
        roundInfo: { strength: 0, detail: '', conditional: false }
      } : {})
    };
  }
  const owner = viewerSeat === ownerSeat;
  if (isNoiseCard(card) && !owner) {
    return {
      id: card.instanceId,
      name: 'Noise',
      desc: '正体は、この札が出されたときに公開されます。',
      category: 'noise',
      displayMark: '?',
      faceLabel: 'Noise',
      visualRole: 'noise',
      state: publicCardState(card)
    };
  }
  const publicCard = publicPrivateCard(card);
  const preview = state && isSeat(ownerSeat) && includeRoundPreview
    ? getPrivateCardRoundPreview(state, ownerSeat, card)
    : null;
  return {
    id: publicCard.instanceId,
    definitionId: publicCard.definitionId,
    name: publicCard.name,
    desc: publicCard.desc,
    category: preview?.category || publicCard.category || '',
    displayMark: publicCard.displayMark || '',
    faceLabel: publicCard.faceLabel || publicCard.name,
    visualRole: publicCard.visualRole || '',
    generated: publicCard.generated === true,
    state: publicCardState(card, { owner }),
    ...(preview ? {
      roundInfo: {
        strength: preview.displayStrength,
        detail: preview.conditionDetail,
        conditional: preview.isConditional
      }
    } : {})
  };
}

function findCandidateCard(state, seat, candidateId) {
  if (!state || !isSeat(seat) || typeof candidateId !== 'string') return null;
  return state[seat]?.hand?.find((card) => card.instanceId === candidateId)
    || state[seat]?.wonPile?.find((card) => card.instanceId === candidateId)
    || null;
}

function publicCandidate(card, context) {
  return publicExpandedCardForViewer(card, { ...context, includeRoundPreview: false });
}

function publicDefinitionCandidate(definitionId) {
  const definition = getPrivateCardDefinition(definitionId);
  return {
    id: definition.id,
    definitionId: definition.id,
    name: definition.name,
    desc: definition.desc,
    category: definition.category,
    displayMark: definition.displayMark || '',
    faceLabel: definition.faceLabel || definition.name,
    visualRole: definition.visualRole || '',
    state: { locked: false }
  };
}

function getPendingActionTargetSurface(type) {
  if (type === 'opponent-choose-copy' || type === 'opponent-choose-noise') return 'addition';
  if (type === 'transfer-won-card') return 'won-pile';
  return 'hand';
}

function actionInstruction(type) {
  const messages = {
    'copy-opponent-hand': '相手の公開札を1枚選び、そのコピーを自分の手札へ加えます。',
    'copy-own-hand': '自分の手札を1枚選び、そのコピーを加えます。',
    'lock-one': '相手の札を1枚選び、次の相手ラウンドの終了までロックします。',
    'opponent-choose-copy': '自分の手札へ追加したい札を1枚選びます。',
    'opponent-choose-noise': '自分の手札へ追加したい札を1枚選びます。相手にはノイズとして見えます。',
    'transfer-won-card': '相手の過去の獲得札を1枚選び、その札を自分の手札へ複製します。',
    'sun-destroy': '自分の手札から、破壊する札を1枚選びます。'
  };
  return messages[type] || '能力の対象を1つ選んでください。';
}

function publicPrivatePendingActionForViewer(pending, state, viewerSeat) {
  // Sun chooses its destruction target before its card is committed.  Even a
  // generic "an ability is choosing" notice would reveal that a player has
  // selected Sun while the opponent is still deciding their own card, so the
  // pre-commit operation is completely private to its actor.
  if (pending?.phase === 'pre-commit' && viewerSeat !== pending?.action?.actorSeat) return null;
  const actionView = publicPrivatePendingAction(pending, viewerSeat);
  if (!actionView?.active || viewerSeat !== pending?.action?.actorSeat) return actionView;
  const candidates = actionView.candidates.map((candidateId) => {
    if (pending.action.type === 'opponent-choose-copy' || pending.action.type === 'opponent-choose-noise') {
      return publicDefinitionCandidate(candidateId);
    }
    const card = findCandidateCard(state, pending.action.targetSeat, candidateId);
    // The engine queue is based on a frozen, server-generated candidate list.
    // A vanished card is never silently exposed or selectable on reconnect.
    return card
      ? publicCandidate(card, { state, ownerSeat: pending.action.targetSeat, viewerSeat })
      : {
        id: candidateId,
        name: '対象なし',
        desc: 'この対象は既に使えません。',
        category: 'unavailable',
        displayMark: '—',
        faceLabel: '—',
        visualRole: 'unavailable',
        state: { locked: true }
      };
  });
  const { candidates: candidateIds, ...safeActionView } = actionView;
  return {
    ...safeActionView,
    instruction: actionInstruction(actionView.type),
    target: Object.freeze({
      surface: getPendingActionTargetSurface(actionView.type),
      seat: pending.action.targetSeat,
      candidateIds: Object.freeze([...candidateIds]),
      cards: Object.freeze(candidates.map((candidate) => Object.freeze({ ...candidate })))
    })
  };
}

module.exports = {
  getPendingActionTargetSurface,
  publicExpandedCardForViewer,
  publicPrivatePendingActionForViewer
};
