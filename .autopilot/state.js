window.STATE =
{
  "slug": "enotdesk",
  "title": "EnotDesk — удалённая поддержка",
  "mode": "full",
  "depth": "deep",
  "polish": null,
  "tier": "T2",
  "briefFile": "2026-09-11-brief.md",
  "memoryFile": "AGENTS.md",
  "startedAt": "2026-09-11T01:26:32+03:00",
  "updatedAt": "2026-09-11T01:44:28+03:00",
  "finishedAt": null,
  "stages": [
    {"id":"preflight","status":"done","startedAt":"2026-09-11T01:26:32+03:00","finishedAt":"2026-09-11T01:32:16+03:00"},
    {"id":"manifest","status":"done","startedAt":"2026-09-11T01:32:16+03:00","finishedAt":"2026-09-11T01:33:14+03:00"},
    {"id":"briefing","status":"skipped","note":"Полный автомат — самобрифинг; решения в manifest.md"},
    {"id":"spec","status":"done","startedAt":"2026-09-11T01:33:14+03:00","finishedAt":"2026-09-11T01:36:36+03:00"},
    {"id":"plan","status":"done","startedAt":"2026-09-11T01:36:36+03:00","finishedAt":"2026-09-11T01:44:28+03:00","note":"4 таска, ярус T2, 3 волны"},
    {"id":"build","status":"active","startedAt":"2026-09-11T01:44:28+03:00","note":"0 из 4 тасков готовы"},
    {"id":"review","status":"pending"},
    {"id":"final","status":"pending"}
  ],
  "requirements":{"total":19,"done":0,"inTicket":19,"inSpec":0,"placeholder":0,"deferred":0,"dropped":0},
  "tickets":[
    {"id":"01","title":"Команда и временные сессии","requirements":["R07","R08","R09","R10","R11","R12","R14","R15","R16","R18"],"blockedBy":[],"wave":1,"zone":["server/","package.json",".gitignore",".env.example"],"status":"repair","startedAt":"2026-09-11T01:44:28+03:00","retries":0,"repairs":1,"handoffs":0},
    {"id":"02","title":"Настольная поддержка и интерфейс","requirements":["R01","R02","R03","R04","R05","R07","R08","R09","R10","R11","R12","R14","R15","R16","R17","R19i"],"blockedBy":["01"],"wave":2,"zone":["desktop/"],"status":"pending","retries":0,"repairs":0,"handoffs":0},
    {"id":"03","title":"Фирменный енот и иконки","requirements":["R03","R04","R05","R06","R13","R17"],"blockedBy":["01"],"wave":2,"zone":["assets/"],"status":"pending","retries":0,"repairs":0,"handoffs":0},
    {"id":"04","title":"Portable, запуск и связная проверка","requirements":["R01","R02","R03","R04","R05","R06","R07","R08","R09","R10","R11","R12","R13","R14","R15","R16","R17","R18","R19i"],"blockedBy":["02","03"],"wave":3,"zone":["package.json","desktop/","server/","docs/","README.md","BRAND.md"],"status":"pending","retries":0,"repairs":0,"handoffs":0}
  ],
  "singlePass":null,
  "tests":null,
  "debt":{"placeholders":[],"assumptions":["Одна команда поддержки; чат существующий внешний"],"emptyEnv":[]},
  "additions":[],
  "coverage":{"found":3,"fixed":3,"deferred":0,"note":"Процесс добавлен в §9; серверное противоречие и дополнительный consent явно обозначены допущениями"},
  "blind":null
}
