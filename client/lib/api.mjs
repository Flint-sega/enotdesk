// HTTP-клиент main-процесса. Токены (authToken после login, hostToken после
// session.create) живут только здесь, в main; наружу рендереру ответы проходят
// через sanitizeForRenderer — токены вырезаются (interfaces.md: Desktop bridge).

const OPERATIONS = {
  health: { method: 'GET', path: '/health' },
  login: { method: 'POST', path: '/auth/login' },
  logout: { method: 'POST', path: '/auth/logout', auth: 'bearer' },
  'password.change': { method: 'PATCH', path: '/auth/password', auth: 'bearer' },
  me: { method: 'GET', path: '/auth/me', auth: 'bearer' },
  'session.create': { method: 'POST', path: '/sessions' },
  'session.claim': { method: 'POST', path: (p) => `/sessions/${p.sessionId}/claim`, auth: 'bearer' },
  'session.decision': { method: 'POST', path: (p) => `/sessions/${p.sessionId}/decision`, auth: 'host' },
  'session.end': { method: 'POST', path: (p) => `/sessions/${p.sessionId}/end`, auth: 'any' },
  'rtc.config': { method: 'GET', path: '/rtc-config', auth: 'any' },
  'members.list': { method: 'GET', path: '/members', auth: 'bearer' },
  'members.patch': { method: 'PATCH', path: (p) => `/members/${p.id}`, auth: 'bearer' },
  'members.delete': { method: 'DELETE', path: (p) => `/members/${p.id}`, auth: 'bearer' },
  'invites.list': { method: 'GET', path: '/invites', auth: 'bearer' },
  'invites.create': { method: 'POST', path: '/invites', auth: 'bearer' },
  'invites.revoke': { method: 'DELETE', path: (p) => `/invites/${p.id}`, auth: 'bearer' },
  'invite.accept': { method: 'POST', path: '/invites/accept' },
  'contacts.list': { method: 'GET', path: '/contacts', auth: 'bearer' },
  'contacts.create': { method: 'POST', path: '/contacts', auth: 'bearer' },
  'contacts.update': { method: 'PATCH', path: (p) => `/contacts/${p.id}`, auth: 'bearer' },
  'contacts.delete': { method: 'DELETE', path: (p) => `/contacts/${p.id}`, auth: 'bearer' },
  'history.list': { method: 'GET', path: '/history', auth: 'bearer' },
  'audit.list': { method: 'GET', path: '/audit', auth: 'bearer' },
  downloads: { method: 'GET', path: '/downloads' },
};

const TOKEN_KEYS = new Set(['hostToken']);

// hostToken вырезается на любой глубине; верхнеуровневый token (приглашение)
// сохраняется — только им оператор делится вручную.
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

export function createApi({ baseUrl, fetchImpl = fetch } = {}) {
  let authToken = null; // оператор/админ: после login
  let hostToken = null; // клиент помощи: после session.create
  let hostSessionId = null;

  return {
    get hostToken() { return hostToken; },
    get hostSessionId() { return hostSessionId; },
    get authToken() { return authToken; },

    clearSessionTokens() { hostToken = null; hostSessionId = null; },
    clearAuth() { authToken = null; },

    async request(operation, payload = {}) {
      const op = OPERATIONS[operation];
      if (!op) throw new Error(`Неизвестная операция: ${operation}`);
      const path = typeof op.path === 'function' ? op.path(payload) : op.path;
      let token = null;
      if (op.auth === 'bearer') token = payload.token ?? authToken;
      else if (op.auth === 'host') token = hostToken;
      else if (op.auth === 'any') token = payload.asHost ? hostToken : (payload.token ?? authToken);

      const { token: _t, asHost: _a, sessionId: _s, id: _i, ...body } = payload;
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
      if (operation === 'login' && res.status === 200) authToken = json?.token ?? null;
      if (operation === 'logout' && res.status === 200) authToken = null;
      if (operation === 'session.create' && res.status === 201) {
        hostToken = json?.hostToken ?? null;
        hostSessionId = json?.sessionId ?? null;
      }
      if (operation === 'session.end' && res.status === 200) {
        hostToken = null;
        hostSessionId = null;
      }
      return sanitizeForRenderer(result, { keepTopLevelToken: operation === 'invites.create' });
    },
  };
}
