'use strict';

const MAX_CHAT_MESSAGE_LENGTH = 50;
const MAX_CHAT_MESSAGES_PER_SESSION = 50;
const MAX_CHAT_HISTORY = 100;
const CHAT_MESSAGE_COOLDOWN_MS = 800;

function countCharacters(value) {
  return Array.from(value).length;
}

function sanitizeChatMessage(value) {
  if (typeof value !== 'string') return { ok: false, error: 'メッセージを入力してください。' };
  if (/[\r\n]/.test(value)) return { ok: false, error: '改行を含むメッセージは送信できません。' };
  if (/[\u0000-\u001F\u007F-\u009F]/.test(value)) return { ok: false, error: '使用できない文字が含まれています。' };
  if (/\p{Cf}/u.test(value)) return { ok: false, error: '見えない制御文字を含むメッセージは送信できません。' };

  const text = value.trim();
  if (!text) return { ok: false, error: 'メッセージを入力してください。' };
  if (countCharacters(text) > MAX_CHAT_MESSAGE_LENGTH) {
    return { ok: false, error: `メッセージは${MAX_CHAT_MESSAGE_LENGTH}文字以内です。` };
  }
  return { ok: true, text };
}

function appendChatMessage(room, { clientId, author, text, now = Date.now() }) {
  const sanitized = sanitizeChatMessage(text);
  if (!sanitized.ok) return sanitized;

  const usage = room.chatUsage.get(clientId) || { count: 0, lastSentAt: 0, lastSeenAt: now };
  if (usage.count >= MAX_CHAT_MESSAGES_PER_SESSION) {
    return { ok: false, error: `この参加セッションで送信できるのは${MAX_CHAT_MESSAGES_PER_SESSION}回までです。` };
  }
  if (usage.lastSentAt && now - usage.lastSentAt < CHAT_MESSAGE_COOLDOWN_MS) {
    return { ok: false, error: '送信間隔が短すぎます。少し待ってから送信してください。' };
  }

  usage.count += 1;
  usage.lastSentAt = now;
  usage.lastSeenAt = now;
  room.chatUsage.set(clientId, usage);

  room.chatSequence += 1;
  const message = {
    id: `${now}-${room.chatSequence}`,
    // Server-internal only. It lets each recipient know whether a message is
    // theirs (for the quiet incoming-chat cue) without exposing a client id.
    authorClientId: clientId,
    author,
    text: sanitized.text,
    sentAt: now
  };
  room.chat.push(message);
  if (room.chat.length > MAX_CHAT_HISTORY) room.chat.splice(0, room.chat.length - MAX_CHAT_HISTORY);

  return {
    ok: true,
    message,
    sent: usage.count,
    limit: MAX_CHAT_MESSAGES_PER_SESSION
  };
}

module.exports = {
  CHAT_MESSAGE_COOLDOWN_MS,
  MAX_CHAT_HISTORY,
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_CHAT_MESSAGES_PER_SESSION,
  appendChatMessage,
  countCharacters,
  sanitizeChatMessage
};
