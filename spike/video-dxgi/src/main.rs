// enot-spike: DXGI Desktop Duplication capture benchmark (ADR 0027 spike).
// Measures capture fps, per-frame map time, WIC JPEG encode time/size, CPU.
use std::time::{Duration, Instant};

use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::D3D11::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Dxgi_Common::*;
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};

fn main() {
    if let Err(e) = run() {
        eprintln!("SPIKE_ERROR: {e}");
        std::process::exit(1);
    }
}

fn make_dup(dev: &ID3D11Device, output: &IDXGIOutput, ctx: &ID3D11DeviceContext) -> Result<Dup, String> {
    unsafe {
        let out1: IDXGIOutput1 = output.cast().map_err(|e| format!("output1 cast: {e}"))?;
        let dup = out1
            .DuplicateOutput(dev)
            .map_err(|e| format!("DuplicateOutput: {e}"))?;
        let desc = dup.Desc();
        let (w, h) = (desc.ModeDesc.Width, desc.ModeDesc.Height);
        let sd = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: D3D11_BIND_FLAG(0),
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging: Option<ID3D11Texture2D> = None;
        dev.CreateTexture2D(&sd, None, Some(&mut staging))
            .map_err(|e| format!("staging tex: {e}"))?;
        let staging = staging.ok_or("no staging tex")?;
        Ok(Dup { dup, staging, ctx: ctx.clone(), w, h })
    }
}

struct Dup {
    dup: IDXGIOutputDuplication,
    staging: ID3D11Texture2D,
    ctx: ID3D11DeviceContext,
    w: u32,
    h: u32,
}

fn run() -> Result<(), String> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).map_err(|e| format!("com: {e}"))?;
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| format!("factory: {e}"))?;

        let mut adapters: Vec<(IDXGIAdapter1, Vec<IDXGIOutput>)> = Vec::new();
        let mut ai = 0u32;
        loop {
            let ad = match factory.EnumAdapters1(ai) {
                Ok(a) => a,
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(e) => return Err(format!("enum adapter {ai}: {e}")),
            };
            let mut outs = Vec::new();
            let mut oi = 0u32;
            loop {
                match ad.EnumOutputs(oi) {
                    Ok(o) => {
                        let mut d = DXGI_OUTPUT_DESC::default();
                        let _ = o.GetDesc(&mut d);
                        let name: String = d.DeviceName.to_string().unwrap_or_else(|_| "?".into());
                        let dm = d.DesktopCoordinates;
                        println!(
                            "DISPLAY: {} {}x{} at ({},{}) attached={}",
                            name.trim_end_matches('\0'),
                            dm.right - dm.left,
                            dm.bottom - dm.top,
                            dm.left,
                            dm.top,
                            d.AttachedToDesktop.as_bool()
                        );
                        outs.push(o);
                    }
                    Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                    Err(e) => return Err(format!("enum output {oi}: {e}")),
                }
                oi += 1;
            }
            if !outs.is_empty() {
                let mut da = DXGI_ADAPTER_DESC1::default();
                let _ = ad.GetDesc1(&mut da);
                let desc: String = da.Description.to_string().unwrap_or_default();
                println!(
                    "ADAPTER: {} DedicatedVRAM={}MB",
                    desc.trim_end_matches('\0'),
                    da.DedicatedVideoMemory / (1024 * 1024)
                );
                adapters.push((ad, outs));
            }
            ai += 1;
        }
        if adapters.is_empty() {
            return Err("no display outputs found".into());
        }
        let (adapter, outputs) = adapters.remove(0);
        let output = outputs[0].clone();

        let mut device: Option<ID3D11Device> = None;
        let mut ctx: Option<ID3D11DeviceContext> = None;
        D3D11CreateDevice(
            &adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG(0),
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut ctx),
        )
        .map_err(|e| format!("D3D11CreateDevice: {e}"))?;
        let device = device.ok_or("no d3d device")?;
        let ctx = ctx.ok_or("no d3d ctx")?;

        let mut state = make_dup(&device, &output, &ctx)?;
        println!("DUP: created {}x{}", state.w, state.h);

        let wic: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("wic: {e}"))?;

        // CPU baseline before the loop (startup cost excluded).
        let cpu0 = cpu_ns();

        let dur = Duration::from_secs(12);
        let t0 = Instant::now();
        let mut frames: u64 = 0;
        let mut timeouts: u64 = 0;
        let mut acc_cap: Duration = Duration::ZERO;
        let mut acc_jpeg: Duration = Duration::ZERO;
        let mut jpeg_n: u64 = 0;
        let mut jpeg_bytes_total: u64 = 0;
        let mut saved_jpeg = false;
        let mut access_lost: u32 = 0;
        let mut buf: Vec<u8> = Vec::new();
        let mut cursor_tick = Instant::now();
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        let (cx, cy) = (pt.x, pt.y);

        while t0.elapsed() < dur {
            if cursor_tick.elapsed() >= Duration::from_millis(300) {
                cursor_tick = Instant::now();
                let dx = if (frames / 2) % 2 == 0 { 2 } else { -2 };
                let _ = SetCursorPos(cx + dx, cy + dx);
            }
            let tc = Instant::now();
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut res: Option<IDXGIResource> = None;
            match state.dup.AcquireNextFrame(100, &mut info, &mut res) {
                Ok(()) => {
                    let res = res.ok_or("no frame resource")?;
                    let tex: ID3D11Texture2D = res.cast().map_err(|e| format!("tex cast: {e}"))?;
                    let mut desc = D3D11_TEXTURE2D_DESC::default();
                    let _ = tex.GetDesc(&mut desc);
                    if desc.Width != state.w || desc.Height != state.h {
                        state = make_dup(&device, &output, &ctx)?;
                        println!("MODECHANGE: now {}x{}", state.w, state.h);
                        continue;
                    }
                    state.ctx.CopyResource(&state.staging, &tex);
                    let mut map = D3D11_MAPPED_SUBRESOURCE::default();
                    state
                        .ctx
                        .Map(&state.staging, 0, D3D11_MAP_READ, 0, Some(&mut map))
                        .map_err(|e| format!("map: {e}"))?;
                    let pitch = map.RowPitch as usize;
                    let (w, h) = (state.w as usize, state.h as usize);
                    let src =
                        std::slice::from_raw_parts(map.pData as *const u8, pitch * h);
                    buf.clear();
                    for row in 0..h {
                        buf.extend_from_slice(&src[row * pitch..row * pitch + w * 4]);
                    }
                    let _ = state.ctx.Unmap(&state.staging, 0);
                    state.dup.ReleaseFrame().map_err(|e| format!("release: {e}"))?;
                    acc_cap += tc.elapsed();
                    frames += 1;

                    if frames % 10 == 0 {
                        let tj = Instant::now();
                        match encode_jpeg(&wic, state.w, state.h, &buf) {
                            Ok(bytes) => {
                                acc_jpeg += tj.elapsed();
                                jpeg_n += 1;
                                jpeg_bytes_total += bytes.len() as u64;
                                if !saved_jpeg {
                                    let path = std::env::temp_dir().join("enot-spike-frame.jpg");
                                    let _ = std::fs::write(&path, &bytes);
                                    saved_jpeg = true;
                                    println!("ARTIFACT: {}", path.display());
                                }
                            }
                            Err(e) => eprintln!("jpeg err: {e}"),
                        }
                    }
                    let _ = info;
                }
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                    timeouts += 1;
                }
                Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => {
                    access_lost += 1;
                    if access_lost > 5 {
                        return Err("too many ACCESS_LOST".into());
                    }
                    state = make_dup(&device, &output, &ctx)?;
                }
                Err(e) => return Err(format!("acquire: {e} ({:#x})", e.code().0)),
            }
        }

        let wall = t0.elapsed().as_secs_f64();
        let cpu_pct = ((cpu_ns() - cpu0) as f64 / 1e9 / wall * 100.0).clamp(0.0, 100.0 * num_cpus());
        let avg_cap_ms = if frames > 0 { acc_cap.as_secs_f64() * 1000.0 / frames as f64 } else { 0.0 };
        let avg_jpeg_ms = if jpeg_n > 0 { acc_jpeg.as_secs_f64() * 1000.0 / jpeg_n as f64 } else { 0.0 };
        let avg_jpeg_kb = if jpeg_n > 0 { jpeg_bytes_total as f64 / jpeg_n as f64 / 1024.0 } else { 0.0 };
        println!(
            "RESULT: {{\"frames\":{},\"wall_s\":{:.1},\"fps\":{:.1},\"timeouts\":{},\"avg_capture_ms\":{:.2},\"avg_jpeg_ms\":{:.2},\"jpeg_n\":{},\"avg_jpeg_kb\":{:.1},\"cpu_pct\":{:.1},\"res\":\"{}x{}\",\"access_lost\":{}}}",
            frames, wall, frames as f64 / wall, timeouts, avg_cap_ms, avg_jpeg_ms, jpeg_n, avg_jpeg_kb, cpu_pct, state.w, state.h, access_lost
        );
        Ok(())
    }
}

fn encode_jpeg(wic: &IWICImagingFactory, w: u32, h: u32, bgra: &[u8]) -> Result<Vec<u8>, String> {
    unsafe {
        let bmp: IWICBitmap = wic
            .CreateBitmapFromMemory(
                w,
                h,
                &GUID_WICPixelFormat32bppBGRA,
                w as u32 * 4,
                bgra,
            )
            .map_err(|e| format!("wic bmp: {e}"))?;
        let enc: IWICBitmapEncoder = wic
            .CreateEncoder(&GUID_ContainerFormatJpeg, None)
            .map_err(|e| format!("wic enc: {e}"))?;
        let mem = InMemoryStream::new();
        let stream: IWICStream = mem.cast().map_err(|e| format!("wicstream cast: {e}"))?;
        enc.Initialize(&stream, WICBitmapEncoderNoCache)
            .map_err(|e| format!("enc init: {e}"))?;
        let mut frame: Option<IWICBitmapFrameEncode> = None;
        enc.CreateNewFrame(Some(&mut frame), None)
            .map_err(|e| format!("frame: {e}"))?;
        let frame = frame.ok_or("no frame")?;
        frame.Initialize(None).map_err(|e| format!("finit: {e}"))?;
        frame.SetSize(w, h).map_err(|e| format!("fsize: {e}"))?;
        let src: IWICBitmapSource = bmp.cast().map_err(|e| format!("src cast: {e}"))?;
        frame
            .WriteSource(&src, None)
            .map_err(|e| format!("write: {e}"))?;
        frame.Commit().map_err(|e| format!("fcommit: {e}"))?;
        enc.Commit().map_err(|e| format!("ecommit: {e}"))?;
        Ok(mem.take())
    }
}

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
        self.data.lock().unwrap().clone()
    }
}

impl ISequentialStream_Impl for InMemoryStream_Impl {
    fn Read(&self, pb: *mut u8, cb: u32, pcbread: Option<*mut u32>) -> Result<()> {
        let data = self.data.lock().unwrap();
        let mut pos = self.pos.lock().unwrap();
        let p = (*pos as usize).min(data.len());
        let n = (cb as usize).min(data.len().saturating_sub(p));
        unsafe {
            std::ptr::copy_nonoverlapping(data.as_ptr().add(p), pb, n);
        }
        *pos = (p + n) as u64;
        if let Some(x) = pcbread {
            unsafe { *x = n as u32 };
        }
        Ok(())
    }
    fn Write(&self, _pb: *const u8, _cb: u32, _pcbw: Option<*mut u32>) -> Result<()> {
        Err(Error::from_hresult(HRESULT(-2147467263))) // E_NOTIMPL
    }
}

impl IStream_Impl for InMemoryStream_Impl {
    fn Seek(&self, dlibmove: i64, dworigin: u32, plibnewposition: Option<*mut u64>) -> Result<()> {
        let mut pos = self.pos.lock().unwrap();
        let len = self.data.lock().unwrap().len() as i64;
        let base: i64 = match dworigin {
            0 => 0,
            1 => *pos as i64,
            2 => len,
            _ => return Err(Error::from_hresult(HRESULT(-2147024707))), // STG_E_INVALIDFUNCTION
        };
        let np = (base + dlibmove).clamp(0, len);
        *pos = np as u64;
        if let Some(p) = plibnewposition {
            unsafe { *p = np as u64 };
        }
        Ok(())
    }
    fn SetSize(&self, _libnewsize: u64) -> Result<()> {
        Ok(())
    }
    fn CopyTo(
        &self,
        _pstm: windows::core::Ref<'_, windows::Win32::System::Com::IStream>,
        _cb: u64,
        _pcbread: Option<*mut u64>,
        _pcbw: Option<*mut u64>,
    ) -> Result<()> {
        Err(Error::from_hresult(HRESULT(-2147467263)))
    }
    fn Commit(&self, _grfcommit: u32) -> Result<()> {
        Ok(())
    }
    fn Revert(&self) -> Result<()> {
        Ok(())
    }
    fn LockRegion(&self, _a: u64, _b: u64, _c: u32) -> Result<()> {
        Ok(())
    }
    fn UnlockRegion(&self, _a: u64, _b: u64, _c: u32) -> Result<()> {
        Ok(())
    }
    fn Stat(&self, _pstatstg: *mut STATSTG, _grfstatflag: u32) -> Result<()> {
        Err(Error::from_hresult(HRESULT(-2147467263)))
    }
    fn Clone(&self) -> Result<windows::Win32::System::Com::IStream> {
        Err(Error::from_hresult(HRESULT(-2147467263)))
    }
}

impl IWICStream_Impl for InMemoryStream_Impl {
    fn InitializeFromIStream(&self, _pistm: windows::core::Ref<'_, IStream>) -> Result<()> {
        Err(Error::from_hresult(HRESULT(-2147467263)))
    }
    fn InitializeFromFilename(
        &self,
        _wzfilename: &windows::core::PCWSTR,
        _dwdesiredaccess: u32,
    ) -> Result<()> {
        Err(Error::from_hresult(HRESULT(-2147467263)))
    }
    fn InitializeFromMemory(&self, _pbbuffer: &[u8]) -> Result<()> {
        Err(Error::from_hresult(HRESULT(-2147467263)))
    }
    fn InitializeFromIStreamRegion(
        &self,
        _pistm: windows::core::Ref<'_, IStream>,
        _uloffset: u64,
        _ulmaxsize: u64,
    ) -> Result<()> {
        Err(Error::from_hresult(HRESULT(-2147467263)))
    }
}

fn cpu_ns() -> u64 {
    unsafe {
        let h = GetCurrentProcess();
        let mut ct = FILETIME::default();
        let mut ut = FILETIME::default();
        let mut ec = FILETIME::default();
        let mut et = FILETIME::default();
        if GetProcessTimes(h, &mut ct, &mut ec, &mut ut, &mut et).is_err() {
            return 0;
        }
        let to_ns = |f: FILETIME| ((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) * 100;
        to_ns(ut) + to_ns(et)
    }
}

fn num_cpus() -> f64 {
    std::thread::available_parallelism()
        .map(|n| n.get() as f64)
        .unwrap_or(4.0)
}
