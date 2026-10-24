// Deep-link приглашения: enotdesk://invite#token=<токен приглашения>.
// Возвращает {token} или null (не приглашение/пустой токен). Регистрация схемы
// уже сделана в main для 'enotdesk' — invite-ссылки едут в тот же обработчик.
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function parseInviteLink(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'enotdesk:' || parsed.host !== 'invite') return null;
  const m = /[#&]token=([^&]+)/.exec(parsed.hash);
  const token = m ? m[1] : '';
  // токен сервера — base64url (43 символа); остальное в адрес страницы /invite не пускаем,
  // как у join (ревью безопасности 1.13, 24.10)
  if (!INVITE_TOKEN_RE.test(token)) return null;
  return { token };
}
