# 04 — D1: webhooks (HMAC, ретраи)

**Требования:** R10, R10.1
**Blocked by:** —
**Зона:** `server/webhooks.mjs` (новое), `server/app.mjs` (emit-вызовы + админ-маршрут настроек), `server/db.mjs` (settings-таблица), `server/test/webhooks.test.mjs` (новое)
**Волна:** 2
**Status:** ready

## Что должно заработать

Self-hostер задаёт URL+secret — сервер сам шлёт события сеансов на его URL
с HMAC-подписью, с ретраями. Не блокирует сеансы при сбоях доставки.

## Из брифа, дословно

> «D1» — webhooks: session.started/ended, machine.claim.denied, HMAC+ретраи

## Разделы спецификации

Истории 13–14, Решения §webhooks.

## Критерии приёмки

- [ ] `createWebhooks(db)` → `{emit(event, payload), configure(url, secret)}`; события: session.started, session.ended, machine.claim.denied
- [ ] POST с `X-Enot-Signature: hex(HMAC-SHA256(secret, body))`; ретраи 3× (1с/10с/60с), потом drop; доставка async — сеансы не ждут
- [ ] Секрет не в логах; события фильтруются по настройке
- [ ] Админ-маршрут POST /settings/webhooks (только admin); тесты: подпись, ретраи (фейк-fetch), фильтр, RBAC
