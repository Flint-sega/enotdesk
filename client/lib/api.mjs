// HTTP-клиент main-процесса для клиента помощи. hostToken (после session.create)
// живёт только здесь, в main; наружу рендереру ответы проходят через
// sanitizeForRenderer — токены вырезаются (interfaces.md: Desktop bridge).

// Только операции клиента помощи и экрана настроек: операторские запросы
// (вход, claim, команда, контакты, журналы, 2FA) живут в программе оператора с
// сервера (ADR 0033, этап 3) — рендерер main не может сделать их через этот мост.
const OPERATIONS = {
  health: { method: 'GET', path: '/health' },
  'session.create': { method: 'POST', path: '/sessions' },
  'session.decision': { method: 'POST', path: (p) => `/sessions/${p.sessionId}/decision`, auth: 'host' },
  'session.end': { method: 'POST', path: (p) => `/sessions/${p.sessionId}/end`, auth: 'host' },
  'rtc.config': { method: 'GET', path: '/rtc-config', auth: 'host' },
  downloads: { method: 'GET', path: '/downloads' },
};

const TOKEN_KEYS = new Set(['hostToken']);

// hostToken вырезается на любой глубине, верхнеуровневый token — тоже.
export function sanitizeForRenderer(result, { keepTopLevelToken = false } = {}) {
  if (!result || typeof result !== 'object' || !result.body || typeof result.body !== 'object') return result;
  const strip = (obj) => {
    for (const k of Object.keys(obj)) {
      if (TOKEN_KEYS.has(k)) delete obj[k];
      else if (obj[k] && typeof obj[k] === 'object') strip(obj[k]);
    }
  };
  strip(result.body);
  if (!keepTopLevelToken && 'token' in result.body) delete result.body.token;
  return result;
}

function buildUrl(base, path, query) {
  const url = new URL(base.replace(/\/$/, '') + '/api/v1' + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url;
}

export function createApi({ baseUrl, fetchImpl = fetch, hostCredentials = null } = {}) {
  let hostToken = null; // клиент помощи: после session.create
  let hostSessionId = null;

  return {
    get hostToken() { return hostToken; },
    get hostSessionId() { return hostSessionId; },

    clearSessionTokens() { hostToken = null; hostSessionId = null; },

    async request(operation, payload = {}) {
      const op = OPERATIONS[operation];
      if (!op) throw new Error(`Неизвестная операция: ${operation}`);
      const path = typeof op.path === 'function' ? op.path(payload) : op.path;
      const token = op.auth === 'host' ? hostToken : null;

      const { token: _t, asHost: _a, sessionId: _s, id: _i, ...body } = payload;
      // Закреплённый ID ПК + пароль запуска (просьба владельца, приёмка 02.10):
      // подставляются в main, рендерер их не знает и не передаёт.
      if (operation === 'session.create' && typeof hostCredentials === 'function') {
        Object.assign(body, hostCredentials());
      }
      const hasBody = op.method !== 'GET';
      const query = op.method === 'GET' ? payload : undefined;

      let res;
      try {
        res = await fetchImpl(buildUrl(baseUrl, path, query), {
          method: op.method,
          headers: {
            ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: hasBody ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        throw new Error(`Сервер недоступен: ${e?.cause?.code ?? e.message}`, { cause: e });
      }

      let json = null;
      try { json = await res.json(); } catch { /* не-JSON ответ (страница) — тело null */ }
      const result = { status: res.status, body: json };

      // Токены оседают в main, к рендереру не уходят.
      if (operation === 'session.create' && res.status === 201) {
        hostToken = json?.hostToken ?? null;
        hostSessionId = json?.sessionId ?? null;
      }
      if (operation === 'session.end' && res.status === 200) {
        hostToken = null;
        hostSessionId = null;
      }
      return sanitizeForRenderer(result);
    },
  };
}
