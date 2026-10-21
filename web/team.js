// Веб-UI команды (admin): участники + приглашения. Тот же цикл, что в
// desktop-клиенте (team.js), но для панели /operator — «полный механизм» стал
// виден из браузера (просьба владельца 02.10: «не видел полного механизма»).
// Модуль изолирован: api/t/showOnly приходят параметрами из operator.mjs —
// свободные идентификаторы в браузере были бы ReferenceError (ревью GLM-5.3).

let teamLoaded = false;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inviteStatus(inv, t) {
  if (inv.usedAt) return t('web.team.statusUsed');
  if (inv.revokedAt) return t('web.team.statusRevoked');
  if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) return t('web.team.statusExpired');
  return t('web.team.statusActive');
}

const roleName = (role, t) => t(`web.team.role${role[0].toUpperCase()}${role.slice(1)}`);

// Строки участников и приглашений — подсетка общей сетки списка (owner 21.10:
// «роль то левее, то правее»): колонки одинаковые во всех строках.
function memberRow(m, t, meId) {
  const self = m.id === meId;
  // роль меняется прямо в строке и сохраняется сразу при выборе (PATCH members {role})
  const roleSel = `<select data-act="role" data-id="${esc(m.id)}" data-role="${esc(m.role)}" aria-label="${esc(t('web.team.role'))}">` +
    ['operator', 'auditor', 'admin'].map((r) =>
      `<option value="${r}" ${m.role === r ? 'selected' : ''}>${esc(roleName(r, t))}</option>`).join('') + '</select>';
  // себя нельзя ни отключить, ни удалить (сервер тоже запрещает удаление)
  const actions = self
    ? `<span class="tag">${esc(t('web.team.youTag'))}</span>`
    : `<button class="btn ghost sm" type="button" data-act="toggle" data-id="${esc(m.id)}" data-active="${m.active ? 1 : 0}">${esc(m.active ? t('web.team.disable') : t('web.team.enable'))}</button>` +
      `<button class="btn danger ghost sm" type="button" data-act="del" data-id="${esc(m.id)}" data-name="${esc(m.name)}">${esc(t('web.team.delete'))}</button>`;
  return `<div class="team-row${m.active ? '' : ' off'}" data-member="${esc(m.id)}">
    <span class="cell-main" title="${esc(m.name)} · ${esc(m.login)}"><strong>${esc(m.name)}</strong><span class="muted">${esc(m.login)}</span></span>
    <span class="cell-role">${roleSel}</span>
    <span class="cell-state"><span class="state-dot${m.active ? ' on' : ''}"></span>${esc(m.active ? t('web.team.active') : t('web.team.disabled'))}</span>
    <span class="team-actions">${actions}</span>
  </div>`;
}

function inviteRow(inv, t, when) {
  const active = !inv.usedAt && !inv.revokedAt && !(inv.expiresAt && new Date(inv.expiresAt) < new Date());
  const date = active ? t('web.team.until', { date: when(inv.expiresAt) }) : when(inv.usedAt ?? inv.revokedAt ?? inv.expiresAt);
  const action = active
    ? `<button class="btn danger ghost sm" type="button" data-act="revoke" data-id="${esc(inv.id)}">${esc(t('web.team.revoke'))}</button>` : '';
  return `<div class="team-row">
    <span class="cell-main"><strong>${esc(roleName(inv.role, t))}</strong></span>
    <span class="cell-role muted">${esc(date)}</span>
    <span class="cell-state">${esc(inviteStatus(inv, t))}</span>
    <span class="team-actions">${action}</span>
  </div>`;
}

export async function renderTeam({ api, t, getMe = () => null, getLocale = () => undefined, force = false } = {}) {
  const err = () => document.getElementById('team-error');
  err().textContent = '';
  if (teamLoaded && !force) return;
  const when = (iso) => (iso ? new Date(iso).toLocaleString(getLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  try {
    const [members, invites, archive] = await Promise.all([
      api('GET', '/members?limit=100'),
      api('GET', '/invites?status=active&limit=100'),
      api('GET', '/invites?status=archive&limit=100'),
    ]);
    // не-админ: это не «сломалось», а ограничение по роли — говорим честно
    if (members.status === 403 || invites.status === 403) {
      const mBox0 = document.getElementById('team-members');
      if (mBox0) mBox0.innerHTML = `<p class="muted">${esc(t('web.team.adminOnly'))}</p>`;
      const iBox0 = document.getElementById('team-invites');
      if (iBox0) iBox0.innerHTML = '';
      return;
    }
    if (members.status !== 200 || invites.status !== 200) {
      err().textContent = members.body?.error?.message ?? t('common.serverError');
      return;
    }
    const mBox = document.getElementById('team-members');
    const iBox = document.getElementById('team-invites');
    mBox.innerHTML = (members.body.items ?? []).map((m) => memberRow(m, t, getMe())).join('') || `<p class="muted">${esc(t('web.team.empty'))}</p>`;
    iBox.innerHTML = (invites.body.items ?? []).map((p) => inviteRow(p, t, when)).join('') || `<p class="muted">${esc(t('web.team.invitesEmpty'))}</p>`;
    // архив: использованные, отозванные, просроченные — свёрнуты, с очисткой
    const aBox = document.getElementById('team-archive-list');
    const items = archive?.status === 200 ? (archive.body.items ?? []) : [];
    const total = archive?.status === 200 ? (archive.body.total ?? items.length) : 0;
    if (aBox) aBox.innerHTML = items.map((p) => inviteRow(p, t, when)).join('') || `<p class="muted">${esc(t('web.team.archiveEmpty'))}</p>`;
    const count = document.getElementById('team-archive-count');
    if (count) count.textContent = String(total);
    const purge = document.getElementById('team-archive-purge');
    if (purge) purge.disabled = total === 0;
    teamLoaded = true;
  } catch (e) {
    err().textContent = e.message;
  }
}

export function teamRoute({ api, t, getMe, getLocale } = {}) {
  void renderTeam({ api, t, getMe, getLocale });
}

export function bindTeam({ api, t, showOnly, getMe, getLocale, onOpenMachines = () => {} } = {}) {
  const panel = document.getElementById('view-team');
  if (!panel) return;
  const err = () => document.getElementById('team-error');
  const refresh = () => renderTeam({ api, t, getMe, getLocale, force: true });
  const fail = (r) => { err().textContent = r.body?.error?.message ?? t('common.serverError'); };
  document.getElementById('btn-nav-machines2')?.addEventListener('click', () => {
    showOnly('view-machines');
    onOpenMachines();
  });
  document.getElementById('btn-nav-connect2')?.addEventListener('click', () => {
    showOnly('view-connect');
  });
  const createBtn = document.getElementById('team-invite-create');
  document.getElementById('team-invite-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    createBtn.disabled = true;
    const role = document.getElementById('team-invite-role').value;
    const link = document.getElementById('team-invite-link');
    try {
      const res = await api('POST', '/invites', { role });
      if (res.status !== 201) {
        err().textContent = res.body?.error?.message ?? t('common.serverError');
        return;
      }
      link.classList.remove('hidden');
      link.textContent = res.body.url ?? res.body.token ?? '';
      teamLoaded = false;
      await refresh();
    } catch (e2) {
      err().textContent = e2.message;
    } finally {
      createBtn.disabled = false;
    }
  });
  // смена роли — сразу при выборе; при отказе сервера (последний админ) список перечитывается
  panel.addEventListener('change', async (e) => {
    const sel = e.target.closest?.('select[data-act="role"]');
    if (!sel) return;
    err().textContent = '';
    try {
      const r = await api('PATCH', `/members/${encodeURIComponent(sel.dataset.id)}`, { role: sel.value });
      teamLoaded = false;
      await refresh();
      if (r.status !== 200) fail(r);
    } catch (e2) {
      err().textContent = e2.message;
    }
  });
  document.getElementById('team-archive-purge')?.addEventListener('click', async () => {
    const count = document.getElementById('team-archive-count')?.textContent ?? '';
    if (!window.confirm(t('web.team.archivePurgeConfirm', { count }))) return;
    try {
      const r = await api('POST', '/invites/purge', {});
      if (r.status !== 200) { fail(r); return; }
      teamLoaded = false;
      await refresh();
    } catch (e2) {
      err().textContent = e2.message;
    }
  });
  panel.addEventListener('click', async (e) => {
    const btn = e.target.closest?.('button[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;
    try {
      if (act === 'toggle') {
        const r = await api('PATCH', `/members/${encodeURIComponent(id)}`, { active: btn.dataset.active !== '1' });
        if (r.status !== 200) { fail(r); return; }
      } else if (act === 'del') {
        if (!window.confirm(t('web.team.deleteConfirm', { name: btn.dataset.name }))) return;
        const r = await api('DELETE', `/members/${encodeURIComponent(id)}`);
        if (r.status !== 200) { fail(r); return; }
      } else if (act === 'revoke') {
        const r = await api('DELETE', `/invites/${encodeURIComponent(id)}`);
        if (r.status !== 200) { fail(r); return; }
      }
      teamLoaded = false;
      await refresh();
    } catch (e2) {
      err().textContent = e2.message;
    }
  });
}
