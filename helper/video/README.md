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
`tick` every 10 s (`{"ev":"tick","state":"waiting|live","fps":N,
"displayOff":bool}`), and one `exit` event. Errors also go to `lastErr` in the
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
{"fps":24,"lastErr":"","uac":false,"locked":false,"displayOff":false}
```

- `fps` — frames sent in the last 2 s window.
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
```

- `x`/`y` are normalized 0..1 over the **virtual desktop** (all monitors);
  converted with the documented `MOUSEEVENTF_ABSOLUTE|VIRTUALDESK` formula
  `abs = (x_virtual_px - SM_XVIRTUALSCREEN) * 65535 / SM_CXVIRTUALSCREEN`.
- `button` is `left|right|middle`; `buttons` is the action `down|up|move`.
  A click that carries coordinates is sent as absolute move, then down/up.
- `key` names are exactly the `INPUT_KEYS` allowlist from
  `client/lib/protocol.mjs` (letters, digits, `space enter tab escape
  backspace delete`, arrows, `home end pageup pagedown`, `shift control alt
  meta`, and the punctuation set). Navigation keys are injected with
  `KEYEVENTF_EXTENDEDKEY` so they do not type digits (numpad twins).
- `jpegQ` clamps to 40..90, `maxFps` clamps to 1..=60.

## Capture and recovery ladders

- `AcquireNextFrame(100ms)` -> staging texture -> `Map` -> compact BGRA buffer;
  static desktop produces no frames (CPU goes to zero, ADR 0027).
- Downscale to width 1280 by box (area average) resample; no upscale below it.
- WIC JPEG encoder, quality via the `ImageQuality` property bag, default 70.
- `DXGI_ERROR_ACCESS_LOST` (UAC/lock/secure-desktop switch) -> recreate
  duplication; more than 3 recreations in 10 s -> exit code 2.
- `DXGI_ERROR_WAIT_TIMEOUT` longer than 5 s -> wake the display
  (`WM_SYSCOMMAND`/`SC_MONITORPOWER -1` broadcast with a 2 s timeout cap),
  attempts at most once per 5 s.
- Display mode change (texture size differs) -> recreate duplication + staging.
- Duplication creation failures and persistent capture errors beyond their
  bounded retry streaks -> exit code 2.

## Exit codes

| code | meaning                                          |
|------|--------------------------------------------------|
| 0    | clean shutdown (service kill — stdin contract removed in v0.6)                    |
| 1    | startup failure (no/empty token, DXGI init, pipe)|
| 2    | capture fatal (access-lost flood, dup/capture errors persist) |
| 3    | hello token mismatch                             |

## v1 limitations (honest list)

- **Pipe security**: no SDDL — the pipe uses the default ACL of the user the
  helper runs as. The argv token mirrored by the first pipe hello is the gate. This is a
  simplification agreed for v1; hardening (explicit DACL or token rotation) is
  future work.
- Single client, single instance of the pipe.
- Blocking writes: a slow reader stalls capture (that is the backpressure
  story); blocking reads are unblocked via `CancelIoEx` on teardown.
- Primary display only (output whose desktop coordinates contain (0,0)).
- Punctuation keys use US-layout OEM positions.
- `sleep`/`wake` rely on the legacy `SC_MONITORPOWER` broadcast; on some
  modern systems (Modern Standby) it may be a no-op — status.displayOff
  reports what the helper did, not what the monitor did.

## Build

Windows machine (or CI on windows-latest):

```
cargo build --release --target x86_64-pc-windows-msvc
```

Nothing else in the repo depends on this crate yet; the service side (spawn +
pipe client) lands with the v0.5 service work.
