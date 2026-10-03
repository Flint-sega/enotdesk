// Чат-виджет клиента: маленькое окно в углу (spec владельца, 02.10).
// Весь транспорт — через main: window.chatWidget.* (preload ниже) ↔ IPC.
// Содержимое: DOM-лог + свернуть/развернуть + непрочитанные.

const log = document.getElementById('wg-log');
const body = document.getElementById('wg-body');
const unread = document.getElementById('wg-unread');
const input = document.getElementById('wg-input');

function append(kind, text) {
  const line = document.createElement('p');
  line.className = `wg-line wg-${kind}`;
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function setCollapsed(collapsed) {
  body.classList.toggle('hidden', collapsed);
  // Непрочитанные копятся только в свёрнутом виде (lib/chat-widget.mjs) —
  // бейдж живёт именно там (спека: «полоска с непрочитанными»); раньше
  // условие было перевёрнуто и прятало счётчик ровно в этом состоянии.
  const count = +unread.dataset.count > 0 ? +unread.dataset.count : 0;
  unread.classList.toggle('hidden', !(collapsed && count > 0));
  unread.textContent = count ? String(count) : '';
  document.getElementById('wg-toggle').textContent = collapsed ? '▢' : '—';
}

window.chatWidget.onState((s) => {
  unread.dataset.count = String(s.unread ?? 0);
  setCollapsed(s.collapsed);
});

window.chatWidget.onMessage(({ who, text }) => append(who, text));

function send() {
  const value = input.value.trim();
  if (!value) return;
  window.chatWidget.send(value);
  input.value = '';
}

document.getElementById('wg-send').addEventListener('click', send);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
document.getElementById('wg-toggle').addEventListener('click', () => window.chatWidget.toggle());
document.getElementById('wg-close').addEventListener('click', () => window.chatWidget.close());
