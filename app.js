const session = document.querySelector('#session');
const id = document.querySelector('#session-id');
const pass = document.querySelector('#session-pass');
const make = (length) => Array.from(crypto.getRandomValues(new Uint8Array(length)), n => (n % 10)).join('');
document.querySelector('#support').onclick = () => { id.textContent = make(9).replace(/(\d{3})(?=\d)/g,'$1 '); pass.textContent = make(6); session.classList.remove('hidden'); session.scrollIntoView({behavior:'smooth'}); };
document.querySelector('#finish').onclick = () => { session.classList.add('hidden'); id.textContent = pass.textContent = '—'; };
document.querySelector('#copy').onclick = async () => { await navigator.clipboard.writeText(`ID: ${id.textContent}\nПароль: ${pass.textContent}`); document.querySelector('#copy').textContent = 'Скопировано'; setTimeout(() => document.querySelector('#copy').textContent = 'Копировать',1500); };
