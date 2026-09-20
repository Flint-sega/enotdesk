# 04 — One-click клиент: протокол enotdesk:// + /join

**Требования:** R04, R04.1
**Blocked by:** —  **Зона:** client/lib/join.mjs (новое), client/main.mjs, build/electron-builder.yml (protocols), hub/web/join.html (страница — каркас из T01), client/test
**Волна:** 1

## Что должно заработать
Ссылка `enotdesk://join?server=…&t=…` открывает установленное приложение: оно подставляет сервер, само создаёт сеанс и репортит {sessionId,password} на hub по одноразовому URL; если приложения нет — страница /join (кнопка протокола + скачивание + инструкция). hostToken не покидает клиент.

## Критерии приёмки
- [ ] parseJoinLink(url) чистая + тесты (валид/мусор/чужие схемы; сервер валидируется normalizeServerUrl)
- [ ] main.mjs: setAsDefaultProtocolClient('enotdesk'), open-url (mac) + argv/second-instance (win/linux); single-instance не мешает (второй вызов с ссылкой — первому)
- [ ] Автостарт: settings.serverUrl=server (сохранить), POST /sessions, репорт на hub /api/join/:t/report (одноразовый; фейк-hub в тестах); ошибки честные, ничего не выдумываем
- [ ] electron-builder protocols (3 ОС); /join-страница каркас (кнопка+инструкция, i18n)
- [ ] Тесты: parseJoinLink-юнит, wiring-контракты (grep main.mjs), join-репорт против фейк-hub; живой прогон протокола — MANUAL-QA
