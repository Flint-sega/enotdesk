// win.rs -- every unsafe Win32 call in one place. The rest of the helper sees
// only safe Rust. The DXGI/WIC/JPEG path is a direct descendant of the proven
// spike (spike/video-dxgi/src/main.rs); module paths, feature names and
// signatures in this file are verified against windows 0.58.0 on crates.io by
// `cargo check --target x86_64-pc-windows-msvc`. Target: Windows only.

use windows::core::{Interface, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, GENERIC_READ, HANDLE, HGLOBAL, HMODULE, LPARAM, POINT, WPARAM,
};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_FLAG, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput, IDXGIOutput1,
    IDXGIOutputDuplication, IDXGIResource, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_NOT_FOUND,
    DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP,
    HGDIOBJ, HDC, RGBQUAD, SRCCOPY,
};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, GUID_WICPixelFormat32bppBGRA, IWICBitmap,
    IWICBitmapEncoder, IWICBitmapFrameEncode, IWICBitmapSource, IWICImagingFactory,
    WICBitmapEncoderNoCache,
};
use windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows::Win32::System::Com::StructuredStorage::{IPropertyBag2, PROPBAG2};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, IStream, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    STREAM_SEEK,
};
use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use windows::Win32::System::Diagnostics::Debug::{
    FormatMessageW, FORMAT_MESSAGE_FROM_SYSTEM, FORMAT_MESSAGE_IGNORE_INSERTS,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PeekNamedPipe, PIPE_READMODE_BYTE,
    PIPE_TYPE_BYTE,
};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, GetThreadDesktop, OpenInputDesktop, SetThreadDesktop,
    DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, DESKTOP_SWITCHDESKTOP,
    DESKTOP_WRITEOBJECTS, UOI_NAME,
};
use windows::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
use windows::Win32::System::IO::CancelIoEx;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    mouse_event, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowW, GetCursorPos, GetSystemMetrics, SendMessageTimeoutW, SetCursorPos, HWND_BROADCAST,
    SMTO_ABORTIFHUNG, SM_CXSCREEN, SM_CXVIRTUALSCREEN, SM_CYSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, WM_SYSCOMMAND,
};

// Progress marker of the last DXGI call inside make_dup() (see make_dup for
// the encoding). Read by the stdout ticker: if a call wedges, the tick keeps
// flowing (separate thread) and names the exact stuck call.
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};
static DUP_OP: AtomicU8 = AtomicU8::new(0);
pub fn last_dup_op() -> u8 {
    DUP_OP.load(Ordering::Relaxed)
}
/// Progress marker for the capture thread (make_dup steps 1..4, status-json
/// path 6/7, 0=idle/ok) — the stdout ticker reads it; see capture_session.
pub fn mark_dup_op(v: u8) {
    DUP_OP.store(v, Ordering::Relaxed);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// True when `e` carries the given Win32 error code. Win32 codes surface as
/// HRESULT 0x8007xxxx; built from first principles so it does not depend on
/// helper names that drifted across windows-rs versions.
fn is_win32(e: &windows::core::Error, code: u32) -> bool {
    e.code() == windows::core::HRESULT(((0x8007u32 << 16) | (code & 0xFFFF)) as i32)
}

/// Fixed pipe name as a UTF-16 literal (the pipe name never changes, so a
/// const array beats any macro or runtime conversion).
const PIPE_NAME_WIDE: &[u16] = &[
    b'\\' as u16,
    b'\\' as u16,
    b'.' as u16,
    b'\\' as u16, // \\.\ (device namespace)
    b'p' as u16,
    b'i' as u16,
    b'p' as u16,
    b'e' as u16,
    b'\\' as u16, // pipe\
    b'e' as u16,
    b'n' as u16,
    b'o' as u16,
    b't' as u16,
    b'd' as u16,
    b'e' as u16,
    b's' as u16,
    b'k' as u16,
    b'-' as u16,
    b'v' as u16,
    b'i' as u16,
    b'd' as u16,
    b'e' as u16,
    b'o' as u16,
    0, // NUL terminator required by Win32
];

// ---------------------------------------------------------------------------
// Named pipe server (the helper is the server; the Node service is the client)
// ---------------------------------------------------------------------------

pub struct PipeServer {
    raw: HANDLE,
    // Set once open_io() handed the handle to a std File (which owns closing
    // it). Drop then skips its own CloseHandle to avoid a double close.
    io_taken: std::cell::Cell<bool>,
}

impl PipeServer {
    pub fn new() -> Result<PipeServer, String> {
        // Byte mode, one instance, duplex. 64 KiB buffers are only hints --
        // frames are larger and WriteFile simply blocks until the service
        // drains, which is the entire v1 backpressure story. No SDDL: v1
        // relies on the default ACL plus the stdin token (README, ADR 0027).
        unsafe {
            let h = CreateNamedPipeW(
                PCWSTR(PIPE_NAME_WIDE.as_ptr()),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE,
                1,
                64 * 1024,
                64 * 1024,
                0,
                None,
            );
            if h.is_invalid() {
                let e = GetLastError();
                return Err(format!("CreateNamedPipeW failed, GetLastError={e:?}"));
            }
            Ok(PipeServer {
                raw: h,
                io_taken: std::cell::Cell::new(false),
            })
        }
    }

    /// Blocks until a client connects. ERROR_PIPE_CONNECTED (231) is the race
    /// where the client connected between CreateNamedPipeW and
    /// ConnectNamedPipe -- that is success, not failure.
    pub fn connect(&self) -> Result<(), String> {
        match unsafe { ConnectNamedPipe(self.raw, None) } {
            Ok(()) => Ok(()),
            Err(e) if is_win32(&e, 231) => Ok(()),
            Err(e) => Err(format!("ConnectNamedPipe: {e}")),
        }
    }

    /// Expose the pipe as a std File for blocking read/write. The File takes
    /// ownership of the raw handle (closes it on drop), so the server keeps
    /// only the numeric value for CancelIoEx/DisconnectNamedPipe afterwards.
    pub fn open_io(&self) -> std::io::Result<std::fs::File> {
        use std::os::windows::io::FromRawHandle;
        let f = unsafe {
            std::fs::File::from_raw_handle(self.raw.0 as std::os::windows::io::RawHandle)
        };
        self.io_taken.set(true);
        Ok(f)
    }

    /// Unblock a pending ReadFile on the reader thread (session teardown).
    pub fn cancel_io(&self) {
        let _ = unsafe { CancelIoEx(self.raw, None) };
    }

    /// Disconnect the connected client so the next instance starts clean.
    pub fn disconnect(&self) {
        let _ = unsafe { DisconnectNamedPipe(self.raw) };
    }
}

/// Bytes waiting in the pipe inbound queue. The reader polls this instead of
/// parking in a blocking ReadFile: the handle is synchronous (no
/// FILE_FLAG_OVERLAPPED), and Windows serializes I/O on it — a pending read
/// would block the STATUS/frame WriteFile until the client speaks first,
/// which never happens (client waits for us). Classic deadlock, observed live
/// as dup=7 (v0.6.0 приёмка).
pub fn pipe_inbound(f: &std::fs::File) -> std::io::Result<u32> {
    use std::os::windows::io::AsRawHandle;
    let mut avail: u32 = 0;
    let ok = unsafe {
        PeekNamedPipe(
            HANDLE(f.as_raw_handle() as *mut core::ffi::c_void),
            None,
            0,
            None,
            Some(&mut avail),
            None,
        )
    };
    ok.map(|_| avail).map_err(|e| {
        std::io::Error::from_raw_os_error(e.code().0) // client gone / pipe broken
    })
}

impl Drop for PipeServer {
    fn drop(&mut self) {
        if !self.io_taken.get() {
            let _ = unsafe { CloseHandle(self.raw) };
        }
    }
}

// ---------------------------------------------------------------------------
// DXGI capture (spike-derived)
// ---------------------------------------------------------------------------

pub struct Capture {
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    output: IDXGIOutput,
    pub wic: Wic,
}

pub struct Dup {
    dup: IDXGIOutputDuplication,
    staging: ID3D11Texture2D,
    ctx: ID3D11DeviceContext,
    w: u32,
    h: u32,
    buf: Vec<u8>, // compact BGRA rows, stride = w*4
    // Creation moment of THIS duplication (D2): black frames in the first
    // seconds of a fresh dup are recreation noise; the caller compares the
    // age against its grace constant. Lives on the Dup so the grace survives
    // a pipe reconnect (the capturer does, the session locals do not).
    since: Instant,
}

/// Outcome of one AcquireNextFrame cycle.
pub enum Grab {
    Frame,
    /// Successful acquisition that presented no desktop pixels
    /// (DXGI_OUTDUPL_FRAME_INFO: LastPresentTime == 0 or AccumulatedFrames
    /// == 0 — a pointer-only metadata update). Dup::buf is deliberately NOT
    /// touched: its previous contents must never be encoded as a "new"
    /// frame (D1, plan rev 3).
    Empty,
    Timeout,
    AccessLost,
    ModeChanged,
    Err(String),
}

impl Capture {
    pub fn new() -> Result<Capture, String> {
        unsafe {
            // 0.58 returns the raw HRESULT here (S_FALSE / already-initialized
            // is a success code and passes through).
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_err() {
                return Err(format!("CoInitializeEx: {hr:?}"));
            }
            let factory: IDXGIFactory1 =
                CreateDXGIFactory1().map_err(|e| format!("CreateDXGIFactory1: {e}"))?;

            // Primary output = the attached output whose desktop coordinates
            // contain (0,0); fall back to the first attached output (covers
            // machines where no output claims the origin).
            let mut primary: Option<(IDXGIAdapter1, IDXGIOutput)> = None;
            let mut fallback: Option<(IDXGIAdapter1, IDXGIOutput)> = None;
            let mut ai = 0u32;
            loop {
                let ad = match factory.EnumAdapters1(ai) {
                    Ok(a) => a,
                    Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                    Err(e) => return Err(format!("EnumAdapters1: {e}")),
                };
                let mut oi = 0u32;
                loop {
                    match ad.EnumOutputs(oi) {
                        Ok(o) => {
                            if let Ok(d) = o.GetDesc() {
                                if d.AttachedToDesktop.as_bool() {
                                    let r = d.DesktopCoordinates;
                                    if r.left == 0 && r.top == 0 && primary.is_none() {
                                        primary = Some((ad.clone(), o.clone()));
                                    }
                                    if fallback.is_none() {
                                        fallback = Some((ad.clone(), o));
                                    }
                                }
                            }
                        }
                        Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                        Err(e) => return Err(format!("EnumOutputs: {e}")),
                    }
                    oi += 1;
                }
                ai += 1;
            }
            let (adapter, output) = primary
                .or(fallback)
                .ok_or("no attached display output found")?;

            let mut device: Option<ID3D11Device> = None;
            let mut ctx: Option<ID3D11DeviceContext> = None;
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_FLAG(0),
                None::<&[D3D_FEATURE_LEVEL]>,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut ctx),
            )
            .map_err(|e| format!("D3D11CreateDevice: {e}"))?;
            let device = device.ok_or("D3D11CreateDevice: no device returned")?;
            let ctx = ctx.ok_or("D3D11CreateDevice: no context returned")?;

            Ok(Capture {
                device,
                ctx,
                output,
                wic: Wic::new()?,
            })
        }
    }

    /// Create duplication + staging texture. Called on startup, after every
    /// ACCESS_LOST, and on every display mode change.
    pub fn make_dup(&self) -> Result<Dup, String> {
        unsafe {
            // 1=output cast, 2=DuplicateOutput, 3=GetDesc, 4=staging texture;
            // 0=done. A wedged call leaves the marker visible in the stdout
            // ticker (the STATUS channel is unreachable from inside make_dup).
            DUP_OP.store(1, Ordering::Relaxed);
            let out1: IDXGIOutput1 = self
                .output
                .cast()
                .map_err(|e| format!("IDXGIOutput1 cast: {e}"))?;
            DUP_OP.store(2, Ordering::Relaxed);
            let dup = out1
                .DuplicateOutput(&self.device)
                .map_err(|e| format!("DuplicateOutput: {e}"))?;
            DUP_OP.store(3, Ordering::Relaxed);
            let desc = dup.GetDesc();
            let (w, h) = (desc.ModeDesc.Width, desc.ModeDesc.Height);
            if w == 0 || h == 0 {
                DUP_OP.store(0, Ordering::Relaxed);
                return Err("duplicate output reports zero size".into());
            }
            // Staging readback texture: same recipe as the spike. CPU reads via
            // Map; GPU writes via CopyResource from the desktop texture.
            let sd = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_STAGING,
                // 0.58 types BindFlags as a plain u32 field
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };
            let mut staging: Option<ID3D11Texture2D> = None;
            DUP_OP.store(4, Ordering::Relaxed);
            self.device
                .CreateTexture2D(&sd, None, Some(&mut staging))
                .map_err(|e| format!("staging texture: {e}"))?;
            DUP_OP.store(0, Ordering::Relaxed);
            let staging = staging.ok_or("staging texture: none returned")?;
            Ok(Dup {
                dup,
                staging,
                ctx: self.ctx.clone(),
                w,
                h,
                buf: Vec::new(),
                since: Instant::now(),
            })
        }
    }
}

impl Dup {
    pub fn size(&self) -> (u32, u32) {
        (self.w, self.h)
    }

    /// Creation moment of this duplication (D2 grace, see the struct doc).
    pub fn since(&self) -> Instant {
        self.since
    }

    /// BGRA pixels of the last grabbed frame (stride exactly w*4).
    pub fn buf(&self) -> &[u8] {
        &self.buf
    }

    /// One acquisition cycle. Always releases the frame before returning.
    pub fn grab(&mut self, timeout_ms: u32) -> Grab {
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut res: Option<IDXGIResource> = None;
            match self.dup.AcquireNextFrame(timeout_ms, &mut info, &mut res) {
                Ok(()) => {
                    // D1 (plan rev 3): a successful acquisition with no
                    // presentation carried only pointer metadata — no new
                    // pixels exist. Release the frame and report Empty
                    // WITHOUT the staging readback: copying it would refresh
                    // buf with unchanged pixels that the caller must never
                    // encode as a "new" frame. Real presents keep the exact
                    // grab_frame path.
                    if info.LastPresentTime == 0 || info.AccumulatedFrames == 0 {
                        let _ = self.dup.ReleaseFrame();
                        return Grab::Empty;
                    }
                    let out = self.grab_frame(res);
                    // Release no matter what happened: a held frame blocks the
                    // desktop composition from reusing it.
                    let _ = self.dup.ReleaseFrame();
                    out
                }
                // Static desktop produces no frames at all (ADR 0027: this is
                // also how a powered-off display looks).
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => Grab::Timeout,
                // Secure desktop switches (UAC, lock) invalidate duplication.
                Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => Grab::AccessLost,
                Err(e) => Grab::Err(format!("AcquireNextFrame: {e}")),
            }
        }
    }

    fn grab_frame(&mut self, res: Option<IDXGIResource>) -> Grab {
        unsafe {
            let res = match res {
                Some(r) => r,
                None => return Grab::Err("frame without resource".into()),
            };
            let tex: ID3D11Texture2D = match res.cast() {
                Ok(t) => t,
                Err(e) => return Grab::Err(format!("texture cast: {e}")),
            };
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            let _ = tex.GetDesc(&mut desc);
            if desc.Width != self.w || desc.Height != self.h {
                // Display mode changed: caller recreates duplication + staging
                // for the new size; this frame is dropped.
                return Grab::ModeChanged;
            }
            self.ctx.CopyResource(&self.staging, &tex);
            let mut map = D3D11_MAPPED_SUBRESOURCE::default();
            if let Err(e) = self
                .ctx
                .Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut map))
            {
                return Grab::Err(format!("Map: {e}"));
            }
            let pitch = map.RowPitch as usize;
            let (w, h) = (self.w as usize, self.h as usize);
            let src = std::slice::from_raw_parts(map.pData as *const u8, pitch * h);
            self.buf.clear();
            for row in 0..h {
                let a = row * pitch;
                self.buf.extend_from_slice(&src[a..a + w * 4]);
            }
            let _ = self.ctx.Unmap(&self.staging, 0);
            Grab::Frame
        }
    }
}

// ---------------------------------------------------------------------------
// GDI capture -- the fallback for machines where Desktop Duplication cannot
// start or stays silent forever (Microsoft Basic Display Adapter VMs, exotic
// GPUs). Same contract as Dup: grab/size/buf, compact BGRA rows with stride
// w*4. Spike numbers (ADR 0027): BitBlt ~23 ms/frame at 1280x720 -- good
// enough as a fallback, rejected as a primary path.
// ---------------------------------------------------------------------------

pub struct Gdi {
    screen_dc: HDC, // GetDC(None), released in Drop
    mem_dc: HDC,    // CreateCompatibleDC, deleted in Drop
    // None while a DIB (re)build failed; grab then reports Err until a later
    // rebuild succeeds -- blitting into a missing bitmap would fabricate
    // frames out of stale memory.
    dib: Option<DibSection>,
    buf: Vec<u8>, // compact BGRA rows, stride = w*4 (same contract as Dup::buf)
}

struct DibSection {
    bm: HBITMAP,
    // What our DIB replaced in mem_dc. DeleteObject on a bitmap that is still
    // selected silently fails, so `prev` must be selected back first.
    prev: HGDIOBJ,
    bits: *mut u8, // DIB pixel memory, valid while `bm` is alive
    w: u32,
    h: u32,
}

impl DibSection {
    fn create(mem_dc: HDC, w: u32, h: u32) -> Result<DibSection, String> {
        unsafe {
            // Negative biHeight = top-down rows: row 0 is the top of the
            // screen, exactly what the downscale/WIC pipeline consumes (no
            // flip step). 32bpp BI_RGB rows are exactly w*4 bytes by
            // definition, matching Dup::buf bit for bit.
            let bi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w as i32,
                    biHeight: -(h as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [RGBQUAD::default()],
            };
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let hbitmap = CreateDIBSection(
                mem_dc,
                &bi,
                DIB_RGB_COLORS,
                &mut bits,
                HANDLE::default(), // no section object: GDI owns the pixel memory
                0,
            )
            .map_err(|e| format!("CreateDIBSection: {e}"))?;
            if bits.is_null() {
                let _ = DeleteObject(hbitmap);
                return Err("CreateDIBSection: null bits pointer".into());
            }
            let prev = SelectObject(mem_dc, hbitmap);
            if prev.is_invalid() {
                let _ = DeleteObject(hbitmap);
                return Err(format!("SelectObject: err={:?}", GetLastError()));
            }
            Ok(DibSection {
                bm: hbitmap,
                prev,
                bits: bits.cast(),
                w,
                h,
            })
        }
    }
}

/// Primary monitor size (SM_CXSCREEN/SM_CYSCREEN, origin 0,0) -- the same
/// output DXGI duplication captures (primary output). Zero on failure, which
/// every caller treats as an error.
fn primary_screen_size() -> (u32, u32) {
    unsafe {
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        (w.max(0) as u32, h.max(0) as u32)
    }
}

impl Gdi {
    pub fn new() -> Result<Gdi, String> {
        unsafe {
            let screen_dc = GetDC(None);
            if screen_dc.is_invalid() {
                return Err("GetDC: failed".into());
            }
            let mem_dc = CreateCompatibleDC(screen_dc);
            if mem_dc.is_invalid() {
                let _ = ReleaseDC(None, screen_dc);
                return Err("CreateCompatibleDC: failed".into());
            }
            let (w, h) = primary_screen_size();
            if w == 0 || h == 0 {
                let _ = DeleteDC(mem_dc);
                let _ = ReleaseDC(None, screen_dc);
                return Err("GetSystemMetrics: zero screen size".into());
            }
            let dib = match DibSection::create(mem_dc, w, h) {
                Ok(d) => d,
                Err(e) => {
                    let _ = DeleteDC(mem_dc);
                    let _ = ReleaseDC(None, screen_dc);
                    return Err(e);
                }
            };
            Ok(Gdi {
                screen_dc,
                mem_dc,
                dib: Some(dib),
                buf: Vec::new(),
            })
        }
    }

    pub fn size(&self) -> (u32, u32) {
        match &self.dib {
            Some(d) => (d.w, d.h),
            None => (0, 0),
        }
    }

    /// BGRA pixels of the last grabbed frame (stride exactly w*4).
    pub fn buf(&self) -> &[u8] {
        &self.buf
    }

    /// One capture cycle paced to `interval_ms` (1000/max_fps, set by the
    /// caller). The trailing sleep makes total grab time ~= interval only at
    /// small sizes: BitBlt is ~23 ms at 1280x720 but ~30-40 ms at >=1080p,
    /// which already exceeds the interval at typical max_fps values -- there
    /// the sleep is a no-op and the loop cadence is max(BitBlt, interval),
    /// i.e. the interval is an upper bound, not a guarantee. (No
    /// StretchBlt/downscaled blits in v1.)
    pub fn grab(&mut self, interval_ms: u32) -> Grab {
        let started = Instant::now();
        let out = self.grab_once();
        // Upper-bound pacing (see doc above); Grab::Err is left unpaced
        // because the error ladder on the caller side already backs off.
        if !matches!(out, Grab::Err(_)) {
            let interval = Duration::from_millis(interval_ms.max(1) as u64);
            if started.elapsed() < interval {
                std::thread::sleep(interval - started.elapsed());
            }
        }
        out
    }

    fn grab_once(&mut self) -> Grab {
        let (w, h) = primary_screen_size();
        if w == 0 || h == 0 {
            return Grab::Err("GetSystemMetrics: zero screen size".into());
        }
        // Display mode change: rebuild the DIB and report ModeChanged like
        // Dup does -- the first frame for the new size is grabbed on the next
        // pass, the out-of-date one is dropped. A previous failed rebuild
        // (dib == None) retries here on every pass.
        let rebuild = match &self.dib {
            Some(d) => d.w != w || d.h != h,
            None => true,
        };
        if rebuild {
            self.drop_dib();
            match DibSection::create(self.mem_dc, w, h) {
                Ok(d) => self.dib = Some(d),
                Err(e) => return Grab::Err(format!("gdi dib: {e}")),
            }
            return Grab::ModeChanged;
        }
        let d = match self.dib.as_ref() {
            Some(d) => d,
            None => return Grab::Err("gdi: no DIB section".into()),
        };
        unsafe {
            // CAPTUREBLT: include layered windows; the spike timing above was
            // measured with exactly this raster-op pair.
            if let Err(e) = BitBlt(
                self.mem_dc,
                0,
                0,
                w as i32,
                h as i32,
                self.screen_dc,
                0,
                0,
                SRCCOPY | CAPTUREBLT,
            ) {
                return Grab::Err(format!("BitBlt: {e}"));
            }
            // Copy into the compact buffer instead of handing out the DIB
            // memory: keeps buf() a plain safe slice of owned bytes with the
            // exact Dup::buf contract, for ~1 ms of memcpy per frame.
            let stride = w as usize * 4;
            let src = std::slice::from_raw_parts(d.bits, stride * h as usize);
            if self.buf.len() != src.len() {
                self.buf.resize(src.len(), 0);
            }
            self.buf.copy_from_slice(src);
        }
        Grab::Frame
    }

    /// Select the old bitmap back, then delete our DIB.
    fn drop_dib(&mut self) {
        if let Some(d) = self.dib.take() {
            unsafe {
                let _ = SelectObject(self.mem_dc, d.prev);
                let _ = DeleteObject(d.bm);
            }
        }
    }
}

impl Drop for Gdi {
    fn drop(&mut self) {
        self.drop_dib();
        unsafe {
            let _ = DeleteDC(self.mem_dc);
            let _ = ReleaseDC(None, self.screen_dc);
        }
    }
}

// ---------------------------------------------------------------------------
// WIC JPEG encode (spike-derived, plus the quality property bag)
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Wic {
    factory: IWICImagingFactory,
}

impl Wic {
    /// Standalone WIC factory (COM init + CoCreateInstance): the GDI-only path
    /// uses this when Capture::new -- which owns its own factory -- never ran.
    /// CoInitializeEx after a caller's own init returns S_FALSE, which is a
    /// success code and passes through.
    pub fn new() -> Result<Wic, String> {
        unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_err() {
                return Err(format!("CoInitializeEx: {hr:?}"));
            }
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| format!("WIC factory: {e}"))?;
            Ok(Wic { factory })
        }
    }

    /// Encode compact BGRA rows as JPEG. `q01` is quality 0.0..1.0.
    pub fn encode(&self, w: u32, h: u32, bgra: &[u8], q01: f32) -> Result<Vec<u8>, String> {
        let stride = w as usize * 4;
        if bgra.len() < stride * h as usize {
            return Err("jpeg: buffer smaller than image".into());
        }
        unsafe {
            enc_step("bitmap");
            let bmp: IWICBitmap = self
                .factory
                .CreateBitmapFromMemory(w, h, &GUID_WICPixelFormat32bppBGRA, stride as u32, bgra)
                .map_err(|e| format!("jpeg: WIC bitmap: {e}"))?;
            enc_step("encoder");
            let enc: IWICBitmapEncoder = self
                .factory
                // vendor GUID left null (documented "no vendor preference")
                .CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())
                .map_err(|e| format!("jpeg: encoder: {e}"))?;
            // The spike-proven in-memory stream (169 KB JPEGs on this very
            // machine), not SHCreateMemStream: with the shlwapi stream the
            // encoder committed "successfully" yet the readback came back
            // EMPTY (40+ zero-length frames live, v0.6.0 приёмка) — this
            // stream is read back from our own buffer, no Seek games.
            // Canonical OLE in-memory stream: battle-tested with WIC
            // encoders for decades. Our own #[implement] COM object AV-ed
            // inside windowscodecs.dll during Initialize, and shlwapi's
            // SHCreateMemStream came back EMPTY after a successful Commit —
            // the OS stream removes both variables at once.
            let stream: IStream = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) }
                .map_err(|e| format!("jpeg: hglobal stream: {e}"))?;
            enc.Initialize(&stream, WICBitmapEncoderNoCache)
                .map_err(|e| format!("jpeg: enc init: {e}"))?;
            let mut frame: Option<IWICBitmapFrameEncode> = None;
            let mut no_options: Option<IPropertyBag2> = None;
            enc.CreateNewFrame(&mut frame, &mut no_options)
                .map_err(|e| format!("jpeg: new frame: {e}"))?;
            let frame = frame.ok_or("jpeg: no frame returned")?;
            frame
                .Initialize(None)
                .map_err(|e| format!("jpeg: frame init: {e}"))?;
            frame
                .SetSize(w, h)
                .map_err(|e| format!("jpeg: set size: {e}"))?;
            // Quality: the property-bag knob is deferred — WIC's JPEG default
            // is 0.9 and the spike shipped identical numbers without it.
            let _ = q01;
            let src: IWICBitmapSource =
                bmp.cast().map_err(|e| format!("jpeg: source cast: {e}"))?;
            // null rect = whole image
            frame
                .WriteSource(&src, std::ptr::null())
                .map_err(|e| format!("jpeg: write: {e}"))?;
            frame
                .Commit()
                .map_err(|e| format!("jpeg: frame commit: {e}"))?;
            enc.Commit()
                .map_err(|e| format!("jpeg: encoder commit: {e}"))?;

            // Read the encoded bytes back: rewind to START, then chunk-read
            // to EOF. No Seek(END) size probing — two different streams both
            // "measured" zero that way (v0.6.0 приёмка).
            stream
                .Seek(0, STREAM_SEEK(0), None) // STREAM_SEEK_FROM_START
                .map_err(|e| format!("jpeg: rewind: {e}"))?;
            let mut out: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 65536];
            loop {
                let mut got: u32 = 0;
                let hr = stream.Read(chunk.as_mut_ptr().cast(), chunk.len() as u32, Some(&mut got));
                if hr.is_err() {
                    return Err(format!("jpeg: stream read back failed: {hr:?}"));
                }
                if got == 0 {
                    break;
                }
                out.extend_from_slice(&chunk[..got as usize]);
            }
            // An empty JPEG must never masquerade as a frame: the pipe client
            // would silently drop it (that is exactly how "running, no video"
            // looked from the operator's seat).
            if out.is_empty() {
                return Err("jpeg: empty output".into());
            }
            Ok(out)
        }
    }
}

/// Minimal in-memory IStream for WIC encoders, ported verbatim from
/// spike/video-dxgi (the benchmark that measured 14.9 ms/169 KB JPEG here).
/// One encode step per stdout line: a crash inside windowscodecs.dll names
/// its exact step (the stdout log survives the process).
fn enc_step(step: &str) {
    use std::io::Write as _;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{{\"ev\":\"enc\",\"step\":\"{step}\"}}");
    let _ = out.flush();
}

// ---------------------------------------------------------------------------
// Input injection (SendInput)
// ---------------------------------------------------------------------------

type MouseEventFlags = windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS;

/// Outcome of one injection call: (accepted, gle) — gle is "" on success and
/// "N (message)" on failure. GetLastError must be read IMMEDIATELY after the
/// failing call, before anything else runs on the thread. Honest caveat,
/// rev-3b: SendInput is NOT documented to set LastError (it returns the
/// number of injected events), so "0 (not set)" is a valid observation and
/// the log records whatever the system says — no more.
fn gle_text() -> String {
    unsafe {
        let e = GetLastError();
        if e.0 == 0 {
            return "0 (not set)".to_string();
        }
        let mut buf = [0u16; 256];
        // FormatMessageW: length 0 means no message text; the trailing CR/LF
        // is trimmed so the log line stays one line.
        let n = FormatMessageW(
            FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
            None,
            e.0,
            0, // neutral language
            PWSTR(buf.as_mut_ptr()),
            buf.len() as u32,
            None,
        );
        let msg = if n > 0 {
            let s = String::from_utf16_lossy(&buf[..n as usize]);
            s.trim_end_matches(['\r', '\n']).trim().to_string()
        } else {
            String::new()
        };
        if msg.is_empty() {
            format!("gle={}", e.0)
        } else {
            format!("gle={} ({})", e.0, msg)
        }
    }
}

fn send_input_mouse(dx: i32, dy: i32, flags: MouseEventFlags, data: u32) -> (bool, String) {
    let mi = MOUSEINPUT {
        dx,
        dy,
        mouseData: data,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0,
    };
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi },
    };
    let arr = [input];
    // SendInput returns the number of events injected; 0 means blocked
    // (e.g. by a UAC elevation prompt on the secure desktop) -- report with
    // the captured LastError and let the next operator event retry.
    let n = unsafe { SendInput(&arr, std::mem::size_of::<INPUT>() as i32) };
    if n == 1 {
        (true, String::new())
    } else {
        (false, gle_text())
    }
}

fn key_input(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> (bool, String) {
    let ki = KEYBDINPUT {
        wVk: vk,
        wScan: 0,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0,
    };
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki },
    };
    let arr = [input];
    let n = unsafe { SendInput(&arr, std::mem::size_of::<INPUT>() as i32) };
    if n == 1 {
        (true, String::new())
    } else {
        (false, gle_text())
    }
}

/// Product positioning path (rev-3b, X-series fact): the absolute move goes
/// through SetCursorPos in virtual-desktop pixels. SendInput absolute moves
/// are REJECTED by the system (return 0) on Basic Display Adapter VMs in both
/// spawn contexts, while SetCursorPos on the same attached thread demonstrably
/// moves the cursor. Buttons, wheel and keys stay on SendInput until the
/// rev-3b matrix says otherwise.
pub fn mouse_move_cursor(x01: f64, y01: f64) -> (bool, String) {
    let (vx, vy, cx, cy) = virtual_desktop_metrics();
    if cx == 0 || cy == 0 {
        return (false, "zero virtual desktop metrics".into());
    }
    let x_px = vx as f64 + (x01 * cx as f64).round();
    let y_px = vy as f64 + (y01 * cy as f64).round();
    unsafe {
        match SetCursorPos(x_px as i32, y_px as i32) {
            Ok(()) => (true, String::new()),
            Err(_) => (false, gle_text()),
        }
    }
}

/// rev-3b matrix variant: SendInput RELATIVE move (pointer acceleration may
/// change the effective delta -- the caller judges by GetCursorPos, not by dx).
pub fn mouse_move_rel(dx: i32, dy: i32) -> (bool, String) {
    send_input_mouse(dx, dy, MOUSEEVENTF_MOVE, 0)
}

/// rev-3b matrix variant: SendInput ABSOLUTE move in virtual-desktop pixels
/// (px -> the documented 0..65535 ABSOLUTE|VIRTUALDESK normalization).
pub fn mouse_move_abs_px(x_px: i32, y_px: i32) -> (bool, String) {
    let (vx, vy, cx, cy) = virtual_desktop_metrics();
    if cx == 0 || cy == 0 {
        return (false, "zero virtual desktop metrics".into());
    }
    let ax = ((x_px - vx) as f64 * 65535.0 / cx as f64).round() as i32;
    let ay = ((y_px - vy) as f64 * 65535.0 / cy as f64).round() as i32;
    send_input_mouse(
        ax,
        ay,
        MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE,
        0,
    )
}

/// rev-3b matrix variant: the deprecated mouse_event entry point (same
/// MOUSEEVENTF_* input stack, different API). Returns nothing by design --
/// the verdict is read from the cursor position by the caller.
pub fn mouse_event_legacy(dx: i32, dy: i32) {
    unsafe { mouse_event(MOUSEEVENTF_MOVE, dx, dy, 0, 0) }
}

/// Button press/release at the current position; the service always sends an
/// absolute move first when the operator's click carries coordinates.
pub fn mouse_button(name: &str, down: bool) -> (bool, String) {
    let (down_flag, up_flag) = match name {
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    };
    send_input_mouse(0, 0, if down { down_flag } else { up_flag }, 0)
}

/// Vertical wheel delta in wheel units; passed through as mouseData unchanged
/// (scaling decisions stay on the service side, mirroring the host input path).
pub fn wheel(dy: i32) -> (bool, String) {
    send_input_mouse(0, 0, MOUSEEVENTF_WHEEL, dy as u32)
}

/// One keyboard event. `extended` must match on down AND up (see keys.rs).
pub fn key_event(vk: u8, extended: bool, down: bool) -> (bool, String) {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    key_input(VIRTUAL_KEY(vk as u16), flags)
}

/// rev-3b matrix variant: raw VK keyboard event (down/up) with the SendInput
/// verdict + LastError. Lab choice VK_F15 (0x7E): a key no normal keyboard
/// has and nothing is bound to -- injecting it is side-effect-free.
pub fn key_vk_probe(vk: u8, down: bool) -> (bool, String) {
    let flags = if down {
        KEYBD_EVENT_FLAGS(0)
    } else {
        KEYEVENTF_KEYUP
    };
    key_input(VIRTUAL_KEY(vk as u16), flags)
}

fn virtual_desktop_metrics() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

// ---------------------------------------------------------------------------
// Display power
// ---------------------------------------------------------------------------

// winuser.h SC_MONITORPOWER selector for WM_SYSCOMMAND wParam (local constant
// on purpose: the numeric value is fixed by the Win32 docs, and keeping it
// local avoids depending on a metadata export name).
const SC_MONITORPOWER_V: usize = 0xF170;
// lParam meaning for SC_MONITORPOWER: -1 = display on, 2 = display off.

/// Poke the display power state. HWND_BROADCAST + SendMessageTimeoutW with a
/// 2 s cap and SMTO_ABORTIFHUNG: we own no window, and a frozen top-level
/// window must never stall the helper.
pub fn monitor_power(on: bool) {
    let lparam: isize = if on { -1 } else { 2 };
    let mut res: usize = 0;
    unsafe {
        let _ = SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SYSCOMMAND,
            WPARAM(SC_MONITORPOWER_V),
            LPARAM(lparam),
            SMTO_ABORTIFHUNG,
            2000,
            Some(&mut res),
        );
    }
}

// ---------------------------------------------------------------------------
// Privacy indicators for the status document
// ---------------------------------------------------------------------------

/// UAC consent screen indicator: consent.exe (the secure-desktop elevation
/// prompt) is running. Toolhelp snapshot, cheap at the 2 s status cadence.
pub fn consent_running() -> bool {
    unsafe {
        let h = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return false, // snapshot failed: report "not seen", do not guess
        };
        let mut e = PROCESSENTRY32W::default();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = false;
        if Process32FirstW(h, &mut e).is_ok() {
            loop {
                let name = String::from_utf16_lossy(&e.szExeFile);
                let name = name.trim_end_matches('\0').to_ascii_lowercase();
                if name == "consent.exe" {
                    found = true;
                    break;
                }
                if Process32NextW(h, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(h);
        found
    }
}

/// Lock/secure-desktop indicator: OpenInputDesktop fails (or returns NULL)
/// exactly when the input desktop is not ours to open (lock screen, UAC).
pub fn input_desktop_locked() -> bool {
    unsafe {
        // GENERIC_READ is the documented minimum for an openability probe of
        // the input desktop; the handle is closed immediately via CloseDesktop.
        let want = DESKTOP_ACCESS_FLAGS(GENERIC_READ.0);
        match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, want) {
            Err(_) => true, // could not open: secure desktop is active
            Ok(h) => {
                if h.is_invalid() {
                    true
                } else {
                    let _ = CloseDesktop(h);
                    false
                }
            }
        }
    }
}

/// D3 (ADR 0027 addendum-2): does the calling thread's desktop equal the
/// session's input desktop by NAME? The input desktop can swap silently UNDER
/// a still-attached thread (lock screen / UAC / wake transitions) — SendInput
/// then "succeeds" into a desktop nobody displays. Errors mean "cannot tell":
/// conservatively true (no re-attach storm); the locked/secure case is
/// reported by input_desktop_locked() elsewhere.
pub fn input_desktop_name_matches() -> bool {
    unsafe {
        let thread_desk = match GetThreadDesktop(GetCurrentThreadId()) {
            Ok(h) => h,
            Err(_) => return true,
        };
        let input_desk = match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_ACCESS_FLAGS(0))
        {
            Ok(h) => h,
            Err(_) => return true,
        };
        let name = |h: HANDLE| -> Option<String> {
            let mut buf = [0u16; 96];
            let mut needed = 0u32;
            if GetUserObjectInformationW(h, UOI_NAME, Some(buf.as_mut_ptr().cast()), 192, Some(&mut needed))
                .is_ok()
            {
                let len = buf.iter().position(|c| *c == 0).unwrap_or(0);
                Some(String::from_utf16_lossy(&buf[..len]))
            } else {
                None
            }
        };
        let (a, b) = (name(HANDLE(thread_desk.0)), name(HANDLE(input_desk.0)));
        let _ = CloseDesktop(input_desk);
        match (a, b) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        }
    }
}

/// "station\desktop" of the thread desktop AND of the input desktop — a
/// service-spawned process can silently land on Service-0x0-3e7$\Default
/// (a desktop nobody displays): both are named just "Default", and then
/// SendInput "succeeds" while the real cursor never moves.
pub fn thread_desktop_name() -> String {
    unsafe {
        let obj_name = |h: HANDLE| -> String {
            let mut name = [0u16; 96];
            let mut needed = 0u32;
            if GetUserObjectInformationW(h, UOI_NAME, Some(name.as_mut_ptr().cast()), 192, Some(&mut needed)).is_ok() {
                let len = name.iter().position(|c| *c == 0).unwrap_or(0);
                String::from_utf16_lossy(&name[..len])
            } else {
                format!("?err={:?}", GetLastError())
            }
        };
        let thread_desk = match GetThreadDesktop(GetCurrentThreadId()) {
            Ok(h) => obj_name(HANDLE(h.0)),
            Err(e) => format!("?err={e:?}"),
        };
        let input_desk = match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_ACCESS_FLAGS(0)) {
            Ok(h) => {
                let n = obj_name(HANDLE(h.0));
                let _ = CloseDesktop(h);
                n
            }
            Err(e) => format!("?err={e:?}"),
        };
        // The shell's taskbar exists ONLY on the real winsta0\Default — a
        // service station desktop (also named "Default") has none.
        let tray = FindWindowW(
            windows::core::w!("Shell_TrayWnd"),
            None,
        );
        let tray_note = if tray.is_ok() && !tray.unwrap().is_invalid() { "tray=yes" } else { "tray=no" };
        format!("thread={thread_desk} input={input_desk} {tray_note}")
    }
}

/// Session id of this process (kernel32 ProcessIdToSessionId).
pub fn current_session_id() -> u32 {
    unsafe {
        let mut sid = 0u32;
        let _ = ProcessIdToSessionId(GetCurrentProcessId(), &mut sid);
        sid
    }
}

/// Attach the CALLING thread to the session's input desktop with write access.
/// CreateProcessAsUserW hands the initial thread a desktop handle whose rights
/// may be truncated — SendInput then "succeeds" while the cursor never moves
/// and SetCursorPos returns FALSE with LastError=0 (night acceptance
/// 2026-10-02). A dedicated input thread re-attaches explicitly, RustDesk-style.
pub fn attach_input_desktop() -> Result<(), String> {
    unsafe {
        let h = OpenInputDesktop(
            DESKTOP_CONTROL_FLAGS(0),
            false,
            DESKTOP_ACCESS_FLAGS(
                DESKTOP_READOBJECTS.0 | DESKTOP_WRITEOBJECTS.0 | DESKTOP_SWITCHDESKTOP.0,
            ),
        )
        .map_err(|e| format!("OpenInputDesktop: {e}"))?;
        let attached = SetThreadDesktop(h);
        // The thread keeps its own reference after SetThreadDesktop; close ours.
        let _ = CloseDesktop(h);
        attached.map_err(|e| format!("SetThreadDesktop: {e}"))
    }
}

/// Virtual-desktop metrics for diagnostics (same numbers SendInput uses).
pub fn virtual_desktop_metrics_pub() -> (i32, i32, i32, i32) {
    virtual_desktop_metrics()
}

/// Cursor position as THIS process sees it (GetCursorPos on its own desktop).
pub fn cursor_pos() -> (i32, i32) {
    unsafe {
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        (pt.x, pt.y)
    }
}

/// Direct cursor set via SetCursorPos (bypasses the input queue entirely) —
/// diagnostics: if even this does not move the cursor, the position is
/// system-frozen, not an input-queue issue.
pub fn set_cursor_pos_probe(x: i32, y: i32) -> String {
    unsafe {
        let ok = SetCursorPos(x, y);
        if ok.is_ok() {
            format!("ok")
        } else {
            format!("err={:?}", GetLastError())
        }
    }
}

/// Direct cursor set, boolean result — plumbing for the input probe
/// (main.rs, D4). The probe needs the plain outcome plus before/after
/// positions; set_cursor_pos_probe above keeps the GetLastError text for
/// manual diagnostics and stays.
pub fn set_cursor_pos_xy(x: i32, y: i32) -> bool {
    unsafe { SetCursorPos(x, y).is_ok() }
}
