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
use windows::Win32::System::Power::{
    SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
};
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

// Recovery ladders (RustDesk mechanics, ADR 0027). GDI switch triggers
// (spec revision 2): (а) dup-fail and (б-v2) black-frames, both one-time per
// process. A zero-frame idle desktop is NORMAL (a static screen produces no
// DDA frames at all, ADR 0027) and NEVER switches -- the target disease of
// (б-v2) is BLACK DDA (Basic Display Adapter VMs deliver real, solid-black
// frames and wake restores nothing). DDA that worked with visible content
// keeps its existing DXGI ladders verbatim (dup-fail -> Fatal at 50, timeout
// wake watchdog), so a lock screen / UAC / dark panel on a healthy machine
// never downgrades to GDI stale-framebuffer video.
const ACCESS_LOST_WINDOW: Duration = Duration::from_secs(10);
const ACCESS_LOST_MAX: usize = 3; // more recreations than this in the window -> honest exit
const TIMEOUT_WAKE_AFTER: Duration = Duration::from_secs(5); // consecutive timeouts -> wake display
const WAKE_THROTTLE: Duration = Duration::from_secs(5); // wake attempts at least this far apart
const DUP_FAIL_GIVE_UP: u32 = 50; // ~10 s of 200 ms retries -> honest exit (the ever-framed path)
const DUP_FAIL_GDI_SWITCH: u32 = 5; // never-framed only: consecutive make_dup failures
const DUP_FAIL_SWITCH_MIN: Duration = Duration::from_secs(5); // never-framed only: streak must span this long since the first failure
const BLACK_STREAK_SWITCH: u32 = 10; // б-v2: consecutive delivered DDA frames that are all black -> switch
const OTHER_ERR_GIVE_UP: u32 = 50; // ~5 s of 100 ms backoffs -> honest exit

// Periods.
const STATUS_PERIOD: Duration = Duration::from_secs(2);
const TICK_PERIOD: Duration = Duration::from_secs(10);

// Input probe (D4, spec rev 3): stdout log throttle for {"ev":"probe"}
// lines. Probes are manual in this revision, but a burst of them must not
// flood the log.
const PROBE_LOG_THROTTLE: Duration = Duration::from_secs(3);

// X3 step 0 (spec rev 3): the unconditional cmd-mouse success trace returns
// ONLY behind this env flag. Unconditional, it accumulated input latency at
// operator cadence and was removed in 0b419b3; the W-U7 diagnostic signature
// ("SendInput TRUE, cursor does not move") is invisible without it. Default
// (flag unset): silent, exactly as shipped since 0b419b3. Read once at
// startup.
static VIDEO_TRACE: AtomicBool = AtomicBool::new(false);

// Exit codes (documented in README.md).
const EXIT_OK: i32 = 0;
const EXIT_STARTUP: i32 = 1;
// Capture fatal: since the GDI fallback exists, this means both DXGI and GDI
// failed to initialize, or capture errors persist in the active mode.
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
    state: Mutex<String>,  // "waiting" | "live" (stdout tick)
    mode: Mutex<&'static str>, // "dxgi" | "gdi" (status doc + stdout tick)
    // Any frame ever delivered to the pipe in this process (both capture
    // modes, black frames included -- delivery, not content). Gates the
    // dup-fail GDI switch trigger (а) only: once true, DDA demonstrably
    // produced frames and its old 50-failure ladder applies; the black-frames
    // trigger (б-v2) deliberately does NOT depend on it (delivered black
    // frames are exactly the disease it detects).
    ever_framed: AtomicBool,
    // Input probe (D4/D6, spec rev 3). probe_last is the outcome of the last
    // probe ("-" = never run, "ok" = verified move, "frozen" = position did
    // not follow the nudge); it persists across status windows. probe_window
    // counts verified probes in the CURRENT status window; the capture
    // thread resets it at each STATUS write alongside frames_window.
    probe_last: Mutex<&'static str>,
    probe_window: AtomicU64,
    // Window snapshots for the stdout ticker (a separate thread that cannot
    // see capture_session locals): published at each STATUS write together
    // with shared.fps. pr = frames encoded in the window (both capture
    // modes), empty = DXGI empty acquisitions (stays 0 in GDI mode),
    // vp = verified probes in the window.
    pr_pub: AtomicU64,
    empty_pub: AtomicU64,
    vp_pub: AtomicU64,
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
            mode: Mutex::new("dxgi"),
            ever_framed: AtomicBool::new(false),
            probe_last: Mutex::new("-"),
            probe_window: AtomicU64::new(0),
            pr_pub: AtomicU64::new(0),
            empty_pub: AtomicU64::new(0),
            vp_pub: AtomicU64::new(0),
        }
    }
}

fn set_state(shared: &Shared, s: &str) {
    *shared.state.lock().unwrap_or_else(|p| p.into_inner()) = s.to_string();
}

fn set_mode(shared: &Shared, m: &'static str) {
    *shared.mode.lock().unwrap_or_else(|p| p.into_inner()) = m;
}

fn mode(shared: &Shared) -> &'static str {
    *shared.mode.lock().unwrap_or_else(|p| p.into_inner())
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
    use std::io::Write as _;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
    // Mirror to a file: the service spawns us DETACHED (stdout is lost), and
    // the tick/err lines are the only helper-side telemetry (v0.6.0 приёмка).
    // TEMP is absent in the service-built environment — ProgramData is the
    // directory the rest of EnotDesk already uses (svc-diag).
    if let Some(dir) = std::env::var("ProgramData")
        .ok()
        .or_else(|| std::env::var("TEMP").ok())
    {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(format!("{dir}\\EnotDesk\\enotdesk-video.log"))
        {
            let _ = writeln!(f, "{line}");
        }
    }
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
    // X3 step 0 (spec rev 3): the diagnostic mouse trace is opt-in via the
    // environment. Read once, before any thread that could log it.
    VIDEO_TRACE.store(
        std::env::var("ENOT_VIDEO_TRACE").map_or(false, |v| !v.is_empty()),
        Ordering::Relaxed,
    );
    // v0.6 fix (review): operator-requested privacy sleep must survive the
    // stuck-display watchdog (which wakes the panel after 5 s of silence).
    let privacy_sleep = Arc::new(AtomicBool::new(false));
    spawn_ticker(shared.clone());

    // Ввод исполняет ОТДЕЛЬНЫЙ поток, первым делом подключающийся к
    // input-десктопу с правами записи: хэндл десктопа, унаследованный от
    // CreateProcessAsUserW, бывает без DESKTOP_WRITEOBJECTS — тогда SendInput
    // «успешен», а курсор стоит (ночная приёмка 02.10). Wake/тосты тоже идут
    // отсюда: broadcast достигает окон только своего десктопа.
    let (input_tx, input_rx) = std::sync::mpsc::channel::<InputJob>();
    {
        let shared = shared.clone();
        let privacy_sleep = privacy_sleep.clone();
        std::thread::Builder::new()
            .name("input".into())
            .spawn(move || input_thread(&shared, &privacy_sleep, input_rx))
            .map_err(|e| format!("input thread: {e}"))?;
    }

    // LAB DIAGNOSTIC (spec rev 3): ENOT_VIDEO_AUTOPROBE_SECS=<N>, N >= 1
    // (u64), makes the helper enqueue one InputJob::Probe every N seconds
    // with NO operator command -- the product UI has no probe path, this env
    // is how the lab measures the service-spawned context (machine-wide env
    // propagates: session-spawn passes Environment=null, the helper inherits
    // the service environment). Default (unset / unparsable / N=0): OFF --
    // no probes without a command. The thread dies with the process; if the
    // input side is gone the loop exits silently.
    if let Some(secs) = std::env::var("ENOT_VIDEO_AUTOPROBE_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|n| *n >= 1)
    {
        let probe_tx = input_tx.clone();
        std::thread::Builder::new()
            .name("autoprobe".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_secs(secs));
                if probe_tx.send(InputJob::Probe).is_err() {
                    return; // input thread is gone: nothing left to probe
                }
            })
            .map_err(|e| format!("auto-probe thread: {e}"))?;
    }

    log_line(&format!(
        "{{\"ev\":\"start\",\"pipe\":\"{}\",\"desktop\":\"{}\",\"session\":{}}}",
        proto::jstr(PIPE_NAME),
        proto::jstr(&ascii(&win::thread_desktop_name())),
        win::current_session_id()
    ));

    // One-time capture-mode selection (spec §2): DXGI first (the proven
    // path); when the D3D11/DXGI stack cannot start at all, trigger (в) --
    // GDI-only capture with its own WIC factory. Both failing is the honest
    // startup exit (1). privacy_sleep is false by construction here (no pipe
    // commands have been processed yet).
    let mut capturer = match win::Capture::new() {
        Ok(cap) => Capturer::Dxgi { cap, dup: None },
        Err(e) => switch_to_gdi(&shared, "no-dxgi", &e, None)
            .map_err(|ge| format!("capture init: {e}; gdi fallback: {ge}"))?,
    };

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
        // One pending I/O at a time on the synchronous pipe handle (see
        // pipe_inbound): reader reads and the capture thread writes strictly
        // under this lock, otherwise WriteFile waits behind a parked ReadFile
        // and the session deadlocks (v0.6.0 приёмка, dup=7).
        let pipe_lock = Arc::new(Mutex::new(()));
        let reader = {
            let token = token.clone();
            let shared = shared.clone();
            let io = io.clone();
            let lock = pipe_lock.clone();
            let input_tx = input_tx.clone();
            let privacy_sleep = privacy_sleep.clone();
            std::thread::spawn(move || reader_thread(io, lock, input_tx, token, shared, privacy_sleep))
        };
        set_state(&shared, "live");

        // While a client is connected the system must not doze off: Modern
        // Standby (S0) freezes synthetic input and swallows SC_MONITORPOWER
        // wakes (night acceptance 2026-10-02: sent=true, cursor frozen,
        // SetCursorPos=false). ES_DISPLAY_REQUIRED keeps the panel on — which
        // is also the ADR 0027 "service must wake the display on claim" duty.
        unsafe {
            let _ = SetThreadExecutionState(
                ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED,
            );
        }

        let end = capture_session(
            &mut capturer,
            &mut access_lost_times,
            &shared,
            &io,
            &privacy_sleep,
            &pipe_lock,
        );

        // Client gone: release the keep-awake (set with ES_CONTINUOUS above).
        unsafe {
            let _ = SetThreadExecutionState(ES_CONTINUOUS);
        }

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

fn reader_thread(
    io: Arc<File>,
    pipe_lock: Arc<Mutex<()>>,
    input_tx: std::sync::mpsc::Sender<InputJob>,
    token: Arc<String>,
    shared: Arc<Shared>,
    privacy_sleep: Arc<AtomicBool>,
) {
    let mut io = io; // Arc<File> derefs to File for read_exact
    let mut authenticated = false;
    loop {
        // Wait for bytes without parking a ReadFile on the handle: the pipe is
        // synchronous, a pending read would serialize the STATUS/frame writes
        // behind itself and deadlock the session. Peek (30 ms poll), then read
        // what arrived under the lock.
        loop {
            match win::pipe_inbound(&io) {
                Ok(n) if n > 0 => break,
                Ok(_) => {
                    if shared.stop.load(Ordering::SeqCst) || shared.broken.load(Ordering::SeqCst) {
                        shared.broken.store(true, Ordering::SeqCst);
                        return;
                    }
                    std::thread::sleep(PIPE_POLL_PERIOD);
                }
                Err(_) => {
                    shared.broken.store(true, Ordering::SeqCst);
                    return;
                }
            }
        }
        let guard = pipe_lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut hdr = [0u8; 9];
        if io.read_exact(&mut hdr).is_err() {
            drop(guard);
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
            drop(guard);
            set_last_err(&shared, "pipe: bad message header");
            break;
        }
        let mut payload = vec![0u8; len];
        if len > 0 && io.read_exact(&mut payload).is_err() {
            drop(guard);
            break;
        }
        drop(guard);
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
            handle_command(&shared, &privacy_sleep, &String::from_utf8_lossy(&payload), &input_tx);
        }
    }
    shared.broken.store(true, Ordering::SeqCst);
}

// Reader poll cadence while the inbound queue is empty. Commands are rare
// (input/quality/privacy), so the wakeups cost nothing and input latency
// stays well under the 100 ms frame cadence.
const PIPE_POLL_PERIOD: Duration = Duration::from_millis(30);

fn handle_command(
    shared: &Shared,
    privacy_sleep: &AtomicBool,
    text: &str,
    input_tx: &std::sync::mpsc::Sender<InputJob>,
) {
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
                let buttons = doc.get("buttons").and_then(Json::as_str).unwrap_or("move").to_string();
                let button = doc.get("button").and_then(Json::as_str).unwrap_or("left").to_string();
                enqueue(input_tx, InputJob::Mouse { x, y, buttons, button }, shared);
            }
        }
        "key" => {
            let name = doc.get("key").and_then(Json::as_str).unwrap_or("").to_string();
            let down = doc.get("down").and_then(Json::as_bool).unwrap_or(false);
            enqueue(input_tx, InputJob::Key { name, down }, shared);
        }
        "wheel" => {
            let dy = doc.get("dy").and_then(Json::as_num).unwrap_or(0.0);
            enqueue(input_tx, InputJob::Wheel { dy }, shared);
        }
        "wake" => enqueue(input_tx, InputJob::Wake, shared),
        "sleep" => enqueue(input_tx, InputJob::Sleep, shared),
        // D4 (spec rev 3): manual-only input probe, lab diagnostics (X3).
        // No auto cadence here -- deliberately out of scope until the lab
        // calibration matrix is done.
        "probe" => enqueue(input_tx, InputJob::Probe, shared),
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
// Input thread: the only executor of synthetic input. Attached to the input
// desktop with write access (see win::attach_input_desktop) BEFORE anything
// else — the inherited CreateProcessAsUserW desktop handle can lack
// DESKTOP_WRITEOBJECTS, silently eating SendInput/SetCursorPos.
// ---------------------------------------------------------------------------

enum InputJob {
    Mouse { x: f64, y: f64, buttons: String, button: String },
    Key { name: String, down: bool },
    Wheel { dy: f64 },
    Wake,
    Sleep,
    // D4 (spec rev 3): one input probe (manual {"cmd":"probe"} in this
    // revision). Executed on the input thread -- the only thread that owns
    // the attached input desktop.
    Probe,
}

fn enqueue(tx: &std::sync::mpsc::Sender<InputJob>, job: InputJob, shared: &Shared) {
    if tx.send(job).is_err() {
        set_last_err(shared, "input thread is gone");
    }
}

fn input_thread(shared: &Shared, privacy_sleep: &AtomicBool, rx: std::sync::mpsc::Receiver<InputJob>) {
    let mut attached = true;
    if let Err(e) = win::attach_input_desktop() {
        attached = false;
        set_last_err(shared, &format!("input desktop: {e}"));
    }
    log_line(&format!(
        "{{\"ev\":\"input\",\"desktop\":\"{}\",\"attach\":\"{}\"}}",
        proto::jstr(&ascii(&win::thread_desktop_name())),
        if attached { "ok" } else { "failed" },
    ));
    // Выходим только по stop процесса. По broken НЕ выходим (ревью GLM-5.3:
    // процесс переживает обрыв и ждёт следующего клиента — умерший здесь поток
    // не респавнится, ввод следующей сессии был бы мёртв до рестарта хелпера).
    // Throttle clock for {"ev":"probe"} lines (D4): one line per probe, at
    // most one per PROBE_LOG_THROTTLE under a burst.
    let mut probe_log_at: Option<Instant> = None;
    for job in rx {
        if shared.stop.load(Ordering::SeqCst) {
            break;
        }
        // Ретрай attach: на старте мог быть активен lock-screen/UAC (OpenInputDesktop
        // без WRITEOBJECTS падает) — повторяем на каждом job, пока не прицепимся,
        // иначе ввод молча мёртв до конца сессии (ревью GLM-5.3).
        if !attached {
            match win::attach_input_desktop() {
                Ok(()) => attached = true,
                Err(e) => set_last_err(shared, &format!("input desktop: {e}")),
            }
        }
        execute_job(shared, privacy_sleep, &mut probe_log_at, job);
    }
}

fn execute_job(
    shared: &Shared,
    privacy_sleep: &AtomicBool,
    probe_log_at: &mut Option<Instant>,
    job: InputJob,
) {
    match job {
        InputJob::Mouse { x, y, buttons, button } => {
            let sent = win::mouse_move_abs(x, y);
            match buttons.as_str() {
                "down" | "up" => {
                    win::mouse_button(&button, buttons == "down");
                }
                // "move": абсолютный сдвиг выше — вся команда
                _ => {}
            }
            // Сна и трассы успеха больше нет: 120 мс на каждый job при темпе
            // оператора ~40 соб/с копили неограниченную задержку ввода (ревью
            // GLM-5.3, high). Ошибка — честно в last_err, успех не шумит.
            // ИСКЛЮЧЕНИЕ (X3 step 0, spec rev 3): безусловная трасса успеха
            // возвращена ТОЛЬКО за флагом окружения ENOT_VIDEO_TRACE (лаба) —
            // без неё сигнатура W-U7 «SendInput TRUE, эффекта нет» в логе
            // невидима. Прод: флаг не задан — молчание ровно как с 0b419b3.
            if VIDEO_TRACE.load(Ordering::Relaxed) {
                let cur = win::cursor_pos();
                log_line(&format!(
                    "{{\"ev\":\"cmd-mouse\",\"sent\":{},\"x\":{x:.2},\"y\":{y:.2},\"cursor\":\"({},{})\"}}",
                    sent, cur.0, cur.1,
                ));
            }
            if !sent {
                let cur = win::cursor_pos();
                set_last_err(
                    shared,
                    &format!("cmd mouse x={x:.2} y={y:.2} sent=false cursor=({},{})", cur.0, cur.1),
                );
            }
        }
        InputJob::Key { name, down } => match keys::key_vk(&name) {
            Some((vk, ext)) => {
                win::key_event(vk, ext, down);
            }
            None => set_last_err(shared, "cmd: key not in EnotDesk allowlist"),
        },
        InputJob::Wheel { dy } => {
            // f64 -> i32 saturates (Rust guarantee), no panic on huge values.
            win::wheel(dy as i32);
        }
        InputJob::Wake => {
            win::monitor_power(true);
            shared.display_off.store(false, Ordering::Relaxed);
            privacy_sleep.store(false, Ordering::Relaxed);
        }
        InputJob::Sleep => {
            win::monitor_power(false);
            shared.display_off.store(true, Ordering::Relaxed);
            // v0.6 fix (review): privacy sleep — the stuck-display watchdog
            // must not silently turn the screen back on after 5 s of silence.
            privacy_sleep.store(true, Ordering::Relaxed);
        }
        InputJob::Probe => {
            // D4 (spec rev 3): read the cursor, nudge +2 px by X (SetCursorPos
            // bypasses the input queue), wait, read again, nudge back to the
            // ORIGINAL position. Verified ok iff the position demonstrably
            // followed the nudge direction -- this rejects both a frozen
            // position and a local user moving the cursor against the probe
            // (single test criterion, plan D4). Triggered manually
            // ({"cmd":"probe"}) or by the lab-only autoprobe env above.
            let before = win::cursor_pos();
            win::set_cursor_pos_xy(before.0 + 2, before.1);
            std::thread::sleep(Duration::from_millis(15));
            let after = win::cursor_pos();
            win::set_cursor_pos_xy(before.0, before.1);
            let ok = after.0 >= before.0 + 2;
            *shared.probe_last.lock().unwrap_or_else(|p| p.into_inner()) =
                if ok { "ok" } else { "frozen" };
            if ok {
                shared.probe_window.fetch_add(1, Ordering::Relaxed);
            }
            // One line per probe with a 3 s throttle: probes are
            // operator/lab-triggered in this revision, a burst must not flood
            // the log. Desktop names are read HERE, on the input thread:
            // "thread=" is the actual desktop of the thread that just ran the
            // probe -- the G2 discriminator (a silently stale desktop object
            // shows up at the failure moment). The string holds '=' and
            // spaces, both valid inside a JSON string value; routed through
            // ascii()/jstr() like every other dynamic log field.
            if probe_log_at.map_or(true, |t| t.elapsed() >= PROBE_LOG_THROTTLE) {
                *probe_log_at = Some(Instant::now());
                log_line(&format!(
                    "{{\"ev\":\"probe\",\"thread\":\"{}\",\"before\":\"({},{})\",\"after\":\"({},{})\",\"ok\":{}}}",
                    proto::jstr(&ascii(&win::thread_desktop_name())),
                    before.0, before.1, after.0, after.1, ok,
                ));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Capture mode (spec §2): DXGI first; at most ONE switch to GDI per process
// lifetime, then DXGI is never retried again. The enum owns whatever the
// active mode needs; a switch replaces the whole value, so no DXGI handles
// outlive the mode they belonged to.
// ---------------------------------------------------------------------------

enum Capturer {
    Dxgi {
        cap: win::Capture,
        dup: Option<win::Dup>,
    },
    Gdi {
        gdi: win::Gdi,
        wic: win::Wic,
    },
}

/// Build the GDI capturer and flip Shared mode. `reuse_wic` borrows the WIC
/// factory of the still-alive DXGI Capture (switches а/б); None builds a
/// standalone factory (startup path, where no Capture exists -- switch в).
/// Nothing is logged and no mode is published until the GDI capturer is
/// actually up: a failed GDI init leaves the reporting to the caller.
fn switch_to_gdi(
    shared: &Shared,
    reason: &str,
    trigger_err: &str,
    reuse_wic: Option<&win::Wic>,
) -> Result<Capturer, String> {
    let gdi = win::Gdi::new()?;
    let wic = match reuse_wic {
        Some(w) => w.clone(),
        None => win::Wic::new()?,
    };
    set_mode(shared, "gdi");
    log_line(&format!(
        "{{\"ev\":\"capture\",\"mode\":\"gdi\",\"reason\":\"{reason}\",\"err\":\"{}\"}}",
        proto::jstr(&ascii(trigger_err))
    ));
    Ok(Capturer::Gdi { gdi, wic })
}

// ---------------------------------------------------------------------------
// Capture loop (runs while a client is connected)
// ---------------------------------------------------------------------------

fn capture_session(
    capturer: &mut Capturer,
    access_lost_times: &mut Vec<Instant>,
    shared: &Shared,
    io: &File,
    privacy_sleep: &AtomicBool,
    pipe_lock: &Mutex<()>,
) -> SessionEnd {
    let mut last_status = Instant::now();
    let mut last_encode: Option<Instant> = None;
    let mut window_start = Instant::now();
    let mut frames_window: u64 = 0;
    // D1/D6 (spec rev 3): DXGI acquisitions that presented no pixels. Not a
    // frame (never encoded, never in frames_window/pr); reset at each STATUS
    // write alongside frames_window. Stays 0 in GDI mode (no "empty
    // acquisition" concept in BitBlt).
    let mut empty_window: u64 = 0;
    let mut timeout_since: Option<Instant> = None;
    let mut last_wake: Option<Instant> = None;
    let mut dup_fail_streak: u32 = 0;
    // Start of the current make_dup failure streak; reset on any success. The
    // GDI switch requires the streak to span DUP_FAIL_SWITCH_MIN so a machine
    // that unlocks within seconds keeps DXGI.
    let mut first_dup_fail: Option<Instant> = None;
    // Trigger (б-v2): consecutive delivered DDA frames whose sampled pixels
    // are all black (spec revision 2). Reset on any visible frame, on
    // privacy-sleep frames, and per connection (a local of this function,
    // which runs once per pipe connection).
    let mut black_streak: u32 = 0;
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
            // 6=in status_json (Toolhelp/OpenInputDesktop), 7=in STATUS write;
            // both are blocking calls on this thread, invisible to the STATUS
            // channel itself — the ticker names them (v0.6.0 приёмка: wedge).
            win::mark_dup_op(6);
            let secs = window_start.elapsed().as_secs_f64();
            let fps = if secs > 0.0 {
                (frames_window as f64 / secs).round() as u64
            } else {
                0
            };
            shared.fps.store(fps, Ordering::Relaxed);
            // D6 (spec rev 3): snapshot the window counters for the stdout
            // ticker BEFORE they reset -- the ticker thread cannot see these
            // locals. probe_window is shared state read at the same moment.
            shared.pr_pub.store(frames_window, Ordering::Relaxed);
            shared.empty_pub.store(empty_window, Ordering::Relaxed);
            let vp = shared.probe_window.load(Ordering::Relaxed);
            shared.vp_pub.store(vp, Ordering::Relaxed);
            let body = status_json(shared, fps, frames_window, empty_window, vp);
            win::mark_dup_op(7);
            if let Err(e) = send_msg(io, pipe_lock, proto::T_STATUS, body.as_bytes()) {
                // The ticker carries this text: a dying pipe must name its
                // error, not just flip to waiting (v0.6.0 приёмка).
                set_last_err(shared, &format!("send status: {e}"));
                shared.broken.store(true, Ordering::SeqCst);
                return SessionEnd::Broken;
            }
            win::mark_dup_op(0);
            frames_window = 0;
            empty_window = 0;
            shared.probe_window.store(0, Ordering::Relaxed);
            window_start = Instant::now();
            last_status = Instant::now();
        }

        // Capture step, per mode. A pending GDI switch is parked in
        // switch_req and handled after the match, where the capturer borrow
        // has ended (the switch replaces the whole enum value).
        let mut switch_req: Option<(&'static str, String)> = None;

        match capturer {
            Capturer::Dxgi { cap, dup } => {
                // Duplication handle: (re)create lazily. The GDI switch
                // (trigger а) is only for a process where DDA never delivered
                // a frame; DDA that worked before keeps the old ladder -- 50
                // consecutive failures -> Fatal, lock-screen/UAC failures
                // never silently downgrade the capture path.
                if dup.is_none() {
                    match cap.make_dup() {
                        Ok(d) => {
                            dup_fail_streak = 0;
                            first_dup_fail = None;
                            *dup = Some(d);
                        }
                        Err(e) => {
                            if first_dup_fail.is_none() {
                                first_dup_fail = Some(Instant::now());
                            }
                            dup_fail_streak += 1;
                            set_last_err(shared, &format!("duplication: {e}"));
                            if dup_fail_streak >= DUP_FAIL_GDI_SWITCH
                                && !shared.ever_framed.load(Ordering::Relaxed)
                                && first_dup_fail
                                    .map_or(false, |t| t.elapsed() >= DUP_FAIL_SWITCH_MIN)
                            {
                                switch_req = Some(("dup-fail", format!("duplication: {e}")));
                            } else if dup_fail_streak >= DUP_FAIL_GIVE_UP {
                                return SessionEnd::Fatal(format!(
                                    "duplication create failed repeatedly: {e}"
                                ));
                            } else {
                                std::thread::sleep(Duration::from_millis(200));
                                continue;
                            }
                        }
                    }
                }
                if switch_req.is_none() {
                    let grab = match dup.as_mut() {
                        Some(d) => d.grab(ACQUIRE_TIMEOUT_MS),
                        None => continue, // switch is pending below; next pass runs GDI
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
                                let (sw, sh, buf) = match dup.as_ref() {
                                    Some(d) => {
                                        let (w, h) = d.size();
                                        (w, h, d.buf())
                                    }
                                    None => continue,
                                };
                                let (px, pw, ph) = downscale(buf, sw, sh, FRAME_TARGET_W);

                                // Trigger (б-v2), DXGI arm only (spec revision 2): in
                                // GDI mode the switch has already happened and BitBlt
                                // returns the real framebuffer. Runs only on frames
                                // about to be encoded/sent, so an idle-static desktop
                                // (no frames at all) never reaches it. The streak can
                                // only grow while privacy_sleep is false (a dark-panel
                                // frame kills it instead); the switch handler below
                                // re-checks privacy before switching.
                                if privacy_sleep.load(Ordering::Relaxed) {
                                    black_streak = 0;
                                } else if frame_is_black(&px, pw, ph) {
                                    black_streak += 1;
                                    if black_streak >= BLACK_STREAK_SWITCH
                                        && !privacy_sleep.load(Ordering::Relaxed)
                                    {
                                        switch_req = Some((
                                            "black-frames",
                                            format!("{black_streak} black DDA frames in a row"),
                                        ));
                                    }
                                } else {
                                    black_streak = 0;
                                }

                                if !encode_and_send(
                                    &cap.wic,
                                    &px,
                                    pw,
                                    ph,
                                    shared,
                                    io,
                                    pipe_lock,
                                    &mut frames_window,
                                    &mut last_encode,
                                ) {
                                    return SessionEnd::Broken;
                                }
                            }
                        }
                        win::Grab::Empty => {
                            // D1 (spec rev 3): a successful acquisition with
                            // no presentation (pointer-only metadata, no new
                            // pixels). Deliberately NOT: encoded, counted in
                            // frames_window/pr, display_off (either
                            // direction), black_streak (an empty acquisition
                            // is not a black frame). What it DOES prove is
                            // that the duplication is alive -- reset the wake
                            // ladder exactly like a real frame; otherwise
                            // mouse-over-static-content on a healthy machine
                            // (pointer updates arrive as Empty, plan Q7)
                            // would flip displayOff and poke monitor_power
                            // every 5 s. On a genuinely dark display there
                            // are no acquisitions at all (WAIT_TIMEOUT), so
                            // the ladder there is untouched.
                            timeout_since = None;
                            empty_window += 1;
                        }
                        win::Grab::Timeout => {
                            // Consecutive timeouts mean a still screen OR a powered-off
                            // display (ADR 0027: DPMS-off yields zero frames). After 5 s
                            // of silence we poke the display, but at most once per 5 s.
                            // Zero-frame idle is NORMAL and never switches (revision 2):
                            // the wake watchdog is the whole story here.
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
                            *dup = None; // recreated on the next loop pass
                        }
                        win::Grab::ModeChanged => {
                            // Display mode change: recreate duplication + staging for the
                            // new size; the out-of-date frame is dropped.
                            timeout_since = None;
                            *dup = None;
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
            Capturer::Gdi { gdi, wic } => {
                // Privacy blackout (spec §4): the operator asked for a dark
                // panel, and a BitBlt of a DPMS-off display can return the
                // last framebuffer content -- grab, and therefore send,
                // nothing while privacy_sleep is on.
                if privacy_sleep.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                // Gdi::grab paces itself to the max_fps interval, so no
                // encode due-check here: the loop period is already >= the
                // interval, every frame is due.
                let max_fps = *shared.max_fps.lock().unwrap_or_else(|p| p.into_inner());
                let interval_ms = (1000u32 / max_fps.max(1)).max(1);
                match gdi.grab(interval_ms) {
                    win::Grab::Frame => {
                        shared.display_off.store(false, Ordering::Relaxed);
                        other_err_streak = 0;
                        let (sw, sh, buf) = {
                            let (w, h) = gdi.size();
                            (w, h, gdi.buf())
                        };
                        let (px, pw, ph) = downscale(buf, sw, sh, FRAME_TARGET_W);
                        // No black detection here (revision 2): the switch has
                        // already happened and BitBlt returns the real
                        // framebuffer, black or not.
                        if !encode_and_send(
                            wic,
                            &px,
                            pw,
                            ph,
                            shared,
                            io,
                            pipe_lock,
                            &mut frames_window,
                            &mut last_encode,
                        ) {
                            return SessionEnd::Broken;
                        }
                    }
                    win::Grab::ModeChanged => {
                        // The DIB was already rebuilt inside Gdi; the first
                        // frame for the new size arrives on the next pass.
                        shared.display_off.store(false, Ordering::Relaxed);
                    }
                    // Not produced in GDI mode: there is no AcquireNextFrame
                    // timeout, no duplication to lose, and BitBlt has no
                    // "empty acquisition" concept (it always returns real
                    // framebuffer bytes). No-op by design.
                    win::Grab::Timeout | win::Grab::AccessLost | win::Grab::Empty => {}
                    win::Grab::Err(e) => {
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

        // One-time switch to GDI (trigger а: make_dup refused >= 5 times over
        // >= 5 s in a never-framed process; trigger б-v2: >= BLACK_STREAK_SWITCH
        // delivered DDA frames in a row are all black). Trigger (а) is gated on
        // ever_framed == false ("DDA never produced a frame in this process");
        // (б-v2) is not -- delivered black frames are exactly its target
        // disease. Zero-frame idle desktops never get here. Never while the
        // operator holds the panel dark (spec §4: a BitBlt of a dark panel can
        // return stale content) -- postpone instead; the streaks keep growing
        // and the switch happens on a later pass after wake.
        if let Some((reason, err)) = switch_req {
            if privacy_sleep.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            let wic = match capturer {
                Capturer::Dxgi { cap, .. } => cap.wic.clone(),
                Capturer::Gdi { .. } => continue, // already GDI: nothing to switch
            };
            match switch_to_gdi(shared, reason, &err, Some(&wic)) {
                Ok(g) => *capturer = g,
                Err(ge) => {
                    // GDI itself cannot initialize: honest capture-fatal exit
                    // (exit 2 now covers "both DXGI and GDI failed").
                    return SessionEnd::Fatal(format!(
                        "gdi fallback failed: {ge} (trigger: {err})"
                    ));
                }
            }
        }
    }
}

/// Encode one already-downscaled frame and push it down the pipe. The caller
/// owns the downscale step (the DXGI arm runs the black-capture probe on its
/// output between the two). Returns false when the pipe is gone (session must
/// end); a JPEG failure is reported via lastErr and the next grab retries, as
/// before.
#[allow(clippy::too_many_arguments)]
fn encode_and_send(
    wic: &win::Wic,
    px: &[u8],
    pw: u32,
    ph: u32,
    shared: &Shared,
    io: &File,
    pipe_lock: &Mutex<()>,
    frames_window: &mut u64,
    last_encode: &mut Option<Instant>,
) -> bool {
    let q = *shared.jpeg_q.lock().unwrap_or_else(|p| p.into_inner()) / 100.0;
    match wic.encode(pw, ph, px, q) {
        Ok(jpeg) => {
            if let Err(e) = send_msg(io, pipe_lock, proto::T_FRAME, &jpeg) {
                // The ticker carries this text: a dying pipe must name its
                // error, not just flip to waiting (v0.6.0 приёмка).
                set_last_err(shared, &format!("send frame: {e}"));
                shared.broken.store(true, Ordering::SeqCst);
                return false;
            }
            *frames_window += 1;
            *last_encode = Some(Instant::now());
            // First successful delivery in the process: from here on the GDI
            // switch triggers are out (DDA demonstrably worked); applies to
            // both capture modes.
            shared.ever_framed.store(true, Ordering::Relaxed);
            true
        }
        Err(e) => {
            set_last_err(shared, &format!("jpeg: {e}"));
            true
        }
    }
}

fn status_json(shared: &Shared, fps: u64, pr: u64, empty: u64, vp: u64) -> String {
    let last_err = shared
        .last_err
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    // D6 (spec rev 3), additive: pr = frames encoded in the window (real
    // presents after the D1 empty filter, both capture modes), empty = DXGI
    // empty acquisitions in the window, vp = verified probes in the window,
    // probe = last probe outcome (persists across windows, "-" = none yet).
    let probe_last = *shared.probe_last.lock().unwrap_or_else(|p| p.into_inner());
    format!(
        "{{\"mode\":\"{}\",\"fps\":{},\"pr\":{},\"empty\":{},\"vp\":{},\"probe\":\"{}\",\"lastErr\":\"{}\",\"uac\":{},\"locked\":{},\"displayOff\":{}}}",
        mode(shared),
        fps,
        pr,
        empty,
        vp,
        probe_last,
        proto::jstr(&ascii(&last_err)),
        win::consent_running(),
        win::input_desktop_locked(),
        display_off(shared),
    )
}

fn send_msg(io: &File, pipe_lock: &Mutex<()>, ty: u8, payload: &[u8]) -> std::io::Result<()> {
    let msg = proto::encode_msg(ty, payload);
    // The handle is synchronous (no FILE_FLAG_OVERLAPPED): never write while
    // the reader holds a read in flight — Windows serializes I/O on the
    // handle and the write would wait for the reader's next message
    // (v0.6.0 приёмка: dup=7 deadlock, statuses never reached the client).
    let _guard = pipe_lock.lock().unwrap_or_else(|p| p.into_inner());
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
// Black-capture probe (spec revision 2, trigger б-v2): a DDA that composites
// no content (Basic Display Adapter VMs) delivers real frames that are solid
// black; wake never restores them. Runs only on frames about to be
// encoded/sent, so idle-static desktops (no frames at all) never pay for it.
// ---------------------------------------------------------------------------

/// True when every 16th pixel of the compact BGRA frame has max(R,G,B) <= 8.
/// Linear stride-16 raster walk: ~64k 3-byte samples at 1280x800, allocation-
/// free. Indexing is in-bounds by construction: the upfront length check
/// guarantees `need <= px.len()` and the loop steps strictly inside `need`.
fn frame_is_black(px: &[u8], w: u32, h: u32) -> bool {
    let need = w as usize * h as usize * 4;
    if w == 0 || h == 0 || px.len() < need {
        return true; // nothing to see counts as black (never trips the probe)
    }
    for p in (0..need).step_by(16 * 4) {
        // BGRA layout: [p]=B, [p+1]=G, [p+2]=R.
        let b = px[p] as u32;
        let g = px[p + 1] as u32;
        let r = px[p + 2] as u32;
        if r.max(g).max(b) > 8 {
            return false;
        }
    }
    true
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
            // dup/err: where the capture thread currently is — make_dup steps
            // (1 cast, 2 DuplicateOutput, 3 desc, 4 staging, 0=done/idle) or the
            // status path (6=status_json, 7=STATUS write); err = last error text.
            // A wedged call is otherwise invisible: the STATUS channel lives on
            // the same stuck thread, the ticker thread does not.
            let err = shared
                .last_err
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            log_line(&format!(
                "{{\"ev\":\"tick\",\"state\":\"{}\",\"mode\":\"{}\",\"fps\":{},\"pr\":{},\"empty\":{},\"vp\":{},\"probe\":\"{}\",\"displayOff\":{},\"dup\":{},\"err\":\"{}\"}}",
                proto::jstr(&state),
                mode(&shared),
                fps,
                // D6 (spec rev 3): snapshots of the last status window,
                // published by the capture thread at each STATUS write.
                shared.pr_pub.load(Ordering::Relaxed),
                shared.empty_pub.load(Ordering::Relaxed),
                shared.vp_pub.load(Ordering::Relaxed),
                *shared.probe_last.lock().unwrap_or_else(|p| p.into_inner()),
                display_off(&shared),
                win::last_dup_op(),
                proto::jstr(&ascii(&err)),
            ));
        }
    });
}

// v0.6: stdin lifecycle watcher removed — the helper is spawned DETACHED
// (no stdin at all); the service kills it via taskkill /T on session end.
// (The original stdin-EOF watcher exited the process directly: a blocked
// ConnectNamedPipe has no clean interrupt without overlapped IO, v1 keeps
// blocking calls; nothing else owns clean shutdown.)
