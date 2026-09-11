# Спецификация: EnotDesk

## 1. Задача и решение
Клиент получает ссылку в существующем чате, скачивает portable EnotDesk для Windows/macOS/Linux, запускает, сообщает временные ID и пароль. Авторизованный оператор подключается, видит экран и управляет мышью/клавиатурой. Клиент постоянно видит состояние и завершает доступ закрытием приложения. При новом запуске оба значения новые. Командные роли, общая книга, приглашения и аудит — в первом выпуске, не «потом».

Создаём оригинальное приложение вместо форка: пользователь разрешил оба варианта. Electron предоставляет desktop capture/WebRTC и portable упаковку; Node 24 + SQLite + ws — единый локально запускаемый control-plane; Koffi — вызовы нативного ввода Windows/macOS/X11 без устанавливаемой службы. Удалённый протокол не изобретаем: WebRTC DTLS/SRTP, signaling через аутентифицированный сервер. Доступ в сложных NAT требует настраиваемого TURN. Зависимости закреплены lockfile.

## 2. Клиент и сеанс (R01, R13–R17, R19i)
- R01.1 Первый запуск: экран «Получить помощь» и вход оператора, адрес сервера. Пока сервер недоступен, никаких готовых ID и статуса защищённого соединения.
- R14.1 Клиент явно начинает поддержку; main process создаёт регистрацию через API. Сервер генерирует случайные 9-значный ID с проверкой коллизий, пароль 8 символов без неоднозначных знаков, отдельный 256-битный hostToken. ID и пароль доступны только клиенту в ответе создания; пароль хранится сервером как salted scrypt hash. hostToken и операторские токены хранятся только в памяти клиентов, в БД только их хеши. Не логировать.
- R14.2 Кнопка копирует только ID и пароль, честно сообщает отказ clipboard. ID принимается с пробелами, password без автокоррекции. Ошибка claim не раскрывает существование ID; лимиты по IP и ID, общий размер тела ограничен.
- R15.1 Автомат: idle → registering → waiting → pending-consent → connected → ended/error. Двойное начало не создаёт два хоста. Один оператор на сеанс, CAS/транзакция claim. Клиент подтверждает видимое имя авторизованного оператора; отказ не открывает транспорт.
- R01.2 Host выбирает экран через native desktopCapturer; track получен только после разрешения ОС. Оператор видит настоящий video stream. RTC offer/answer/ICE идут только между владельцами claim через signaling. Неавторизованные socket/перекрёстные session сообщения отклоняются. RTC config с STUN/TURN поставляет сервер.
- R01.3 DataChannel принимает только ограниченный JSON input enum с нормализованными координатами, allowlisted клавишами, ограниченными размерами/частотой. Ввод включается лишь после согласия и соединения; no shell/exec/произвольных файловых команд. Native input поддерживает Windows SendInput, macOS CoreGraphics и Linux X11/XTest; Wayland явно диагностируется как unsupported-control, не выдаётся за полноценную поддержку.
- R19i.1 При отсутствии разрешений захвата/Accessibility экран объясняет причину и следующий шаг. Повышенные окна Windows могут быть недоступны без повышения, вход в ОС/UAC secure desktop не обещаются. На Linux выбор дисплея/scale учитывается, на macOS координаты logical/physical конвертируются.
- R16.1 Закрытие BrowserWindow = quit, не tray/hide. Сначала stop media tracks, close PC/DataChannel, блокировать input и разорвать signaling. Main процесс также делает revoke best-effort, но локальное прекращение не ждёт сервера. На macOS последнее окно завершает приложение. Никаких restartable services/автозапуска/дочерних input daemon.
- R16.2 Сервер завершает сессию при закрытии host socket; heartbeat 5 с/lease 20 с для аварий. Рестарт сервера инвалидирует все живые регистрации. Кнопка «Завершить» очищает данные и требует новую регистрацию для следующей помощи. Перезапуск генерирует новые ID/password/hostToken; старые claim и sockets не работают.
- R15.2 Операторское отключение завершает текущий claim/RTC; клиент может начать новую поддержку с новой парой. Не разрешать незаметное переподключение старого оператора. Потеря signaling завершает RTC локально, fail closed. Потеря RTC — завершение и понятная ошибка, не вечный connected.
- R13.1 Страница /downloads показывает только реально имеющиеся portable артефакты по платформам. Отсутствующие — «сборка ещё не готова», без фальшивых ссылок. Ссылка на страницу копируется для внешнего чата. Хостинг/домен задаются пользователем позднее; локальный URL не представляется интернет-ссылкой.

## 3. Команда (R07–R12)
- R10.1 Первый администратор создаётся отдельной интерактивной CLI-командой, пароль вводится локально без вывода и без заранее заданных credentials. Команда не перезаписывает существующую БД. Login возвращает opaque bearer, logout отзывает, TTL 8 часов, пароль scrypt с солью; persisted sessions hashed.
- R10.2 Роли: admin управляет командой/приглашениями и книгой, operator читает/редактирует книгу и подключается, auditor читает историю/аудит и книгу без права изменять/claim. Авторизация на каждом HTTP/WS действии по актуальной роли/active-флагу; disable/logout закрывают связанные подключения. Последнего активного admin нельзя отключить/понизить. Самоизменение роли не обход.
- R08.1 Admin создаёт одноразовую invite link, привязанную к роли, expiry 24ч; хранится hash token. Пользователь принимает, задаёт имя/login/password; accept атомарен, уникальный нормализованный login, invite нельзя переиспользовать. Admin может отозвать ещё не принятые ссылки. Доставка — копирование в внешний чат.
- R07.1 Общая книга: id UUID, name (1–120), notes (0–2000), tags (до 10 × 30), timestamps, revision. Никаких постоянных паролей и фиктивной online-индикации. CRUD, поиск с лимитом и offset. Lost-update возвращает 409 по revision. Удаление требует явного подтверждения UI.
- R09.1 История: sessionId, необязательная ссылка contactId, operatorId, начальное/конечное время и причина/статус, без секретов. Сервер отличает explicit-end от socket-loss/lease-expired/server-restart. Выбор contactId при claim не создаёт постоянного доступа.
- R11.1 Append-only API audit для login success/failure, invite create/revoke/accept, role/disable, contact CRUD, session create/claim/approve/reject/end. Серверный actor получен из auth, не произвольного поля клиента. Audit не принимает screenshot/пароли/keystrokes. Ограниченная выдача и фильтры; прежние данные переживают restart.
- R12.1 Командные операции проверяются в первом доступном локальном запуске; их отсутствие блокирует приёмку.

## 4. Внешний вид (R03–R06)
Оригинальный EnotDesk не использует RustDesk UI/ассеты. Палитра из BRAND.md: graphite #0B1020, panel #121A2B, accent #35D0BA; холодный голубой дополнительный. Собственный vector raccoon: сильный плечевой силуэт, узнаваемая маска енота, очки, гарнитура, профессиональная одежда. SVG без emoji. Иконки и одинаковая тема клиент/оператор/подключение/настройки/ошибки/скачивание, название окна/пакета EnotDesk.

Главный клиент: один основной CTA, ID/password читаемы, stop заметен; оператор: sidebar Подключение/Адресная книга/Команда/История/Журнал, активный экран с toolbar. Пустые списки объясняют следующий шаг; loading/disabled/error/success на всех формах. Русский UI, доступные label, keyboard navigation, focus ring, contrast, 360px–desktop без обрезанных CTA. Секреты не в URL, кроме одноразового invite, лучше fragment. Долгие списки пагинируются; нет фиктивных данных. Корневой старый макет маркируется архивным/неработающим, не открывается как приложение.

## 5. Глубокая проверка измерений
Для каждой строки принят следующий порядок измерений: первый запуск / пусто / неверный ввод / отказ / прерывание / рост / права / последствия. Нижеследующие критерии — обязательные истории .n соответствующего R.

| R | Критерии по восьми измерениям |
|---|---|
| R01 | виден старт; нет video до связи; input allowlist; RTC error показана; close останавливает; один peer/ограничение частоты; только consent+auth; end записан |
| R02 | OS detected; unsupported explained; server URL validated; permissions shown; native exit; scale/multi-screen tested; OS permissions; артефакт отдельно каждой ОС |
| R03 | все окна EnotDesk; нет чужих placeholders; asset fallback accessible; missing asset виден тесту; стабильная тема; scalable vector; лицензии deps; название артефакта своё |
| R04 | имя в title; Н/П пусто; Н/П ввод; metadata build test; Н/П прерывание; Н/П рост; Н/П права; имя в downloads |
| R05 | dark initial; empty layouts; inline validation; readable errors; busy reset; pagination/scroll; focus accessibility; state feedback |
| R06 | SVG в hero; fallback wordmark; Н/П ввод; load checked; Н/П прерывание; small icon legible; alt text; reuse all packages |
| R07 | empty prompt; no hits prompt; length/revision validation; preserve form; no duplicates; limit search; RBAC; audit update/delete |
| R08 | invite CTA admin; empty list; invalid/expired generic; retry safe; atomic accept; bounded list; admin/recipient; token consumed/revoked |
| R09 | empty prompt; no events honest; filters validated; fetch retry; server persisted; pagination; read roles; ended reason |
| R10 | bootstrap; no defaults; bad password generic; rate limit; tokens expire; bounded auth; live role check; revoked sockets end |
| R11 | empty prompt; no fabricated events; filters validated; failed writes not false success; restart persists; pagination; read only; append-only API |
| R12 | all team routes present; initial empty; shared validation; startup smoke; restart; bounded lists; server RBAC; release blocks omissions |
| R13 | download page; missing build disabled; filename allowlist; 404 honest; download standard HTTP; stream file; no path traversal; actual artifact only |
| R14 | real registration; no codes offline; limits claim; fail generic; no stale codes; collision retry; token binding; expire clear |
| R15 | waiting explicit; idle no transport; state validation; fail closed; socket loss ends; one operator; consent; history |
| R16 | new startup values; cleared end; reject old token; revoke best effort; kill local input; lease cleanup; no background access; fresh registration |
| R17 | no installer wizard; no service; config errors clear; permission instruction; close quits; standard packaging; user permissions; no autostart |
| R18 | localhost defaults; external config empty; URL validation; no server false-ready; retry bounded; TURN configurable; HTTPS/WSS production; deploy later by consent |
| R19i | permissions explained; no source explained; key/coord bounds; native error surfaced; stop release pressed keys; input throttled; OS+consent; no retained pressed keys |

## 6. Границы и швы
Server owns SQLite accounts/contacts/audit, temporary sessions and WS signaling. Exposes JSON /api/v1 and /signal; hides hashes, raw DB, binding/rate limits. Desktop main owns window/process, configuration, capture-source selection, native input and network calls; exposes context-isolated enot bridge only, hides OS handles and never accepts arbitrary IPC method/path. Renderer owns UI, media tracks/RTCPeerConnection and verified datachannel processing; no nodeIntegration and strict CSP. Branding owns SVG/icon resources only.

Server API details are frozen in interfaces.md before parallel work. Tests target public HTTP/WS and desktop bridge/session lifecycle; fakes used only for OS permissions/network simulation, named as such. Real startup required; real two-host video/input test required for final acceptance of remote access. Native builds unavailable here remain explicit blockers.

## 7. Безопасность и конфигурация
No unsolicited inbound background access. Local development HTTP allowed on loopback, non-loopback requires HTTPS/WSS or explicit documented dev override. Server default bind 127.0.0.1. CORS deny unknown origins, origin/host checks and bearer auth, no cookies for API. WS auth by first message within 5s, not query tokens; maxPayload. CSP self, no inline scripts/eval, remote pages cannot call bridge. Electron navigation/new windows denied except approved external HTTPS download/help via safe handler. Local config stores server URL only, no support passwords.

No hosting account/domain/signing facts assumed. .env.example holds names only: ENOT_HOST, ENOT_PORT, ENOT_DB, ENOT_PUBLIC_URL, ENOT_TURN_URLS, ENOT_TURN_USERNAME, ENOT_TURN_PASSWORD. Values user configures locally; secrets never in test report/log. TURN credentials returned only to authenticated participating clients, not download visitors.

## 8. Приёмка и рамки
Must test HTTP role matrix, invite single-use/concurrency, no last-admin removal, contacts revision conflict, restart persistence, stale session/socket denial, close/lease end, crossed signal denial, no secret logging; renderer idle/error/active/stop flows; native input validation; build and start desktop on available macOS. Package targets portable .exe, .app ZIP, AppImage with source and reproducible commands. Windows/Linux actual runtime checks need corresponding machines; do not claim passed from macOS. No external deployment/publication now (R18). Internet operation remains blocked until endpoints/TURN where needed are configured and end-to-end tested. These are delivery blockers, not removal of R01/R02/R13/R17.

No unrequested billing, multi-company tenancy, unattended access, built-in support chat, remote shell. File transfer was an assistant suggestion, not an accepted standalone requirement; not needed for this specified workflow.

## 9. Процесс и явные разрешения противоречий
Полный автомат / deep: исходный бриф неизменяем; manifest и таски сохраняются в .autopilot; код пишут отдельные исполнители, каждому таску — независимое ревью, затем независимая приёмка по брифу без спецификации. Проверки и фактический запуск обязательны, отчёт показывает все неподтверждённые требования. Коммиты только по явной инструкции пользователя; текущий предоставленный регламент требует их после проверки. Публикация/деплой/оплата не разрешены.

ASSUMPTION к R18: «сервер позже» понимается как размещение сервера в интернете позже, поскольку пользователь после этого явно потребовал серверные командные функции в первой версии. Реализация сервера входит сейчас, а интернет-доставка клиентам останется заблокирована до размещения. Это не готовый облачный сервис.

R15.3 — дополнительное подтверждение клиентом конкретного оператора является углублением attended-сценария, выбранным в полном автомате. Это один дополнительный клик после передачи ID/password; самобрифинг и отчёт явно показывают решение.

## 10. Покрытие
R01 §2,6,8; R02 §1,5,8; R03 §4; R04 §4; R05 §4,5; R06 §4; R07 §3; R08 §3; R09 §3; R10 §3,7; R11 §3; R12 §3,8; R13 §2,8; R14 §2,7; R15 §2; R16 §2,8; R17 §2,8; R18 §1,7,8; R19i §2,5.
