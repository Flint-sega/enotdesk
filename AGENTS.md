<!-- autopilot:start -->
# EnotDesk

Portable remote support for Windows, macOS and Linux. Client runs only for an attended support session, communicates temporary ID/password through the user's existing chat, and closing terminates remote access. Dark technological branding, strong professional raccoon wearing glasses. Team roles, shared address book, invitations and audit are first-release requirements.

## Current state
Working MVP: Node server (control plane + WS signaling) and Electron desktop client with real native input on macOS; Win/X11 adapters and cross-machine video untested. Root `index.html` is an archived visual mockup — not the application.

## Commands
- `npm install` — deps (node>=24.12; koffi, ws exact-pinned; electron, electron-builder dev).
- `npm test` — node:test, 46 tests, server+desktop, no Electron needed.
- `npm run server` — server on `127.0.0.1:8080`; `GET /api/v1/health` → `{ok:true}`.
- `npm run bootstrap` — interactive CLI creating first admin (refuses to overwrite existing); DB = `ENOT_DB` or `enotdesk.db`.
- `npm start` — Electron client (`EDESK_SMOKE=1 npx electron@44.3.0 desktop/main.mjs --no-sandbox` for smoke run).
- `npm run smoke:local` — full local cycle: bootstrap → login → invite/accept → session → claim → consent → WS relay offer/answer → end.
- `npm run pack:mac` — electron-builder zip into `dist/` (`pack:win`, `pack:linux` analogues); `npm run icons` — macOS only (sips/iconutil).

## Structure
```
server/          control plane: app.mjs (all HTTP /api/v1 + WS /signal), db.mjs (node:sqlite), crypto.mjs (scrypt, tokens), bootstrap.mjs, test/
desktop/         Electron: main.mjs (window, tokens, WS, input wiring), preload.cjs (window.enot bridge)
desktop/lib/     Electron-free shims: api.mjs, signal.mjs, protocol.mjs, input-pipeline.mjs, native-input.mjs
desktop/renderer/ UI (index.html, app.js, styles.css) — no nodeIntegration
desktop/test/    node:test for the lib shims
assets/          enot-mascot.svg, enot-icon.svg, icon.png (+.icns/.ico), README.md
scripts/         smoke-local.mjs, make-icons.mjs
docs/            SESSION_PROTOCOL.md, adr/0001-original-electron-webrtc.md
```

## Key files
- `server/app.mjs` — `createServer({dbPath,host,port,leaseMs,heartbeatMs,limits}) -> {start,close}`; sole service entry, prod and tests use it.
- `server/main.mjs` — CLI wrapper: `bootstrap` arg or server start from `ENOT_*` env.
- `desktop/main.mjs` — main process: owns authToken/hostToken, WS client, input gate, `desktopCapturer`; renderer sees only `window.enot`.
- `desktop/lib/input-pipeline.mjs` — `createInputPipeline({gate,nativeInput}).handle(evOrRawString,bounds)`: parse → validate → gate → dispatch; single wiring used by main and tests.
- `desktop/lib/native-input.mjs` — lazy koffi adapters: macOS CoreGraphics / Win SendInput / X11 XTest; missing koffi/OS API → inert adapter with honest status; Wayland → `wayland-unsupported-control`.
- `desktop/lib/protocol.mjs` — `INPUT_KEYS` Set is the single allowlist of keys (renderer gets it via `permissions().inputKeys`); also `validateInputEvent`, `validateOutgoingSignal`, `createInputGate`.

## Architecture
Client `POST /sessions` (unauthenticated, rate-limited) → gets `sessionId` (9 digits) + `password` + `hostToken`; lease starts immediately, host refreshes via WS `heartbeat` every 5s, timeout 20s. Operator `claim` (bearer admin/operator) → host gets `claim` → host `decision allow` → both get `approved`; both connect WS `/signal`, one socket per participant, duplicate rejected. Server relays only offer/answer/ICE (host is offerer) between approved participants; video over WebRTC, input over DataChannel → input-pipeline → koffi native dispatch. RBAC: admin/operator/auditor, checked per-request; auditor read-only; last active admin protected. Audit + history are append-only server tables. Signal loss or `end` invalidates session immediately, input resets (releases held keys/buttons).

## Conventions
Server is pure ESM `.mjs`, node:sqlite (experimental warning is normal), no frameworks — only `ws` + `koffi`. Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; renderer talks only via preload bridge `window.enot`. Keys/buttons/scroll/SDP sizes are allowlisted and bounded (protocol.mjs); file serving from `dist/` is name-allowlisted, traversal rejected. Unavailable platform features report honest status (`native-unavailable`, `wayland-unsupported-control`), never fake success. Russian user-facing messages; frozen API contracts live in `.autopilot/enotdesk/interfaces.md`.

## Environment
`ENOT_HOST`, `ENOT_PORT`, `ENOT_DB`, `ENOT_PUBLIC_URL`, `ENOT_TURN_URLS`, `ENOT_TURN_USERNAME`, `ENOT_TURN_PASSWORD` (see `.env.example`) — never commit values; desktop also reads `EDESK_SMOKE=1`.

## Tests
`node --test server/test/*.test.mjs desktop/test/*.test.mjs`; single file: `node --test server/test/session-flow.test.mjs`. `smoke:local` covers the whole control-plane + signaling cycle on a temp DB in ephemeral port. NOT covered: real input injection into OS, WebRTC video across machines, Win/X11 adapters (inert only), Electron UI smoke — report those honestly, don't fake.

## Pitfalls
koffi 3.x: `lib.func(...)` with full C signature strings; adapters load lazily, any load failure must fall back to inert, never throw. `npm run icons` uses sips/iconutil — macOS only, exits on other OS. `.autopilot/` is committed (except graphify-out/, which is gitignored). Root `index.html`/`app.js`/`styles.css` — archived mockup, do not mistake for the app. electron 44.3.0 and koffi 3.2.1 are exact-pinned — do not bump casually; `asarUnpack` for koffi is required in builds. Input decision belongs to main via WS-state gate (`gate.isOpen()`), never trust renderer claims.

## Autopilot
Full / deep run tracked in `.autopilot/enotdesk/`, live state in `.autopilot/state.js`. User requirements may not be silently deferred. Code changes delegated to executors. No deployment/publication or secret collection. Tests and actual startup required; native platform availability must be reported honestly.
<!-- autopilot:end -->
