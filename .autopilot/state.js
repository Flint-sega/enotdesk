window.STATE =
{
  "slug": "enotdesk-oss",
  "dir": "2026-09-17-enotdesk-oss",
  "title": "EnotDesk — OSS: i18n, браузерный оператор, unattended-агент",
  "mode": "semi",
  "depth": "deep",
  "polish": null,
  "execution": "parallel",
  "tier": "T3",
  "briefFile": "2026-09-17-brief.md",
  "memoryFile": "AGENTS.md",
  "conventionsFile": "AGENTS.md",
  "skillDir": "/Users/admin/.zcode/skills/foreman",
  "startedAt": "2026-09-17T12:24:25+03:00",
  "updatedAt": "2026-09-17T15:35:13+03:00",
  "finishedAt": null,
  "stages": [
    {
      "id": "preflight",
      "status": "done",
      "startedAt": "2026-09-17T12:24:25+03:00",
      "finishedAt": "2026-09-17T12:29:32+03:00"
    },
    {
      "id": "manifest",
      "status": "done",
      "startedAt": "2026-09-17T12:29:32+03:00",
      "finishedAt": "2026-09-17T12:29:32+03:00"
    },
    {
      "id": "briefing",
      "status": "done",
      "startedAt": "2026-09-17T12:29:32+03:00",
      "finishedAt": "2026-09-17T12:36:43+03:00"
    },
    {
      "id": "spec",
      "status": "done",
      "startedAt": "2026-09-17T12:36:43+03:00",
      "finishedAt": "2026-09-17T12:46:11+03:00"
    },
    {
      "id": "plan",
      "status": "done",
      "startedAt": "2026-09-17T12:46:11+03:00",
      "finishedAt": "2026-09-17T12:52:29+03:00",
      "note": "9 тасков, ярус T3, 4 волны"
    },
    {
      "id": "build",
      "status": "active",
      "startedAt": "2026-09-17T12:52:29+03:00",
      "note": "9 из 9 тасков готовы"
    },
    {
      "id": "review",
      "status": "done",
      "finishedAt": "2026-09-17T15:24:46+03:00",
      "startedAt": "2026-09-17T12:52:29+03:00",
      "note": "все таски отревьюены (2 ревьюера), ремонты закрыты"
    },
    {
      "id": "final",
      "status": "pending"
    }
  ],
  "requirements": {
    "total": 20,
    "done": 20,
    "inTicket": 0,
    "inSpec": 0,
    "placeholder": 0,
    "deferred": 0,
    "dropped": 0
  },
  "tickets": [
    {
      "id": "01",
      "title": "OSS-фундамент: лицензия AGPL, English-доки, CI-matrix",
      "requirements": [
        "R02",
        "R15i",
        "R12",
        "R02.3",
        "R03.1"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "README*",
        "LICENSE",
        ".github/"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-17T12:52:29+03:00",
      "finishedAt": "2026-09-17T13:42:27+03:00",
      "commit": "8455e08",
      "tests": {
        "passed": 135,
        "failed": 0
      }
    },
    {
      "id": "02",
      "title": "i18n: словари ru/en, без строк в коде",
      "requirements": [
        "R08",
        "R14i",
        "R01",
        "R09"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "client/lib/i18n.mjs",
        "locales/",
        "client/renderer/",
        "server/pages.mjs"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-17T12:52:29+03:00",
      "finishedAt": "2026-09-17T13:42:27+03:00",
      "commit": "9c761aa",
      "tests": {
        "passed": 148,
        "failed": 0
      },
      "repairFindings": [
        "ремонт: insecure-плашка страниц (R16i.2) — ре-ревью обеих осей «addressed»; изменения летят в коммите таска 06 (общий pages.mjs/locales)"
      ]
    },
    {
      "id": "03",
      "title": "Docker: compose server+coturn+caddy",
      "requirements": [
        "R13i",
        "R16i",
        "R02.1",
        "R02.2",
        "R13i.1"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "docker/",
        "Dockerfile",
        "compose.yaml"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 1,
      "handoffs": 0,
      "startedAt": "2026-09-17T12:52:29+03:00",
      "repairFindings": [
        "дозапрос TURN-URL не воспроизвёлся: код уже валиден (comma-формат, живой rtc-config), ошибку держал контракт interfaces.md — исправлен"
      ],
      "finishedAt": "2026-09-17T13:44:33+03:00",
      "commit": "a080855",
      "tests": {
        "passed": 148,
        "failed": 0
      }
    },
    {
      "id": "04",
      "title": "Bare-metal установщик: coturn + Caddy",
      "requirements": [
        "R16i",
        "R16i.1",
        "R16i.2"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "scripts/install-server.sh",
        "docs/SERVER.md"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 1,
      "handoffs": 0,
      "startedAt": "2026-09-17T13:21:55+03:00",
      "repairFindings": [
        "BLOCKING: перезапись внешних ENOT_TURN_* на update; R16i.2 partial (плашка страницы — дозапрос таску 02) + craft: секрет в argv, guard setup_turn, ufw 443/udp"
      ],
      "finishedAt": "2026-09-17T15:20:08+03:00",
      "commit": "7a98e96",
      "tests": {
        "passed": 184,
        "failed": 0
      }
    },
    {
      "id": "05",
      "title": "Браузерный оператор /operator",
      "requirements": [
        "R05",
        "R19i",
        "R05.1",
        "R05.2",
        "R05.3",
        "R05.4"
      ],
      "blockedBy": [
        "02"
      ],
      "wave": 2,
      "zone": [
        "web/",
        "client/test/"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-17T13:44:33+03:00",
      "finishedAt": "2026-09-17T15:20:08+03:00",
      "commit": "3b61235",
      "tests": {
        "passed": 193,
        "failed": 0
      }
    },
    {
      "id": "06",
      "title": "Machines API + политики (причина, PIN)",
      "requirements": [
        "R04",
        "R06",
        "R18i",
        "R10",
        "A01",
        "R04.5"
      ],
      "blockedBy": [
        "02"
      ],
      "wave": 2,
      "zone": [
        "server/"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-17T13:44:33+03:00",
      "finishedAt": "2026-09-17T15:20:08+03:00",
      "commit": "bc2f7de",
      "tests": {
        "passed": 193,
        "failed": 0
      }
    },
    {
      "id": "07",
      "title": "Агент headless: цикл, reconnect, claim",
      "requirements": [
        "R04",
        "R04.2",
        "R04.4",
        "R11"
      ],
      "blockedBy": [
        "06"
      ],
      "wave": 3,
      "zone": [
        "client/lib/agent.mjs",
        "client/main.mjs"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-17T13:47:12+03:00",
      "finishedAt": "2026-09-17T15:20:08+03:00",
      "commit": "80c260f",
      "tests": {
        "passed": 193,
        "failed": 0
      }
    },
    {
      "id": "08",
      "title": "Службы агента 3 ОС + доки",
      "requirements": [
        "R04",
        "R11",
        "R04.7"
      ],
      "blockedBy": [
        "07"
      ],
      "wave": 4,
      "zone": [
        "client/agent-service/",
        "docs/"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-17T15:00:12+03:00",
      "finishedAt": "2026-09-17T15:24:46+03:00",
      "commit": "a2ad30b",
      "tests": {
        "passed": 198,
        "failed": 0
      }
    },
    {
      "id": "09",
      "title": "Релизы: Releases, updater, checksums",
      "requirements": [
        "R17i",
        "R07",
        "A02",
        "R20i",
        "R03"
      ],
      "blockedBy": [
        "07"
      ],
      "wave": 4,
      "zone": [
        ".github/workflows/",
        "client/main.mjs",
        "README"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-17T15:00:12+03:00",
      "finishedAt": "2026-09-17T15:24:46+03:00",
      "commit": "89f5dca",
      "tests": {
        "passed": 198,
        "failed": 0
      }
    },
    {
      "id": "10",
      "title": "Финал: i18n-хвосты и честные статусы",
      "requirements": [
        "R08",
        "R09",
        "R10"
      ],
      "blockedBy": [],
      "wave": 4,
      "zone": [
        "client/",
        "web/"
      ],
      "status": "done",
      "startedAt": "2026-09-17T15:35:13+03:00",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "finishedAt": "2026-09-17T16:05:00+03:00",
      "commit": "final",
      "tests": {
        "passed": 200,
        "failed": 0
      }
    }
  ],
  "singlePass": null,
  "tests": null,
  "debt": {
    "placeholders": [],
    "assumptions": [],
    "emptyEnv": []
  },
  "additions": [],
  "coverage": {
    "found": 6,
    "fixed": 6,
    "deferred": 0,
    "note": "G2 независимый проверятель: 2 пропуска (ресурсы/количества+покупки; агент-ревью как шаг) закрыты секциями спеки; 2 половинки (сравнение инструментов; приоритет Windows в MANUAL-QA) дописаны; старт-гейт вынесен в Открытые места; 8 позиций «в спеке, нет в брифе» — трассируются в принятый план из Дополнений брифа (R##.n/A01/A02)"
  },
  "concerns": [
    "T01: npm audit шаг вне acceptance (advisory)",
    "T02: серверные страницы — язык только по Accept-Language, настройки нет (история 9, половина)",
    "T02 craft: самоподтверждающийся ассерт initLocale; aria-label/alt без data-i18n (index.html:174,99); throw-строка в main.mjs мимо словаря; HTML-эвристика контракта не ловит непомеченную кириллицу",
    "T03: coturn без TURN over TLS 5349 — граница v1 (задокументировано)",
    "T04: дефолтный режим перезаписывает сохранённые ENOT_TURN_*; предупреждение http-режима «на странице» — зона сервера",
    "T05 craft: web/operator.mjs:95,256 — статус принудительно «Подключено» после ошибки даже без сеанса",
    "T05 craft: web-operator тест мёртвых кнопок — подстрока вместо $()-формы (ослаблен против renderer-контракта)",
    "T07 craft: состояние 'registering' при старте с сохранённым токеном — мутное имя",
    "T07 spec: tray у агента v1 отсутствует (логи stdout) — зафиксировать в MANUAL-QA (T08 включил)",
    "T04 ре-ревью: смена домена без --reset-turn оставляет старый realm в conf — описать в docs",
    "T09: electron-updater@6.8.9 добавлен точным пином — обосновано spec §решения (пакет назван в спеке)",
    "T09: Windows portable не умеет самообновление — только уведомление (честно)",
    "продукт: админ-UI для setPin/групп отсутствует — управление только API; триаж финала",
    "T08 craft: windows.md — путь первой регистрации токена противоречив (консоль от админа пишет в профиль админа); SERVER_URL без экранирования в bat/sh",
    "T09 craft: два источника баннера обновлений (серверный поллинг + GitHub-фид) пишут в один #update-banner",
    "T09: Windows portable — только уведомление об обновлении (portable не умеет автоустановку)"
  ],
  "reviewers": {
    "manifestSpec": "agent_c3833678-2195-44a9-840d-1f30ed854a13",
    "craft": "agent_185272e2-9a22-4eda-905d-e98bcad08690"
  },
  "blind": {
    "verdict": "все пункты брифа реализованы и запускаются: live-проверены сервер/health, bootstrap, полный unattended-цикл (код→машина→PIN→claim с причиной→session), compose up + health, smoke Electron, 198 тестов; непроверяемое без машин (службы Win/mac/Linux, TURN-релей, TLS-сертификат, живой браузерный WS, видео) честно вынесено в docs/MANUAL-QA.md",
    "drift": 0
  }
}
