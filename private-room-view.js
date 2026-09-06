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
  const cardView = publicExpandedCardForViewer(card, { ...context, includeRoundPreview: false });
  return {
    id: cardView.id,
    label: cardView.displayMark ? `${cardView.displayMark} ${cardView.name}` : cardView.name,
    description: cardView.desc,
    category: cardView.category,
    ...(cardView.definitionId ? { definitionId: cardView.definitionId } : {})
  };
}

function publicDefinitionCandidate(definitionId) {
  const definition = getPrivateCardDefinition(definitionId);
  return {
    id: definition.id,
    label: definition.displayMark ? `${definition.displayMark} ${definition.name}` : definition.name,
    description: definition.desc,
    category: definition.category,
    definitionId: definition.id
  };
}

function actionInstruction(type) {
  const messages = {
    'copy-opponent-hand': '相手の公開札を1枚選び、そのコピーを自分の手札へ加えます。',
    'copy-own-hand': '自分の手札を1枚選び、そのコピーを加えます。',
    'lock-one': '相手の札を1枚選び、次の相手ラウンドの終了までロックします。',
    'opponent-choose-copy': '自分の手札へ追加したい札を1枚選びます。',
    'opponent-choose-noise': '自分の手札へ追加したい札を1枚選びます。相手にはノイズとして見えます。',
    'transfer-won-card': '相手の過去の獲得札を1枚選び、そのコピーを自分の手札へ加えます。'
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
      : { id: candidateId, label: '対象なし', description: 'この対象は既に使えません。', category: 'unavailable' };
  });
  return {
    ...actionView,
    instruction: actionInstruction(actionView.type),
    candidates
  };
}

module.exports = {
  publicExpandedCardForViewer,
  publicPrivatePendingActionForViewer
};
