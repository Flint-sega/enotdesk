# 09 — Релизы: GitHub Releases, updater, checksums, без подписи

**Требования:** R17i, R07, A02, R20i (фазовая приёмка завершается здесь), R03 (подготовка публикации)
**Blocked by:** 07 (client/main.mjs — общий файл)
**Зона:** `.github/workflows/release.yml` (новое), `client/main.mjs` + `client/lib/` (updater), README (screenshots/инструкции)
**Волна:** 4
**Status:** ready

## Что должно заработать

Пуш тега `v…` собирает три платформы, прикладывает артефакты с SHA256 и
инструкциями запуска без подписи. Клиент сам узнаёт о новой версии
(electron-updater на GitHub Releases) и обновляется. README показывает
реальные скриншоты.

## Из брифа, дословно

> «пока нет бюджета так что подписываем сами чтоб работало» ·
> «релизы и обновление клиента через GitHub Releases»

## Разделы спецификации

Истории 13, 33–36; Решения §релизы.

## Критерии приёмки

- [ ] `release.yml`: тег `v*` → pack:mac/win/linux на matrix-раннерах → артефакты + `checksums-sha256.txt` в GitHub Release
- [ ] Блок секретов подписи (APPLE_ID, MAC_CERTS, WINDOWS_CERTIFICATE) — закомментирован, включается без переделки
- [ ] electron-updater (generic feed на GitHub Releases) в main-процессе; в dev/EDESK_SMOKE отключён; парсер фида — юнит-тест; в браузерную страницу не лезет
- [ ] README: секция Screenshots (смок-скриншоты из `docs/`), инструкции запуска без подписи (macOS ПКМ→Открыть, Windows SmartScreen, Linux chmod)
- [ ] `npm test`/lint зелёные; реальный релиз-пуш — по явной команде пользователя (наружное действие)
