// Linux: ярлык приложения (.desktop), чтобы EnotDesk запускался из меню
// приложений как обычная программа (находка 10.10: после установки агентского
// дерева на ВМ ярлыка не было — запуск был возможен только из терминала).
// AppImage-обновление заменяет файл по тому же пути — запись остаётся валидной;
// при смене пути Exec перезаписывается. Файловые операции и xdg-mime инъекцией —
// тесты идут без реальной ФС, вызов не критичен для приложения.

import fs from 'node:fs';
import path from 'node:path';

export const DESKTOP_ID = 'enotdesk.desktop';
// Спецификация freedesktop: обработчик протокола enotdesk:// (join-ссылки)
export const DESKTOP_MIME = 'x-scheme-handler/enotdesk';

export function buildDesktopEntry({ execPath, iconPath = null, comment = 'EnotDesk' }) {
  // Спецификация Desktop Entry (Exec): литеральный % в аргументе удваивается,
  // " и \ экранируются обратным слэшем; аргумент с пробелом берётся в кавычки
  // (ревью 10.10: путь AppImage, выбранный пользователем, может содержать % —
  // без удвоения запись ломалась или парсилась с лишним токеном).
  const raw = String(execPath).replace(/%/g, '%%').replace(/(["\\])/g, '\\$1');
  const exec = /[ \t]/.test(raw) ? `"${raw}"` : raw;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=EnotDesk',
    `Comment=${comment}`,
    `Exec=${exec}`,
    `Icon=${iconPath ?? 'EnotDesk'}`,
    'Terminal=false',
    'Categories=Network;Utility;',
    'StartupWMClass=EnotDesk',
    `MimeType=${DESKTOP_MIME}`,
    '',
  ].join('\n');
}

const defaultIo = {
  exists: (p) => fs.existsSync(p),
  mkdir: (p, opts) => fs.mkdirSync(p, opts),
  readFile: (p, enc) => fs.readFileSync(p, enc),
  writeFile: (p, data) => fs.writeFileSync(p, data),
  copyFile: (src, dst) => fs.copyFileSync(src, dst),
};

export function applyDesktopEntry({ home, execPath, iconSource = null, comment = 'EnotDesk', runXdgMime = null }, io = defaultIo) {
  const applicationsDir = path.join(home, '.local', 'share', 'applications');
  const entryFile = path.join(applicationsDir, DESKTOP_ID);
  let iconPath = null;
  if (iconSource && io.exists(iconSource)) {
    const iconDir = path.join(home, '.local', 'share', 'icons');
    io.mkdir(iconDir, { recursive: true });
    iconPath = path.join(iconDir, 'enotdesk.png');
    io.copyFile(iconSource, iconPath);
  }
  const entry = buildDesktopEntry({ execPath, iconPath, comment });
  let unchanged = false;
  try { unchanged = io.readFile(entryFile, 'utf8') === entry; } catch { /* нет записи — создадим */ }
  if (!unchanged) {
    io.mkdir(applicationsDir, { recursive: true });
    io.writeFile(entryFile, entry);
    if (runXdgMime) {
      try { runXdgMime('default', DESKTOP_ID, DESKTOP_MIME); } catch { /* не критично */ }
    }
  }
  return { entryFile, iconPath, changed: !unchanged };
}
