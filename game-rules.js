/**
 * OVERTHINKING のカード定義と勝敗判定。
 *
 * 画面・通信の実装から切り離すことで、ゲームルールを変更せずに
 * サーバー側で一貫して検証できるようにする。
 */
const CARD_DEFINITIONS = Object.freeze([
  { id: 'ace', name: 'Ace', strength: 14, desc: '能力なし' },
  { id: 'king', name: 'King', strength: 13, desc: '能力なし' },
  { id: 'queen', name: 'Queen', strength: 12, desc: '能力なし' },
  { id: 'jack', name: 'Jack', strength: 11, desc: '能力なし' },
  { id: 'joker', name: 'Joker', strength: 0, desc: '相手の強さをコピー' },
  { id: 'three', name: 'Three', strength: 3, desc: 'Jokerに勝利' },
  { id: 'two', name: 'Two', strength: 2, desc: 'Aceに勝利' }
]);

function createInitialHand() {
  return CARD_DEFINITIONS.map((card) => ({ ...card }));
}

function resolveRoundDetails(firstCard, secondCard) {
  const rawFirstStrength = firstCard.strength;
  const rawSecondStrength = secondCard.strength;
  if (firstCard.id === 'two' && secondCard.id === 'ace') {
    return { winner: 'p1', p1Strength: rawFirstStrength, p2Strength: rawSecondStrength, comparison: 'two-beats-ace' };
  }
  if (secondCard.id === 'two' && firstCard.id === 'ace') {
    return { winner: 'p2', p1Strength: rawFirstStrength, p2Strength: rawSecondStrength, comparison: 'two-beats-ace' };
  }
  if (firstCard.id === 'three' && secondCard.id === 'joker') {
    return { winner: 'p1', p1Strength: rawFirstStrength, p2Strength: rawSecondStrength, comparison: 'three-beats-joker' };
  }
  if (secondCard.id === 'three' && firstCard.id === 'joker') {
    return { winner: 'p2', p1Strength: rawFirstStrength, p2Strength: rawSecondStrength, comparison: 'three-beats-joker' };
  }

  const firstStrength = firstCard.id === 'joker'
    ? (secondCard.id === 'joker' ? 0 : secondCard.strength)
    : firstCard.strength;
  const secondStrength = secondCard.id === 'joker'
    ? (firstCard.id === 'joker' ? 0 : firstCard.strength)
    : secondCard.strength;

  const comparison = firstCard.id === 'joker' || secondCard.id === 'joker'
    ? 'joker-copies'
    : firstStrength === secondStrength
      ? 'equal-strength'
      : 'strength-compare';
  const winner = firstStrength > secondStrength ? 'p1' : secondStrength > firstStrength ? 'p2' : 'draw';
  return { winner, p1Strength: firstStrength, p2Strength: secondStrength, comparison };
}

function resolveRound(firstCard, secondCard) {
  return resolveRoundDetails(firstCard, secondCard).winner;
}

module.exports = { CARD_DEFINITIONS, createInitialHand, resolveRound, resolveRoundDetails };
