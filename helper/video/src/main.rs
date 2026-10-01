// enotdesk-video: unattended video helper (ADR 0027).
//
// DXGI duplication capture of the console desktop -> JPEG -> named pipe to the
// Node service; mouse/keyboard/wake/sleep/quality commands arrive on the same
// pipe. Started by the service (SYSTEM) inside the logged-on console session
// with the session token -- the RustDesk mechanics: the heavy capture and input
// injection live in a user-session process, because session 0 cannot see the
// console desktop.
//
// House rules: no panics anywhere (mutexes are poisoned-tolerant, all errors
// surface in status.lastErr / the exit event), stdout carries only ASCII JSON
// diagnostic events, the one-time token gates the pipe.

mod keys;
mod proto;
mod win;

use proto::Json;
use std::fs::File;
use std::io::{Read, Write as _};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PIPE_NAME: &str = r"\\.\pipe\enotdesk-video";

// Protocol guards: commands are tiny JSON documents; anything bigger is junk.
const MAX_CMD_PAYLOAD: usize = 4096;

// Capture tuning.
const FRAME_TARGET_W: u32 = 1280; // downscale target width (no upscale below it)
const ACQUIRE_TIMEOUT_MS: u32 = 100; // AcquireNextFrame poll window

// Recovery ladders (RustDesk mechanics, ADR 0027).
const ACCESS_LOST_WINDOW: Duration = Duration::from_secs(10);
const ACCESS_LOST_MAX: usize = 3; // more recreations than this in the window -> honest exit
const TIMEOUT_WAKE_AFTER: Duration = Duration::from_secs(5); // consecutive timeouts -> wake display
const WAKE_THROTTLE: Duration = Duration::from_secs(5); // wake attempts at least this far apart
const DUP_FAIL_GIVE_UP: u32 = 50; // ~10 s of 200 ms retries -> honest exit
const OTHER_ERR_GIVE_UP: u32 = 50; // ~5 s of 100 ms backoffs -> honest exit

// Periods.
const STATUS_PERIOD: Duration = Duration::from_secs(2);
const TICK_PERIOD: Duration = Duration::from_secs(10);

// Exit codes (documented in README.md).
const EXIT_OK: i32 = 0;
const EXIT_STARTUP: i32 = 1;
const EXIT_CAPTURE_FATAL: i32 = 2;
const EXIT_AUTH: i32 = 3;

// ---------------------------------------------------------------------------
// Shared state between the capture loop (writer) and the pipe reader thread
// ---------------------------------------------------------------------------

struct Shared {
    jpeg_q: Mutex<f32>, // 40..90 (stored as the raw quality, divided by 100 at encode)
    max_fps: Mutex<u32>, // 1..=60
    display_off: AtomicBool,
    fps: AtomicU64, // frames per second, updated at each status tick
    last_err: Mutex<String>,
    broken: AtomicBool,    // pipe connection is gone
    auth_fail: AtomicBool, // hello token mismatch -> hard exit
    stop: AtomicBool,
    state: Mutex<String>, // "waiting" | "live" (stdout tick)
}

impl Shared {
    fn new() -> Shared {
        Shared {
            jpeg_q: Mutex::new(70.0), // spec default
            max_fps: Mutex::new(24),
            display_off: AtomicBool::new(false),
            fps: AtomicU64::new(0),
            last_err: Mutex::new(String::new()),
            broken: AtomicBool::new(false),
            auth_fail: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            state: Mutex::new("starting".into()),
        }
    }
}

fn set_state(shared: &Shared, s: &str) {
    *shared.state.lock().unwrap_or_else(|p| p.into_inner()) = s.to_string();
}

fn set_last_err(shared: &Shared, msg: &str) {
    *shared.last_err.lock().unwrap_or_else(|p| p.into_inner()) = msg.to_string();
}

fn display_off(shared: &Shared) -> bool {
    shared.display_off.load(Ordering::Relaxed)
}

/// Keep stdout ASCII-only: every dynamic string goes through this.
fn ascii(s: &str) -> String {
    s.chars()
        .map(|c| if (c as u32) < 0x80 { c } else { '?' })
        .collect()
}

fn log_line(line: &str) {
    println!("{line}");
    let _ = std::io::stdout().flush();
}

fn log_exit(code: i32, err: &str) {
    log_line(&format!(
        "{{\"ev\":\"exit\",\"code\":{code},\"err\":\"{}\"}}",
        proto::jstr(&ascii(err))
    ));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    let code = match run() {
        Ok(c) => c,
        Err(e) => {
            log_exit(EXIT_STARTUP, &e);
            EXIT_STARTUP
        }
    };
    std::process::exit(code);
}

fn run() -> Result<i32, String> {
    // The service passes the one-time pipe token as --token <hex> on the command
    // line (v0.6 fix): the helper is spawned DETACHED_PROCESS with no stdin, so
    // the original stdin handshake could never deliver it. The command line of a
    // process is visible only within the same trust domain as the default pipe
    // ACL (same-session/same-user), which is the v1 boundary recorded in the
    // helper README.
    let mut token_value = String::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--token" {
            token_value = args.next().unwrap_or_default();
        }
    }
    let token = Arc::new(token_value.trim().to_string());
    if token.is_empty() {
        return Err("no --token argument".into());
    }

    let shared = Arc::new(Shared::new());
    // v0.6 fix (review): operator-requested privacy sleep must survive the
    // stuck-display watchdog (which wakes the panel after 5 s of silence).
    let privacy_sleep = Arc::new(AtomicBool::new(false));
    spawn_ticker(shared.clone());

    log_line(&format!(
        "{{\"ev\":\"start\",\"pipe\":\"{}\"}}",
        proto::jstr(PIPE_NAME)
    ));

    // One-time DXGI/WIC setup: COM, factory, primary output, D3D11 device,
    // WIC factory. Duplication handles come and go; this stays.
    let cap = win::Capture::new().map_err(|e| format!("capture init: {e}"))?;

    let mut dup: Option<win::Dup> = None;
    let mut access_lost_times: Vec<Instant> = Vec::new();

    loop {
        if shared.stop.load(Ordering::SeqCst) {
            return Ok(EXIT_OK);
        }
        set_state(&shared, "waiting");

        // Fresh pipe instance per connection; Drop closes the server handle
        // (unless the reader took it over as a std File).
        let pipe = win::PipeServer::new()?;
        if let Err(e) = pipe.connect() {
            // Rare: client vanished between create and connect. Recreate.
            set_last_err(&shared, &format!("pipe: {e}"));
            pipe.cancel_io();
            drop(pipe);
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
        let io = match pipe.open_io() {
            Ok(f) => Arc::new(f),
            Err(e) => {
                set_last_err(&shared, &format!("pipe io: {e}"));
                pipe.cancel_io();
                drop(pipe);
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        let reader = {
            let token = token.clone();
            let shared = shared.clone();
            let io = io.clone();
            std::thread::spawn(move || reader_thread(io, token, shared, privacy_sleep))
        };
        set_state(&shared, "live");

        let end = capture_session(&cap, &mut dup, &mut access_lost_times, &shared, &io);

        pipe.cancel_io(); // unblock a pending read on the reader thread
        let _ = reader.join();
        pipe.disconnect();

        match end {
            SessionEnd::Auth => {
                let msg = "pipe: hello token rejected";
                log_exit(EXIT_AUTH, msg);
                return Ok(EXIT_AUTH);
            }
            SessionEnd::Fatal(msg) => {
                log_exit(EXIT_CAPTURE_FATAL, &msg);
                return Ok(EXIT_CAPTURE_FATAL);
            }
            // Broken pipe: the service went away or closed the connection.
            // Loop, recreate the pipe instance and wait for the next client.
            SessionEnd::Broken => {
                shared.fps.store(0, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

enum SessionEnd {
    Broken,
    Auth,
    Fatal(String),
}

// ---------------------------------------------------------------------------
// Reader thread: hello handshake + command dispatch
// ---------------------------------------------------------------------------

fn reader_thread(io: Arc<File>, token: Arc<String>, shared: Arc<Shared>, privacy_sleep: Arc<AtomicBool>) {
    let mut io = io; // Arc<File> derefs to File for read_exact
    let mut authenticated = false;
    loop {
        let mut hdr = [0u8; 9];
        if io.read_exact(&mut hdr).is_err() {
            break;
        }
        let magic = u32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]);
        let ty = hdr[4];
        let len = u32::from_le_bytes([hdr[5], hdr[6], hdr[7], hdr[8]]) as usize;
        let shape_ok = magic == proto::MAGIC
            && len <= MAX_CMD_PAYLOAD
            && match ty {
                proto::T_HELLO => !authenticated,
                proto::T_CMD => authenticated,
                _ => false,
            };
        if !shape_ok {
            set_last_err(&shared, "pipe: bad message header");
            break;
        }
        let mut payload = vec![0u8; len];
        if len > 0 && io.read_exact(&mut payload).is_err() {
            break;
        }
        if ty == proto::T_HELLO {
            // Byte-exact comparison; the service sends the same bytes it put
            // on our stdin. Any mismatch ends the session and the process.
            authenticated = String::from_utf8_lossy(&payload) == token.as_str();
            if !authenticated {
                shared.auth_fail.store(true, Ordering::SeqCst);
                set_last_err(&shared, "pipe: hello token mismatch");
                break;
            }
        } else {
            handle_command(&shared, &privacy_sleep, &String::from_utf8_lossy(&payload));
        }
    }
    shared.broken.store(true, Ordering::SeqCst);
}

fn handle_command(shared: &Shared, privacy_sleep: &AtomicBool, text: &str) {
    let doc = match proto::parse(text) {
        Ok(d) => d,
        Err(e) => {
            set_last_err(shared, &format!("cmd json: {e}"));
            return;
        }
    };
    let cmd = doc.get("cmd").and_then(Json::as_str).unwrap_or("");
    match cmd {
        "mouse" => {
            let x = doc
                .get("x")
                .and_then(Json::as_num)
                .map(|v| v.clamp(0.0, 1.0));
            let y = doc
                .get("y")
                .and_then(Json::as_num)
                .map(|v| v.clamp(0.0, 1.0));
            if let (Some(x), Some(y)) = (x, y) {
                win::mouse_move_abs(x, y);
            }
            match doc.get("buttons").and_then(Json::as_str) {
                Some("down") | Some("up") => {
                    let down = doc.get("buttons").and_then(Json::as_str) == Some("down");
                    let button = doc.get("button").and_then(Json::as_str).unwrap_or("left");
                    win::mouse_button(button, down);
                }
                // "move" or absent: the absolute move above is the whole event.
                _ => {}
            }
        }
        "key" => {
            let name = doc.get("key").and_then(Json::as_str).unwrap_or("");
            let down = doc.get("down").and_then(Json::as_bool).unwrap_or(false);
            match keys::key_vk(name) {
                Some((vk, ext)) => {
                    win::key_event(vk, ext, down);
                }
                None => set_last_err(shared, "cmd: key not in EnotDesk allowlist"),
            }
        }
        "wheel" => {
            let dy = doc.get("dy").and_then(Json::as_num).unwrap_or(0.0);
            // f64 -> i32 saturates (Rust guarantee), no panic on huge values.
            win::wheel(dy as i32);
        }
        "wake" => {
            win::monitor_power(true);
            shared.display_off.store(false, Ordering::Relaxed);
            privacy_sleep.store(false, Ordering::Relaxed);
        }
        "sleep" => {
            win::monitor_power(false);
            shared.display_off.store(true, Ordering::Relaxed);
            // v0.6 fix (review): privacy sleep — the stuck-display watchdog
            // must not silently turn the screen back on after 5 s of silence.
            privacy_sleep.store(true, Ordering::Relaxed);
        }
        "quality" => {
            if let Some(q) = doc.get("jpegQ").and_then(Json::as_num) {
                *shared.jpeg_q.lock().unwrap_or_else(|p| p.into_inner()) =
                    q.clamp(40.0, 90.0) as f32;
            }
            if let Some(f) = doc.get("maxFps").and_then(Json::as_num) {
                *shared.max_fps.lock().unwrap_or_else(|p| p.into_inner()) =
                    f.clamp(1.0, 60.0) as u32;
            }
        }
        other => set_last_err(shared, &format!("cmd: unknown command '{}'", ascii(other))),
    }
}

// ---------------------------------------------------------------------------
// Capture loop (runs while a client is connected)
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn capture_session(
    cap: &win::Capture,
    dup_slot: &mut Option<win::Dup>,
    access_lost_times: &mut Vec<Instant>,
    shared: &Shared,
    io: &File,
) -> SessionEnd {
    let mut last_status = Instant::now();
    let mut last_encode: Option<Instant> = None;
    let mut window_start = Instant::now();
    let mut frames_window: u64 = 0;
    let mut timeout_since: Option<Instant> = None;
    let mut last_wake: Option<Instant> = None;
    let mut dup_fail_streak: u32 = 0;
    let mut other_err_streak: u32 = 0;

    loop {
        if shared.auth_fail.load(Ordering::SeqCst) {
            return SessionEnd::Auth;
        }
        if shared.broken.load(Ordering::SeqCst) || shared.stop.load(Ordering::SeqCst) {
            return SessionEnd::Broken;
        }

        // Status document every 2 s: fps, lastErr, uac, locked, displayOff.
        if last_status.elapsed() >= STATUS_PERIOD {
            let secs = window_start.elapsed().as_secs_f64();
            let fps = if secs > 0.0 {
                (frames_window as f64 / secs).round() as u64
            } else {
                0
            };
            shared.fps.store(fps, Ordering::Relaxed);
            let body = status_json(shared, fps);
            if send_msg(io, proto::T_STATUS, body.as_bytes()).is_err() {
                shared.broken.store(true, Ordering::SeqCst);
                return SessionEnd::Broken;
            }
            frames_window = 0;
            window_start = Instant::now();
            last_status = Instant::now();
        }

        // Duplication handle: (re)create lazily with a bounded retry streak.
        if dup_slot.is_none() {
            match cap.make_dup() {
                Ok(d) => {
                    dup_fail_streak = 0;
                    *dup_slot = Some(d);
                }
                Err(e) => {
                    dup_fail_streak += 1;
                    set_last_err(shared, &format!("duplication: {e}"));
                    if dup_fail_streak >= DUP_FAIL_GIVE_UP {
                        return SessionEnd::Fatal(format!(
                            "duplication create failed repeatedly: {e}"
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
            }
        }
        let grab = match dup_slot.as_mut() {
            Some(d) => d.grab(ACQUIRE_TIMEOUT_MS),
            None => continue, // create failed just above; next pass retries
        };

        match grab {
            win::Grab::Frame => {
                timeout_since = None;
                shared.display_off.store(false, Ordering::Relaxed);
                other_err_streak = 0;

                // Frame pacing: skip encode/send while inside the max_fps
                // interval. The desktop texture is already consumed (released
                // inside grab), so a skipped frame is just a dropped one.
                let max_fps = *shared.max_fps.lock().unwrap_or_else(|p| p.into_inner());
                let interval = Duration::from_secs_f64(1.0 / (max_fps.max(1)) as f64);
                let due = last_encode.map_or(true, |t| t.elapsed() >= interval);
                if due {
                    let (sw, sh, buf) = match dup_slot.as_ref() {
                        Some(d) => {
                            let (w, h) = d.size();
                            (w, h, d.buf())
                        }
                        None => continue,
                    };
                    let (px, pw, ph) = downscale(buf, sw, sh, FRAME_TARGET_W);
                    let q = *shared.jpeg_q.lock().unwrap_or_else(|p| p.into_inner()) / 100.0;
                    match cap.wic.encode(pw, ph, &px, q) {
                        Ok(jpeg) => {
                            if send_msg(io, proto::T_FRAME, &jpeg).is_err() {
                                shared.broken.store(true, Ordering::SeqCst);
                                return SessionEnd::Broken;
                            }
                            frames_window += 1;
                            last_encode = Some(Instant::now());
                        }
                        Err(e) => set_last_err(shared, &format!("jpeg: {e}")),
                    }
                }
            }
            win::Grab::Timeout => {
                // Consecutive timeouts mean a still screen OR a powered-off
                // display (ADR 0027: DPMS-off yields zero frames). After 5 s
                // of silence we poke the display, but at most once per 5 s.
                let since = match timeout_since {
                    Some(t) => t,
                    None => {
                        let n = Instant::now();
                        timeout_since = Some(n);
                        n
                    }
                };
                if since.elapsed() >= TIMEOUT_WAKE_AFTER
                    && last_wake.map_or(true, |t| t.elapsed() >= WAKE_THROTTLE)
                {
                    last_wake = Some(Instant::now());
                    timeout_since = Some(Instant::now()); // restart the 5 s window
                    // v0.6 fix (review): operator-requested privacy sleep must
                    // NOT be undone by the stuck-display watchdog — zero frames
                    // is exactly what privacy looks like. Wake only when the
                    // silence was not our own "sleep" command.
                    if !privacy_sleep.load(Ordering::Relaxed) {
                        win::monitor_power(true);
                        set_last_err(shared, "capture: long timeout, display wake attempted");
                    }
                    shared.display_off.store(true, Ordering::Relaxed);
                }
            }
            win::Grab::AccessLost => {
                // Secure-desktop switches (UAC, lock screen) invalidate the
                // duplication. Recreate, but if this floods, exit honestly.
                timeout_since = None;
                let now = Instant::now();
                access_lost_times.retain(|t| now.duration_since(*t) <= ACCESS_LOST_WINDOW);
                access_lost_times.push(now);
                if access_lost_times.len() > ACCESS_LOST_MAX {
                    return SessionEnd::Fatal(
                        "access-lost restart flood: more than 3 recreations in 10 s".into(),
                    );
                }
                *dup_slot = None; // recreated on the next loop pass
            }
            win::Grab::ModeChanged => {
                // Display mode change: recreate duplication + staging for the
                // new size; the out-of-date frame is dropped.
                timeout_since = None;
                *dup_slot = None;
            }
            win::Grab::Err(e) => {
                timeout_since = None;
                other_err_streak += 1;
                set_last_err(shared, &format!("capture: {e}"));
                if other_err_streak >= OTHER_ERR_GIVE_UP {
                    return SessionEnd::Fatal(format!("capture errors persist: {e}"));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn status_json(shared: &Shared, fps: u64) -> String {
    let last_err = shared
        .last_err
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    format!(
        "{{\"fps\":{},\"lastErr\":\"{}\",\"uac\":{},\"locked\":{},\"displayOff\":{}}}",
        fps,
        proto::jstr(&ascii(&last_err)),
        win::consent_running(),
        win::input_desktop_locked(),
        display_off(shared),
    )
}

fn send_msg(io: &File, ty: u8, payload: &[u8]) -> std::io::Result<()> {
    let msg = proto::encode_msg(ty, payload);
    let mut io = io;
    io.write_all(&msg)
}

// ---------------------------------------------------------------------------
// Downscale: box (area average) resample, integer source rectangles, no crates
// ---------------------------------------------------------------------------

fn downscale(src: &[u8], w: u32, h: u32, target_w: u32) -> (Vec<u8>, u32, u32) {
    if w == 0 || h == 0 {
        return (Vec::new(), 0, 0);
    }
    let row = w as usize * 4;
    if w <= target_w {
        // No upscaling (honest pass-through); rows are compacted to a w*4
        // stride (grab already copies compact rows, this also protects the
        // WIC stride assumption).
        let mut out = Vec::with_capacity(row * h as usize);
        for r in 0..h as usize {
            let a = r * row;
            out.extend_from_slice(&src[a..a + row]);
        }
        return (out, w, h);
    }
    let tw = target_w;
    let th = (((h as u64) * (tw as u64) / w as u64).max(1)) as u32;
    let mut out = vec![0u8; (tw as usize) * (th as usize) * 4];
    for dy in 0..th {
        let sy0 = ((dy as u64) * (h as u64) / th as u64) as u32;
        let sy1 = ((((dy as u64) + 1) * (h as u64) / th as u64) as u32).max(sy0 + 1);
        for dx in 0..tw {
            let sx0 = ((dx as u64) * (w as u64) / tw as u64) as u32;
            let sx1 = ((((dx as u64) + 1) * (w as u64) / tw as u64) as u32).max(sx0 + 1);
            let (mut sr, mut sg, mut sb) = (0u64, 0u64, 0u64);
            let mut count = 0u64;
            for sy in sy0..sy1 {
                let base = sy as usize * row;
                for sx in sx0..sx1 {
                    let p = base + sx as usize * 4;
                    sb += src[p] as u64; // BGRA layout
                    sg += src[p + 1] as u64;
                    sr += src[p + 2] as u64;
                    count += 1;
                }
            }
            let o = ((dy as usize) * (tw as usize) + dx as usize) * 4;
            out[o] = (sb / count) as u8;
            out[o + 1] = (sg / count) as u8;
            out[o + 2] = (sr / count) as u8;
            out[o + 3] = 255; // screen capture: alpha always opaque
        }
    }
    (out, tw, th)
}

// ---------------------------------------------------------------------------
// Background threads: stdout tick + stdin lifecycle
// ---------------------------------------------------------------------------

/// One ASCII JSON diagnostic line on stdout every 10 s.
fn spawn_ticker(shared: Arc<Shared>) {
    std::thread::spawn(move || {
        let mut last = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            if shared.stop.load(Ordering::SeqCst) {
                return;
            }
            if last.elapsed() < TICK_PERIOD {
                continue;
            }
            last = Instant::now();
            let state = shared
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            let fps = shared.fps.load(Ordering::Relaxed);
            log_line(&format!(
                "{{\"ev\":\"tick\",\"state\":\"{}\",\"fps\":{},\"displayOff\":{}}}",
                proto::jstr(&state),
                fps,
                display_off(&shared),
            ));
        }
    });
}

// v0.6: stdin lifecycle watcher removed — the helper is spawned DETACHED
// (no stdin at all); the service kills it via taskkill /T on session end.
// (The original stdin-EOF watcher exited the process directly: a blocked
// ConnectNamedPipe has no clean interrupt without overlapped IO, v1 keeps
// blocking calls; nothing else owns clean shutdown.)
