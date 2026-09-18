# Interfaces — EnotDesk upgrade v2

## Границы, решённые в спецификации

| Модуль | Владеет | Выставляет | Прячет |
|---|---|---|---|
| `client/lib/adaptive-bitrate.mjs` | политика качества видео | `nextTarget({lossPct, rttMs}, current, lastChangeAt, now) → {target, changed}` | ступени, гистерезис |
| `client/lib/first-run.mjs` | резолв адреса сервера при первом запуске | `resolveServerUrl({saved, execPath}) → {url, source}` | чтение файла, парсинг, порядок |
| `client/lib/term.mjs` | PTY-шов терминала агента | `createTerm({shell, cols, rows}) → {write, onData, resize, kill}`; `spawnShellFor(platform)` | различия ОС, контекст запуска |
| `client/lib/notify.mjs` | toast на экран машины | `showToast(platform, text) → {ok, reason?}` | WTSSendMessage/notify-send/osascript |
| `server/webhooks.mjs` | события→доставка | `createWebhooks(db) → {emit(event, payload), configure(url, secret)}` | подпись HMAC, ретраи |
| `server/totp.mjs` | RFC 6238 + base32 + резервные коды | `generateSecret/verifyCode(secret, code, {now})/backupCodes` | крипто-детали |
| `server/app.mjs` (новые маршруты) | /machines/:id/inventory, /machines/:id/toast, /settings/webhooks, /auth/totp* | HTTP | валидация, RBAC |
| web `/machines` панель | UI машин | страница (admin) | переиспользование web/* |

**Швы для тестов**: существующие (createServer HTTP/WS; lib-шимы без Electron; контракт-тесты renderer/web). Новый шов один: `createTerm` — фейк-PTY + фейковый spawn (реальные shells — MANUAL-QA).

## Правила проекта (из AGENTS.md, дословно по существу)

- Server is pure ESM `.mjs`, node:sqlite, no frameworks — only `ws` + `koffi` + `electron-updater`. Electron: contextIsolation true, sandbox true; renderer только через `window.enot`.
- Всё входящее — allowlist и лимиты; unavailable → honest status, никогда не фейкуем.
- Токены/секреты — только хешами или зашифрованными (AES-256-GCM от ENOT_SECRET_KEY); в renderer не утекают.
- Русские тексты ошибок через словари (client/locales, ключи ru=en, паритет-тест).
- electron 44.3.0, koffi 3.2.1, electron-updater 6.8.9, ws 8.21.3 — точные пины; `asarUnpack: node_modules/koffi/**` обязателен.
- Input decision — в main по `gate.isOpen()`; RBAC на каждом запросе; audit append-only.
- Команды: `npm test` (200 тестов), `npm run lint`, `npm run smoke:local`, `node --test <path>`.
- Зависимости не добавлять — верни `BLOCKED` с названием. Коммиты — не делай (оркестратор).
- ADR нумерация продолжается с 0019 (docs/adr/).

## Из таска 01 — koffi-срез

- electron-builder files: исключения koffi/src|vendor|doc + реинклюды `node_modules/koffi/src/koffi/{*.cjs,*.js}`, `src/koffi/src/{*.cjs,*.js}` — ПОРЯДОК ПАТТЕРНОВ ЗНАЧИМ (последний совпавший побеждает); бинарник @koromix остаётся
- Факт: app.asar.unpacked koffi 1.0M → 296K; SMOKE собранного бинарника OK

## Из таска 02 — адаптивный битрейт

- `client/lib/adaptive-bitrate.mjs`: `nextTarget({lossPct, rttMs}, current, lastChangeAt, now) → {target, changed}`; ступени 2500/1200/600; вниз при loss≥5 или rtt>400; вверх при loss<2 И rtt<150 не раньше 15 с; TOP_BITRATE export
- adaptive-цикл живёт на HOST (startHostRtc, опрос 2 с, setParameters); summarizeStats читает remote-inbound-rtp (потери исходящего)
- смена источника не сбрасывает ступень

## Из таска 03 — first-run конфиг (ВАЖНО: CSP-фикс)

- `client/lib/first-run.mjs`: `resolveServerUrl({saved, execPath, baked, defaultUrl?}) → {url, source∈saved|file|baked|default}`; файл `enotdesk-server.txt` рядом с execPath (≤4КБ, первая непустая строка)
- CSP index.html: `connect-src 'self' file:` — БЕЗ этого JSON-импорты словарей падают и ВЕСЬ граф модулей рендерера мёртв (ассерт в контракт-тесте); встренные EDESK_SMOKE_FIRSTRUN=1 — изолированный профиль для first-run скриншотов
- i18n ключи: server.*, firstRun.* (ru=en)

## Из таска 06 — инвентарь

- `server/machines.mjs`: `sanitizeInventory(value) → {os,appVersion,uptimeSec,diskFreeGb}|null` (allowlist, строки ≤60, числа finite ≥0, >4КБ → null); `touch(id, {inventory})`
- GET /machines/:id — новый (admin+operator, sanitized out()); inventory едет в HTTP-машинном heartbeat (не в WS-сессионном)
- агент: `api.heartbeat(token, inventory?)`; policy.getInventory → collectInventory() в main (statfs; недоступно — поле нет)

## Из таска 10 — доукрепление терминала

- `BRIDGE_IPC.ICE_CONFIG='enot:rtc-ice-config'` (main→мост); `createBridgeRelay({send, log, onClosed, fetchIceServers})` — async-хук один раз перед первым OFFER; сбой/пусто → iceServers:[] + причина
- очередь паузы: хвост ≤1МБ (старшие куски выбрасываются, кусок > капа роняется); гонка ANSWER-раньше-createAnswer кэшируется; канон BRIDGE_IPC захардкожен в контракте (sandbox-preload не может импортировать модули)
- ПРЕДУПРЕЖДЕНИЕ: runtime-подключение fetchIceServers в main/agent — делается отдельным хвостом (зона main.mjs)
