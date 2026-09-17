# Contributing to EnotDesk

Thank you for considering a contribution. EnotDesk is a remote-support tool that strangers run on machines they care about, so the project optimizes for honesty and safety over features: no fake success states, no unbounded inputs, no hidden network behavior.

## Development setup

- Node.js ≥ 24.12 (the server uses `node:sqlite`; its experimental warning is normal).
- `npm install` — dependencies are `ws` and `koffi` (exact-pinned), dev deps include Electron 44.3.0 (exact-pinned) and ESLint.
- `npm test` — the full `node:test` suite (no Electron required).
- `npm run lint` — must be clean.
- `npm run smoke:local` — full control-plane cycle (bootstrap → login → invite → session → claim → consent → signaling) on a temp DB.

## Ground rules

- **Pure ESM `.mjs`** on the server; no frameworks — only `ws` + `koffi`. Do not add dependencies without discussing it in an issue first.
- **Exact pins are intentional**: `electron 44.3.0` and `koffi 3.2.1` are pinned; do not bump them casually, and keep `asarUnpack` for koffi in the build config.
- **Honest status everywhere**: an unavailable platform feature reports `native-unavailable` / `wayland-unsupported-control` — never fake success. Koffi adapters load lazily and fall back to inert adapters instead of throwing.
- **Allowlists and bounds**: keys, buttons, scroll deltas, SDP sizes and served filenames are allowlisted and size-bounded. New protocol input must go through validation in `client/lib/protocol.mjs` (or the server equivalent), never raw pass-through.
- **Input decisions belong to the main process** behind the WS-state gate (`gate.isOpen()`); renderer claims are never trusted.
- **Security invariants**: passwords and tokens are stored only as hashes; secrets never cross into the renderer; RBAC is checked per request; the last active admin is protected; audit and history are append-only.
- **User-facing messages are in Russian** (the project ships ru+en); keep new user-facing strings consistent with that convention.
- **Architectural decisions** are recorded as ADRs in `docs/adr/` (numbering continues from the latest).

## Pull requests

1. Fork / branch, keep the change focused.
2. Add or extend tests for any behavior change — tests run through public seams (server HTTP/WS via `createServer()`, Electron-free lib shims, the renderer contract test).
3. `npm test`, `npm run lint` and `npm run smoke:local` must pass locally; CI must be green on ubuntu (windows/macos jobs are advisory while those adapters are verified manually).
4. Describe in the PR what you changed and what you verified manually (e.g., “input injection tested on macOS only”).
5. One-line commit summaries in Russian are the existing convention; matching it is appreciated but not required.

## Areas

`server/` (control plane + WS signaling), `client/` (Electron main + preload + lib shims + renderer), `web/` (browser operator), `docker/` (self-hosting stack), `docs/` (guides and ADRs). If your change touches an area another maintainer owns, call it out early in an issue.

## Reporting issues

Bugs and feature requests go to GitHub Issues. Security vulnerabilities do **not** — see [SECURITY.md](SECURITY.md) for the private reporting channel.
