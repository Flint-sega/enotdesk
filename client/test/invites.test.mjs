import test from 'node:test';
import assert from 'node:assert/strict';
import { inviteStatus } from '../lib/invites.mjs';

const future = new Date(Date.now() + 86_400_000).toISOString();
const base = { usedAt: null, revokedAt: null, expiresAt: future };

test('inviteStatus: active и его подпись', () => {
  const st = inviteStatus({ ...base });
  assert.equal(st.state, 'active');
  assert.match(st.label, /^действует до /);
});

test('inviteStatus: used', () => {
  assert.deepEqual(inviteStatus({ ...base, usedAt: '2026-01-01T00:00:00.000Z' }), {
    state: 'used', label: 'использовано',
  });
});

test('inviteStatus: revoked', () => {
  assert.deepEqual(inviteStatus({ ...base, revokedAt: '2026-01-01T00:00:00.000Z' }), {
    state: 'revoked', label: 'отозвано',
  });
});

test('inviteStatus: expired', () => {
  assert.deepEqual(inviteStatus({ ...base, expiresAt: '2026-01-01T00:00:00.000Z' }), {
    state: 'expired', label: 'истекло',
  });
});

test('inviteStatus: граница expiresAt === now — expired, на миллисекунду позже — active', () => {
  const now = new Date('2026-05-01T12:00:00.000Z');
  assert.equal(inviteStatus({ usedAt: null, revokedAt: null, expiresAt: now.toISOString() }, now).state, 'expired');
  assert.equal(inviteStatus({ usedAt: null, revokedAt: null, expiresAt: new Date(now.getTime() + 1).toISOString() }, now).state, 'active');
});
