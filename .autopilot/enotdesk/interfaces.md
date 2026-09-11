# Границы, решённые в спецификации

Server owns SQLite accounts/contacts/audit, temporary sessions and WS signaling. Exposes JSON /api/v1 and /signal; hides hashes, raw DB, binding/rate limits. Desktop main owns window/process, configuration, capture-source selection, native input and network calls; exposes context-isolated enot bridge only, hides OS handles and never accepts arbitrary IPC method/path. Renderer owns UI, media tracks/RTCPeerConnection and verified datachannel processing; no nodeIntegration and strict CSP. Branding owns SVG/icon resources only.

## Общие правила
Node >=24.12, ESM .mjs server; Electron stable pinned exact version and ws/koffi, electron-builder exact pinned, package-lock committed. npm scripts server, bootstrap, start, test, pack:mac, pack:win, pack:linux. No new framework. Root package created T01; T02 owns desktop only; T03 assets only. T04 integration owns final package/README/docs checks. Dependencies essential to requested build may be downloaded; missing external services report BLOCKED, never simulate readiness. No secrets in source/reports. Existing root HTML remains visibly mockup (T04). All edits apply_patch. No commits by executor; orchestrator commits after independent review. Return CONTRACT block with exact additions/changes.

## HTTP /api/v1 (frozen)
JSON request/response. Error {error:{code,message}} in Russian. Bearer auth in Authorization; no cookies. POST responses normally 201/200. List {items,total}; limit default50 max100, offset>=0. ISO date strings.

- GET /health -> {ok:true,version} unauthenticated.
- POST /auth/login {login,password} -> {token,user:{id,login,name,role,active},expiresAt}.
- GET /auth/me -> {user}; POST /auth/logout {} -> {ok:true}.
- GET /members -> {items,total} admin; PATCH /members/:id {role?,active?} -> {user}; cannot remove last active admin.
- GET /invites admin -> {items,total} no token; POST /invites {role} -> {invite:{id,role,expiresAt},token,url}; DELETE /invites/:id -> {ok:true}. POST /invites/accept {token,login,name,password} -> {ok:true}, unauthenticated. invite URL /invite#token=... browser page explains/open app, app has accept form paste code or URL.
- GET /contacts?q=&limit=&offset= authenticated all; POST /contacts {name,notes,tags} -> {contact}; PATCH /contacts/:id {name,notes,tags,revision} -> {contact}; DELETE /contacts/:id with JSON {revision} -> {ok:true}. admin/operator write, auditor read. Contact {id,name,notes,tags,revision,createdAt,updatedAt}.
- GET /history?limit=&offset= -> {items,total}; History {id,contactId,operatorId,operatorName,state,createdAt,startedAt,endedAt,endReason}.
- GET /audit?limit=&offset= -> {items,total}; Audit {id,actorId,action,targetId,detail,createdAt}; read all roles, no secret detail.
- POST /sessions {} unauthenticated rate limited -> {sessionId,password,hostToken,expiresAt}; sessionId numeric 9 digits; lease starts immediately.
- POST /sessions/:id/claim {password,contactId?} bearer admin/operator -> {sessionId,claimId,operator:{id,name},state:'pending-consent'}; generic failure. One claim only.
- POST /sessions/:id/decision {claimId,allow:boolean} Authorization Bearer hostToken -> {ok:true}; approval sets approved. Denial ends session to ensure fresh attempt.
- POST /sessions/:id/end {} with hostToken or claimed operator bearer -> {ok:true}; idempotent for legitimate caller; session invalidated immediately.
- GET /rtc-config Authorization hostToken OR valid operator token -> {iceServers:[...]}; default [] for offline local test, configurable STUN/TURN. Production secrets never public.
- GET /downloads and /invite provide minimal real HTML (server owner); GET /api/v1/downloads -> {items:[{platform,arch,name,url,size}]} actual allowlisted filenames in dist only. No exposing project files or .env. T04 final design integration.

## WS /signal (frozen)
WS connects same server origin. First within5s: {type:'auth',role:'host',sessionId,token:hostToken} OR {type:'auth',role:'operator',sessionId,token:operatorToken,claimId}. One socket per participant; reject duplicate sockets (no supersession race). Reply {type:'ready',sessionId,role,state}. Native main emits renderer event after auth-ready only. Ping heartbeat owned transport; lease refresh for host on explicit {type:'heartbeat'} every5s; timeout20s. Server sends {type:'heartbeat'} acknowledgement optional. Loss host/operator signal ends current session and notifies counterpart.

Host receives {type:'claim',claimId,operator:{id,name}} including pending claim when host authenticates. Both receive {type:'approved',claimId} after decision. On late operator socket auth, server must send approved if already approved. Signal relay accepts {type:'signal',data:{description:{type:'offer'|'answer',sdp}}} OR {type:'signal',data:{candidate:<RTCIceCandidateInit>}} only approved participants, strips extra routing/identity, forwards same schema. Host is offerer, operator answerer; candidate queue until remote description set. Server sends {type:'ended',reason}; errors {type:'error',code,message}. Reject signal before approval/cross-session. Frame max128KiB, validate type/data and bound relay frequency.

## Desktop bridge (owned T02)
Renderer gets window.enot with explicit methods: getSettings(), setServerUrl(url), request(operation,payload), openSignal({role,sessionId,hostToken?,claimId?}), sendSignal(message), closeSignal(), onSignal(callback)->unsubscribe, sources(), selectSource(id), permissions(), input(event), copy(text), quit(). request operation enum maps fixed HTTP routes (include id in validated payload), main owns authToken after login, hostToken after creation; don't return tokens to renderer except invite token for manual sharing. Runtime IPC sender must be local trusted frame. input(event) native only if approved host session gate; gate also checked main-side, not just renderer.

Capture through desktopCapturer + selected source validated in main; renderer navigator.mediaDevices.getDisplayMedia via setDisplayMediaRequestHandler or documented supported capture path. Native main tracks selected display bounds, active consent/lifetime. DataChannel protocol {type:'move',x:0..1,y:0..1}, {type:'button',button:'left'|'right'|'middle',down:boolean}, {type:'key',key:<allowlist>,down:boolean}, {type:'scroll',dx,dy bounded}. Key releases/held buttons reset on end. Never arbitrary scancodes/shell strings.

## Assets contract (owned T03)
assets/enot-mascot.svg wide shoulders, glasses, headset; assets/enot-icon.svg compact; assets/icon.png 1024x1024 for packager. Optional .icns/.ico if generated reliably. Desktop references ../assets/enot-mascot.svg and ../assets/icon.png. License original art stated in assets/README.md. No external generation credentials. SVG native artwork allowed.

## Test seams
Public server create/start/close helper can be exported for node:test ephemeral port/temporary database; production uses same app. Desktop input validation and native adapters separate module test with inert adapter only; real OS input smoke reported separately. Lifecycle and WS behavior tested against real service. No test-only bypass in released main/renderer. Browser smoke uses Electron visible runtime/offline screenshots without silently accepting permissions or real desktop control.

## Implemented contracts

### Из таска 01 — control plane (server/)
- `createServer({dbPath,host,port,leaseMs,heartbeatMs,limits}) -> {start,close}` — единственная точка поднятия сервиса (server/app.mjs); прод использует тот же app.
- HTTP /api/v1 и WS /signal реализованы по frozen-контрактам выше: sessions create/claim/decision/end, rtc-config, members, invites (+POST /invites/accept), contacts, history, audit, /downloads (+ /downloads-files/:name по allowlist имён из dist/), /invite HTML.
- CLI bootstrap первого админа: `npm run bootstrap` (интерактивный скрытый ввод; отказ перезаписывать существующего).
- WS close-коды: 4001 auth-timeout, 4002 auth-first, 4003 invalid-session, 4004 duplicate socket.
- Скрипты: `npm test` (node:test, 26 тестов), `npm run server`. node:sqlite — experimental warning нормален.
- Пароли scrypt, токены в БД только хеши; rate limits in-memory per-IP (сброс при рестарте — принято).
- Файловый стриминг dist/ появился в T01: GET /api/v1/downloads-files/:name (allowlist, 400 traversal, 404 иначе).

### Из таска 02 — desktop
- `window.enot` = {getSettings,setServerUrl,request(op,payload),openSignal,sendSignal,closeSignal,onSignal,sources,selectSource,permissions,input,copy,openExternal,quit} — единственный мост renderer→main.
- request-enum: health, login, logout, me, session.create/claim/decision/end, rtc.config, members.list/patch, invites.list/create/revoke, invite.accept, contacts.list/create/update/delete, history.list, audit.list.
- authToken/hostToken живут только в main; sanitizeForRenderer срезает hostToken на любой глубине; WS-auth нормализует hostToken→token.
- koffi-адаптеры (macOS CG / Win SendInput / X11 XTest) подключаются лениво; без koffi — инертный честный статус.
- Тесты: `node --test desktop/test/*.test.mjs` (15). Смоук: `EDESK_SMOKE=1 npx electron@44.3.0 desktop/main.mjs --no-sandbox`.
- Renderer ждёт ../assets/enot-mascot.svg c текстовым fallback (см. таск 03).

### Из таска 02, ремонт (обязано для T04)
- desktop/lib/input-pipeline.mjs = createInputPipeline({gate,nativeInput}).handle(evOrRawString,bounds) — единые ворота/валидация/диспетчер.
- protocol.mjs экспортирует INPUT_KEYS — единственный источник допустимых клавиш; renderer получает его через permissions().inputKeys.
- before-quit: best-effort POST /sessions/:id/end (Promise.race 1с), выход не блокирует.
- T04 ОБЯЗАН: добавить koffi точным пином в корневой package.json (dependencies), чтобы диспетчер перестал быть инертным; проверить `require('koffi')` на macOS; адаптеры Win/X11 в реальной ОС недоступны — оставить честный статус. UI-скриншот главного окна приложить в отчёт (до сих пор не снимался).

### Из таска 03 — assets
- assets/enot-mascot.svg — маскот 800×900 (viewBox), hero главного окна; title/desc на русском.
- assets/enot-icon.svg — 64×64; assets/icon.png — 1024×1024 RGBA, отрендерен qlmanage из SVG.
- assets/README.md — оригинальность, палитра, команда перегенерации PNG; товарный знак не регистрировался.
- .icns/.ico не созданы; команда генерации описана в assets/README.md (сделает T04 при упаковке).
