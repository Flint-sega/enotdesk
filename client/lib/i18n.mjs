// i18n без библиотек (spec §i18n): словари, выбор языка, фолбэк en.
// Один модуль для рендерера (Electron) и серверных страниц (Node) — без DOM и fs.
import ru from '../locales/ru.json' with { type: 'json' };
import en from '../locales/en.json' with { type: 'json' };

const DICTS = { ru, en };
let locale = 'ru'; // до initLocale совпадает с языком статического index.html

export function setLocale(next) {
  if (DICTS[next]) locale = next;
  return locale;
}

export function getLocale() {
  return locale;
}

// Локаль при старте: сохранённый выбор сильнее системной; неизвестная — фолбэк en.
export function initLocale(saved) {
  if (typeof saved === 'string' && DICTS[saved]) return setLocale(saved);
  let sys = '';
  try { sys = String(navigator?.language ?? '').slice(0, 2).toLowerCase(); } catch { /* не браузер */ }
  return setLocale(DICTS[sys] ? sys : 'en');
}

// Сервер: Accept-Language → 'ru' | 'en' (первый поддерживаемый тег).
// Нет заголовка или только неизвестные языки — дефолт ru (исторический язык продукта).
export function pickLocale(acceptLanguage) {
  const header = String(acceptLanguage ?? '').trim();
  if (!header) return 'ru';
  for (const part of header.split(',')) {
    const base = part.trim().split(';')[0].trim().toLowerCase().split('-')[0];
    if (base === 'ru' || base === 'en') return base;
  }
  return 'ru';
}

// t('key', {name: '…'}, locale?): подстановка {именованных} плейсхолдеров.
// Явный третий аргумент — для серверных страниц (свой язык на каждый запрос).
export function t(key, vars = {}, loc = locale) {
  let s = DICTS[loc]?.[key] ?? DICTS.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
