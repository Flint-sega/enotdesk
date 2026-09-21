// Протокол канала 'term' БЕЗ node-импортов — безопасен для sandbox-рендерера.
// Выделено из client/lib/term.mjs: там статический import 'node:child_process',
// а в sandbox-рендерере (contextIsolation+sandbox, CSP script-src 'self')
// загрузка node:-скрипта блокируется CSP и роняет ВЕСЬ модульный граф
// (регресс v0.2.0: «кнопки не нажимаются» — ни один слушатель не повешен).
// Рендереру от term-шва нужно только это: честный отказ каналу.

// Честный отказ каналу 'term' от host'а без терминала (attended-человек):
// оболочку поднимает только machine-агент (spec R09).
export function rejectTermChannel(ch, code = 'term-unavailable') {
  try { ch.send(JSON.stringify({ type: 'error', code })); } catch { /* канал умирает */ }
  const bye = () => { try { ch.close(); } catch { /* уже закрыт */ } };
  // даём ошибке уйти до закрытия: кадры DataChannel уходят асинхронно
  if (typeof setTimeout === 'function') setTimeout(bye, 100);
  else bye();
}
