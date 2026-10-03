import test from 'node:test';
import assert from 'node:assert/strict';

// Исполнимый прогон web/team.js (ревью GLM-5.3: контракт-тест читал файл только
// текстом, и TypeError/ReferenceError дожили до ревью). Зависимости (api/t)
// приходят параметрами — модуль исполняется в node с фейковым document.

const els = new Map();
function fakeEl(id) {
  return {
    id,
    textContent: '',
    innerHTML: '',
    value: 'operator',
    disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
  };
}
globalThis.document = { getElementById: (id) => els.get(id) ?? null };

const { renderTeam, bindTeam, teamRoute } = await import('../../web/team.js');

const t = (key) => key;
function stubApi({ members, invites }) {
  return async (method, path) => {
    if (path === '/members') return members;
    if (path === '/invites') return invites;
    return { status: 404, body: {} };
  };
}

test('renderTeam исполняется и рендерит участников с select роли (без ReferenceError)', async () => {
  els.set('team-error', fakeEl('team-error'));
  els.set('team-members', fakeEl('team-members'));
  els.set('team-invites', fakeEl('team-invites'));
  const api = stubApi({
    members: { status: 200, body: { items: [{ id: 'm1', name: 'A <b>', login: 'a', role: 'operator', active: true }] } },
    invites: { status: 200, body: { items: [{ id: 'i1', role: 'auditor', expiresAt: '2026-10-05T00:00:00Z' }] } },
  });
  await renderTeam({ api, t, force: true });
  const html = els.get('team-members').innerHTML;
  assert.match(html, /<select/);
  assert.match(html, /<option value="operator" selected>/);
  assert.match(html, /data-role="operator"/); // esc(m.role) — дисциплина файла
  assert.ok(!html.includes('<b>'), 'имя экранируется');
  assert.match(els.get('team-invites').innerHTML, /roleAuditor/);
});

test('renderTeam: 403 — честное «только админ», не ошибка', async () => {
  els.set('team-error', fakeEl('team-error'));
  els.set('team-members', fakeEl('team-members'));
  els.set('team-invites', fakeEl('team-invites'));
  const api = stubApi({
    members: { status: 403, body: { error: { message: 'forbidden' } } },
    invites: { status: 403, body: { error: { message: 'forbidden' } } },
  });
  await renderTeam({ api, t, force: true });
  assert.match(els.get('team-members').innerHTML, /web\.team\.adminOnly/);
  assert.equal(els.get('team-error').textContent, '');
});

test('teamRoute/bindTeam вызываются без исключений (панель может отсутствовать)', () => {
  assert.doesNotThrow(() => teamRoute({ api: stubApi({}), t }));
  assert.doesNotThrow(() => bindTeam({ api: stubApi({}), t, showOnly: () => {} }));
});
