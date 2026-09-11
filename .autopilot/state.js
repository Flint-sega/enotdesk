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
  "updatedAt": "2026-09-11T12:29:01+03:00",
  "finishedAt": null,
  "stages": [
    {"id":"preflight","status":"done","startedAt":"2026-09-11T11:30:00+03:00","finishedAt":"2026-09-11T11:38:07+03:00","note":"разведка сервера Ubuntu 24.04, вход по ключу"},
    {"id":"manifest","status":"done","startedAt":"2026-09-11T11:38:07+03:00","finishedAt":"2026-09-11T11:40:37+03:00"},
    {"id":"briefing","status":"skipped","note":"полный автомат — самобрифинг"},
    {"id":"spec","status":"done","startedAt":"2026-09-11T11:40:37+03:00","finishedAt":"2026-09-11T11:40:37+03:00"},
    {"id":"plan","status":"done","startedAt":"2026-09-11T11:40:37+03:00","finishedAt":"2026-09-11T11:40:37+03:00","note":"3 таска, ярус T1, 2 волны"},
    {"id":"build","status":"active","startedAt":"2026-09-11T11:40:37+03:00"    ,"note":"0 из 3 тасков готовы"},
    {"id":"review","status":"pending"},
    {"id":"final","status":"pending"}
  ],
  "requirements":{"total":5,"done":0,"inTicket":5,"inSpec":0,"placeholder":0,"deferred":0,"dropped":0},
  "tickets":[
    {"id":"05","title":"Скрипты установки и деплоя","requirements":["R20","R20.1","R20.2","R20.3","R20.4","R24i"],"blockedBy":[],"wave":1,"zone":["scripts/",".env.example"],"status":"review","startedAt":"2026-09-11T11:40:37+03:00","retries":0,"repairs":0,"handoffs":0},
    {"id":"06","title":"Документация сервера и сборок","requirements":["R21","R21.1"],"blockedBy":[],"wave":1,"zone":["docs/","README.md"],"status":"review","startedAt":"2026-09-11T11:40:37+03:00","retries":0,"repairs":0,"handoffs":0},
    {"id":"07","title":"Развёртывание и обкатка на тестовом сервере","requirements":["R22","R23i","R20"],"blockedBy":["08"],"wave":3,"zone":["сервер"],"status":"pending","retries":0,"repairs":0,"handoffs":0},
    {"id":"08","title":"Node tarball + устойчивый деплой (D01)","requirements":["R20","R22"],"blockedBy":["05"],"wave":2,"zone":["scripts/","docs/SERVER.md"],"status":"in-progress","startedAt":"2026-09-11T12:29:01+03:00","retries":0,"repairs":0,"handoffs":0}
  ],
  "singlePass":null,
  "tests":null,
  "debt":{"placeholders":[],"assumptions":[],"emptyEnv":["ENOT_DEPLOY_HOST","ENOT_DEPLOY_USER","ENOT_DEPLOY_PASSWORD"]},
  "additions":[],
  "coverage":null,
  "blind":null
}
