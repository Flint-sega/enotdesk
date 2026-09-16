// Сравнение версий сборок по имени файла на сервере /downloads.
// 'EnotDesk-0.2.1-win-x64.zip' → '0.2.1'; всё лишнее (арки, мусор) игнорируется.

const VER_RE = /(\d+)\.(\d+)\.(\d+)/;

export function parseVersionFromFilename(name) {
  const m = String(name ?? '').match(VER_RE);
  if (!m) return null;
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
}

// true, только если latest строго новее current (числовое сравнение a.b.c).
export function isNewerVersion(current, latest) {
  const a = String(current ?? '').match(VER_RE);
  const b = String(latest ?? '').match(VER_RE);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (x !== y) return y > x;
  }
  return false;
}

// Самая свежая версия среди имён файлов; пусто/мусор → null.
export function latestVersionFrom(names) {
  let latest = null;
  for (const name of names ?? []) {
    const v = parseVersionFromFilename(name);
    if (v && (!latest || isNewerVersion(latest, v))) latest = v;
  }
  return latest;
}
