# Interfaces — EnotDesk Hub

## Границы, решённые в спецификации

| Модуль | Владеет | Выставляет | Прячет |
|---|---|---|---|
| `hub/main.mjs`+`hub/app.mjs` | HTTP/WS хаба | `createHub({dbPath,port,enotdeskUrl,publicUrl,secretKey,...}) -> {server,db,start,close}` | маршруты/лимиты |
| `hub/db.mjs` | схема hub.db | `openHubDb`, schema_version-миграции | SQL |
| `hub/auth.mjs` | SSO-прокси+cookie-сессии | `createAuth({enotFetch})` | bearer-хранение, sid |
| `hub/threads.mjs` | треды/сообщения/контакты | store: threads/messages/contacts CRUD, фильтры | SQL |
| `hub/widget/` | виджет | `/widget.js` (лоадер), `/w` (iframe), WS `/ws/widget` | протокол гостя |
| `hub/join.mjs` | one-click | `/api/hub/join/:t/report`, генерация join-токенов | токены |
| `hub/email.mjs` | email-канал | `createEmailChannel({imap,smtp,store})` | креды, парсинг |
| `client/lib/join.mjs` | парс ссылок | `parseJoinLink(url) -> {server,token}|null` | — |
| `hub/web/` | консоль агента | `/hub/` страница | i18n-переиспользование |

**Швы для тестов**: createHub HTTP/WS (фейк-EnotDesk через enotFetch-инъекцию), lib-шимы (parseJoinLink, email-маппер, фейк-IMAP/SMTP), контракты UI-страниц (id/кнопки/словари).

## Правила проекта (кратко; полные — AGENTS.md)

- Чистый ESM .mjs, без фреймворков; новые зависимости ТОЛЬКО imapflow+nodemailer (решено владельцем), точные пины.
- Всё входящее — allowlist/лимиты; unavailable → честный статус; токены/секреты — хеши или AES-256-GCM от ENOT_SECRET_KEY; в логи не пишутся.
- i18n: ключи hub.*/widget.* в client/locales/{ru,en}.mjs — ПАРИТЕТ (тест).
- Электро́н-клиент: contextIsolation/sandbox; ввод — только по gate; токены не утекают в renderer; hostToken не покидает клиент (join-репорт шлёт только sessionId+password).
- ADR: 0023 hub+SSO, 0024 one-click протокол, 0025 email-канал.
- Тесты: `npm test` (335 + hub/test/*.test.mjs), один файл `node --test <path>`; lint чист; коммитит оркестратор.

## Из таска 01 — каркас

- `createHub({dbPath,port,host,enotdeskUrl,publicUrl,secretKey,version,enotFetch,now}) → {server,db,auth,start,close}`; маршруты /api/hub/{health,auth/*}; статика /hub/ (index.html+app.mjs+i18n+locales); заглушки /w,/join (200), /widget.js (501 — до T03)
- `createAuth({db,enotdeskUrl,secretKey,enotFetch,sessionTtlMs,revalidateMs,now})` → {login,authUser,logout,session}; cookie enot_hub_sid HttpOnly SameSite=Lax (+Secure на https); sid в БД sha256; bearer AES-256-GCM (ENOT_SECRET_KEY); ревалидация /auth/me кэш 60с
- env: ENOT_HUB_PORT/ENOT_HUB_HOST/ENOT_HUB_DB/ENOTDESK_URL/HUB_URL/ENOT_SECRET_KEY; compose profile `hub` (COMPOSE_PROFILES), Caddy: /hub/*, /widget.js, /w, /join, /api/hub/* → hub:8090
- health: {ok, enotdesk} — кэш 5с

## Из таска 04 — one-click клиент

- `client/lib/join.mjs`: `parseJoinLink(url) → {server,token}|null` (enotdesk://join, server через normalizeServerUrl allowInsecureHttp, токен [A-Za-z0-9_-]{16,128}); `reportJoin(server,token,{sessionId,password},fetchImpl)` → POST `${server}/api/hub/join/${t}/report` — БЕЗ hostToken
- preload: `enot.onJoinStart(cb)`, `enot.joinReport(server,token,creds)`; main: протокол регистрируется только в упаковке (!SMOKE&&!AGENT&&isPackaged); open-url/argv/second-instance с доставкой после did-finish-load; автостарт через существующий startHelp; saved-сервер из ссылки
- electron-builder: protocols [{name:'EnotDesk Help', schemes:['enotdesk']}]
