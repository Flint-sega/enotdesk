window.STATE =
{
  "slug": "enotdesk-redesign",
  "title": "EnotDesk — визуал по эталонам, порядок в проекте, вес и старт",
  "mode": "full",
  "depth": "deep",
  "polish": null,
  "tier": "T2",
  "briefFile": "2026-09-11-brief.md",
  "memoryFile": "AGENTS.md",
  "startedAt": "2026-09-11T16:53:58+03:00",
  "updatedAt": "2026-09-11T17:09:01+03:00",
  "finishedAt": null,
  "stages": [
    {
      "id": "preflight",
      "status": "done",
      "startedAt": "2026-09-11T16:53:58+03:00",
      "finishedAt": "2026-09-11T16:54:04+03:00",
      "note": "эталоны скопированы в reference/"
    },
    {
      "id": "manifest",
      "status": "done",
      "startedAt": "2026-09-11T16:54:04+03:00",
      "finishedAt": "2026-09-11T16:57:12+03:00"
    },
    {
      "id": "briefing",
      "status": "skipped",
      "note": "полный автомат — самобрифинг"
    },
    {
      "id": "spec",
      "status": "done",
      "startedAt": "2026-09-11T16:57:12+03:00",
      "finishedAt": "2026-09-11T16:57:12+03:00",
      "note": "G2: 5 дыр найдено и закрыто"
    },
    {
      "id": "plan",
      "status": "done",
      "startedAt": "2026-09-11T16:57:12+03:00",
      "finishedAt": "2026-09-11T16:57:12+03:00",
      "note": "6 тасков, ярус T2, 4 волны"
    },
    {
      "id": "build",
      "status": "active",
      "startedAt": "2026-09-11T16:57:12+03:00",
      "note": "2 из 6 тасков готовы; волна 2 (03,04) в работе"
    },
    {
      "id": "review",
      "status": "pending"
    },
    {
      "id": "final",
      "status": "pending"
    }
  ],
  "requirements": {
    "total": 10,
    "done": 0,
    "inTicket": 10,
    "inSpec": 0,
    "placeholder": 0,
    "deferred": 0,
    "dropped": 0
  },
  "tickets": [
    {
      "id": "01",
      "title": "Переезд проекта по папкам",
      "requirements": [
        "R07",
        "R04"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "package.json",
        "build/",
        "client/",
        "archive/",
        "README.md",
        "AGENTS.md",
        "docs/"
      ],
      "status": "done",
      "startedAt": "2026-09-11T16:57:12+03:00",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "finishedAt": "2026-09-11T17:09:01+03:00",
      "commit": "T01",
      "tests": {
        "passed": 76,
        "failed": 0
      }
    },
    {
      "id": "02",
      "title": "Маскот-ассеты и иконка приложения",
      "requirements": [
        "R05",
        "R06"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "assets/",
        "scripts/make-mascot.mjs",
        "scripts/make-icons.mjs",
        "BRAND.md"
      ],
      "status": "done",
      "startedAt": "2026-09-11T16:57:12+03:00",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "finishedAt": "2026-09-11T17:09:01+03:00",
      "commit": "T02",
      "tests": {
        "passed": 76,
        "failed": 0
      }
    },
    {
      "id": "03",
      "title": "Визуал приложения по эталону",
      "requirements": [
        "R01",
        "R04",
        "R06",
        "R08i",
        "R10i"
      ],
      "blockedBy": [
        "01",
        "02"
      ],
      "wave": 2,
      "zone": [
        "client/"
      ],
      "status": "in-progress",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-11T17:09:01+03:00"
    },
    {
      "id": "04",
      "title": "Визуал сайта по эталону",
      "requirements": [
        "R02",
        "R06",
        "R08i",
        "R09i",
        "R10i"
      ],
      "blockedBy": [
        "02"
      ],
      "wave": 2,
      "zone": [
        "server/app.mjs",
        "server/test/"
      ],
      "status": "in-progress",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-11T17:09:01+03:00"
    },
    {
      "id": "05",
      "title": "Лёгкая сборка, быстрый старт, документация",
      "requirements": [
        "R03",
        "R04"
      ],
      "blockedBy": [
        "01",
        "03"
      ],
      "wave": 3,
      "zone": [
        "build/electron-builder.yml",
        "docs/BUILD.md",
        "README.md"
      ],
      "status": "pending",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0
    },
    {
      "id": "06",
      "title": "Выкладка на сервер и приёмка",
      "requirements": [
        "R01",
        "R02",
        "R03",
        "R04",
        "R05",
        "R06",
        "R07",
        "R09i"
      ],
      "blockedBy": [
        "03",
        "04",
        "05"
      ],
      "wave": 4,
      "zone": [
        "сервер"
      ],
      "status": "pending",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0
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
  "coverage": null,
  "blind": null
}
