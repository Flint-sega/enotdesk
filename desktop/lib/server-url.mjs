// Нормализация адреса сервера: чистая функция, без побочных эффектов.
// Внешний HTTP запрещён по умолчанию — требуется явный dev override allowInsecureHttp.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function normalizeServerUrl(raw, { allowInsecureHttp = false } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'empty' };
  const trimmed = raw.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'invalid' };
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname) && !allowInsecureHttp) {
    return { ok: false, reason: 'https-required' };
  }
  return { ok: true, url: trimmed.replace(/\/$/, '') };
}
