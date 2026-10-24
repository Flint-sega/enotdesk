import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInviteLink } from '../lib/invite-link.mjs';

test('invite deep-link: токен из #fragment', () => {
  const tok = 'Qm9vLXRva2VuLWZvci10ZXN0cy0xMjM0NTY3ODkwYWI';
  assert.deepEqual(parseInviteLink(`enotdesk://invite#token=${tok}`), { token: tok });
  // ревью 1.13: только формат токена сервера (base64url 16..128)
  assert.equal(parseInviteLink('enotdesk://invite#token=abc123'), null, 'слишком короткий');
  assert.equal(parseInviteLink(`enotdesk://invite#token=${tok}%2F..%2Fx`), null, 'посторонние символы');
  assert.equal(parseInviteLink(`enotdesk://invite#token=${'a'.repeat(200)}`), null, 'слишком длинный');
  assert.equal(parseInviteLink('enotdesk://invite#other=1'), null);
  assert.equal(parseInviteLink('enotdesk://join?server=x&t=y'), null); // join-ссылка — не приглашение
  assert.equal(parseInviteLink('not a url'), null);
  assert.equal(parseInviteLink(42), null);
});
