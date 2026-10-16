import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatMessage, chatMessage, CHAT_MAX, CHAT_NAME_MAX } from '../lib/chat.mjs';

test('чат: корректное сообщение проходит туда и обратно', () => {
  const wire = chatMessage('Здравствуйте, я подключуюсь');
  assert.ok(wire);
  assert.deepEqual(parseChatMessage(wire), { text: 'Здравствуйте, я подключуюсь' });
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

// G2 (волна G, 16.10): метаданные автора — allowlist from ∈ {operator, host},
// имя 1..CHAT_NAME_MAX; мусорные поля отбрасываются ПОЛЯМИ, сообщение живо
// (обратная совместимость: старые хосты поле не ставят — это не ошибка).
test('G2: мета автора — валидное проходит туда и обратно, мусор отбрасывается полями', () => {
  const wire = chatMessage('привет', { from: 'operator', name: 'Анна' });
  assert.deepEqual(parseChatMessage(wire), { text: 'привет', from: 'operator', name: 'Анна' });

  // from вне allowlist и слишком длинное имя — поля отброшены, текст дошёл
  const junk = JSON.stringify({ type: 'chat', text: 'ок', from: 'system', name: 'н'.repeat(CHAT_NAME_MAX + 1) });
  assert.deepEqual(parseChatMessage(junk), { text: 'ок' });
  // пустое имя — как отсутствие имени
  assert.deepEqual(parseChatMessage(JSON.stringify({ type: 'chat', text: 'ок', name: '' })), { text: 'ок' });
  // граничное имя проходит
  const edgeName = 'и'.repeat(CHAT_NAME_MAX);
  assert.deepEqual(
    parseChatMessage(chatMessage('ок', { from: 'host', name: edgeName })),
    { text: 'ок', from: 'host', name: edgeName },
  );
  // chatMessage с мусорной метой сериализует чистый текст
  assert.equal(chatMessage('ок', { from: 'system' }), JSON.stringify({ type: 'chat', text: 'ок' }));
  // старый провод без полей парсится как раньше — ключ к совместимости
  assert.deepEqual(parseChatMessage(JSON.stringify({ type: 'chat', text: 'легаси' })), { text: 'легаси' });
});
