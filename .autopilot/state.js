window.STATE =
{
  "slug": "enotdesk-upgrade-v2",
  "dir": "2026-09-17-enotdesk-upgrade-v2--wip",
  "title": "EnotDesk — клиентский апгрейд v2: размер, first-run, видео, unattended, 2FA",
  "mode": "semi",
  "depth": "deep",
  "polish": null,
  "execution": "parallel",
  "tier": "T3",
  "briefFile": "2026-09-17-brief.md",
  "memoryFile": "AGENTS.md",
  "conventionsFile": "AGENTS.md",
  "skillDir": "/Users/admin/.zcode/skills/foreman",
  "startedAt": "2026-09-17T23:37:45+03:00",
  "updatedAt": "2026-09-18T02:28:37+03:00",
  "finishedAt": null,
  "stages": [
    {
      "id": "preflight",
      "status": "done",
      "startedAt": "2026-09-17T23:37:45+03:00",
      "finishedAt": "2026-09-17T23:37:45+03:00"
    },
    {
      "id": "manifest",
      "status": "done",
      "startedAt": "2026-09-17T23:37:45+03:00",
      "finishedAt": "2026-09-17T23:47:20+03:00"
    },
    {
      "id": "briefing",
      "status": "skipped",
      "note": "развилки закрыты на этапе планирования (D1+D2, SYSTEM, один прогон)"
    },
    {
      "id": "spec",
      "status": "done",
      "finishedAt": "2026-09-17T23:47:20+03:00"
    },
    {
      "id": "plan",
      "status": "done",
      "startedAt": "2026-09-17T23:47:20+03:00",
      "finishedAt": "2026-09-17T23:47:20+03:00",
      "note": "8 тасков, ярус T3, 5 волн"
    },
    {
      "id": "build",
      "status": "active",
      "startedAt": "2026-09-17T23:47:20+03:00",
      "note": "волна 4 на ревью (06 инвентарь, 10 доукрепление терминала)"
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
    "total": 12,
    "done": 0,
    "inTicket": 12,
    "inSpec": 0,
    "placeholder": 0,
    "deferred": 0,
    "dropped": 0
  },
  "tickets": [
    {
      "id": "01",
      "title": "A1: срез мёртвого груза koffi",
      "requirements": [
        "R01"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "build/electron-builder.yml"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-17T23:47:20+03:00",
      "finishedAt": "2026-09-18T00:29:43+03:00",
      "commit": "13cf331 (T01-часть)",
      "tests": {
        "passed": 207,
        "failed": 0
      }
    },
    {
      "id": "02",
      "title": "A3: адаптивный битрейт видео",
      "requirements": [
        "R02"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "client/lib/adaptive-bitrate.mjs",
        "client/renderer/session-media.js"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-17T23:47:20+03:00",
      "finishedAt": "2026-09-18T00:29:43+03:00",
      "commit": "13cf331",
      "tests": {
        "passed": 220,
        "failed": 0
      }
    },
    {
      "id": "03",
      "title": "Первый запуск: baked URL, файл-конфиг, экран соединения",
      "requirements": [
        "R03",
        "R04",
        "R05"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "client/lib/first-run.mjs",
        "client/main.mjs",
        "client/renderer/",
        "client/locales/",
        "docs/BUILD.md"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 1,
      "handoffs": 0,
      "startedAt": "2026-09-17T23:47:20+03:00",
      "repairFindings": [
        "BLOCKING: baked-адрес только runtime-env — нужно вшивание через extraMetadata ${env.ENOT_BAKED_SERVER_URL} + чтение из pkg"
      ],
      "finishedAt": "2026-09-18T00:55:20+03:00",
      "commit": "41c816c",
      "tests": {
        "passed": 239,
        "failed": 0
      }
    },
    {
      "id": "04",
      "title": "D1: webhooks (HMAC, ретраи)",
      "requirements": [
        "R10"
      ],
      "blockedBy": [],
      "wave": 2,
      "zone": [
        "server/webhooks.mjs",
        "server/app.mjs",
        "server/db.mjs"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-18T00:05:40+03:00",
      "finishedAt": "2026-09-18T00:31:57+03:00",
      "commit": "b8b669a",
      "tests": {
        "passed": 230,
        "failed": 0
      }
    },
    {
      "id": "05",
      "title": "C1: удалённый терминал (SYSTEM v1)",
      "requirements": [
        "R09",
        "R09.1"
      ],
      "blockedBy": [],
      "wave": 3,
      "zone": [
        "client/lib/term.mjs",
        "client/main.mjs",
        "web/",
        "server/app.mjs"
      ],
      "status": "done",
      "retries": 0,
      "repairs": 2,
      "handoffs": 0,
      "repairFindings": [
        "BLOCKING: терминал мёртв end-to-end — createTermHost не инстанцирован, агент без RTCPeerConnection; + ринг-буфер не держит кусок > лимита",
        "дозапрос 2 (потолок): скрытый renderer-мост RTC — чтобы терминал работал в собранном агенте, а не только на швах"
      ],
      "startedAt": "2026-09-18T01:15:30+03:00",
      "finishedAt": "2026-09-18T02:06:41+03:00",
      "commit": "857b57a",
      "tests": {
        "passed": 250,
        "failed": 0
      }
    },
    {
      "id": "06",
      "title": "C5: инвентарь машин",
      "requirements": [
        "R06"
      ],
      "blockedBy": [],
      "wave": 4,
      "zone": [
        "server/machines.mjs",
        "server/db.mjs",
        "client/lib/agent.mjs"
      ],
      "status": "review",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0,
      "startedAt": "2026-09-18T02:06:41+03:00"
    },
    {
      "id": "07",
      "title": "C2: админ-UI машин",
      "requirements": [
        "R07"
      ],
      "blockedBy": [
        "06"
      ],
      "wave": 5,
      "zone": [
        "web/",
        "client/locales/"
      ],
      "status": "pending",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0
    },
    {
      "id": "08",
      "title": "C4: сообщение на экран машины",
      "requirements": [
        "R08"
      ],
      "blockedBy": [
        "07"
      ],
      "wave": 6,
      "zone": [
        "client/lib/notify.mjs",
        "web/"
      ],
      "status": "pending",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0
    },
    {
      "id": "09",
      "title": "D2: TOTP-2FA операторов",
      "requirements": [
        "R11",
        "R11.1"
      ],
      "blockedBy": [],
      "wave": 5,
      "zone": [
        "server/totp.mjs",
        "server/app.mjs",
        "server/db.mjs"
      ],
      "status": "pending",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0
    },
    {
      "id": "10",
      "title": "Доукрепление терминала: iceServers из /rtc-config, тесты капа/гонки, паритет каналов",
      "requirements": [
        "R09"
      ],
      "blockedBy": [],
      "wave": 4,
      "zone": [
        "client/agent-bridge/",
        "client/lib/term.mjs",
        "client/test/"
      ],
      "status": "review",
      "startedAt": "2026-09-18T02:06:41+03:00",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0
    }
  ],
  "singlePass": null,
  "tests": {
    "passed": 200,
    "failed": 0
  },
  "debt": {
    "placeholders": [],
    "assumptions": [],
    "emptyEnv": [
      "ENOT_SECRET_KEY"
    ]
  },
  "additions": [],
  "coverage": null,
  "concerns": [
    "T02 craft: adaptiveTimer дублирует qualityTimer (два опроса одного pc) — объединить в один цикл",
    "T03 craft: EDESK_SMOKE_FIRSTRUN сравнивается на истинность вместо '1' — унифицировать в дозапросе",
    "T04: claim отозванной машины (machine_revoked) не шлёт machine.claim.denied — решить, входит ли revoked в событие",
    "T04: дефолтные ретраи [1,10,60]с не зафиксированы тестом (тесты на инжектированных) — допустимо",
    "T04: тексты ошибок webhook-маршрута hardcoded ru вместо словарей — косметика, единообразие с machines-маршрутом",
    "T05 craft (→ T10): мост с iceServers:[] — терминал только по LAN; нужен /rtc-config с токеном машины",
    "T05 craft (→ T10): тест капа очереди не мог быть красным; гонка ANSWER-раньше-createAnswer не покрыта",
    "T05 craft (→ T10): имена BRIDGE_IPC продублированы литералами в preload без сверки",
    "T10: runtime-подключение fetchIceServers (main/agent) — дозапрос исполнителю 06-зоны в полёте",
    "T10 craft: канон BRIDGE_IPC захардкожен в контракте (sandbox-preload не импортирует модули) — приемлемо, пометить",
    "T06: дубль match-блоков GET /machines/:id в app.mjs (косметика)"
  ],
  "reviewers": {
    "manifestSpec": null,
    "craft": null
  },
  "blind": null
}
