// Команда: участники, роли, приглашения (admin-функции с честными отказами).

import { $, enot, text, setBusy, roleName, fetchList } from '../dom.js';
import { state } from '../state.js';
import { inviteStatus } from '../../lib/invites.mjs';

export async function renderTeam() {
  const box = $('members-list');
  const ibox = $('invites-list');
  box.textContent = ''; ibox.textContent = '';
  text($('team-status'), 'Загрузка…');
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
      empty.textContent = 'Команда пуста. Создайте приглашение ниже и отправьте его коллеге.';
      box.appendChild(empty);
    }
    for (const m of members.items) {
      const item = document.createElement('div');
      item.className = 'list-item';
      const main = document.createElement('div');
      main.className = 'grow';
      main.innerHTML = `<div class="title"></div><div class="sub"></div>`;
      main.querySelector('.title').textContent = `${m.name} (@${m.login})`;
      main.querySelector('.sub').textContent = m.active ? 'активен' : 'отключён';
      item.appendChild(main);
      if (state.me?.role === 'admin') {
        const roleSel = document.createElement('select');
        roleSel.setAttribute('aria-label', `Роль: ${m.name}`);
        for (const [v, label] of [['admin', 'Администратор'], ['operator', 'Оператор'], ['auditor', 'Наблюдатель']]) {
          const o = document.createElement('option');
          o.value = v; o.textContent = label;
          roleSel.appendChild(o);
        }
        roleSel.value = m.role;
        roleSel.addEventListener('change', () => patchMember(m, { role: roleSel.value }));
        const toggle = document.createElement('button');
        toggle.className = 'btn small';
        toggle.textContent = m.active ? 'Отключить' : 'Включить';
        toggle.addEventListener('click', () => patchMember(m, { active: !m.active }));
        item.append(roleSel, toggle);
        if (state.me?.id !== m.id) {
          const del = document.createElement('button');
          del.className = 'btn small danger-ghost';
          del.textContent = 'Удалить';
          del.addEventListener('click', async () => {
            if (del.textContent !== 'Точно удалить?') { del.textContent = 'Точно удалить?'; return; }
            const res = await enot.request('members.delete', { id: m.id });
            if (res.status !== 200) text($('team-error'), res.body?.error?.message ?? 'Не удалось удалить участника');
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
      empty.textContent = 'Активных приглашений нет. Создайте одноразовое приглашение и передайте его в чате.';
      ibox.appendChild(empty);
    }
    for (const inv of invites.items) {
      const item = document.createElement('div');
      item.className = 'list-item';
      const main = document.createElement('div');
      main.className = 'grow';
      main.innerHTML = '<div class="title"></div><div class="sub"></div>';
      main.querySelector('.title').textContent = `Приглашение на роль: ${roleName(inv.role)}`;
      const status = inviteStatus(inv);
      main.querySelector('.sub').textContent = status.label;
      item.append(main);
      if (status.state === 'active') {
        const revoke = document.createElement('button');
        revoke.className = 'btn small danger-ghost';
        revoke.textContent = 'Отозвать';
        revoke.addEventListener('click', async () => {
          const res = await enot.request('invites.revoke', { id: inv.id });
          if (res.status !== 200) text($('team-error'), res.body?.error?.message ?? 'Не удалось отозвать');
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
  if (res.status !== 200) text($('team-error'), res.body?.error?.message ?? 'Не удалось изменить участника');
  else renderTeam();
}

$('form-invite').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-invite-create');
  setBusy(btn, true, 'Создаём…');
  text($('invite-result'), ''); text($('team-error'), '');
  try {
    const res = await enot.request('invites.create', { role: $('invite-role').value });
    if (res.status !== 201) throw new Error(res.body?.error?.message ?? 'Не удалось создать приглашение');
    // одноразовый токен приглашения — единственный токен, отдаваемый на рендерер
    const url = res.body.url || `${res.body.token}`;
    text($('invite-result'), `Приглашение (одноразовое, скопируйте и отправьте): ${url}`);
    await enot.copy(url);
    renderTeam();
  } catch (err) {
    text($('team-error'), err.message);
  } finally {
    setBusy(btn, false);
  }
});
