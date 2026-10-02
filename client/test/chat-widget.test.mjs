import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldNotify, onIncoming, onCollapse, onExpand } from '../lib/chat-widget.mjs';

test('уведомление: только в свёрнутом виде и не чаще троттла', () => {
  assert.equal(shouldNotify({ collapsed: true, lastNotifiedAt: 0, nowMs: 10_000 }), true);
  assert.equal(shouldNotify({ collapsed: false, lastNotifiedAt: 0, nowMs: 10_000 }), false);
  // троттл: 3 с между уведомлениями
  assert.equal(shouldNotify({ collapsed: true, lastNotifiedAt: 10_000, nowMs: 12_000, minMs: 3000 }), false);
  assert.equal(shouldNotify({ collapsed: true, lastNotifiedAt: 10_000, nowMs: 13_000, minMs: 3000 }), true);
});

test('входящее сообщение показывает виджет; в свёрнутом копит непрочитанные', () => {
  const fromHidden = onIncoming({ visible: false, collapsed: true, unread: 2 });
  assert.deepEqual(fromHidden, { visible: true, collapsed: true, unread: 3 });
  const fromOpen = onIncoming({ visible: true, collapsed: false, unread: 0 });
  assert.deepEqual(fromOpen, { visible: true, collapsed: false, unread: 0 });
});

test('сворачивание сохраняет счётчик, разворот обнуляет', () => {
  assert.deepEqual(onCollapse({ unread: 4 }), { visible: true, collapsed: true, unread: 4 });
  assert.deepEqual(onExpand(), { visible: true, collapsed: false, unread: 0 });
});
