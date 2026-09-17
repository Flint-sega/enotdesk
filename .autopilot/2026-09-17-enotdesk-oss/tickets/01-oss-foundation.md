# 01 — OSS-фундамент: лицензия, English-доки, CI-matrix

**Требования:** R02, R15i, R12, R02.3, R03.1
**Blocked by:** —
**Зона:** корневые доки (README*, LICENSE, CONTRIBUTING*, SECURITY*, CODE_OF_CONDUCT*), `.github/`
**Волна:** 1
**Status:** ready

## Что должно заработать

Проект выглядит и ведёт себя как открытый: лицензия AGPL-3.0, англоязычная
точка входа, правила для контрибьюторов, CI гоняет тесты на трёх ОС.

## Из брифа, дословно

> «Open source» · «https://github.com/Flint-sega/enotdesk»
> «да пока так» (ru + en) · «EnotDesk» (бренд сохраняется)

## Разделы спецификации

Истории 5, 6, 10, 11, 12; Решения §лицензия.

## Критерии приёмки

- [ ] LICENSE — текст AGPL-3.0 (заменяет автостартовавшую GPL-3.0); упомянут в README
- [ ] README.md (English): quick start (docker + bare-metal ссылки), security notes, screenshots-плейсхолдер до фазы релизов; README.ru.md — русский
- [ ] CONTRIBUTING.md, SECURITY.md (приватный канал уязвимостей), CODE_OF_CONDUCT.md
- [ ] `.github/workflows/test.yml` — matrix ubuntu/windows/macos (lint+test; smoke на ubuntu); ветка win/mac при падении инфраструктуры — `continue-on-error` с пометкой
- [ ] Бренд EnotDesk не заменяется нигде; существующие русские README-разделы не удаляются (переезжают в README.ru.md)
- [ ] `npm test` и `npm run lint` зелёные (файлы — только доки/workflow, но прогон обязателен)
