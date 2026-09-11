# Handoff 04-1 — сайт по эталону + Range

**STATUS: DONE** (зелёный прогон, все критерии таска 04 закрыты)
Дата: 2026-09-11
Зона правок: `server/app.mjs`, `server/test/downloads.test.mjs` (client/assets/package.json не тронуты; прочие dirty-файлы — от тасков 02/03).

## Сделано

- `/downloads` по эталону: шапка (иконка + «EnotDesk | Удалённая поддержка», «Помощь» → `/downloads#download`, «Оператор» → `/invite`), hero (eyebrow, H1 «EnotDesk», подзаголовок, CTA «Скачать» + «Как это работает», чипы щит/молния/замок), маскот `/brand/mascot-site.png` (бабл и подпись в растре), 3 карточки ОС с SVG Apple/Windows/Linux (активная — имя файла, размер, арх, кнопка; неактивная — «Скоро будет» без ссылки; состав из `distFiles()`), 4 шага «Как это работает» (номер+иконка), футер `EnotDesk v<cfg.version>` + «С заботой о ваших задачах». `/invite` — тот же стиль.
- `/brand/:name` allowlist: + `mascot-site.png`, `mascot-app.png` (image/png); traversal по-прежнему 400/404.
- `GET /api/v1/downloads-files/:name`: `Content-Length`, `Accept-Ranges: bytes`; `Range` (`a-b`, `a-`, `-suffix`) → 206 c корректным `Content-Range`/`Content-Length`, невалидный Range → 416, без Range → 200. Allowlist имён не менялся.
- Страницы самодостаточны: без CDN/шрифтов/JS, inline `<style>`, системный стек, адаптив от 360px, focus-ring, семантические h1/h2/h3.

## Проверки (фактические)

- `npm test` — 84 pass / 0 fail (downloads.test.mjs: 7 тестов, включая Range на temp-артефакте с побайтовым сравнением).
- `npm run smoke:local` — PASS (полный цикл).
- curl на локальном сервере (temp-БД): `/` → 302; `/downloads` 200; `/invite` 200; `/brand/mascot-site.png` → 200 image/png; реальный zip 129 691 163 Б: без Range → 200 + Content-Length, `Range: bytes=0-1023` → 206 `bytes 0-1023/129691163`, suffix → 206; traversal → 400.
- Скриншоты headless Chrome (1440 full, 390/360, invite) сверены глазами с `reference/site.png`.

## Ревью-правки (04-1)

- Маскот: soft-mask по всем кромкам — жёсткий прямоугольник/шов убран (скриншот 1440 сверен).
- `parseRange` по RFC 9110: невалидный/чужой unit (`bytes=abc`, `bytes=0-1,5-6`, `items=`, `bytes=5-1`) игнорируется → 200 без `Content-Range`; unsatisfiable (`start ≥ size`, `bytes=-0`) → 416 + `Content-Range: bytes */size`.
- Тест запрещённого файла: `secrets.zip` в `ENOT_DIST_DIR` → 404 на `downloads-files` и отсутствие в `GET /api/v1/downloads`.

## Concerns

- `mascot-site.png` (артефакт 02) остаётся непрозрачным, но кромки растворены CSS-маской (intersect linear-gradient, как в `client/renderer/styles.css`) — на скриншоте 1440 шов не виден; при перегенерации ассета с alpha маску можно снять.
- HEAD на `/api/v1/downloads-files/:name` → 404 (маршруты GET-only, поведение до таска; Range через GET работает).
- Если на платформу несколько артефактов — карточка показывает первый (эталон: одна карточка на ОС).
