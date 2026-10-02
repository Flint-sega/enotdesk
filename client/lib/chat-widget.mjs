// Чистая логика чат-виджета клиента (решения показ/сворачивание/уведомление)
// без DOM и Electron — юнит-тесты. Само окно создаёт main (BrowserWidget).

// Решение по входящему сообщению: показать ли уведомление ОС.
// Уведомляем только когда виджет свёрнут (collapsed) — в развёрнутом сообщении
// и так видно; троттл — не чаще minMs между уведомлениями (шум глушим).
export function shouldNotify({ collapsed, lastNotifiedAt = 0, nowMs, minMs = 3000 }) {
  if (!collapsed) return false;
  if (typeof nowMs !== 'number' || nowMs - lastNotifiedAt < minMs) return false;
  return true;
}

// Новое состояние после входящего сообщения: виджет показывается (spec владельца:
// «когда оператор пишет — оно появляется и остаётся»), счётчик непрочитанных
// растёт только в свёрнутом виде.
export function onIncoming(prev = { visible: false, collapsed: true, unread: 0 }) {
  const visible = true;
  const collapsed = prev.collapsed === true;
  const unread = collapsed ? (prev.unread ?? 0) + 1 : 0;
  return { visible, collapsed, unread };
}

// Пользователь свернул виджет: полоска остаётся, счётчик сохраняется.
export function onCollapse(prev = { unread: 0 }) {
  return { visible: true, collapsed: true, unread: prev.unread ?? 0 };
}

// Пользователь развернул: непрочитанные обнуляются.
export function onExpand() {
  return { visible: true, collapsed: false, unread: 0 };
}
