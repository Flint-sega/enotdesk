window.STATE =
{
  "slug": "enotdesk-hub",
  "dir": "2026-09-18-enotdesk-hub",
  "title": "EnotDesk Hub — тикет-система + чат-виджет с интеграцией EnotDesk",
  "mode": "semi",
  "depth": "deep",
  "polish": null,
  "execution": "parallel",
  "tier": "T3",
  "briefFile": "2026-09-18-brief.md",
  "memoryFile": "AGENTS.md",
  "conventionsFile": "AGENTS.md",
  "skillDir": "/Users/admin/.zcode/skills/foreman",
  "startedAt": "2026-09-18T22:10:57+03:00",
  "updatedAt": "2026-09-21T01:34:53+03:00",
  "finishedAt": "2026-09-21T01:34:53+03:00",
  "stages": [
    {
      "id": "preflight",
      "status": "done",
      "startedAt": "2026-09-18T22:10:57+03:00",
      "finishedAt": "2026-09-18T22:10:57+03:00"
    },
    {
      "id": "manifest",
      "status": "done",
      "startedAt": "2026-09-18T22:10:57+03:00",
      "finishedAt": "2026-09-20T22:14:46+03:00"
    },
    {
      "id": "briefing",
      "status": "skipped",
      "note": "развилки закрыты до плана: one-click, email сейчас, SSO, имя Hub"
    },
    {
      "id": "spec",
      "status": "done",
      "startedAt": "2026-09-20T22:14:46+03:00",
      "finishedAt": "2026-09-20T22:14:46+03:00",
      "note": "G2: 2 пробела закрыты (роли R09, GDPR-политика)"
    },
    {
      "id": "plan",
      "status": "done",
      "startedAt": "2026-09-20T22:14:46+03:00",
      "finishedAt": "2026-09-20T22:14:46+03:00",
      "note": "7 тасков, ярус T3, 4 волны"
    },
    {
      "id": "build",
      "status": "active",
      "startedAt": "2026-09-20T22:14:46+03:00",
      "note": "6 из 7 готовы; T07 приёмка (R05/R11/R12/R13i)"
    },
    {
      "id": "review",
      "status": "done",
      "startedAt": "2026-09-21T01:18:28+03:00",
      "finishedAt": "2026-09-21T01:18:28+03:00",
      "note": "все таски отревьюены, ремонты закрыты (0 незакрытых)"
    },
    {
      "id": "final",
      "status": "done",
      "startedAt": "2026-09-19T01:15:00+03:00",
      "finishedAt": "2026-09-21T01:34:53+03:00",
      "note": "G4: 1 drift (MANUAL-QA) закрыт; 7/7 тасков"
    }
  ],
  "requirements": {
    "total": 13,
    "done": 13,
    "inTicket": 0,
    "inSpec": 0,
    "placeholder": 0,
    "deferred": 0,
    "dropped": 0
  },
  "tickets": [
    {
      "id": "01",
      "title": "Hub-каркас: сервер, SSO, деплой",
      "requirements": [
        "R01",
        "R01.1"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "hub/",
        "compose.yaml",
        "scripts/"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 1,
      "handoffs": 0,
      "startedAt": "2026-09-20T22:14:46+03:00",
      "repairFindings": [
        "волна-1 ревью: см. concerns/state"
      ],
      "finishedAt": "2026-09-20T23:17:31+03:00",
      "commit": "520f0b0",
      "tests": {
        "passed": 412,
        "failed": 0
      }
    },
    {
      "id": "02",
      "title": "Тикеты: модель+REST+консоль",
      "requirements": [
        "R02",
        "R02.1",
        "R09",
        "R10",
        "R11",
        "R06"
      ],
      "blockedBy": [
        "01"
      ],
      "wave": 2,
      "zone": [
        "hub/threads.mjs",
        "hub/web/"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-20T22:38:25+03:00",
      "finishedAt": "2026-09-20T23:17:31+03:00",
      "commit": "520f0b0",
      "tests": {
        "passed": 412,
        "failed": 0
      }
    },
    {
      "id": "03",
      "title": "Чат-виджет для сайтов",
      "requirements": [
        "R03",
        "R03.1",
        "R03.2",
        "R11"
      ],
      "blockedBy": [
        "02"
      ],
      "wave": 2,
      "zone": [
        "hub/widget/"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-20T23:17:31+03:00",
      "finishedAt": "2026-09-21T00:38:41+03:00",
      "commit": "9bdfd00",
      "tests": {
        "passed": 443,
        "failed": 0
      }
    },
    {
      "id": "04",
      "title": "One-click: протокол enotdesk:// + /join",
      "requirements": [
        "R04",
        "R04.1"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "client/lib/join.mjs",
        "client/main.mjs",
        "build/"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 1,
      "handoffs": 0,
      "startedAt": "2026-09-20T22:14:46+03:00",
      "repairFindings": [
        "волна-1 ревью: см. concerns/state"
      ],
      "finishedAt": "2026-09-20T23:17:31+03:00",
      "commit": "a4164bc",
      "tests": {
        "passed": 403,
        "failed": 0
      }
    },
    {
      "id": "05",
      "title": "Карточка Подключиться + webhooks",
      "requirements": [
        "R07",
        "R07.1"
      ],
      "blockedBy": [
        "02",
        "04"
      ],
      "wave": 3,
      "zone": [
        "hub/join.mjs",
        "hub/"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-21T00:02:13+03:00",
      "finishedAt": "2026-09-21T00:38:41+03:00",
      "commit": "9bdfd00",
      "tests": {
        "passed": 443,
        "failed": 0
      }
    },
    {
      "id": "06",
      "title": "Email: IMAP→тикет, SMTP→ответы",
      "requirements": [
        "R08",
        "R08.1"
      ],
      "blockedBy": [
        "02"
      ],
      "wave": 3,
      "zone": [
        "hub/email.mjs",
        "package.json"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-21T00:38:41+03:00",
      "finishedAt": "2026-09-21T01:18:28+03:00",
      "commit": "59c890e",
      "tests": {
        "passed": 481,
        "failed": 0
      }
    },
    {
      "id": "07",
      "title": "Приёмка: ADR/MANUAL-QA/доки",
      "requirements": [
        "R05",
        "R11",
        "R12",
        "R13i"
      ],
      "blockedBy": [
        "01",
        "02",
        "03",
        "04",
        "05",
        "06"
      ],
      "wave": 4,
      "zone": [
        "docs/"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-21T01:18:28+03:00",
      "finishedAt": "2026-09-21T01:34:53+03:00",
      "commit": "final",
      "tests": {
        "passed": 481,
        "failed": 0
      }
    }
  ],
  "singlePass": null,
  "tests": {
    "passed": 481,
    "failed": 0
  },
  "debt": {
    "placeholders": [],
    "assumptions": [],
    "emptyEnv": []
  },
  "additions": [],
  "coverage": {
    "found": 3,
    "fixed": 3,
    "deferred": 0,
    "note": "G2: T-план и волны — уровень Phase 4 (не спеки); R09 обе роли + GDPR-политика вписаны; «у кого есть доступ» покрыто operator+admin"
  },
  "concerns": [
    "T01: релизный тарболл не содержит hub/ — дозапрос агенту 01 (deploy-server.sh + release.yml + check_tarball)",
    "T01 craft: readJson-копия, lastLocaleHeader-гонка, traversal-тест не доказывает — в дозапросе",
    "T04 craft: wiring-grep-тесты — замечание принято (мелочь)",
    "T01/04 manifest мелочи: комментарий loopback vs 0.0.0.0; insecure-http из ссылки (в дозапросе)",
    "инцидент: диск 99% (npm-кэш 4.5Г) — вычищен, 4.9Г свободно; dist/ регенерируемый удалён",
    "T03: Caddy-матчер без /ws/widget,/ws/console — дозапрос T01-агенту (docker-зона)",
    "T05 manifest мелочи: bearerForAgent дублирует шов auth.mjs; system-строки ru (решение задокументировано)",
    "T05: http:-joinPage из dev не рендерится кнопкой (только https) — осознанно",
    "T03: старые uuid-куки гостей инвалидируются (посетителей в проде нет)"
  ],
  "reviewers": {
    "manifestSpec": null,
    "craft": null
  },
  "blind": {
    "verdict": "все требования брифа реализованы; live-проверено: 481 тест, SSO-логин+2FA-наследование, тикеты (ручной/чат-API/offline-email), join-карточка enotdesk://+/join, CORS-гейт 403, HMAC 403; непроверяемое без GUI/IMAP (виджет в браузере, протокол на 3 ОС, живой IMAP/SMTP) — чек-лист docs/MANUAL-QA.md (H-*)",
    "drift": 1
  },
  "drift_note": "G4 нашёл 1 расхождение: MANUAL-QA не упоминал Hub — закрыто в T07 (чек-лист H-*)"
}
