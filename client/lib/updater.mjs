// Решение об обновлении клиента (релизы GitHub, истории 33-34) — чистые функции
// без Electron: шов для юнит-тестов. Фид — generic-провайдер electron-updater:
// latest.yml / latest-linux.yml (latest-mac.yml — только для будущей подписанной сборки) в каталоге
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

// Фид только для уведомления «вышла версия X» (без установки). Неподписанная
// mac-сборка самообновиться не может: Squirrel.Mac отвергает неподписанное
// приложение, а прежние 0.6.x скачивали обновление, закрывались «на установку»
// и запускались снова старой версией (журнал 21.10.2026). Поэтому релизы больше
// не прикладывают latest-mac.yml (у установленных 0.6.x петля прекращается сама),
// а mac узнаёт версию из latest.yml — версия у всех платформ релиза одна.
// macSelfUpdate=true — будущая подписанная сборка; тогда её фид должен получить
// новое имя (канал electron-updater), чтобы старые неподписанные клиенты его не видели.
export function notifyFeedName(platform = process.platform, { macSelfUpdate = false } = {}) {
  if (platform === 'darwin' && macSelfUpdate !== true) return 'latest.yml';
  return platformFeedName(platform);
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

// Политика установки (SEC-010): автоустановка при выходе включается только
// после явного подтверждения человеком (dialog-баннер в main); по умолчанию —
// только уведомление. Windows portable .exe самообновление не поддерживает
// (запущенный самораспаковщик нельзя заменить) — только уведомление со
// ссылкой на релизы; установленная сборка (NSIS в Program Files) обновляется
// как mac/linux — electron-updater поднимает установщик при выходе
// (ADR 0029). winInstalled решает вызывающий (main: отсутствие
// PORTABLE_EXECUTABLE_FILE у упакованного win32-exe). askConfirm — показать
// ли диалог подтверждения на update-downloaded.
// macSelfUpdate — mac-сборка подписана и умеет ставить обновление сама; без
// этого mac, как портативный .exe, получает только уведомление (см. notifyFeedName).
export function updateInstallDecision({ platform = process.platform, confirmed = false, winInstalled = false, macSelfUpdate = false } = {}) {
  if ((platform === 'win32' && !winInstalled) || (platform === 'darwin' && macSelfUpdate !== true)) {
    return { autoDownload: false, autoInstallOnAppQuit: false, askConfirm: false };
  }
  return {
    autoDownload: true,
    autoInstallOnAppQuit: confirmed === true,
    askConfirm: confirmed !== true,
  };
}
