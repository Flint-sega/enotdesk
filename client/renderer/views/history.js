// История сеансов и журнал действий: списки, пагинация, экспорт в CSV.

import { $, text, fetchList } from '../dom.js';
import { state } from '../state.js';
import { t, getLocale } from '../../lib/i18n.mjs';
import { toCsv } from '../../lib/csv.mjs';

function renderTimeList(box, items, emptyText, format) {
  box.textContent = '';
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyText;
    box.appendChild(empty);
    return;
  }
  for (const it of items) {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = '<div class="grow"><div class="title"></div><div class="sub"></div></div>';
    item.querySelector('.title').textContent = format.title(it);
    item.querySelector('.sub').textContent = format.sub(it);
    box.appendChild(item);
  }
}

export async function renderHistory() {
  const box = $('history-list');
  text($('history-status'), t('common.loading'));
  try {
    const body = await fetchList('history.list', { limit: 20, offset: state.pages.history * 20 });
    renderTimeList(box, body.items, t('history.empty'), {
      title: (it) => t('history.item', { id: it.id, state: it.state }),
      sub: (it) => t('history.sub', {
        operator: it.operatorName ?? t('history.operatorDefault'),
        date: new Date(it.createdAt).toLocaleString(getLocale()),
        reason: it.endReason ?? '—',
      }),
    });
    text($('history-page'), t('common.pageOf', { page: state.pages.history + 1, total: body.total }));
    $('history-prev').disabled = state.pages.history === 0;
    $('history-next').disabled = (state.pages.history + 1) * 20 >= body.total;
    text($('history-status'), '');
  } catch (e) {
    text($('history-status'), e.message);
  }
}

export async function renderAudit() {
  const box = $('audit-list');
  text($('audit-status'), t('common.loading'));
  try {
    const body = await fetchList('audit.list', { limit: 20, offset: state.pages.audit * 20 });
    renderTimeList(box, body.items, t('audit.empty'), {
      title: (it) => `${it.action}`,
      sub: (it) => t('audit.sub', {
        date: new Date(it.createdAt).toLocaleString(getLocale()),
        detail: it.detail && typeof it.detail === 'string' ? ` · ${it.detail}` : '',
      }),
    });
    text($('audit-page'), t('common.pageOf', { page: state.pages.audit + 1, total: body.total }));
    $('audit-prev').disabled = state.pages.audit === 0;
    $('audit-next').disabled = (state.pages.audit + 1) * 20 >= body.total;
    text($('audit-status'), '');
  } catch (e) {
    text($('audit-status'), e.message);
  }
}
$('history-prev').addEventListener('click', () => { state.pages.history = Math.max(0, state.pages.history - 1); renderHistory(); });
$('history-next').addEventListener('click', () => { state.pages.history += 1; renderHistory(); });
$('audit-prev').addEventListener('click', () => { state.pages.audit = Math.max(0, state.pages.audit - 1); renderAudit(); });
$('audit-next').addEventListener('click', () => { state.pages.audit += 1; renderAudit(); });

// Экспорт в CSV: до 1000 записей постранично, файл через Blob (как принятые файлы).
const CSV_LIMIT = 1000;
async function downloadCsv(op, header, rowOf) {
  const rows = [];
  for (let offset = 0; offset < CSV_LIMIT && rows.length < CSV_LIMIT; offset += 100) {
    const body = await fetchList(op, { limit: 100, offset });
    for (const it of body.items) rows.push(rowOf(it));
    if (rows.length >= body.total || body.items.length < 100) break;
  }
  const blob = new Blob([toCsv(header, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${op}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
$('history-csv').addEventListener('click', () => {
  downloadCsv('history.list',
    [t('csv.session'), t('csv.operator'), t('csv.state'), t('csv.created'), t('csv.ended'), t('csv.reason')],
    (it) => [it.id, it.operatorName ?? '', it.state, it.createdAt, it.endedAt ?? '', it.endReason ?? ''])
    .catch((e) => text($('history-status'), e.message));
});
$('audit-csv').addEventListener('click', () => {
  downloadCsv('audit.list',
    [t('csv.action'), t('csv.actor'), t('csv.target'), t('csv.when'), t('csv.details')],
    (it) => [it.action, it.actorId ?? '', it.targetId ?? '', it.createdAt, JSON.stringify(it.detail ?? {})])
    .catch((e) => text($('audit-status'), e.message));
});
