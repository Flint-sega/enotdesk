// Адресная книга оператора: поиск, CRUD с revision-конфликтом, выбор клиента.

import { $, enot, text, show, hide, setBusy, fetchList } from '../dom.js';
import { state } from '../state.js';

export async function renderContacts() {
  const box = $('contacts-list');
  box.textContent = '';
  text($('contacts-status'), 'Загрузка…');
  try {
    const body = await fetchList('contacts.list', { q: state.query.contacts || undefined, limit: 20, offset: state.pages.contacts * 20 });
    box.textContent = '';
    if (!body.items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = state.query.contacts
        ? 'Ничего не найдено. Измените запрос.'
        : 'Книга пуста. Нажмите «Добавить», чтобы создать первый контакт.';
      box.appendChild(empty);
    }
    for (const c of body.items) box.appendChild(contactItem(c));
    text($('contacts-page'), `Стр. ${state.pages.contacts + 1}, всего ${body.total}`);
    $('contacts-prev').disabled = state.pages.contacts === 0;
    $('contacts-next').disabled = (state.pages.contacts + 1) * 20 >= body.total;
    text($('contacts-status'), '');
  } catch (e) {
    text($('contacts-status'), '');
    const err = document.createElement('p');
    err.className = 'err-text';
    err.textContent = e.message;
    box.appendChild(err);
  }
}

function contactItem(c) {
  const item = document.createElement('div');
  item.className = 'list-item';
  const main = document.createElement('div');
  main.className = 'grow';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = c.name;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = c.notes ? c.notes.slice(0, 120) : '';
  main.append(title, sub);
  item.appendChild(main);
  for (const t of (c.tags ?? []).slice(0, 10)) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = t;
    item.appendChild(tag);
  }
  const edit = document.createElement('button');
  edit.className = 'btn small';
  edit.textContent = 'Изменить';
  edit.addEventListener('click', () => openContactEditor(c));
  const del = document.createElement('button');
  del.className = 'btn small danger-ghost';
  del.textContent = 'Удалить';
  del.addEventListener('click', async () => {
    if (!window.confirm(`Удалить контакт «${c.name}»?`)) return; // явное подтверждение удаления
    const res = await enot.request('contacts.delete', { id: c.id, revision: c.revision });
    if (res.status !== 200) text($('contacts-status'), res.body?.error?.message ?? 'Не удалось удалить');
    else renderContacts();
  });
  item.append(edit, del);
  return item;
}

let editingContact = null;
function openContactEditor(c) {
  editingContact = c ?? null;
  text($('contact-editor-title'), c ? 'Изменить контакт' : 'Новый контакт');
  $('contact-name').value = c?.name ?? '';
  $('contact-notes').value = c?.notes ?? '';
  $('contact-tags').value = (c?.tags ?? []).join(', ');
  text($('contact-error'), '');
  show($('contact-editor'));
  $('contact-name').focus();
}
$('btn-contact-add').addEventListener('click', () => openContactEditor(null));
$('btn-contact-cancel').addEventListener('click', () => hide($('contact-editor')));

$('form-contact').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-contact-save');
  setBusy(btn, true, 'Сохраняем…');
  text($('contact-error'), '');
  const name = $('contact-name').value.trim();
  if (!name || name.length > 120) { text($('contact-error'), 'Имя обязательно (1–120 символов)'); setBusy(btn, false); return; }
  const tags = $('contact-tags').value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10);
  const base = { name, notes: $('contact-notes').value, tags };
  const res = editingContact
    ? await enot.request('contacts.update', { id: editingContact.id, ...base, revision: editingContact.revision })
    : await enot.request('contacts.create', base);
  setBusy(btn, false);
  if (res.status === 409) {
    text($('contact-error'), 'Контакт изменён кем-то другим. Проверьте актуальную версию и повторите.');
    renderContacts();
    return;
  }
  if (res.status !== 200 && res.status !== 201) {
    text($('contact-error'), res.body?.error?.message ?? 'Не удалось сохранить');
    return;
  }
  hide($('contact-editor'));
  renderContacts();
});

$('form-contact-search').addEventListener('submit', (e) => {
  e.preventDefault();
  state.query.contacts = $('contact-search').value.trim();
  state.pages.contacts = 0;
  renderContacts();
});
$('contacts-prev').addEventListener('click', () => { state.pages.contacts = Math.max(0, state.pages.contacts - 1); renderContacts(); });
$('contacts-next').addEventListener('click', () => { state.pages.contacts += 1; renderContacts(); });

export async function loadContactsIntoSelect() {
  const sel = $('conn-contact');
  sel.textContent = '';
  const opt0 = document.createElement('option');
  opt0.value = ''; opt0.textContent = '—';
  sel.appendChild(opt0);
  try {
    const body = await fetchList('contacts.list', { limit: 100 });
    for (const c of body.items) {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      sel.appendChild(o);
    }
  } catch { /* пустой список выбора — не критично */ }
}
