// Веб-UI команды (admin): участники + приглашения. Тот же цикл, что в
// desktop-клиенте (team.js), но для панели /operator — «полный механизм» стал
// виден из браузера (просьба владельца 02.10: «не видел полного механизма»).

let teamLoaded = false;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inviteStatus(inv) {
  if (inv.usedAt) return t('web.team.statusUsed');
  if (inv.revokedAt) return t('web.team.statusRevoked');
  if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) return t('web.team.statusExpired');
  return t('web.team.statusActive');
}

function memberRow(m) {
  const me = m.name;
  const roleSel = ['operator', 'auditor', 'admin'].map((r) =>
    `<option value="${r}" ${m.role === r ? 'selected' : ''}>${esc(t(`web.team.role${r[0].toUpperCase()}${r.slice(1)}`))}</option>`).join('');
  const actions = [
    `<button class="btn ghost" data-act="save" data-id="${esc(m.id)}" data-role="${m.role}" data-active="${m.active ? 1 : 0}" data-name="${esc(me)}">${esc(t('web.team.save'))}</button>`,
    `<button class="btn ghost" data-act="toggle" data-id="${esc(m.id)}" data-active="${m.active ? 1 : 0}">${esc(m.active ? t('web.team.disable') : t('web.team.enable'))}</button>`,
  ];
  // себя нельзя удалить (сервер тоже запрещает)
  actions.push(`<button class="btn danger ghost" data-act="del" data-id="${esc(m.id)}" data-name="${esc(me)}">${esc(t('web.team.delete'))}</button>`);
  return `<div class="team-row" data-member="${esc(m.id)}">
    <strong>${esc(m.name)}</strong> <span class="muted">${esc(m.login)}</span>
    <span class="muted">${esc(t(`web.team.role${m.role[0].toUpperCase()}${m.role.slice(1)}`))}</span>
    <span class="muted">${esc(m.active ? t('web.team.active') : t('web.team.disabled'))}</span>
    <span class="team-actions">${actions.join(' ')}</span>
  </div>`;
}

function inviteRow(inv) {
  const status = inviteStatus(inv);
  const revoke = !inv.usedAt && !inv.revokedAt
    ? `<button class="btn danger ghost" data-act="revoke" data-id="${esc(inv.id)}">${esc(t('web.team.revoke'))}</button>` : '';
  return `<div class="team-row">
    <span>${esc(t(`web.team.role${inv.role[0].toUpperCase()}${inv.role.slice(1)}`))}</span>
    <span class="muted">${esc(status)}</span>
    <span class="muted">${esc(inv.expiresAt ?? '')}</span>
    ${revoke}
  </div>`;
}

export async function renderTeam({ force = false } = {}) {
  const err = document.getElementById('team-error');
  err().textContent = '';
  if (teamLoaded && !force) return;
  try {
    const [members, invites] = await Promise.all([
      api('GET', '/members'),
      api('GET', '/invites'),
    ]);
    if (members.status !== 200 || invites.status !== 200) {
      err().textContent = members.body?.error?.message ?? t('common.serverError');
      return;
    }
    const mBox = document.getElementById('team-members');
    const iBox = document.getElementById('team-invites');
    mBox.innerHTML = (members.body.items ?? []).map((m) => memberRow(m)).join('') || `<p class="muted">${esc(t('web.team.empty'))}</p>`;
    iBox.innerHTML = (invites.body.items ?? []).map((p) => inviteRow(p)).join('') || `<p class="muted">${esc(t('web.team.invitesEmpty'))}</p>`;
    teamLoaded = true;
  } catch (e) {
    err().textContent = e.message;
  }
}

export function teamRoute() {
  renderTeam();
}

export function bindTeam({ onOpenMachines = () => {} } = {}) {
  const panel = document.getElementById('view-team');
  if (!panel) return;
  const err = () => document.getElementById('team-error');
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
      void renderTeam({ force: true });
    } catch (e2) {
      err().textContent = e2.message;
    } finally {
      createBtn.disabled = false;
    }
  });
  panel.addEventListener('click', async (e) => {
    const btn = e.target.closest?.('button[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;
    try {
      if (act === 'save') {
        const row = btn.closest('[data-member]');
        const role = row?.querySelector('select')?.value ?? btn.dataset.role;
        const active = row?.querySelector('[data-act="toggle"]') ? undefined : btn.dataset.active === '1';
        const body = { role };
        if (active !== undefined) body.active = active;
        const r = await api('PATCH', `/members/${encodeURIComponent(id)}`, body);
        if (r.status !== 200) { err().textContent = r.body?.error?.message ?? t('common.serverError'); return; }
      } else if (act === 'toggle') {
        const r = await api('PATCH', `/members/${encodeURIComponent(id)}`, { active: btn.dataset.active !== '1' });
        if (r.status !== 200) { err().textContent = r.body?.error?.message ?? t('common.serverError'); return; }
      } else if (act === 'del') {
        const r = await api('DELETE', `/members/${encodeURIComponent(id)}`);
        if (r.status !== 200) { err().textContent = r.body?.error?.message ?? t('common.serverError'); return; }
      } else if (act === 'revoke') {
        const r = await api('DELETE', `/invites/${encodeURIComponent(id)}`);
        if (r.status !== 200) { err().textContent = r.body?.error?.message ?? t('common.serverError'); return; }
      }
      teamLoaded = false;
      await renderTeam({ force: true });
    } catch (e2) {
      err().textContent = e2.message;
    }
  });
}
