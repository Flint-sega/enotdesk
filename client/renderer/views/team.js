// Команда: участники, роли, приглашения (admin-функции с честными отказами).

import { $, enot, text, setBusy, roleName, fetchList } from '../dom.js';
import { state } from '../state.js';
import { t } from '../../lib/i18n.mjs';
import { inviteStatus } from '../../lib/invites.mjs';

export async function renderTeam() {
  const box = $('members-list');
  const ibox = $('invites-list');
  box.textContent = ''; ibox.textContent = '';
  text($('team-status'), t('common.loading'));
  text($('team-error'), '');
  try {
    const [members, invites] = await Promise.all([
      fetchList('members.list', {}),
      fetchList('invites.list', {}).catch(() => ({ items: [], total: 0 })), // не-admin не видит приглашения
    ]);
    box.textContent = '';
    if (!members.items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = t('team.empty');
      box.appendChild(empty);
    }
    for (const m of members.items) {
      const item = document.createElement('div');
      item.className = 'list-item';
      const main = document.createElement('div');
      main.className = 'grow';
      main.innerHTML = '<div class="title"></div><div class="sub"></div>';
      main.querySelector('.title').textContent = `${m.name} (@${m.login})`;
      main.querySelector('.sub').textContent = m.active ? t('team.active') : t('team.disabled');
      item.appendChild(main);
      if (state.me?.role === 'admin') {
        const roleSel = document.createElement('select');
        roleSel.setAttribute('aria-label', t('team.roleAria', { name: m.name }));
        for (const v of ['admin', 'operator', 'auditor']) {
          const o = document.createElement('option');
          o.value = v; o.textContent = t(`team.roleSelect.${v}`);
          roleSel.appendChild(o);
        }
        roleSel.value = m.role;
        roleSel.addEventListener('change', () => patchMember(m, { role: roleSel.value }));
        const toggle = document.createElement('button');
        toggle.className = 'btn small';
        toggle.textContent = m.active ? t('team.disable') : t('team.enable');
        toggle.addEventListener('click', () => patchMember(m, { active: !m.active }));
        item.append(roleSel, toggle);
        if (state.me?.id !== m.id) {
          const del = document.createElement('button');
          del.className = 'btn small danger-ghost';
          del.textContent = t('common.delete');
          del.addEventListener('click', async () => {
            if (del.textContent !== t('team.sureDelete')) { del.textContent = t('team.sureDelete'); return; }
            const res = await enot.request('members.delete', { id: m.id });
            if (res.status !== 200) text($('team-error'), res.body?.error?.message ?? t('team.deleteFail'));
            else renderTeam();
          });
          item.appendChild(del);
        }
      }
      box.appendChild(item);
    }
    ibox.textContent = '';
    if (!invites.items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = t('team.invitesEmpty');
      ibox.appendChild(empty);
    }
    for (const inv of invites.items) {
      const item = document.createElement('div');
      item.className = 'list-item';
      const main = document.createElement('div');
      main.className = 'grow';
      main.innerHTML = '<div class="title"></div><div class="sub"></div>';
      main.querySelector('.title').textContent = t('team.inviteFor', { role: roleName(inv.role) });
      const status = inviteStatus(inv);
      main.querySelector('.sub').textContent = status.label;
      item.append(main);
      if (status.state === 'active') {
        const revoke = document.createElement('button');
        revoke.className = 'btn small danger-ghost';
        revoke.textContent = t('team.revoke');
        revoke.addEventListener('click', async () => {
          const res = await enot.request('invites.revoke', { id: inv.id });
          if (res.status !== 200) text($('team-error'), res.body?.error?.message ?? t('team.revokeFail'));
          else renderTeam();
        });
        item.appendChild(revoke);
      }
      ibox.appendChild(item);
    }
    text($('team-status'), '');
  } catch (e) {
    text($('team-status'), '');
    text($('team-error'), e.message);
  }
}

async function patchMember(m, patch) {
  const res = await enot.request('members.patch', { id: m.id, ...patch });
  if (res.status !== 200) text($('team-error'), res.body?.error?.message ?? t('team.patchFail'));
  else renderTeam();
}

$('form-invite').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-invite-create');
  setBusy(btn, true, t('team.createBusy'));
  text($('invite-result'), ''); text($('team-error'), '');
  try {
    const res = await enot.request('invites.create', { role: $('invite-role').value });
    if (res.status !== 201) throw new Error(res.body?.error?.message ?? t('team.createFail'));
    // одноразовый токен приглашения — единственный токен, отдаваемый на рендерер
    const url = res.body.url || `${res.body.token}`;
    text($('invite-result'), t('team.inviteResult', { url }));
    await enot.copy(url);
    renderTeam();
  } catch (err) {
    text($('team-error'), err.message);
  } finally {
    setBusy(btn, false);
  }
});
