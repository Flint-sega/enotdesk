# enotdesk-video

Unattended-video helper (ADR 0026/0027): a Windows-only Rust binary that runs
**inside the logged-on console session** (the service starts it with the
session token, RustDesk mechanics) and does what a session-0 service cannot:
DXGI Desktop Duplication capture, JPEG encode, and console input injection.

It is one half of the v0.5 unattended-video stack:

```
Node service (SYSTEM)                    enotdesk-video (console session)
---------------------                    --------------------------------
spawn helper, --token <hex> on    -----> reads --token from argv (v0.6 fix:
command line (DETACHED, no stdin)         DETACHED spawn has no stdin)
connects to named pipe         <-------> pipe server \\.\pipe\enotdesk-video
reads frames/status                      DXGI -> downscale 1280 -> JPEG -> pipe
sends commands (JSON)          --------> SendInput / monitor power / quality
```

Runtime dependencies: none beyond the `windows` crate (0.58, same major as the
proven `spike/video-dxgi`).

## Launch contract

1. Service (SYSTEM) starts the helper in the console session (token of the
   logged-on user, `CreateProcessAsUser`) with `--token <hex>` on the command
   line (v0.6: DETACHED spawn has no stdin; the command line is visible only
   within the same trust domain as the default pipe ACL — same session/user).
2. No/empty `--token` -> exit code 1.
3. Helper creates the pipe server and blocks in `ConnectNamedPipe`.
4. Service connects, then MUST send `hello` (type 0) with the same token as the
   first message. Mismatch -> session torn down, exit code 3.
5. Shutdown: the service kills the helper (`taskkill /T /F` by pid). There is
   no stdin-based shutdown signal (no stdin at all).

stdout carries **only ASCII JSON diagnostic lines**: one `start` event, one
`tick` every 10 s (`{"ev":"tick","state":"waiting|live","mode":"dxgi|gdi",
"fps":N,"pr":N,"empty":N,"vp":N,"probe":"-","displayOff":bool,"dup":N,
"err":"…"}`), one optional
`{"ev":"capture","mode":"gdi","reason":…}` when the capture mode switches
(see below), and one `exit` event. Errors also go to `lastErr` in the
status document; nothing else is printed.

## Pipe protocol

Binary messages in both directions, byte-mode duplex named pipe
`\\.\pipe\enotdesk-video`:

```
[u32 LE magic = 0x454E4F54 ("ENOT")][u8 type][u32 LE payload length][payload]
```

| type | direction        | payload                                              |
|------|------------------|------------------------------------------------------|
| 0    | service -> helper | `hello`: token bytes, must be the first message     |
| 1    | helper -> service | `frame`: JPEG bytes                                 |
| 2    | helper -> service | `status`: JSON, every 2 s                           |
| 3    | service -> helper | `command`: JSON, one command per message            |

Status document:

```json
{"mode":"dxgi","fps":24,"pr":3,"empty":0,"vp":1,"probe":"ok","lastErr":"","uac":false,"locked":false,"displayOff":false}
```

- `mode` — active capture mode: `dxgi` (Desktop Duplication) or `gdi`
  (BitBlt fallback), see "Capture modes" below.
- `fps` — frames sent in the last 2 s window.
- `pr` — frames encoded in the last window (real presents after the D1
  empty-acquisition filter).
- `empty` — DXGI acquisitions in the window that carried no presentation
  (pointer-only metadata; never encoded; stays 0 in GDI mode).
- `vp` — verified input probes in the window (see "Input injection").
- `probe` — last probe outcome: `"ok"` (cursor followed the nudge), `"frozen"`
  (position did not move) or `"-"` (no probe yet).
- `lastErr` — last human-readable problem (ASCII), empty when healthy.
- `uac` — `consent.exe` is running (Toolhelp snapshot, 2 s cadence): the UAC
  secure-desktop prompt is up. Input is typically blocked while true.
- `locked` — `OpenInputDesktop` failed: lock screen / secure desktop is active.
- `displayOff` — helper-side tracking (after a `sleep` command or long capture
  timeouts that triggered a wake attempt).

Commands (JSON object with `"cmd"`):

```json
{"cmd":"mouse","x":0.5,"y":0.5,"buttons":"move"}
{"cmd":"mouse","x":0.5,"y":0.5,"buttons":"down","button":"left"}
{"cmd":"mouse","buttons":"up","button":"left"}
{"cmd":"key","key":"a","down":true}
{"cmd":"wheel","dy":-3}
{"cmd":"wake"}
{"cmd":"sleep"}
{"cmd":"quality","jpegQ":70,"maxFps":24}
{"cmd":"probe"}
{"cmd":"probe3"}
```

- `x`/`y` are normalized 0..1 over the **virtual desktop** (all monitors).
  Positioning (rev-3b) goes through **`SetCursorPos`** in virtual-desktop
  pixels: the X-series (2026-10-07) proved `SendInput` absolute moves are
  REJECTED by the system (return 0) on Basic Display Adapter VMs in both spawn
  contexts, while `SetCursorPos` on the same attached input thread moves the
  cursor. Buttons and wheel stay on `SendInput` at the positioned point.
- `button` is `left|right|middle`; `buttons` is the action `down|up|move`.
  A click that carries coordinates is sent as a `SetCursorPos` move, then
  down/up.
- `key` names are exactly the `INPUT_KEYS` allowlist from
  `client/lib/protocol.mjs` (letters, digits, `space enter tab escape
  backspace delete`, arrows, `home end pageup pagedown`, `shift control alt
  meta`, and the punctuation set). Navigation keys are injected with
  `KEYEVENTF_EXTENDEDKEY` so they do not type digits (numpad twins).
- `jpegQ` clamps to 40..90, `maxFps` clamps to 1..=60.
- `probe` (lab diagnostics): one input probe — read the cursor, nudge it
  +2 px by X with `SetCursorPos`, read again, nudge back. Verified `ok` iff
  the position demonstrably followed the nudge.
- `probe3` (lab diagnostics, rev-3b): one pass of the FULL injection matrix
  in a fixed order — SetCursorPos reference, `SendInput` absolute (+2 px),
  `SendInput` relative (+40 px), legacy `mouse_event` (+40 px), `SendInput`
  key F15 down/up (side-effect-free VK). The SendInput/key variants report
  accepted + LastError text; legacy `mouse_event` has no return value and is
  judged by the cursor position; cursor-affecting variants report before/after
  positions in one `{"ev":"probe3",…}` log line. Log-only: `probe3` does NOT
  update the status `probe`/`vp` counters (those are driven by `probe`).
  No product caller.

## Input injection and lab diagnostics (rev-3b)

- All injection runs on a dedicated input thread attached to the input desktop
  with write access (`attach_input_desktop`) — an inherited desktop handle can
  lack `DESKTOP_WRITEOBJECTS`, silently eating input.
- A rejected `SendInput` records the captured LastError text (via
  `FormatMessageW`) in `lastErr`. Honest caveat: `SendInput` is not documented
  to set LastError, so `gle=0 (not set)` is a valid observation.
- `ENOT_VIDEO_TRACE=<any>` (env, read once at startup, lab-only) returns the
  unconditional per-command mouse trace:
  `{"ev":"cmd-mouse","via":"cursor","sent":bool,…}` — without it success is
  silent (the unconditional trace accumulated input latency and was removed
  in 0b419b3).
- `ENOT_VIDEO_AUTOPROBE_SECS=<N>` with `N >= 1` (env, lab-only): the helper
  enqueues one `probe3` matrix pass every N seconds with no operator command.
  The env is inherited by the service-spawned helper (session-spawn passes
  Environment=null), which is how the lab measures the service context.
  Default: off.
- The stdout `tick` line carries the window counters: `pr`, `empty`, `vp`,
  `probe` (same meaning as in the status document).

## Product auto-nudge and desktop recheck (rev-3c, ADR 0027 addendum-2)

- **D10.1 auto-nudge (owner-approved)**: while a client is connected AND the
  operator actually sent input (mouse/key/wheel) within the last 10 s, the
  helper nudges the cursor by +2 px at most once per 4 s and restores the
  position (the existing `probe`). This is the "does synthetic input reach the
  screen" sensor for the future `input-dead-video` trigger; its result feeds
  the status `probe`/`vp` fields. In an idle session the helper stays silent —
  the user of the machine sees nothing. Gated on: connected, `mode=dxgi`,
  display on, no privacy sleep, no UAC, no lock screen (uac/locked come from
  the status-cycle cache — the nudge thread makes no Win32 calls of its own).
- **D9 kill switch**: env `ENOT_VIDEO_UNRESPONSIVE=0` disables the whole
  unresponsive-detection machinery (auto-nudges today; the trigger when it
  lands). Unset or any other value = on. The env propagates: session-spawn
  passes Environment=null, so the helper inherits the service environment.
- **D3 desktop recheck**: at most once per second (only while attached) the
  input thread compares its thread-desktop name with the session's input
  desktop name; a mismatch (lock screen / UAC / wake swapped the desktop under
  a still-attached thread) re-attaches and logs
  `{"ev":"desktop","check":"mismatch","reattach":"ok|failed"}` (throttled 3 s).
- **D2 fresh-dup grace**: black-frame counting for the one-shot GDI switch
  starts only after the current duplication has lived for 2 s — recreation
  noise (access-lost / display mode change) can no longer trip the switch.

## Capture modes

The helper starts in **DXGI Desktop Duplication** mode (`"mode":"dxgi"`) and
can switch **once per process lifetime** to a **GDI/BitBlt** fallback
(`"mode":"gdi"`) — for machines where DDA cannot start at all or delivers
frames without content (Microsoft Basic Display Adapter VMs, exotic or broken
GPU drivers). After the switch DXGI is never retried. The GDI capturer grabs
the primary monitor via `CreateDIBSection` (32bpp top-down BGRA) +
`BitBlt(SRCCOPY|CAPTUREBLT)` and exposes the same grab/size/buf contract as
the DXGI path, so downscale, JPEG encoding and the pipe protocol are
identical in both modes.

Switch triggers (one-shot; never fire while privacy sleep is active — and in
GDI mode nothing is grabbed while privacy sleep is active either):

- `dup-fail` — at least 5 consecutive duplication-creation failures spanning
  at least 5 seconds **and** the process has never delivered a frame
  (`ever_framed` gate: the first successful frame delivery anywhere in the
  process sets it). On a machine where DDA has already delivered frames, the
  old ladder applies instead: 50 consecutive failures (~10 s) → exit code 2,
  so a UAC prompt or lock screen never downgrades a working capture path.
- `black-frames` — 10 consecutive delivered DDA frames that are all black:
  every 16th sampled pixel has max(R,G,B) ≤ 8/255. A zero-frame idle desktop
  is NORMAL (a static screen produces no DDA frames at all) and never
  switches; the target disease is DDA that delivers real frames whose content
  never reaches the composition.
- `no-dxgi` — the D3D11/DXGI stack fails to initialize at startup: the helper
  tries GDI with its own WIC factory before exiting; only if that also fails
  is it the honest startup exit (code 1).

Every switch emits exactly one log line
`{"ev":"capture","mode":"gdi","reason":"dup-fail|black-frames|no-dxgi","err":"…"}`.

## Capture and recovery ladders

- `AcquireNextFrame(100ms)` -> staging texture -> `Map` -> compact BGRA buffer;
  static desktop produces no frames (CPU goes to zero, ADR 0027).
- Downscale to width 1280 by box (area average) resample; no upscale below it.
- WIC JPEG encoder, quality via the `ImageQuality` property bag, default 70.
- `DXGI_ERROR_ACCESS_LOST` (UAC/lock/secure-desktop switch) -> recreate
  duplication; more than 3 recreations in 10 s -> exit code 2.
- `DXGI_ERROR_WAIT_TIMEOUT` longer than 5 s -> wake the display
  (`WM_SYSCOMMAND`/`SC_MONITORPOWER -1` broadcast with a 2 s timeout cap),
  attempts at most once per 5 s. A zero-frame idle desktop is normal and never
  switches the capture mode.
- Display mode change (texture size differs) -> recreate duplication + staging.
- Duplication creation failures -> GDI switch per `dup-fail` above; otherwise
  50 consecutive failures (~10 s) -> exit code 2.
- GDI mode: `BitBlt` has no timeout and no access-lost state, so the wake
  watchdog and the access-lost ladder do not run (wake/sleep commands,
  displayOff tracking and input are unchanged). Persistent GDI errors count on
  the same ladder as DXGI capture errors: 50 x 100 ms backoff -> exit code 2.
- Persistent capture errors beyond their bounded retry streaks -> exit code 2.
  Exit code 2 therefore means "both capture paths failed to initialize, or
  capture errors persist in the active mode".

## Exit codes

| code | meaning                                          |
|------|--------------------------------------------------|
| 0    | clean shutdown (service kill — stdin contract removed in v0.6)                    |
| 1    | startup failure (no/empty token, DXGI+GDI init, pipe)|
| 2    | capture fatal (both DXGI and GDI failed to initialize, or capture errors persist in the active mode) |
| 3    | hello token mismatch                             |

## v1 limitations (honest list)

- **Pipe security**: no SDDL — the pipe uses the default ACL of the user the
  helper runs as. The argv token mirrored by the first pipe hello is the gate. This is a
  simplification agreed for v1; hardening (explicit DACL or token rotation) is
  future work.
- Single client, single instance of the pipe.
- Blocking writes: a slow reader stalls capture (that is the backpressure
  story); blocking reads are unblocked via `CancelIoEx` on teardown.
- Primary display only (output whose desktop coordinates contain (0,0); the
  GDI fallback likewise captures SM_CXSCREEN/SM_CYSCREEN — the primary
  monitor).
- Neither capture path draws the cursor into the frame (DDA by default, GDI
  BitBlt never composites it).
- In GDI mode a locked console / secure desktop captures as a stream of black
  frames (BitBlt returns no content there) — status `locked:true` says what is
  happening.
- A fullscreen pure-black animated screensaver on a healthy DDA machine can
  benignly flip the helper to GDI (same black content; the cost is CPU only,
  not correctness).
- A zero-frame idle desktop never switches the capture mode.
- Punctuation keys use US-layout OEM positions.
- `sleep`/`wake` rely on the legacy `SC_MONITORPOWER` broadcast; on some
  modern systems (Modern Standby) it may be a no-op — status.displayOff
  reports what the helper did, not what the monitor did.

## Build

Windows machine (or CI on windows-latest):

```
cargo build --release --target x86_64-pc-windows-msvc
```

Lab cross-build (building on a non-Windows machine without MSVC; used for the
07.10 standalone VM runs, not a release path — release CI stays msvc +
crt-static):

```
rustup target add x86_64-pc-windows-gnu
# mingw-w64 toolchain required (e.g. brew install mingw-w64)
RUSTFLAGS="-C target-feature=+crt-static" \
  cargo build --release --target x86_64-pc-windows-gnu
```

Produces a static PE32+ exe (~1.8 MB, no VC++ runtime needed) — proven
07.10.2026 on VM 101.

Nothing else in the repo depends on this crate yet; the service side (spawn +
pipe client) lands with the v0.5 service work.
