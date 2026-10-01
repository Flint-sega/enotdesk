// win.rs -- every unsafe Win32 call in one place. The rest of the helper sees
// only safe Rust. The DXGI/WIC/JPEG path is a direct descendant of the proven
// spike (spike/video-dxgi/src/main.rs); module paths, feature names and
// signatures in this file are verified against windows 0.58.0 on crates.io by
// `cargo check --target x86_64-pc-windows-msvc`. Target: Windows only.

use windows::core::{Interface, PCWSTR, PWSTR, VARIANT};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, GENERIC_READ, HANDLE, HMODULE, LPARAM, WPARAM,
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
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, GUID_WICPixelFormat32bppBGRA, IWICBitmap,
    IWICBitmapEncoder, IWICBitmapFrameEncode, IWICBitmapSource, IWICImagingFactory, IWICStream, IWICStream_Impl,
    WICBitmapEncoderNoCache,
};
use windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows::Win32::System::Com::StructuredStorage::{IPropertyBag2, PROPBAG2};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, IStream, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    ISequentialStream, ISequentialStream_Impl, IStream_Impl, LOCKTYPE, STATFLAG, STATSTG,
    STREAM_SEEK, STGC,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PeekNamedPipe, PIPE_READMODE_BYTE,
    PIPE_TYPE_BYTE,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, OpenInputDesktop, DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS,
};
use windows::Win32::System::IO::CancelIoEx;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
    MOUSEINPUT, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, WM_SYSCOMMAND,
};

// Progress marker of the last DXGI call inside make_dup() (see make_dup for
// the encoding). Read by the stdout ticker: if a call wedges, the tick keeps
// flowing (separate thread) and names the exact stuck call.
use std::sync::atomic::{AtomicU8, Ordering};
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
}

/// Outcome of one AcquireNextFrame cycle.
pub enum Grab {
    Frame,
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

            let wic_factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| format!("WIC factory: {e}"))?;

            Ok(Capture {
                device,
                ctx,
                output,
                wic: Wic {
                    factory: wic_factory,
                },
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
            })
        }
    }
}

impl Dup {
    pub fn size(&self) -> (u32, u32) {
        (self.w, self.h)
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
// WIC JPEG encode (spike-derived, plus the quality property bag)
// ---------------------------------------------------------------------------

pub struct Wic {
    factory: IWICImagingFactory,
}

impl Wic {
    /// Encode compact BGRA rows as JPEG. `q01` is quality 0.0..1.0.
    pub fn encode(&self, w: u32, h: u32, bgra: &[u8], q01: f32) -> Result<Vec<u8>, String> {
        let stride = w as usize * 4;
        if bgra.len() < stride * h as usize {
            return Err("jpeg: buffer smaller than image".into());
        }
        unsafe {
            let bmp: IWICBitmap = self
                .factory
                .CreateBitmapFromMemory(w, h, &GUID_WICPixelFormat32bppBGRA, stride as u32, bgra)
                .map_err(|e| format!("jpeg: WIC bitmap: {e}"))?;
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
            let mem = InMemoryStream::new();
            let stream: IStream = mem
                .cast()
                .map_err(|e| format!("jpeg: wicstream cast: {e}"))?;
            enc.Initialize(&stream, WICBitmapEncoderNoCache)
                .map_err(|e| format!("jpeg: enc init: {e}"))?;
            let mut frame: Option<IWICBitmapFrameEncode> = None;
            let mut options: Option<IPropertyBag2> = None;
            enc.CreateNewFrame(&mut frame, &mut options)
                .map_err(|e| format!("jpeg: new frame: {e}"))?;
            let frame = frame.ok_or("jpeg: no frame returned")?;
            frame
                .Initialize(None)
                .map_err(|e| format!("jpeg: frame init: {e}"))?;
            frame
                .SetSize(w, h)
                .map_err(|e| format!("jpeg: set size: {e}"))?;
            if let Some(bag) = &options {
                // Best effort: a failed property write keeps the encoder's
                // default quality instead of failing the whole frame.
                set_jpeg_quality(bag, q01);
            }
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
            let out = mem.take();
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
#[windows::core::implement(IWICStream, IStream, ISequentialStream)]
struct InMemoryStream {
    data: std::sync::Mutex<Vec<u8>>,
    pos: std::sync::Mutex<u64>,
}

impl InMemoryStream {
    fn new() -> Self {
        Self {
            data: std::sync::Mutex::new(Vec::with_capacity(1 << 20)),
            pos: std::sync::Mutex::new(0),
        }
    }
    fn take(&self) -> Vec<u8> {
        self.data.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

impl ISequentialStream_Impl for InMemoryStream_Impl {
    fn Read(&self, pv: *mut core::ffi::c_void, cb: u32, pcbread: *mut u32) -> windows::core::HRESULT {
        let data = self.data.lock().unwrap_or_else(|p| p.into_inner());
        let mut pos = self.pos.lock().unwrap_or_else(|p| p.into_inner());
        let p = (*pos as usize).min(data.len());
        let n = (cb as usize).min(data.len().saturating_sub(p));
        unsafe {
            std::ptr::copy_nonoverlapping(data.as_ptr().add(p), pv.cast(), n);
        }
        *pos = (p + n) as u64;
        if !pcbread.is_null() {
            unsafe { *pcbread = n as u32 };
        }
        windows::core::HRESULT(0) // S_OK
    }
    fn Write(&self, _pv: *const core::ffi::c_void, _cb: u32, _pcbwritten: *mut u32) -> windows::core::HRESULT {
        // The encoder only reads back; writes go through the WIC encoder.
        windows::core::HRESULT(0x8000_4001u32 as i32) // E_NOTIMPL
    }
}

impl IStream_Impl for InMemoryStream_Impl {
    fn Seek(&self, dlibmove: i64, dworigin: STREAM_SEEK, plibnewposition: *mut u64) -> windows::core::Result<()> {
        let mut pos = self.pos.lock().unwrap_or_else(|p| p.into_inner());
        let len = self.data.lock().unwrap_or_else(|p| p.into_inner()).len() as i64;
        let base: i64 = match dworigin.0 {
            0 => 0,                      // STREAM_SEEK_FROM_START
            1 => *pos as i64,            // STREAM_SEEK_FROM_CURRENT
            2 => len,                    // STREAM_SEEK_FROM_END
            _ => return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8003_0001u32 as i32))), // STG_E_INVALIDFUNCTION
        };
        let np = (base + dlibmove).clamp(0, len);
        *pos = np as u64;
        if !plibnewposition.is_null() {
            unsafe { *plibnewposition = np as u64 };
        }
        Ok(())
    }
    fn SetSize(&self, _libnewsize: u64) -> windows::core::Result<()> {
        Ok(())
    }
    fn CopyTo(&self, _pstm: Option<&IStream>, _cb: u64, _pcbread: *mut u64, _pcbwritten: *mut u64) -> windows::core::Result<()> {
        Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8000_4001u32 as i32)))
    }
    fn Commit(&self, _grfcommitflags: &STGC) -> windows::core::Result<()> {
        Ok(())
    }
    fn Revert(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn LockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: &LOCKTYPE) -> windows::core::Result<()> {
        Ok(())
    }
    fn UnlockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: u32) -> windows::core::Result<()> {
        Ok(())
    }
    fn Stat(&self, _pstatstg: *mut STATSTG, _grfstatflag: &STATFLAG) -> windows::core::Result<()> {
        Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8000_4001u32 as i32)))
    }
    fn Clone(&self) -> windows::core::Result<IStream> {
        Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8000_4001u32 as i32)))
    }
}

impl IWICStream_Impl for InMemoryStream_Impl {
    fn InitializeFromIStream(&self, _pistream: Option<&IStream>) -> windows::core::Result<()> {
        Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8000_4001u32 as i32)))
    }
    fn InitializeFromFilename(&self, _wzfilename: &windows::core::PCWSTR, _dwdesiredaccess: u32) -> windows::core::Result<()> {
        Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8000_4001u32 as i32)))
    }
    fn InitializeFromMemory(&self, _pbbuffer: *const u8, _cbbuffersize: u32) -> windows::core::Result<()> {
        Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8000_4001u32 as i32)))
    }
    fn InitializeFromIStreamRegion(&self, _pistream: Option<&IStream>, _uloffset: u64, _ulmaxsize: u64) -> windows::core::Result<()> {
        Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8000_4001u32 as i32)))
    }
}

/// JPEG quality in WIC is only reachable through the frame encoder's property
/// bag: "ImageQuality", VT_R4, 0.0..1.0. There is no SetQuality method.
fn set_jpeg_quality(bag: &IPropertyBag2, q01: f32) {
    let mut name: Vec<u16> = "ImageQuality\0".encode_utf16().collect();
    unsafe {
        let mut prop = PROPBAG2::default();
        prop.pstrName = PWSTR(name.as_mut_ptr());
        // windows-core builds the VT_R4 variant for us via From<f32>.
        let var = VARIANT::from(q01.clamp(0.0, 1.0));
        let _ = bag.Write(1, &prop, &var);
    }
}

// ---------------------------------------------------------------------------
// Input injection (SendInput)
// ---------------------------------------------------------------------------

type MouseEventFlags = windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS;

fn mouse_input(dx: i32, dy: i32, flags: MouseEventFlags, data: u32) -> bool {
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
    // (e.g. by a UAC elevation prompt on the secure desktop) -- report and let
    // the next operator event retry.
    unsafe { SendInput(&arr, std::mem::size_of::<INPUT>() as i32) == 1 }
}

fn key_input(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> bool {
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
    unsafe { SendInput(&arr, std::mem::size_of::<INPUT>() as i32) == 1 }
}

/// Normalized virtual-desktop coordinate (0..1) -> absolute mouse position.
/// Per the documented MOUSEEVENTF_ABSOLUTE|VIRTUALDESK normalization:
///   abs = (x_virtual_px - SM_XVIRTUALSCREEN) * 65535 / SM_CXVIRTUALSCREEN
/// which algebraically collapses to x01 * 65535, but is written through the
/// metrics so the formula stays auditable against the docs.
pub fn mouse_move_abs(x01: f64, y01: f64) -> bool {
    let (vx, vy, cx, cy) = virtual_desktop_metrics();
    if cx == 0 || cy == 0 {
        return false;
    }
    let x_px = vx as f64 + x01 * cx as f64;
    let y_px = vy as f64 + y01 * cy as f64;
    let ax = ((x_px - vx as f64) * 65535.0 / cx as f64).round() as i32;
    let ay = ((y_px - vy as f64) * 65535.0 / cy as f64).round() as i32;
    mouse_input(
        ax,
        ay,
        MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE,
        0,
    )
}

/// Button press/release at the current position; the service always sends an
/// absolute move first when the operator's click carries coordinates.
pub fn mouse_button(name: &str, down: bool) -> bool {
    let (down_flag, up_flag) = match name {
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    };
    mouse_input(0, 0, if down { down_flag } else { up_flag }, 0)
}

/// Vertical wheel delta in wheel units; passed through as mouseData unchanged
/// (scaling decisions stay on the service side, mirroring the host input path).
pub fn wheel(dy: i32) -> bool {
    mouse_input(0, 0, MOUSEEVENTF_WHEEL, dy as u32)
}

/// One keyboard event. `extended` must match on down AND up (see keys.rs).
pub fn key_event(vk: u8, extended: bool, down: bool) -> bool {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
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
