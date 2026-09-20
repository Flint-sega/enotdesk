# Спецификация: EnotDesk Hub — тикет-система + чат-виджет с интеграцией EnotDesk

## Задача

У нас есть self-hosted удалённая поддержка EnotDesk, но нет «переднего края»:
клиенту некуда написать на сайте, обращения сыпятся в личную почту, истории нет.
Нужен отдельный сервис, ставящийся рядом с EnotDesk: чат-виджет на сайт
(как livechat.com, только свой и лёгкий), полноценные тикеты (из чата, с почты,
от операторов), и — главное — из чата оператор одной кнопкой зовёт клиента
в сеанс удалённой помощи. Живые машины пока не трогаем: код+тесты+ревью.

## Решение

Сервис **EnotDesk Hub** (`hub/`, тот же монорепо): чистый Node ESM + собственная
SQLite, ставится флажком в compose/quick-setup, за Caddy на том же домене.
Агенты входят теми же учётками EnotDesk (SSO). Консоль-инбокс (тёмная тема,
ru/en) с тредами-«тикетами» (каналы: чат/email/ручные), canned-ответами по #,
тегами, статусами агентов и рейтингом чата. Виджет — одна строка на сайт:
пузырь-iframe, WS-канал гостя, pre-chat форма, offline-форма → тикет.
Из чата — карточка «Подключиться»: одноразовая ссылка `enotdesk://join`
запускает установленное приложение (протокол) или страницу /join со скачиванием;
клиент сам создаёт сеанс и репортит креды в hub, агент автоклеймит.
Почта: IMAP-поллинг → тикеты, SMTP → ответы. События сеансов (webhooks)
ложатся в тред системными сообщениями.

## Пользовательские истории

| # | Метка | История | Приёмка |
|---|-------|---------|---------|
| 1 | R01 | Как self-hostер, я ставлю Hub вместе с EnotDesk (галочка в quick-setup / compose-сервис) | health хаба; Caddy-маршруты /hub, /widget.js, /w, /join |
| 2 | R01.1 | …и хаб здоров только когда доступен EnotDesk (SSO) | health отражает зависимость честно |
| 3 | R02 | Как оператор, я вижу инбокс тикетов/чатов: фильтры (статус/канал/тег/исполнитель), поиск, пагинация | REST + UI; i18n ru/en |
| 4 | R02.1 | …и веду тред: отвечаю, ставлю статус open/pending/resolved, теги, заметки (не видны клиенту), canned-ответы по # | контракты UI + тесты REST |
| 5 | R03 | Как владелец сайта, я вставляю ОДНУ строку — на сайте появляется пузырь чата | widget.js + iframe; работает на чужом домене (CORS-allowlist) |
| 6 | R03.1 | Как посетитель, я пишу в чат без регистрации: pre-chat имя/email (опц.) + строка согласия (GDPR: ссылка на политику — поле админа; чат не стартует без галочки, если включено настройкой); offline-форма создаёт тикет | WS-гость-цикл; offline→тикет (тест); consent-гейт |
| 7 | R03.2 | …и моя история сохраняется между визитами (visitor-cookie) | история по visitor_id |
| 8 | R04 | Как посетитель, по кнопке из чата я запускаю помощь одной ссылкой: протокол enotdesk:// — приложение открывается и само начинает сеанс | парсер-тесты; фейк-цикл клиент→hub |
| 9 | R04.1 | …если приложения нет — /join-страница: скачать + инструкция + та же кнопка | страница; MANUAL-QA живой прогон протокола |
| 10 | R07 | Как оператор, я жму «Подключиться» в чате → клиент получает карточку → после запуска клиента сеанс автоклеймится и падает в тред | сквозной фейк-тест hub+EnotDesk |
| 11 | R07.1 | …и события сеанса (started/ended) видны в треде системными строками | webhook→тред (тест) |
| 12 | R08 | Как клиент, я пишу письмо на support@ — создаётся тикет, ответ оператора приходит мне на почту | IMAP-поллер (фейк), SMTP (фейк), маппинг Message-ID/subject |
| 13 | R08.1 | Как админ, я настраиваю IMAP/SMTP в консоли; пароли не светятся | креды AES-256-GCM; не в логах (тест) |
| 14 | R09 | Как оператор ИЛИ админ (любой с доступом к программе), я завожу тикет вручную (тема, текст, контакт) | REST+UI тест; RBAC обе роли |
| 15 | R10 | Как новый агент, я понимаю консоль без обучения: инбокс, цветные статусы, честные пустые состояния | контракты UI; пустые состояния |
| 16 | R11 | Как агент, у меня canned-ответы (#шорткат), теги, рейтинг чата после завершения, статус online/away/offline (виджет честно показывает) | тесты; виджет реагирует |
| 17 | R13i | Как владелец, прогон даёт тесты/lint/smoke/ревью/ADR; бренд и i18n едины | цель ~430+ тестов; ADR 0023-0025 |

## Решения по реализации

- **hub/ без фреймворка**: node:http + ws (как server/); SQLite hub.db, миграции schema_version; порт ENOT_HUB_PORT (8090); тот же стиль кода/ошибок/allowlist.
- **Новые зависимости**: `imapflow`, `nodemailer` — точные пины, первое добавление со старта (решение владельца).
- **SSO**: POST /hub/auth/login → прокси в EnotDesk /auth/login; hub-сессия sid (HttpOnly, SameSite=Lax, Secure на https) → bearer в записи сессии; ревалидация /auth/me; RBAC operator/admin из роли EnotDesk.
- **Модель**: contacts(visitor_id,email,name), threads(channel,status,assignee,tags,rating,subject,last_activity,contact_id), messages(author,type text|card|note,body,agent_id). Тикет = thread.
- **Виджет**: /widget.js — лоадер (читает data-server), создаёт iframe /w; WS /ws/widget (visitor_id-cookie на домене hub); CORS-allowlist origins (настройка, эхо Origin на HTTP-эндпоинтах виджета).
- **One-click**: hub генерирует одноразовый join-token (TTL 10 мин, привязан к треду); ссылка `enotdesk://join?server=<enot-url>&t=<token>`; клиент регистрирует протокол (electron-builder protocols + main.mjs open-url/argv/second-instance), парсит, ставит serverUrl, сам POST /sessions и репортит {sessionId,password} на hub /api/hub/join/:t/report (одноразовый); hub: авто-claim (bearer агента из сессии), system-сообщение в тред. hostToken НИКОГДА не покидает клиент.
- **Webhooks**: hub принимает на /hooks/enotdesk (HMAC по секрету из настроек хаба) session.started/ended → system-сообщения в тред, связанный по sessionId.
- **Email**: imapflow-поллер (интервал, unref) → inbound → тред по Message-ID/In-Reply-To else from+subject; nodemailer — отправка ответов (thread channel=email); креды AES-256-GCM (ENOT_SECRET_KEY).
- **Деплой**: compose-сервис hub (x-hardening, depends_on enotdesk, env ENOTDESK_URL/ENOT_SECRET_KEY/HUB_URL); quick-setup: вопрос «Установить EnotDesk Hub?» (docker + bare-metal юнит enotdesk-hub).
- **Разведка конкурентов** зафиксирована: UX livechat.com (копируем перечисленное), паттерны Chatwoot (Conversation+Message, embed+iframe, IMAP-поллинг), «ссылка→помощь» — TeamViewer/AnyDesk-стиль. В ADR 0023.

## Границы и швы

| Модуль | Владеет | Выставляет | Прячет |
|---|---|---|---|
| `hub/main.mjs`+`hub/app.mjs` | HTTP/WS хаба | `createHub({dbPath,port,enotdeskUrl,...})` | маршруты/лимиты |
| `hub/db.mjs` | схема hub.db | `openHubDb`, миграции | SQL |
| `hub/auth.mjs` | SSO-прокси+сессии | `createAuth({enotFetch})` → middleware | bearer-хранение |
| `hub/threads.mjs` | треды/сообщения/контакты | store CRUD | SQL |
| `hub/widget/` | лоадер+страница виджета | /widget.js, /w, WS | внутренний протокол |
| `hub/join.mjs` | join-токены/репорт/автоклейм | `/api/hub/join/*` | токен-генерация |
| `hub/email.mjs` | IMAP/SMTP | `createEmailChannel({imap,smtp,store})` | креды, парсинг |
| `client/lib/join.mjs` | парс enotdesk:// | `parseJoinLink(url)` | — |
| `hub/web/app.html+mjs` | консоль агента | /hub/ | переиспользование i18n |

Швы для тестов: createHub (HTTP/WS, фейк-EnotDesk), lib-шимы (parseJoinLink, email-маппер с фейк-IMAP/SMTP), контракты UI-страниц.

## Вне рамок

| Что | Почему |
|---|---|
| Файлы в чате виджета, proactive, SLA, мультиканалы, отчёты, KB, боты | v2 (лайт livechat) |
| Живые проверки (виджет на реальном сайте, протокол 3 ОС, IMAP-ящик) | решение владельца: MANUAL-QA |
| Мобильные приложения, push | не в брифе |

## Открытые места

Плейсхолдеров нет. env-имена: ENOT_HUB_PORT, ENOTDESK_URL, HUB_URL, ENOT_SECRET_KEY (переиспользуется), IMAP_*/SMTP_* — через настройки админа (не env).

## Покрытие манифеста

R01→1-2; R02→3-4,14; R03→5-7; R04→8-9; R05→ADR 0023; R06→весь спек; R07→10-11; R08→12-13; R09→14; R10→15; R11→16; R12→границы/MANUAL-QA; R13i→17.
