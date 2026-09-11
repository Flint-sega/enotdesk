const session = document.querySelector('#session');
const id = document.querySelector('#session-id');
const pass = document.querySelector('#session-pass');
// Архивный макет: настоящих ID/паролей здесь нет и не будет — только npm start.
document.querySelector('#support').onclick = () => { id.textContent = 'архивный макет'; pass.textContent = 'отключено'; session.classList.remove('hidden'); session.scrollIntoView({behavior:'smooth'}); };
document.querySelector('#finish').onclick = () => { session.classList.add('hidden'); id.textContent = pass.textContent = '—'; };
document.querySelector('#copy').onclick = async () => { await navigator.clipboard.writeText('Это архивный макет EnotDesk, а не приложение. Настоящее приложение: npm start'); document.querySelector('#copy').textContent = 'Скопировано'; setTimeout(() => document.querySelector('#copy').textContent = 'Копировать',1500); };
