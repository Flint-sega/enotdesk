// Страница /invite: токен приглашения приходит только в #fragment (сервер его
// не видит) — читаем здесь и показываем форму принятия. Без токена остаётся
// посадка «откройте приложение». Токены сервера URL-safe, декодирование не нужно.
// С токеном советы «откройте приложение / скачайте» прячутся: форма — весь путь
// (в т.ч. в окне оператора desktop, ADR 0033), после успеха — кнопка «Войти».

const form = document.getElementById('invite-accept-form');
const okNote = document.getElementById('invite-ok');
const errBox = document.getElementById('invite-error');

function tokenFromHash() {
  const m = location.hash.match(/[#&]token=([^&]+)/);
  return m ? m[1] : '';
}

function init() {
  const token = tokenFromHash();
  if (!token) return; // посадка без токена — прежний лендинг
  document.getElementById('invite-accept').hidden = false;
  document.getElementById('invite-lead').hidden = true;
  document.getElementById('invite-lead-form').hidden = false;
  document.getElementById('invite-landing').hidden = true;
  const first = document.getElementById('invite-name');
  if (first) first.focus();
}

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  errBox.textContent = '';
  const body = {
    token: tokenFromHash(),
    login: document.getElementById('invite-login').value.trim(),
    name: document.getElementById('invite-name').value.trim(),
    password: document.getElementById('invite-password').value,
  };
  try {
    const res = await fetch('/api/v1/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) {
      const j = await res.json().catch(() => null);
      errBox.textContent = j?.error?.message ?? `HTTP ${res.status}`;
      return;
    }
    form.hidden = true;
    okNote.hidden = false; // атрибут, не класс .hidden (тот с !important глушил «Готово»)
  } catch (err) {
    errBox.textContent = String(err.message ?? err);
  }
});

init();
