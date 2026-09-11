// Разбор вставленного текста с данными доступа клиента ЕнотDesk (ID + пароль).
// Чистая функция без DOM и сети. Формат и алфавит — server/crypto.mjs.

const PASS_CHARS = '[A-HJ-NP-Za-kmnp-z2-9]'; // ALPHABET без 0O1lI| (и строчной o)
const PASS_TOKEN = new RegExp(`(?<![\\p{L}\\d])${PASS_CHARS}{8}(?![\\p{L}\\d])`, 'u');
const PASS_TOKEN_ALL = new RegExp(PASS_TOKEN.source, 'gu');
const ID_LABEL = /(?<![\p{L}\d])(?:идентификатор|ид|id)(?![\p{L}\d])\s*[:№#*]*\s*/iu;
const PASS_LABEL = /(?<![\p{L}\d])(?:пароль|password)(?![\p{L}\d])\s*[:№#*]*\s*/iu;

const normalizeId = (raw) => raw.replace(/\D/g, '');

function findId(text) {
  const label = ID_LABEL.exec(text);
  if (label) {
    const rest = text.slice(label.index + label[0].length);
    const num = /^[^\d\p{L}]*(\d+(?:[ \t\-–—]*\d+)*)/u.exec(rest);
    if (num && normalizeId(num[1]).length === 9) {
      const start = label.index + label[0].length + num[0].length - num[1].length;
      return { value: normalizeId(num[1]), start, end: start + num[1].length };
    }
  }
  const plain = /(?<!\d)(\d{9})(?!\d)/.exec(text);
  if (plain) return { value: plain[1], start: plain.index, end: plain.index + 9 };
  // без метки: «985 375 066» и «985-375-066» теми же 3-3-3 группами
  const grouped = /(?<![\d\-–—])(?<!\d[ \t\-–—])(\d{3}([ \t])\d{3}\2\d{3})(?![\d\-–—])/.exec(text);
  if (grouped) {
    return { value: normalizeId(grouped[1]), start: grouped.index, end: grouped.index + grouped[1].length };
  }
  return null;
}

function findPassword(text, id) {
  const label = PASS_LABEL.exec(text);
  if (label) {
    const m = PASS_TOKEN.exec(text.slice(label.index + label[0].length));
    if (m) return m[0];
  }
  for (const m of text.matchAll(PASS_TOKEN_ALL)) {
    if (id && m.index < id.end && m.index + m[0].length > id.start) continue; // не внутри ID
    return m[0];
  }
  return null;
}

export function parseCredentials(text) {
  const src = typeof text === 'string' ? text : '';
  const id = findId(src);
  const password = findPassword(src, id);
  if (!id && !password) return null;
  const out = {};
  if (id) out.sessionId = id.value;
  if (password) out.password = password;
  return out;
}
