import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCredentials } from '../lib/credentials.mjs';

test('полный формат клиента: ID и пароль с метками', () => {
  assert.deepEqual(parseCredentials('ID: 985375066\nПароль: b2PrdxDb'), {
    sessionId: '985375066', password: 'b2PrdxDb',
  });
});

test('две строки без меток', () => {
  assert.deepEqual(parseCredentials('985375066\nb2PrdxDb'), {
    sessionId: '985375066', password: 'b2PrdxDb',
  });
});

test('ID с пробелами и дефисами: с меткой и без', () => {
  assert.deepEqual(parseCredentials('ID: 985 375 066'), { sessionId: '985375066' });
  assert.deepEqual(parseCredentials('ИД: 985-375-066'), { sessionId: '985375066' });
  assert.deepEqual(parseCredentials('985 375 066'), { sessionId: '985375066' });
});

test('только ID', () => {
  assert.deepEqual(parseCredentials('идентификатор 985375066'), { sessionId: '985375066' });
});

test('только пароль: с меткой, в кавычках и без метки', () => {
  assert.deepEqual(parseCredentials('Пароль: «b2PrdxDb»'), { password: 'b2PrdxDb' });
  assert.deepEqual(parseCredentials('password = b2PrdxDb'), { password: 'b2PrdxDb' });
  assert.deepEqual(parseCredentials('b2PrdxDb'), { password: 'b2PrdxDb' });
});

test('мусор → null', () => {
  assert.equal(parseCredentials('привет, как дела?'), null);
  assert.equal(parseCredentials('ID: abc'), null);
  assert.equal(parseCredentials(''), null);
});

test('Telegram-разметка с • и *', () => {
  assert.deepEqual(parseCredentials('• ID: 985375066\n• Пароль: b2PrdxDb'), {
    sessionId: '985375066', password: 'b2PrdxDb',
  });
  assert.deepEqual(parseCredentials('*ID:* 985375066\n*Пароль:* b2PrdxDb'), {
    sessionId: '985375066', password: 'b2PrdxDb',
  });
});

test('11-значное число не даёт sessionId', () => {
  assert.equal(parseCredentials('ID: 12345678901'), null);
  assert.equal(parseCredentials('12345678901'), null);
});

test('12345678 без метки не считается паролем', () => {
  assert.equal(parseCredentials('12345678'), null);
});
