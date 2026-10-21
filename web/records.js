// Веб-UI записей оператора (B6, этап 1, ADR 0033): адресная книга, история
// сеансов, журнал действий, экспорт в CSV, выбор контакта при подключении.
// Перенесено из прежнего desktop-оператора (удалён на этапе 3); права — как у сервера:
// контакты — admin/operator, история — любой вошедший, журнал — admin/auditor.
// Модуль изолирован, как team.js: api/t/showOnly/getLocale приходят параметрами.
// DOM строится через textContent — пользовательские строки не попадают в HTML.

import { toCsv } from '../client/lib/csv.mjs';

const PAGE = 20;
const CSV_LIMIT = 1000;

export function bindRecords({ api, t, getLocale, showOnly, $, getRole = () => null }) {
  const pages = { contacts: 0, history: 0, audit: 0 };
  let contactsQuery = '';
  let editing = null; // контакт в редакторе (null — новый)

  async function list(path, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
    const res = await api('GET', `${path}?${qs}`);
    if (res.status !== 200) throw new Error(res.body?.error?.message ?? t('common.httpError', { status: res.status }));
    return res.body;
  }

  function el(tag, cls, textValue) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (textValue !== undefined) n.textContent = textValue;
    return n;
  }

  // Элементы разделов — литеральными id: контракт-тест страницы находит их грепом.
  const ui = {
    contacts: { list: $('contacts-list'), status: $('contacts-status'), page: $('contacts-page'), prev: $('contacts-prev'), next: $('contacts-next') },
    history: { list: $('history-list'), status: $('history-status'), page: $('history-page'), prev: $('history-prev'), next: $('history-next') },
    audit: { list: $('audit-list'), status: $('audit-status'), page: $('audit-page'), prev: $('audit-prev'), next: $('audit-next') },
  };

  function pager(kind, total) {
    ui[kind].page.textContent = t('common.pageOf', { page: pages[kind] + 1, total });
    ui[kind].prev.disabled = pages[kind] === 0;
    ui[kind].next.disabled = (pages[kind] + 1) * PAGE >= total;
  }

  // ---- адресная книга ----
  async function renderContacts() {
    const box = ui.contacts.list;
    box.textContent = '';
    ui.contacts.status.textContent = t('common.loading');
    try {
      const body = await list('/contacts', { q: contactsQuery || undefined, limit: PAGE, offset: pages.contacts * PAGE });
      if (!body.items.length) box.appendChild(el('p', 'note', contactsQuery ? t('contacts.emptyQuery') : t('contacts.empty')));
      for (const c of body.items) box.appendChild(contactRow(c));
      pager('contacts', body.total);
      ui.contacts.status.textContent = '';
    } catch (e) {
      ui.contacts.status.textContent = e.message;
    }
  }

  function contactRow(c) {
    const row = el('div', 'record-row');
    const main = el('div', 'record-main');
    main.append(el('strong', '', c.name), el('div', 'muted', c.notes ? c.notes.slice(0, 120) : ''));
    row.appendChild(main);
    for (const tag of (c.tags ?? []).slice(0, 10)) row.appendChild(el('span', 'tag', tag));
    const edit = el('button', 'btn ghost', t('common.edit'));
    edit.type = 'button';
    edit.dataset.act = 'edit';
    edit.addEventListener('click', () => openEditor(c));
    const del = el('button', 'btn danger ghost', t('common.delete'));
    del.type = 'button';
    del.dataset.act = 'delete';
    del.addEventListener('click', async () => {
      if (!window.confirm(t('contacts.deleteConfirm', { name: c.name }))) return; // явное подтверждение удаления
      const res = await api('DELETE', `/contacts/${encodeURIComponent(c.id)}`, { revision: c.revision });
      if (res.status !== 200) ui.contacts.status.textContent = res.body?.error?.message ?? t('contacts.deleteFail');
      else void renderContacts();
    });
    row.append(edit, del);
    return row;
  }

  function openEditor(c) {
    editing = c ?? null;
    $('contact-editor-title').textContent = c ? t('contacts.editTitle') : t('contacts.newTitle');
    $('contact-name').value = c?.name ?? '';
    $('contact-notes').value = c?.notes ?? '';
    $('contact-tags').value = (c?.tags ?? []).join(', ');
    $('contact-error').textContent = '';
    $('contact-editor').classList.remove('hidden');
    $('contact-name').focus();
  }

  async function saveContact() {
    const name = $('contact-name').value.trim();
    if (!name || name.length > 120) { $('contact-error').textContent = t('contacts.nameRequired'); return; }
    const tags = $('contact-tags').value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10);
    const base = { name, notes: $('contact-notes').value, tags };
    const res = editing
      ? await api('PATCH', `/contacts/${encodeURIComponent(editing.id)}`, { ...base, revision: editing.revision })
      : await api('POST', '/contacts', base);
    if (res.status === 409) { $('contact-error').textContent = t('contacts.conflict'); void renderContacts(); return; }
    if (res.status !== 200 && res.status !== 201) { $('contact-error').textContent = res.body?.error?.message ?? t('contacts.saveFail'); return; }
    $('contact-editor').classList.add('hidden');
    void renderContacts();
  }

  // ---- история и журнал ----
  async function renderTimeList(kind, path, emptyKey, format) {
    const box = ui[kind].list;
    ui[kind].status.textContent = t('common.loading');
    try {
      const body = await list(path, { limit: PAGE, offset: pages[kind] * PAGE });
      box.textContent = '';
      if (!body.items.length) box.appendChild(el('p', 'note', t(emptyKey)));
      for (const it of body.items) {
        const row = el('div', 'record-row');
        const main = el('div', 'record-main');
        main.append(el('strong', '', format.title(it)), el('div', 'muted', format.sub(it)));
        row.appendChild(main);
        box.appendChild(row);
      }
      pager(kind, body.total);
      ui[kind].status.textContent = '';
    } catch (e) {
      ui[kind].status.textContent = e.message;
    }
  }

  const when = (iso) => new Date(iso).toLocaleString(getLocale());
  const renderHistory = () => renderTimeList('history', '/history', 'history.empty', {
    title: (it) => t('history.item', { id: it.id, state: it.state }),
    sub: (it) => t('history.sub', { operator: it.operatorName ?? t('history.operatorDefault'), date: when(it.createdAt), reason: it.endReason ?? '—' }),
  });
  // понятное название действия из словаря; неизвестный код показывается как есть
  const actionName = (code) => {
    const key = `audit.action.${code}`;
    const text = t(key);
    return text === key ? code : text;
  };
  // деталь записи — объект с сервера: короткие пары «ключ: значение»
  const detailText = (d) => {
    if (!d || typeof d !== 'object') return '';
    const parts = Object.entries(d)
      .filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object')
      .map(([k, v]) => `${k}: ${v}`);
    return parts.length ? ` · ${parts.join(', ')}` : '';
  };
  const renderAudit = () => renderTimeList('audit', '/audit', 'audit.empty', {
    title: (it) => actionName(it.action),
    sub: (it) => t('audit.sub', {
      date: `${it.actorName ? `${it.actorName} · ` : ''}${when(it.createdAt)}`,
      detail: detailText(it.detail),
    }),
  });

  // ---- хранение и очистка (ADR 0034): видят admin и auditor, меняет только admin ----
  async function renderManage(kind) {
    const box = $(`${kind}-manage`);
    const note = $(`${kind}-manage-note`);
    let res;
    try { res = await api('GET', '/settings/retention'); } catch { res = { status: 0 }; }
    if (res.status !== 200) { box.classList.add('hidden'); if (kind === 'audit') $('audit-off').classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const admin = getRole() === 'admin';
    const keep = $(`${kind}-keep`);
    const days = kind === 'audit' ? res.body.auditDays : res.body.historyDays;
    // срок из ENOT_RETENTION_DAYS может быть нестандартным — показываем его отдельной строкой
    if (![...keep.options].some((o) => Number(o.value) === days)) {
      const o = document.createElement('option');
      o.value = String(days);
      o.textContent = t('retention.keepDays', { days });
      keep.appendChild(o);
    }
    keep.value = String(days);
    keep.disabled = !admin;
    $(`${kind}-purge-age`).disabled = !admin;
    $(`${kind}-purge`).disabled = !admin;
    if (kind === 'audit') {
      $('audit-enabled').checked = res.body.auditEnabled;
      $('audit-enabled').disabled = !admin;
      $('audit-off').classList.toggle('hidden', res.body.auditEnabled);
    }
    if (!admin) note.textContent = t('retention.readOnly');
  }
  async function saveRetention(kind, patch) {
    const note = $(`${kind}-manage-note`);
    note.textContent = '';
    try {
      const res = await api('POST', '/settings/retention', patch);
      note.textContent = res.status === 200 ? t('retention.saved') : (res.body?.error?.message ?? t('common.serverError'));
    } catch (e) {
      note.textContent = e.message;
    }
    await renderManage(kind);
  }
  async function purge(kind, render) {
    const age = Number($(`${kind}-purge-age`).value);
    const what = $(`${kind}-purge-age`).selectedOptions[0]?.textContent ?? '';
    if (!window.confirm(t(kind === 'audit' ? 'retention.purgeAuditConfirm' : 'retention.purgeHistoryConfirm', { what }))) return;
    const note = $(`${kind}-manage-note`);
    const btn = $(`${kind}-purge`);
    btn.disabled = true;
    try {
      const res = await api('POST', `/${kind}/purge`, { olderThanDays: age });
      note.textContent = res.status === 200 ? t('retention.purged', { count: res.body.deleted }) : (res.body?.error?.message ?? t('common.serverError'));
      pages[kind] = 0;
      await render();
    } catch (e) {
      note.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  // Экспорт в CSV: до 1000 записей постранично, файл через Blob (как в desktop).
  async function downloadCsv(path, name, header, rowOf) {
    const rows = [];
    for (let offset = 0; offset < CSV_LIMIT && rows.length < CSV_LIMIT; offset += 100) {
      const body = await list(path, { limit: 100, offset });
      for (const it of body.items) rows.push(rowOf(it));
      if (rows.length >= body.total || body.items.length < 100) break;
    }
    const url = URL.createObjectURL(new Blob([toCsv(header, rows)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // ---- выбор контакта в форме подключения (claim с contactId, как desktop) ----
  async function loadContactsIntoSelect() {
    const sel = $('conn-contact');
    if (!sel) return;
    sel.textContent = '';
    const opt0 = el('option', '', '—');
    opt0.value = '';
    sel.appendChild(opt0);
    try {
      const body = await list('/contacts', { limit: 100 });
      for (const c of body.items) {
        const o = el('option', '', c.name);
        o.value = c.id;
        sel.appendChild(o);
      }
    } catch { /* пустой список выбора — не критично */ }
  }

  // ---- проводка (один раз) ----
  $('btn-contact-add').addEventListener('click', () => openEditor(null));
  $('btn-contact-cancel').addEventListener('click', () => $('contact-editor').classList.add('hidden'));
  $('form-contact').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btn-contact-save');
    btn.disabled = true; // без двойного сохранения (как setBusy в desktop)
    try { await saveContact(); } finally { btn.disabled = false; }
  });
  $('form-contact-search').addEventListener('submit', (e) => {
    e.preventDefault();
    contactsQuery = $('contact-search').value.trim();
    pages.contacts = 0;
    void renderContacts();
  });
  for (const [kind, render] of [['contacts', renderContacts], ['history', renderHistory], ['audit', renderAudit]]) {
    ui[kind].prev.addEventListener('click', () => { pages[kind] = Math.max(0, pages[kind] - 1); void render(); });
    ui[kind].next.addEventListener('click', () => { pages[kind] += 1; void render(); });
  }
  $('history-keep').addEventListener('change', (e) => { void saveRetention('history', { historyDays: Number(e.target.value) }); });
  $('audit-keep').addEventListener('change', (e) => { void saveRetention('audit', { auditDays: Number(e.target.value) }); });
  $('audit-enabled').addEventListener('change', (e) => { void saveRetention('audit', { auditEnabled: e.target.checked }); });
  $('history-purge').addEventListener('click', () => { void purge('history', renderHistory); });
  $('audit-purge').addEventListener('click', () => { void purge('audit', renderAudit); });
  $('history-csv').addEventListener('click', () => {
    downloadCsv('/history', 'history',
      [t('csv.session'), t('csv.operator'), t('csv.state'), t('csv.created'), t('csv.ended'), t('csv.reason')],
      (it) => [it.id, it.operatorName ?? '', it.state, it.createdAt, it.endedAt ?? '', it.endReason ?? ''])
      .catch((e) => { ui.history.status.textContent = e.message; });
  });
  $('audit-csv').addEventListener('click', () => {
    downloadCsv('/audit', 'audit',
      [t('csv.action'), t('csv.actor'), t('csv.target'), t('csv.when'), t('csv.details')],
      (it) => [it.action, it.actorId ?? '', it.targetId ?? '', it.createdAt, JSON.stringify(it.detail ?? {})])
      .catch((e) => { ui.audit.status.textContent = e.message; });
  });

  return {
    showContacts() { showOnly('view-contacts'); void renderContacts(); },
    showHistory() { showOnly('view-history'); void renderHistory(); void renderManage('history'); },
    showAudit() { showOnly('view-audit'); void renderAudit(); void renderManage('audit'); },
    loadContactsIntoSelect,
  };
}
