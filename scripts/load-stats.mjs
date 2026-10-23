// Статистика нагрузочного прогона (scripts/load-test.mjs) — чистые функции без сети.

// Перцентиль по отсортированному массиву (метод «ближайший ранг»): p95 из 20
// значений — 19-е, а не интерполяция между соседями.
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

// Копилка замеров по классам запросов: время (мс) и ошибки отдельно.
export function createRecorder() {
  const times = new Map();
  const errors = new Map();
  return {
    time(cls, ms) {
      if (!times.has(cls)) times.set(cls, []);
      times.get(cls).push(ms);
    },
    error(cls, what) {
      if (!errors.has(cls)) errors.set(cls, []);
      const list = errors.get(cls);
      if (list.length < 20) list.push(String(what).slice(0, 160)); // образцы, не весь поток
      list.count = (list.count ?? 0) + 1;
    },
    summary() {
      const out = {};
      for (const cls of new Set([...times.keys(), ...errors.keys()])) {
        const sorted = [...(times.get(cls) ?? [])].sort((a, b) => a - b);
        const round = (v) => (v == null ? null : Math.round(v * 10) / 10);
        out[cls] = {
          count: sorted.length,
          p50: round(percentile(sorted, 50)),
          p95: round(percentile(sorted, 95)),
          p99: round(percentile(sorted, 99)),
          max: round(sorted.at(-1) ?? null),
          errors: errors.get(cls)?.count ?? 0,
          errorSamples: errors.get(cls) ? [...errors.get(cls)] : [],
        };
      }
      return out;
    },
  };
}

// Запросы с хешированием пароля (scrypt, намеренно медленный — защита от
// подбора): вход и приём приглашения. Бывают на подготовке, не в потоке агентов,
// — у них свой порог.
export const PASSWORD_HASH_CLASSES = ['auth.login', 'invites.accept'];

// Вердикт: каждый класс API укладывается в p95 (классы с паролем — в свой
// порог), ошибок нет, все сеансы согласованы, все агенты онлайн к концу прогона.
export function verdict({ api, ws, sessions, agents, p95Ms, slowP95Ms = p95Ms }) {
  const failures = [];
  for (const [cls, s] of Object.entries(api)) {
    const limit = PASSWORD_HASH_CLASSES.includes(cls) ? slowP95Ms : p95Ms;
    if (s.p95 != null && s.p95 > limit) failures.push(`${cls}: p95 ${s.p95} мс > ${limit} мс`);
    if (s.errors) failures.push(`${cls}: ошибок ${s.errors}`);
  }
  for (const [cls, s] of Object.entries(ws)) {
    if (s.errors) failures.push(`ws ${cls}: ошибок ${s.errors}`);
  }
  if (sessions.approved !== sessions.planned) failures.push(`сеансов согласовано ${sessions.approved} из ${sessions.planned}`);
  if (agents.onlineAtEnd !== agents.planned) failures.push(`агентов онлайн к концу ${agents.onlineAtEnd} из ${agents.planned}`);
  return { ok: failures.length === 0, failures };
}
