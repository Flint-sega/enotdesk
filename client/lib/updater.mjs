// Решение об обновлении клиента (релизы GitHub, истории 33-34) — чистые функции
// без Electron: шов для юнит-тестов. Фид — generic-провайдер electron-updater:
// latest-mac.yml / latest.yml / latest-linux.yml в каталоге
// https://github.com/<owner>/<repo>/releases/latest/download/ ; эти файлы рядом
// с артефактами и checksums-sha256.txt собирает .github/workflows/release.yml.
// Сравнение версий — тот же numerical a.b.c, что у страницы /downloads (version-check).

import { isNewerVersion } from './version-check.mjs';

// Репозиторий релизов (константа продукта, не настройка сервера: фид живёт на GitHub).
export const UPDATE_REPO = Object.freeze({ owner: 'Flint-sega', repo: 'enotdesk' });

export function updateFeedUrl(repo = UPDATE_REPO) {
  const owner = String(repo?.owner ?? '').trim();
  const name = String(repo?.repo ?? '').trim();
  if (!owner || !name) return null;
  return `https://github.com/${owner}/${name}/releases/latest/download/`;
}

// Имя файла фида, которое electron-updater запрашивает на каждой платформе.
export function platformFeedName(platform = process.platform) {
  if (platform === 'darwin') return 'latest-mac.yml';
  if (platform === 'linux') return 'latest-linux.yml';
  if (platform === 'win32') return 'latest.yml';
  return null;
}

// Разбор минимального подмножества latest*.yml, которое пишет electron-builder:
// строка `version: X.Y.Z` и список `files: [- url: …]`. Всё остальное (sha512,
// path, releaseDate) парсеру решения не нужен. Мусор/пусто → null: честный отказ,
// а не «обновлений нет».
function parseLatestFeed(text) {
  const m = String(text ?? '').match(/version:\s*["']?(\d+\.\d+\.\d+)["']?\s*$/m);
  if (!m) return null;
  const files = [...String(text ?? '').matchAll(/^\s*-\s*url:\s*(\S+)\s*$/gm)].map((x) => x[1]);
  return { version: m[1], files };
}

// Единственное решение таска: нет разбираемого фида или текущая версия неизвестна —
// «обновления нет»; фид строго новее текущей — «обновиться».
export function updateDecision({ current, feedText }) {
  const feed = parseLatestFeed(feedText);
  if (!feed) return { update: false, version: null, files: [] };
  return {
    update: Boolean(current) && isNewerVersion(current, feed.version),
    version: feed.version,
    files: feed.files,
  };
}

// Политика установки (SEC-010): mac/linux умеют автоустановку при выходе, но
// включается она только после явного подтверждения человеком (dialog-баннер в
// main); по умолчанию — только уведомление. Windows-сборка v1 — portable .exe,
// самообновление такой формат не поддерживает: только уведомление со ссылкой
// на релизы. askConfirm — показать ли диалог подтверждения на update-downloaded.
export function updateInstallDecision({ platform = process.platform, confirmed = false } = {}) {
  if (platform === 'win32') {
    return { autoDownload: false, autoInstallOnAppQuit: false, askConfirm: false };
  }
  return {
    autoDownload: true,
    autoInstallOnAppQuit: confirmed === true,
    askConfirm: confirmed !== true,
  };
}
