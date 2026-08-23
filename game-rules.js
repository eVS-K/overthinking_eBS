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

function resolveRound(firstCard, secondCard) {
  if (firstCard.id === 'two' && secondCard.id === 'ace') return 'p1';
  if (secondCard.id === 'two' && firstCard.id === 'ace') return 'p2';
  if (firstCard.id === 'three' && secondCard.id === 'joker') return 'p1';
  if (secondCard.id === 'three' && firstCard.id === 'joker') return 'p2';

  const firstStrength = firstCard.id === 'joker'
    ? (secondCard.id === 'joker' ? 0 : secondCard.strength)
    : firstCard.strength;
  const secondStrength = secondCard.id === 'joker'
    ? (firstCard.id === 'joker' ? 0 : firstCard.strength)
    : secondCard.strength;

  if (firstStrength > secondStrength) return 'p1';
  if (secondStrength > firstStrength) return 'p2';
  return 'draw';
}

module.exports = { CARD_DEFINITIONS, createInitialHand, resolveRound };
