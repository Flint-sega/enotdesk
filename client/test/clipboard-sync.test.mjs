import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClipMessage, clipMessage, CLIP_MAX } from '../lib/clipboard-sync.mjs';

test('буфер: корректный текст проходит туда и обратно', () => {
  const wire = clipMessage('скопированный текст');
  assert.ok(wire);
  assert.deepEqual(parseClipMessage(wire), { text: 'скопированный текст' });
});

test('буфер: пустое и сверхлимитное отклоняются, мусор отбрасывается', () => {
  assert.equal(clipMessage(''), null);
  assert.equal(clipMessage('б'.repeat(CLIP_MAX + 1)), null);
  assert.ok(parseClipMessage(clipMessage('б'.repeat(CLIP_MAX))));

  assert.equal(parseClipMessage('garbage'), null);
  assert.equal(parseClipMessage(JSON.stringify({ type: 'clip', text: null })), null);
  assert.equal(parseClipMessage(JSON.stringify({ type: 'clip', text: 'б'.repeat(CLIP_MAX + 1) })), null);
  assert.equal(parseClipMessage(JSON.stringify({ type: 'chat', text: 'не буфер' })), null);
});
