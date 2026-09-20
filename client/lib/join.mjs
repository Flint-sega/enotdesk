// One-click (R04, spec §One-click): разбор ссылки enotdesk://join?server=<url>&t=<token>
// и репорт {sessionId,password} на hub по одноразовому URL. Модуль чистый от
// Electron: работает и в тестах. hostToken наружу не уходит никогда — репорт
// несёт строго sessionId и password.

import { normalizeServerUrl } from './server-url.mjs';

// Токен hub-а: безопасный алфавит и разумная длина (что генерирует hub/join.mjs).
export const JOIN_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

// Валидна только схема enotdesk: с узлом join; адрес сервера проходит
// normalizeServerUrl({allowInsecureHttp:true}) — loopback http допустим, https
// всегда. Всё остальное — null: чужая строка никогда не становится действием
// клиента (никаких throw — просто «не join-ссылка»).
export function parseJoinLink(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'enotdesk:' || parsed.host !== 'join') return null;
  const serverRaw = parsed.searchParams.get('server');
  const token = parsed.searchParams.get('t');
  if (typeof serverRaw !== 'string' || serverRaw.trim() === '') return null;
  if (typeof token !== 'string' || !JOIN_TOKEN_RE.test(token)) return null;
  const server = normalizeServerUrl(serverRaw, { allowInsecureHttp: true });
  if (!server.ok) return null;
  return { server: server.url, token };
}

// Соглашение (spec §One-click): hub монтируется на том же домене, что и сервер
// из ссылки (Caddy) — репорт уходит на тот же origin, путь /api/hub/join/:t/report.
// Невалидные входные — throw: вызывающий покажет честный статус.
export function reportJoinUrl(server, token) {
  const norm = normalizeServerUrl(server, { allowInsecureHttp: true });
  if (!norm.ok) throw new Error('Некорректный адрес сервера');
  if (typeof token !== 'string' || !JOIN_TOKEN_RE.test(token)) throw new Error('Некорректный токен join');
  return `${norm.url}/api/hub/join/${token}/report`;
}

// Репорт одноразового join-токена. Сетевую ошибку не глотаем — решает вызывающий
// (UI показывает честный статус, сеанс не роняем). fetchImpl — шов для тестов.
export async function reportJoin(server, token, { sessionId, password } = {}, fetchImpl = fetch) {
  const url = reportJoinUrl(server, token);
  if (typeof sessionId !== 'string' || !sessionId || typeof password !== 'string' || !password) {
    throw new Error('Некорректные данные сеанса для репорта');
  }
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Строго два поля: hostToken остаётся в main-процессе клиента (interfaces.md).
    body: JSON.stringify({ sessionId, password }),
  });
  return { ok: res.ok === true, status: res.status };
}
