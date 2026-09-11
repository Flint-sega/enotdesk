window.STATE =
{
  "slug": "enotdesk-deploy",
  "title": "EnotDesk — развёртывание на сервер и документация",
  "mode": "full",
  "depth": "deep",
  "polish": null,
  "tier": "T1",
  "briefFile": "2026-09-11-brief.md",
  "memoryFile": "AGENTS.md",
  "startedAt": "2026-09-11T11:38:07+03:00",
  "updatedAt": "2026-09-11T12:41:04+03:00",
  "finishedAt": "2026-09-11T12:41:04+03:00",
  "stages": [
    {
      "id": "preflight",
      "status": "done",
      "startedAt": "2026-09-11T11:30:00+03:00",
      "finishedAt": "2026-09-11T11:38:07+03:00",
      "note": "разведка сервера Ubuntu 24.04, вход по ключу"
    },
    {
      "id": "manifest",
      "status": "done",
      "startedAt": "2026-09-11T11:38:07+03:00",
      "finishedAt": "2026-09-11T11:40:37+03:00"
    },
    {
      "id": "briefing",
      "status": "skipped",
      "note": "полный автомат — самобрифинг"
    },
    {
      "id": "spec",
      "status": "done",
      "startedAt": "2026-09-11T11:40:37+03:00",
      "finishedAt": "2026-09-11T11:40:37+03:00"
    },
    {
      "id": "plan",
      "status": "done",
      "startedAt": "2026-09-11T11:40:37+03:00",
      "finishedAt": "2026-09-11T11:40:37+03:00",
      "note": "3 таска, ярус T1, 2 волны"
    },
    {
      "id": "build",
      "status": "done",
      "startedAt": "2026-09-11T11:40:37+03:00",
      "note": "4 из 4 тасков готовы (07 — развёртывание и обкатка)",
      "finishedAt": "2026-09-11T12:41:04+03:00"
    },
    {
      "id": "review",
      "status": "done",
      "startedAt": "2026-09-11T12:41:04+03:00",
      "finishedAt": "2026-09-11T12:41:04+03:00",
      "note": "все таски проверены независимыми ревьюерами"
    },
    {
      "id": "final",
      "status": "done",
      "startedAt": "2026-09-11T12:41:04+03:00",
      "finishedAt": "2026-09-11T12:41:04+03:00"
    }
  ],
  "requirements": {
    "total": 6,
    "done": 6,
    "inTicket": 0,
    "inSpec": 0,
    "placeholder": 0,
    "deferred": 0,
    "dropped": 0
  },
  "tickets": [
    {
      "id": "05",
      "title": "Скрипты установки и деплоя",
      "requirements": [
        "R20",
        "R20.1",
        "R20.2",
        "R20.3",
        "R20.4",
        "R24i"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "scripts/",
        ".env.example"
      ],
      "status": "done",
      "startedAt": "2026-09-11T11:40:37+03:00",
      "retries": 0,
      "repairs": 2,
      "handoffs": 0,
      "finishedAt": "2026-09-11T12:04:16+03:00",
      "commit": "7d264c4",
      "tests": {
        "passed": 46,
        "failed": 0
      }
    },
    {
      "id": "06",
      "title": "Документация сервера и сборок",
      "requirements": [
        "R21",
        "R21.1"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "docs/",
        "README.md"
      ],
      "status": "done",
      "startedAt": "2026-09-11T11:40:37+03:00",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "finishedAt": "2026-09-11T12:04:16+03:00",
      "commit": "c7a6fad",
      "tests": {
        "passed": 46,
        "failed": 0
      }
    },
    {
      "id": "07",
      "title": "Развёртывание и обкатка на тестовом сервере",
      "requirements": [
        "R22",
        "R23i",
        "R20"
      ],
      "blockedBy": [
        "08"
      ],
      "wave": 3,
      "zone": [
        "сервер"
      ],
      "status": "done",
      "startedAt": "2026-09-11T12:36:06+03:00",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "finishedAt": "2026-09-11T12:41:04+03:00",
      "commit": "FINAL",
      "tests": {
        "passed": 46,
        "failed": 0
      },
      "concerns": [
        "deploy-server.sh не поддерживает --help (env-driven; задокументировано)"
      ]
    },
    {
      "id": "08",
      "title": "Node tarball + устойчивый деплой (D01)",
      "requirements": [
        "R20",
        "R22"
      ],
      "blockedBy": [
        "05"
      ],
      "wave": 2,
      "zone": [
        "scripts/",
        "docs/SERVER.md"
      ],
      "status": "done",
      "startedAt": "2026-09-11T12:29:01+03:00",
      "retries": 0,
      "repairs": 1,
      "handoffs": 0,
      "finishedAt": "2026-09-11T12:36:11+03:00",
      "commit": "HEAD",
      "tests": {
        "passed": 46,
        "failed": 0
      }
    }
  ],
  "singlePass": null,
  "tests": null,
  "debt": {
    "placeholders": [],
    "assumptions": [],
    "emptyEnv": [
      "ENOT_DEPLOY_HOST",
      "ENOT_DEPLOY_USER",
      "ENOT_DEPLOY_PASSWORD"
    ]
  },
  "additions": [],
  "coverage": null,
  "blind": {
    "verdict": "сервер реально работает (health/страницы/смоук/reboot); скрипты и документация на месте; единственное расхождение — deploy-server.sh без --help (не требование)",
    "drift": 0
  }
}
