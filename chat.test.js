'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHAT_MESSAGE_COOLDOWN_MS,
  MAX_CHAT_HISTORY,
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_CHAT_MESSAGES_PER_SESSION,
  appendChatMessage,
  sanitizeChatMessage
} = require('./chat');

function createRoom() {
  return { chat: [], chatSequence: 0, chatUsage: new Map() };
}

test('チャットは50文字以内の通常テキストだけを受け入れる', () => {
  assert.deepEqual(sanitizeChatMessage('  読み合いましょう  '), { ok: true, text: '読み合いましょう' });
  assert.equal(sanitizeChatMessage('あ'.repeat(MAX_CHAT_MESSAGE_LENGTH)).ok, true);
  assert.equal(sanitizeChatMessage('あ'.repeat(MAX_CHAT_MESSAGE_LENGTH + 1)).ok, false);
  assert.equal(sanitizeChatMessage('hello\nworld').ok, false);
  assert.equal(sanitizeChatMessage(' \t ').ok, false);
  assert.equal(sanitizeChatMessage('見え\u200Bない文字').ok, false);
  assert.equal(sanitizeChatMessage('右\u202E左').ok, false);
});

test('チャット送信はセッションごとに50回で止まり、短時間の連投を拒否する', () => {
  const room = createRoom();
  const first = appendChatMessage(room, { clientId: 'client-a', author: 'Player', text: 'hello', now: 1_000 });
  assert.equal(first.ok, true);
  assert.equal(appendChatMessage(room, { clientId: 'client-a', author: 'Player', text: 'again', now: 1_000 + CHAT_MESSAGE_COOLDOWN_MS - 1 }).ok, false);

  let now = 1_000 + CHAT_MESSAGE_COOLDOWN_MS;
  for (let index = 1; index < MAX_CHAT_MESSAGES_PER_SESSION; index += 1) {
    const result = appendChatMessage(room, { clientId: 'client-a', author: 'Player', text: `m${index}`, now });
    assert.equal(result.ok, true);
    now += CHAT_MESSAGE_COOLDOWN_MS;
  }
  assert.equal(appendChatMessage(room, { clientId: 'client-a', author: 'Player', text: 'over', now }).ok, false);
});

test('履歴は最新100件だけを保持する', () => {
  const room = createRoom();
  let now = 1_000;
  for (let index = 0; index < MAX_CHAT_HISTORY + 1; index += 1) {
    const result = appendChatMessage(room, { clientId: `client-${index}`, author: 'Player', text: `m${index}`, now });
    assert.equal(result.ok, true);
    now += CHAT_MESSAGE_COOLDOWN_MS;
  }
  assert.equal(room.chat.length, MAX_CHAT_HISTORY);
  assert.equal(room.chat[0].text, 'm1');
});
