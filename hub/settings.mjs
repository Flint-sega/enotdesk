// Настройки хаба (T03): сейчас — виджет (allowlist origins, consent-гейт,
// ссылка на политику). Ключ 'widget' — одна строка в hub_settings с JSON.
// Ничего секретного здесь нет (origins/ссылка не тайна), но мусор не проходит:
// hostname — строгий regex, policyUrl — только http(s).

export const WIDGET_SETTINGS_LIMITS = { origins: 20, origin: 253, policyUrl: 500 };

// hostname (минимум одна точка) с необязательным портом; дефисы не по краям
// меток; только lowercase после санитизации. Порт 1..65535 без ведущих нулей —
// допускаем любые цифры, порт > 65535 отвергается отдельной проверкой.
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:[0-9]{1,5})?$/;

// 'https://Site.example:8443/path' → 'site.example:8443' | null
export function sanitizeOriginHost(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!s) return null;
  let host;
  try { host = new URL(s.includes('://') ? s : `https://${s}`).host; } catch { return null; }
  if (!HOST_RE.test(host)) return null;
  const port = Number.parseInt(host.slice(host.indexOf(':') + 1), 10);
  if (host.includes(':') && (port < 1 || port > 65535)) return null;
  return host;
}

export function sanitizePolicyUrl(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') return null;
  const s = value.trim().slice(0, WIDGET_SETTINGS_LIMITS.policyUrl);
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return s;
  } catch { return null; }
}

// raw → null (мусор) | {origins:[host...], consentRequired:bool, policyUrl:string}
export function sanitizeWidgetSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let origins = [];
  if (raw.origins !== undefined) {
    if (!Array.isArray(raw.origins) || raw.origins.length > WIDGET_SETTINGS_LIMITS.origins) return null;
    for (const o of raw.origins) {
      const host = sanitizeOriginHost(o);
      if (!host) return null;
      if (!origins.includes(host)) origins.push(host);
    }
  }
  const consentRequired = raw.consentRequired === undefined ? false : raw.consentRequired === true;
  const policyUrl = sanitizePolicyUrl(raw.policyUrl);
  if (policyUrl === null) return null;
  return { origins, consentRequired, policyUrl };
}

export const DEFAULT_WIDGET_SETTINGS = { origins: [], consentRequired: false, policyUrl: '' };

export function createSettingsStore(db, { nowMs = Date.now } = {}) {
  const KEY = 'widget';

  function getWidget() {
    const row = db.prepare('SELECT value FROM hub_settings WHERE key = ?').get(KEY);
    if (!row) return { ...DEFAULT_WIDGET_SETTINGS };
    try {
      const parsed = sanitizeWidgetSettings(JSON.parse(row.value));
      return parsed ?? { ...DEFAULT_WIDGET_SETTINGS };
    } catch { return { ...DEFAULT_WIDGET_SETTINGS }; }
  }

  // Слитченный патч (передаётся полный объект) → 'invalid' | сохранённые настройки.
  function setWidget(next) {
    const clean = sanitizeWidgetSettings(next);
    if (!clean) return 'invalid';
    db.prepare(`
      INSERT INTO hub_settings (key, value, updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(KEY, JSON.stringify(clean), new Date(nowMs()).toISOString());
    return clean;
  }

  return { getWidget, setWidget };
}
