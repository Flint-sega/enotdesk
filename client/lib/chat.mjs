// Протокол чата поверх DataChannel (ADR 0014): только текст, жёсткий потолок.
// Чистый модуль без DOM и сети — используется рендерером обеих сторон и тестами.

export const CHAT_MAX = 2000;

// G2 (волна G, 16.10): метаданные автора в сообщении чата. Хост-фан-аут
// подписывает релей сообщений операторов ({from:'operator', name}) и свои
// исходящие ({from:'host'}); получатели рисуют подпись по from. Неизвестные
// поля парсер НЕ отвергает — клиенты ≤0.6.20 просто не показывают автора,
// сообщение доходит (обратная совместимость без границы версий).
export const CHAT_FROM = new Set(['operator', 'host']);
export const CHAT_NAME_MAX = 120;

function chatMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const out = {};
  if (CHAT_FROM.has(meta.from)) out.from = meta.from;
  if (typeof meta.name === 'string' && meta.name.length > 0 && meta.name.length <= CHAT_NAME_MAX) {
    out.name = meta.name;
  }
  return Object.keys(out).length ? out : null;
}

// Входящее сообщение чата: сырая строка DC → {text, from?, name?} | null
// (мусор молча отбрасывается; мусорные from/name отбрасываются полями).
export function parseChatMessage(raw) {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return null; }
  if (!msg || msg.type !== 'chat' || typeof msg.text !== 'string') return null;
  const text = msg.text;
  if (text.length === 0 || text.length > CHAT_MAX) return null;
  const meta = chatMeta(msg);
  return meta ? { text, ...meta } : { text };
}

// meta: {from?: 'operator'|'host', name?: string} — поля проходят тот же
// allowlist, что и приём: оператор не может подписаться «хостом» сам (метку
// ставит только хост-фан-аут), а мусор в полях не уходит в провод.
export function chatMessage(text, meta) {
  if (typeof text !== 'string' || text.length === 0 || text.length > CHAT_MAX) return null;
  const extra = chatMeta(meta);
  return JSON.stringify(extra ? { type: 'chat', text, ...extra } : { type: 'chat', text });
}
