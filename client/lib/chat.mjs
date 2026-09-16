// Протокол чата поверх DataChannel (ADR 0014): только текст, жёсткий потолок.
// Чистый модуль без DOM и сети — используется рендерером обеих сторон и тестами.

export const CHAT_MAX = 2000;

// Входящее сообщение чата: сырая строка DC → {text} | null (мусор молча отбрасывается).
export function parseChatMessage(raw) {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return null; }
  if (!msg || msg.type !== 'chat' || typeof msg.text !== 'string') return null;
  const text = msg.text;
  if (text.length === 0 || text.length > CHAT_MAX) return null;
  return { text };
}

export function chatMessage(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > CHAT_MAX) return null;
  return JSON.stringify({ type: 'chat', text });
}
