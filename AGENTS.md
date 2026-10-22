# EnotDesk — инструкции для агентов и контрибьюторов

Портативная удалённая поддержка, self-hosted, AGPL-3.0. Клиент помощи запускается без установки (Windows/macOS/Linux), передаёт одноразовые ID и пароль оператору через обычный чат; закрытие окна сразу завершает доступ. Это оригинальное приложение на Electron и WebRTC, не форк RustDesk (ADR 0001). Есть unattended-агент (служба ОС), браузерный оператор `/operator` и опциональный Hub (тикеты, виджет, email).

> Локальные заметки мейнтейнера (лаба, прод, история волн), если файл есть: `.local/AGENTS.private.md` — прочитать в начале сессии. В git он не входит. **Ничего о стенде, проде, адресах и доступах в этот файл не писать**: его охраняет `client/test/docs-guard.test.mjs`.

## Команды
- `npm install` — node ≥ 24.12. Рантайм-зависимости клиента и сервера: `ws`, `koffi`, `electron-updater`; только Hub дополнительно использует `imapflow` и `nodemailer` (ленивый импорт). Пины точные.
- `npm test` — node:test по `server/test`, `client/test`, `hub/test` (~724 теста, Electron не нужен). Один файл: `node --test server/test/lifecycle.test.mjs`.
- `npm run lint` — ESLint. `npm run smoke:local` — полный цикл bootstrap → login → invite → session → claim → consent → WS relay → end на временной БД.
- `npm run server` — сервер на `127.0.0.1:8080`, `GET /api/v1/health` → `{ok,version,activeSessions,uptimeSec}`. `npm run bootstrap` — первый админ. `node hub/main.mjs` — Hub на `127.0.0.1:8090`.
- `npm start` — Electron-клиент. Смоук: `EDESK_SMOKE=1 npx electron@44.9.0 client/main.mjs --no-sandbox`. Второй экземпляр — `EDESK_ALLOW_MULTI=1`, профиль первого запуска — `EDESK_SMOKE_FIRSTRUN=1`.
- `npm run pack:mac|pack:win|pack:linux` — electron-builder (`build/electron-builder.yml`). Релизы собирает `.github/workflows/release.yml` по тегу `v*`.
- Сервер: `sudo bash scripts/quick-setup.sh` (мастер: bare-metal или `--docker`, `--update`, `--dry-run`, `--hub/--no-hub`), `scripts/install-server.sh`, `compose.yaml` (сервер + coturn + Caddy, профиль `hub`), `node server/backup.mjs <db> <dir> [keep]` (VACUUM INTO).
- Внешний цикл против живого сервера: `ENOT_BASE_URL=… ENOT_ADMIN_LOGIN=… ENOT_ADMIN_PASSWORD=… node scripts/smoke-remote.mjs`.

## Структура
```
server/      app.mjs (REST /api/v1, WS /signal, страницы, статика, relay файлов, WoL, /rtc-config), machines.mjs, totp.mjs, webhooks.mjs, pages.mjs, db.mjs (SCHEMA_VERSION=10), crypto.mjs, backup.mjs, bootstrap.mjs, main.mjs, test/
hub/         опциональный сервис: app.mjs, auth.mjs (SSO через EnotDesk), threads.mjs, settings.mjs, email.mjs, join.mjs, db.mjs (свой hub.db, SCHEMA_VERSION=5), web/ (консоль), widget/, test/
client/      main.mjs (окно, токены, WS, ворота ввода, агент-режим, SCM-родитель, мост RTC, updater, окно оператора), preload.cjs (window.enot), operator-preload.cjs (window.enotOperator — «запомнить меня» в окне оператора)
client/agent-bridge/  скрытое окно с RTCPeerConnection для машинного сеанса: relay.mjs, bridge.mjs, page.html, preload.cjs
client/lib/  модули без Electron: protocol, input-pipeline, input-arbiter, native-input (koffi), notify, term, agent, video-host, session-spawn, win-service, adaptive-bitrate, rtc-stats, i18n, first-run, updater, join и др.
client/renderer/  UI клиента помощи (host) и карточка окна оператора (app.js, session-media.js, session-services.js, views/client-view.js); dom.js/state.js импортирует и /operator
client/locales/   ru.mjs, en.mjs (паритет ключей проверяет тест)
client/agent-service/  службы агента: Windows (sc.exe), Linux (systemd), macOS (LaunchAgent пользователя, ADR 0038) + install/remove
web/         единственная программа оператора /operator, её же показывает desktop (operator.html, operator.mjs, input-source.mjs, team.js, records.js — контакты/история/журнал/CSV, account.js — пароль и 2FA; ADR 0033)
helper/video/  Rust-хелпер Windows: захват DXGI/GDI и ввод в консольной сессии, named pipe (ADR 0027)
docker/ Dockerfile compose.yaml   серверный стек
scripts/     quick-setup.sh, install-server.sh, deploy-server.sh, smoke-local.mjs, smoke-remote.mjs, make-icons.mjs, make-mascot.mjs, make-social.mjs (картинки соцпревью)
site/        публичная витрина (GitHub Pages)
docs/        guides/ (руководства людям: клиенту, оператору, админу, постоянный доступ, «если что-то не так», откат выпуска), SESSION_PROTOCOL, SERVER, AGENT, WEB-OPERATOR, BUILD, ACCEPTANCE-1.0 (определение готовности 1.0), MANUAL-QA, ROADMAP, LAB, adr/0001–0038
```

## Архитектура (кратко; подробности в docs/ и ADR)
- **Attended:** клиент `POST /api/v1/sessions` → sessionId (9 цифр) + пароль + hostToken. Оператор делает claim, хост даёт согласие, оба подключаются к WS `/signal`. Сервер пересылает только offer/answer/ICE; **хост офферит**, отдельный pc на каждого оператора. Обрыв WS в approved — грейс `ENOT_GRACE_MS`; до согласия — fail-closed (ADR 0013).
- **Unattended:** админ создаёт машину → одноразовый onboarding-код → агент (`EDESK_AGENT=1`) меняет его на токен. Claim оператора требует причину и PIN (политика на сервере), агент соглашается автоматически. **Оператор офферит**, pc агента живёт в скрытом окне моста. Windows: служба `EnotDeskAgent` = SCM-родитель на koffi (`EDESK_AGENT_SVC=1`, ADR 0026), видео и ввод — через хелпер в консольной сессии (ADR 0027); хелпер из Program Files запускается от SYSTEM и следует за рабочим столом ввода — экран входа и блокировки (ADR 0036). Linux/X11: видео через getDisplayMedia в мосту (ADR 0031), ввод — XTest.
- **Сервисы сеанса** — DataChannel: `input`, `chat`, `clip`, `file`, `term` (ADR 0014/0021). Relay сервера не расширяется; у файлов есть серверный fallback `/relay`.
- **Мультиоператор:** адресация `to/from` по claimId, арбитраж ввода в main (`input-arbiter`), до 3 видеослотов (ADR 0030); join к машине — по паролю из claim (ADR 0032); список участников, передача управления и «только смотреть» (ADR 0035).
- **Решение о вводе** принимает только main хоста по реальному состоянию WS (`gate.isOpen()`), рендереру и браузеру не доверяем.
- **RBAC** admin/operator/auditor на каждом запросе; audit и history пишутся только сервером; срок хранения, очистка и выключатель рутинных записей — у админа, события безопасности пишутся всегда (ADR 0034); TOTP-2FA (`ENOT_SECRET_KEY`, AES-256-GCM); webhooks с HMAC-подписью; ретенция БД раз в час.
- **TURN:** `/rtc-config` выдаёт эфемерные креды coturn REST (HMAC-SHA1 от `ENOT_TURN_SECRET`, TTL 1 ч).
- Платформенный слой (Electron, WebRTC, koffi, службы, docker) подробно описан в проектном скилле `enotdesk-platform`, если он установлен локально.

## Конвенции
- Сервер — чистый ESM `.mjs`, node:sqlite (experimental warning — норма), без фреймворков. Пины точные: electron 44.9.0, koffi 3.3.3, electron-updater 6.8.9, ws 8.22.0, imapflow 2.5.8, nodemailer 10.1.7. Не бампать и не добавлять зависимости без решения мейнтейнера.
- Electron: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; рендерер — только через мост `window.enot`, каждый IPC проверяет отправителя.
- Всё входящее проходит allowlist и лимиты. Недоступная платформа честно сообщает код причины (`native-unavailable`, `wayland-unsupported-control`, `video-unsupported-platform`, `no-active-session`, `term-busy`…), фейковый успех запрещён.
- Токены, пароли и коды в БД — только хешами; шифруемые секреты — AES-256-GCM от `ENOT_SECRET_KEY`; токены не попадают в рендерер; секреты не идут в argv и логи.
- Пользовательские тексты — через словари `client/locales/{ru,en}.mjs` (ключи совпадают, `error.code` не локализуется).
- ADR в `docs/adr/`: следующий номер — 0039.
- README.md (en) ↔ README.ru.md. Лицензия AGPL-3.0.

## Окружение
Сервер: `ENOT_HOST`, `ENOT_PORT`, `ENOT_DB`, `ENOT_DIST_DIR`, `ENOT_PUBLIC_URL`, `ENOT_TURN_URLS`, `ENOT_TURN_SECRET`, `ENOT_TURN_USERNAME`, `ENOT_TURN_PASSWORD`, `ENOT_GRACE_MS`, `ENOT_RETENTION_DAYS`, `ENOT_MAX_SESSIONS`, `ENOT_MIN_CLIENT_VERSION`, `ENOT_SECRET_KEY`, `ENOT_TRUSTED_PROXY`. Hub: `ENOT_HUB_HOST`, `ENOT_HUB_PORT`, `ENOT_HUB_DB`, `ENOTDESK_URL`, `HUB_URL`. Compose: `DOMAIN`, `TURN_SECRET` (обязателен), `HUB`, `COMPOSE_PROFILES=hub`. Сборка: `ENOT_BAKED_SERVER_URL` (через `-c.extraMetadata.…`). Клиент и агент: `EDESK_SMOKE`, `EDESK_SMOKE_PATH`, `EDESK_SMOKE_FIRSTRUN`, `EDESK_ALLOW_MULTI`, `EDESK_AGENT=1`, `EDESK_AGENT_NAME`, `EDESK_AGENT_CODE` (только первая регистрация), `EDESK_AGENT_SVC`, `EDESK_AGENT_VIDEO=off`. Значения не коммитятся (шаблон `.env.example`).

## Тесты
- Серверные HTTP/WS-циклы, lib-шимы без Electron (koffi, spawn, net — инъекцией), контракт рендерера и web-оператора («анти-мёртвые кнопки», i18n), Hub на фейках сети. `client/test/agent-term-bridge.test.mjs` исполняет настоящий `bridge.mjs`.
- Ожидания событий в серверных тестах — через `ws.wait(pred)` с дедлайном `WAIT_MS` (10 с, `ENOT_TEST_WAIT_MS`). Отрицательные проверки («сообщения не будет») передают ms явно. Тесты с короткими lease/grace чувствительны к сильной загрузке машины.
- Не покрыто автотестами (ручная приёмка `docs/MANUAL-QA.md`): живая инъекция ввода, WebRTC между машинами, службы на живых ОС, реальный PTY, тосты Windows, живой IMAP/SMTP, `enotdesk://join` на живых ОС. Докладывать честно.

## Ловушки
- koffi 3: полные C-сигнатуры строкой; асинхронный вызов — `fn.async(...args, cb)`; повторный `koffi.struct` с тем же именем бросает исключение; загрузка ленивая, ошибка — inert-режим, никогда не throw.
- `electron-builder.yml`: побеждает последний совпавший паттерн (koffi-реинклюды идут после `!src/**`); `asarUnpack: node_modules/koffi/**` обязателен; **не добавлять платформенный `files:`** (утягивает весь репо в asar); `electronLanguages` — только `en-US`, не `en`; `${env.*}` в extraMetadata не раскрывается.
- Серверные страницы и `/operator` импортируют `client/lib`, `client/renderer` (dom/state) и словари: Dockerfile, `deploy-server.sh` и релизный тарбол обязаны их копировать.
- `BRIDGE_IPC` и имена каналов захардкожены в sandbox-preload моста (`client/agent-bridge/preload.cjs`).
- compose без `TURN_SECRET` падает на интерполяции; сервис `hub` без `command` запускает второй сервер вместо хаба.
- Single instance: второй экземпляр уходит молча; агент живёт в своём профиле `userData/agent` и работает рядом с клиентом.
- Windows portable не умеет самообновление (только уведомление); установленная NSIS-сборка обновляется сама (ADR 0029).
- Linux: без `--ozone-platform=x11` Electron 44 падает на Wayland (флаг ставит main). Профиль агента — `~/.config/enotdesk/agent` (строчными).
- `npm run icons` — только macOS.

## Фоновые процессы (после сбоя Mac 20.10.2026)
- Никаких бесконечных циклов ожидания: у каждого поллера дедлайн (≤30 мин) или число итераций. Ждать процесс — по PID (`while kill -0 $PID`) или `wait`; `until ! pgrep -f 'строка'` находит сам себя и не кончается никогда.
- Не отвязывать процессы от сессии (`nohup`, `disown`, `setsid`, `&`, `screen`/`tmux`) без прямой просьбы владельца; перед концом работы остановить всё фоновое, что запустил сам, и написать, что осталось запущенным.
- Долгоживущая служба — только по просьбе владельца, как LaunchAgent или Docker, с записью в `handoff.md`.
- Проверка сирот: `ps -axo pid,ppid,etime,command | awk '$2==1' | grep -E 'zsh|bash|sh -c|sleep|python|node'`.
