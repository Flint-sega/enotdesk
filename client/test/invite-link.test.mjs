import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInviteLink } from '../lib/invite-link.mjs';

test('invite deep-link: токен из #fragment', () => {
  assert.deepEqual(parseInviteLink('enotdesk://invite#token=abc123'), { token: 'abc123' });
  assert.equal(parseInviteLink('enotdesk://invite#other=1'), null);
  assert.equal(parseInviteLink('enotdesk://join?server=x&t=y'), null); // join-ссылка — не приглашение
  assert.equal(parseInviteLink('not a url'), null);
  assert.equal(parseInviteLink(42), null);
});
