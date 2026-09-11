# Handoff 03-1 — визуал приложения

STATUS: HANDOFF

## СДЕЛАНО
- `index.html`: шапка (enot-icon.svg, «EnotDesk | Удалённая поддержка», «? Помощь», «Оператор», шестерёнка), hero (eyebrow, H1 EnotDesk, лид в 2 строки, пояснение, teal-CTA с самолётиком и стрелкой, строка с замком), маскот `../../assets/mascot-app.png` (подпись в растре, кромки растворены маской), плитки Безопасно/Быстро/Удобно, футер «EnotDesk v…» + «С заботой о ваших задачах ♥». CSP без inline, стили только styles.css.
- `styles.css` переписан под палитру BRAND.md; все классы, которые создаёт/переключает app.js, сохранены (проверено программно).
- `getSettings()` отдаёт `version: app.isPackaged ? app.getVersion() : pkg.version` (корневой package.json читается один раз при старте); app.js показывает футер только при наличии версии. В dev футер — v0.1.0.
- Ленивый koffi: `createNativeInput({ getAdapter })` — `status()`/`end()` не грузят, `load()` на старте host-сеанса + первый `dispatch()`; `loadPlatformAdapter` экспортирован; main не грузит koffi на старте. Сообщение в настройках — только для `checked && !available`.
- Все состояния клиента/оператора/контактов/команды/истории/журнала/настроек не тронуты; UI-клики не проверялись.

## ФАЙЛЫ
- `client/renderer/index.html`, `client/renderer/styles.css`, `client/renderer/app.js` (boot-футер, perm-report)
- `client/main.mjs` (ленивый адаптер, version), `client/lib/native-input.mjs`
- `client/test/native-input.test.mjs` (+2 теста ленивости), `client/test/renderer-contract.test.mjs` (новый: id/CSP/version)
- `docs/screenshot-main.png` (переснят и сверен с reference/app.png)

## РЕШЕНИЯ
- Иконки CTA — CSS pseudo/mask: `setBusy()` переписывает `textContent` кнопки и DOM-иконки бы уничтожил.
- Статус до загрузки — `{available:false, reason:'native-not-checked', checked:false}`: честно «не проверено», не «недоступно».
- Плитки лежат внутри `.hero` — прежнее правило `:has(#client-idle.hidden)` скрывает их вместе с hero в сеансе.
- Маска маскота: прямоугольный кроп не показывает границу; низ почти не тронут (хвост/лапы).

## ТУПИКИ
- Нет.

## ДАЛЬШЕ
- Таск 05: на `pack:mac` убедиться, что футер показывает версию из `app.getVersion()`.
- Ревью fix: renderer-contract проверяет `view-client`/`view-operator` (switchView-тернарник regex не ловил).
