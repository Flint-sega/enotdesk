# Браузерный оператор `/operator`

Страница для оператора и администратора: тот же аккаунт, тот же протокол, что у
desktop-клиента — без установки приложения. Спецификация: истории 14–19
(`.autopilot/2026-09-17-enotdesk-oss--wip/spec.md`), шов — `web/`.

## Как это работает

- `GET /operator` — отдаёт `web/operator.html`. Статус по роли: аноним — `401`
  (форма входа), `auditor` — `403` («недостаточно прав»), `operator`/`admin` — `200`.
  Роль браузер подтверждает cookie `enot_op` (ставит сама страница после login,
  `path=/operator`, `SameSite=Strict`, `Secure` на HTTPS) — навигация не умеет
  слать `Authorization`. Каждый `/api/v1/*` и WS-аутентификация всё равно
  проверяют Bearer-токен на сервере: страница без данных, RBAC один на проект.
- Логика страницы — `web/operator.mjs`: login (`POST /api/v1/auth/login`), claim
  (`POST /api/v1/sessions/:id/claim`), `WebConnector` — нативный WebSocket
  `/signal` с тем же сообщением `auth`, что у desktop (`role: 'operator'`,
  `claimId`, токен). Клиент — оферер, страница отвечает answer'ом; ICE-кандидаты
  до remote-description стоят в очереди.
- Сессия: DataChannel-каналы `input` / `chat` / `clip` / `file` (ADR 0014) — те
  же имена и протоколы, что в desktop (`client/lib/chat.mjs`,
  `clipboard-sync.mjs`, `file-transfer.mjs` переиспользуются буквально).
- Ввод: `web/input-source.mjs` (`wireBrowserInput(video, send, {keys})`)
  переводит pointer/wheel/keyboard в allowlist-события протокола через
  `keyFromCode` (физические коды, раскладка не важна) и `wheelToLines`.
- Состояния: ожидание согласия, `peer-reconnecting` / `resumed` (грейс ADR 0013),
  `ended` с причиной, ошибки сигналинга. Обрыв WS при живом сеансе показывает
  карточку «Переподключиться»: повторный `auth` теми же токенами в грейс-окне
  сервер разыгрывает replay.
- Статика модулей: `/web/*`, `/client/lib/*`, `/client/renderer/{dom,state}.js`,
  `/client/locales/*.json` — только allowlist (`OPERATOR_ASSETS` в
  `server/app.mjs`), traversal исключён. CSP: `script-src 'self'`,
  `connect-src 'self'`, без inline-кода.

## Паритет с desktop (главные сценарии)

| Сценарий | Desktop | `/operator` |
|---|---|---|
| Вход своим аккаунтом | + | + |
| Подключение по ID/паролю, согласие клиента | + | + |
| Видео, полноэкранный режим, fit/fill | + | + |
| Мышь/колесо/клавиатура по физическим кодам | + | + (один allowlist) |
| Чат, буфер, файлы (input + drag&drop) | + | + |
| peer-reconnecting / resumed / ended | + | + |
| RBAC: auditor — только чтение (403) | + | + |
| Языки ru/en из общих словарей | + | + |

## Отличия браузера (честно)

- **Захват экрана — только у клиента в desktop.** Браузер не может отдать свой
  экран как хост: роль клиента помощи в браузере недоступна (v1).
- **Буфер обмена**: приём текста требует разрешения браузера и HTTPS (или
  localhost); отправка — по событию copy, как в desktop. Без разрешения приём
  молча не срабатывает (честный отказ API).
- **Смена источника экрана и пауза трансляции** — функции хоста, в браузере их нет.
- **Адресная книга/команда/история/аудит** — только в desktop; `/operator` —
  чисто сеансовая страница.
- **Переподключение оператора** — вручную кнопкой в грейс-окне; авто-reconnect
  цикла агента здесь не применяется (у оператора есть диалог).
- **Проверено тестами**: серверная поверхность (RBAC 401/200/403, CSP, статика)
  и signaling-цикл offer/answer с фейк-пиром (`server/test/operator-page.test.mjs`),
  трансляция DOM→протокол (`client/test/input-source.test.mjs`), контракт
  разметки и словарей (`client/test/web-operator.test.mjs`). Живой прогон
  Chrome+WebRTC — ручная приёмка (см. `docs/MANUAL-QA.md`).
