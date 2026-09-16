// Протокол синхронизации текстового буфера обмена поверх DataChannel (ADR 0014).
// Обе стороны явно включают синхронизацию в UI; модуль только валидирует полезную нагрузку.

export const CLIP_MAX = 100 * 1024; // символов

export function parseClipMessage(raw) {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return null; }
  if (!msg || msg.type !== 'clip' || typeof msg.text !== 'string') return null;
  if (msg.text.length === 0 || msg.text.length > CLIP_MAX) return null;
  return { text: msg.text };
}

export function clipMessage(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > CLIP_MAX) return null;
  return JSON.stringify({ type: 'clip', text });
}
