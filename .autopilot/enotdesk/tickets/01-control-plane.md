# 01 — Команда и временные сессии
Требования: R07,R08,R09,R10,R11,R12,R14,R15,R16,R18. Blocked by: none. Волна: 1. Зона: server/, package.json, package-lock.json, .gitignore, .env.example.

Из брифа: «в первой» (командные функции); «логин и пароль ... одноразовый»; «пока программа работает сессия живёт».

Спецификация §2–3,6–9 и interfaces.md обязательны. Создать полноценный Node24 SQLite HTTP/WS сервис по замороженному контракту. Admin bootstrap CLI interactive hidden password; no credentials printed. Все RBAC/invite/contact/audit/history операции работают с реальной БД. Session ID/password/token серверные, claim single-owner и consent gate, WS relay строго принадлежность/состояние/валидация, heartbeat и revocation.

Приёмка:
- auth/roles/revocation и last-admin защита, invites atomic/expiry/revoke, contacts revision/search/page, audit/history persistence;
- no secret logging, rate/body/frame limits, startup localhost, origin checks;
- реальный HTTP/WS check полного register/claim/consent/relay/end + негативные stale/crossed sockets;
- restart invalidates live sessions and keeps team/contact/audit;
- node:test через публичный шов, smoke startup и /health;
- package scripts подготовлены для desktop T02/pack T04, deps exact pins verified current docs; avoid speculative deps;
- вернуть CONTRACT, результаты, blockers; no commit. Root mockup пока не менять.
