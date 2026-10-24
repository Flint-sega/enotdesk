// Куда регистрировать ссылку enotdesk:// на Windows — чистая функция без Electron.
//
// Портативная сборка (electron-builder portable) на каждый старт распаковывается
// во временную папку и удаляет её при выходе. Регистрация по process.execPath
// указывала на эту копию — после выхода портатива ссылки вели на исчезнувший exe,
// даже если рядом стоит установленная версия (живая проверка A-10, ВМ 102, 24.10).
// Портатив регистрирует установленную версию, если она есть (стабильный путь,
// один экземпляр на профиль передаст ссылку уже запущенному окну), иначе — сам
// файл портатива (PORTABLE_EXECUTABLE_FILE). null — оставить process.execPath.

export function protocolTarget({ platform, env = {}, exists = () => false } = {}) {
  if (platform !== 'win32') return null;
  const portable = env.PORTABLE_EXECUTABLE_FILE;
  if (!portable) return null;
  const root = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files';
  const installed = `${root}\\EnotDesk\\EnotDesk.exe`;
  return exists(installed) ? installed : portable;
}
