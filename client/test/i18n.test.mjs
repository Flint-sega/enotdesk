import test from 'node:test';
import assert from 'node:assert/strict';
import { t, setLocale, getLocale, initLocale, pickLocale } from '../lib/i18n.mjs';
import ru from '../locales/ru.mjs';
import en from '../locales/en.mjs';

// Шов i18n (interfaces.md): t/setLocale/initLocale, словари, фолбэк en.
// Ожидаемые значения — из словарей как из данных, не из кода под тестом.

test('t: известный ключ отдаёт текст текущей локали, интерполяция подставляет vars', () => {
  setLocale('ru');
  assert.equal(t('client.allow'), ru['client.allow']);
  assert.equal(t('client.allow'), 'Разрешить');
  assert.equal(t('common.pageOf', { page: 2, total: 5 }), 'Стр. 2, всего 5');
  setLocale('en');
  assert.equal(t('client.allow'), en['client.allow']);
  assert.equal(t('client.allow'), 'Allow');
});

test('t: неизвестный ключ или локаль не роняют вызов — фолбэк en, затем сам ключ', () => {
  setLocale('ru');
  assert.equal(t('no.such.key'), 'no.such.key');
  setLocale('en');
  assert.equal(t('no.such.key'), 'no.such.key'); // отсутствует в обеих — ключ как есть
});

test('initLocale: сохранённый выбор сильнее системы, неизвестная локаль — фолбэк en', () => {
  assert.equal(initLocale('ru'), 'ru');
  assert.equal(getLocale(), 'ru');
  assert.equal(initLocale('fr'), 'en');
  setLocale('en');
});

test('initLocale: без сохранения следует системной локали (stub), неизвестная система — фолбэк en', () => {
  const realDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const stubSystem = (language) => Object.defineProperty(globalThis, 'navigator', {
    value: { language }, configurable: true,
  });
  try {
    stubSystem('ru-RU');
    assert.equal(initLocale(null), 'ru'); // ожидание задано стабом, не результатом вызова
    assert.equal(getLocale(), 'ru');
    stubSystem('en-GB');
    assert.equal(initLocale(undefined), 'en');
    assert.equal(getLocale(), 'en');
    stubSystem('de-DE'); // системный язык вне словаря — честный фолбэк en
    assert.equal(initLocale(null), 'en');
  } finally {
    Object.defineProperty(globalThis, 'navigator', realDescriptor);
    setLocale('en');
  }
});

test('pickLocale: Accept-Language с q-весами, тегами с регионом и мусором', () => {
  assert.equal(pickLocale('ru-RU,ru;q=0.9,en;q=0.8'), 'ru');
  assert.equal(pickLocale('en-US,en;q=0.9'), 'en');
  assert.equal(pickLocale('fr-CH,fr;q=0.9,ru;q=0.8,en;q=0.7'), 'ru');
  assert.equal(pickLocale('de-DE,de;q=0.9'), 'ru'); // ни ru, ни en → дефолт продукта
  assert.equal(pickLocale('*'), 'ru');
  assert.equal(pickLocale(undefined), 'ru');
});

test('словари ru/en покрывают одно и то же множество ключей', () => {
  const ruKeys = Object.keys(ru).sort();
  const enKeys = Object.keys(en).sort();
  assert.ok(ruKeys.length > 100, 'словарь не должен быть пустышкой');
  assert.deepEqual(ruKeys, enKeys);
});
