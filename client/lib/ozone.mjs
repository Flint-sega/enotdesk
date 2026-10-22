// Выбор ozone-платформы Electron на Linux — чистая функция без Electron.
//
// Клиент на Linux идёт через X11 (Xwayland на Wayland-сессиях): без явного
// флага Electron 44 падает при старте на Wayland (лаба 05.10). Агент-служба
// (EDESK_AGENT=1) на машине без графического сеанса (сервер, NAS, служба без
// DISPLAY) с x11 падает сразу — «Missing X server or $DISPLAY» (лаба 22.10).
// Ему нужен headless: регистрация, heartbeat, терминал, сообщения и файлы
// работают, а видео и ввод честно сообщают о недоступности.

export function linuxOzonePlatform({ agent = false, env = {} } = {}) {
  const hasDisplay = Boolean(env.DISPLAY) || Boolean(env.WAYLAND_DISPLAY);
  if (agent && !hasDisplay) return 'headless';
  return 'x11';
}
