import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatMessage, chatMessage, CHAT_MAX } from '../lib/chat.mjs';

test('чат: корректное сообщение проходит туда и обратно', () => {
  const wire = chatMessage('Здравствуйте, я подключаюсь');
  assert.ok(wire);
  assert.deepEqual(parseChatMessage(wire), { text: 'Здравствуйте, я подключаюсь' });
});

test('чат: границы — пустое и сверхлимитное отклоняются, граничное проходит', () => {
  assert.equal(chatMessage(''), null);
  assert.equal(chatMessage('е'.repeat(CHAT_MAX + 1)), null);
  const edge = chatMessage('е'.repeat(CHAT_MAX));
  assert.ok(edge);
  assert.ok(parseChatMessage(edge));

  assert.equal(parseChatMessage('not json{'), null);
  assert.equal(parseChatMessage(JSON.stringify({ type: 'chat', text: 42 })), null);
  assert.equal(parseChatMessage(JSON.stringify({ type: 'chat' })), null);
  assert.equal(parseChatMessage(JSON.stringify({ type: 'exec', text: 'ls' })), null);
  assert.equal(parseChatMessage(JSON.stringify({ type: 'chat', text: 'x'.repeat(CHAT_MAX + 1) })), null);
});
