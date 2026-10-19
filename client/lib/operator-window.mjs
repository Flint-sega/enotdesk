// Окно оператора в desktop (ADR 0033, этап 2): чистая логика без Electron.
// Desktop показывает браузерную программу оператора с сервера (<сервер>/operator)
// в отдельном закалённом окне; здесь — адреса, допуск навигации и проверка,
// что сервер уже отдаёт новую страницу (иначе честное «обновите сервер»).

// Уровень страницы /operator, который понимает этот клиент. Сервер объявляет
// свой уровень в /api/v1/health (поле operatorUi). Номер версии сервера для
// этого не годится: package.json в деплое может отставать от тега релиза.
export const OPERATOR_UI_LEVEL = 1;

const HEALTH_TIMEOUT_MS = 5000;

function originOf(serverUrl) {
  try {
    const u = new URL(serverUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch { return null; }
}

// Адреса окна: страница оператора и страница приглашения (deep-link
// enotdesk://invite#token=… ведёт сюда же, форма принятия живёт на сервере).
export function operatorWindowUrls(serverUrl) {
  const origin = originOf(serverUrl);
  if (!origin) return null;
  return {
    origin,
    operator: `${origin}/operator`,
    invite: (token) => `${origin}/invite#token=${encodeURIComponent(String(token))}`,
    health: `${origin}/api/v1/health`,
  };
}

// Навигация окна — только внутри origin сервера (переходы между /operator,
// /invite, /downloads). Всё остальное окно не открывает.
export function isAllowedNavigation(url, origin) {
  if (typeof url !== 'string' || !origin) return false;
  try { return new URL(url).origin === origin; } catch { return false; }
}

// Вердикт по ответу /api/v1/health. reason — код без локализации:
// server-unreachable (нет ответа / не наш сервер), server-outdated (старая
// страница оператора; version — что сообщил сервер, для текста пользователю).
export function evaluateHealth(status, body) {
  if (status !== 200 || !body || typeof body !== 'object' || body.ok !== true) {
    return { ok: false, reason: 'server-unreachable' };
  }
  const version = typeof body.version === 'string' ? body.version.slice(0, 40) : null;
  const level = Number.isInteger(body.operatorUi) ? body.operatorUi : 0;
  if (level < OPERATOR_UI_LEVEL) return { ok: false, reason: 'server-outdated', version };
  return { ok: true, version };
}

// Проба сервера перед открытием окна. fetchImpl — инъекцией (тесты без сети).
export async function probeOperatorServer(serverUrl, fetchImpl = fetch, timeoutMs = HEALTH_TIMEOUT_MS) {
  const urls = operatorWindowUrls(serverUrl);
  if (!urls) return { ok: false, reason: 'server-unreachable' };
  let res;
  try {
    res = await fetchImpl(urls.health, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch {
    return { ok: false, reason: 'server-unreachable' };
  }
  let body = null;
  try { body = await res.json(); } catch { /* не JSON — не наш сервер */ }
  return evaluateHealth(res.status, body);
}

// «Запомнить меня» — только для https или loopback: страницу, пришедшую по
// открытому HTTP с внешнего адреса (галочка «Разрешить HTTP»), может подменить
// посредник — такой странице сохранённый пароль не отдаём и не берём.
export function rememberAllowed(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

// Отправитель IPC моста «запомнить меня»: только главный фрейм окна оператора
// и только со страницы сервера (не со стороннего адреса, куда окно не пускаем,
// и не из iframe).
export function isTrustedOperatorFrame({ isOperatorWindow, isMainFrame, frameUrl, origin }) {
  return isOperatorWindow === true && isMainFrame === true && isAllowedNavigation(frameUrl, origin);
}
