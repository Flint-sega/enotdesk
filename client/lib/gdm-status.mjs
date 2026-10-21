// Статус видео machine-сеанса на Linux (ADR 0031): кадры даёт мост через
// getDisplayMedia, а не Windows-хелпер. Оператору уходит реальное состояние
// захвата моста — раньше main отвечал «video-unsupported-platform» на любой
// старт, и панель показывала «видео недоступно» поверх живой картинки.
// null — состояние неизвестно (мост ещё грузится): статус не отправляется.
export function gdmVideoStatus(gdm) {
  if (gdm?.state === 'running') return { state: 'running' };
  if (gdm?.state === 'unavailable') return { state: 'error', reason: 'video-capture-unavailable' };
  return null;
}
