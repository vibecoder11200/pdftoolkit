// The 7 consolidated IPC commands (R4.1, review M5). Thin wrappers over the
// phase 2 supervisor / phase 3 flow / phase 4 ocr proxy — no business logic
// here. Errors cross IPC as `CommandError { kind, detail }` where `kind` is
// the STABLE key from `EngineError::key()` (or 'download' / 'invalid' /
// 'busy' / 'io' / 'cancelled') — the JS `src/lib/native-errors.ts` maps
// these 1:1 to typed `WorkerCrashError` subclasses. NativeStatus carries NO
// token and NO port (type-enforced, not convention).
use super::download::ProgressFrame;
use super::flow;
use super::ocr::{self, OcrError, OcrPageResult, TokenFrame};
use super::store::{self, Kind};
use super::supervisor;
use super::{EngineError, EnginePhase, NativeEngineState};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub kind: String,
    pub detail: Option<String>,
}

impl CommandError {
    fn of(kind: &str, detail: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            detail: Some(detail.into()),
        }
    }
}

impl From<EngineError> for CommandError {
    fn from(e: EngineError) -> Self {
        Self {
            kind: e.key().into(),
            detail: Some(e.to_string()),
        }
    }
}

impl From<OcrError> for CommandError {
    fn from(e: OcrError) -> Self {
        match e {
            OcrError::NotReady => Self::of("busy", e.to_string()),
            OcrError::BadPayload(_) => Self::of("invalid", e.to_string()),
            OcrError::Cancelled => Self::of("cancelled", e.to_string()),
            OcrError::Network(s) => Self::of("io", s),
        }
    }
}

fn io_err(e: std::io::Error) -> CommandError {
    CommandError::of("io", e.to_string())
}

/// R4.1 NativeStatus — `phase` is one of 'notInstalled' | 'versionChecking'
/// | 'starting' | 'ready' | 'stopping' | 'stopped' | 'dead'. `backend` +
/// `cpuFallback` feed the phase 5 CPU-fallback gate and the benchmark
/// `backend` dimension (review F14); `enginePresent`/`modelPresent` are the
/// NATIVE availability inputs the ocr-tool radio consumes (review F1).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStatus {
    pub phase: String,
    pub backend: Option<String>,
    pub cpu_fallback: Option<bool>,
    pub devices: Option<Vec<String>>,
    pub engine_present: bool,
    pub model_present: bool,
    pub cuda_present: bool,
    pub sizes: SizeBreakdown,
    pub last_error: Option<CommandError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeBreakdown {
    pub engine: u64,
    pub cuda: u64,
    pub model: u64,
}

fn phase_key(p: &EnginePhase) -> &'static str {
    match p {
        EnginePhase::NotInstalled => "notInstalled",
        EnginePhase::VersionChecking => "versionChecking",
        EnginePhase::Starting { .. } => "starting",
        EnginePhase::Ready { .. } => "ready",
        EnginePhase::Stopping => "stopping",
        EnginePhase::Stopped => "stopped",
        EnginePhase::Dead { .. } => "dead",
    }
}

fn kind_of(s: &str) -> Result<Kind, CommandError> {
    match s {
        "engine" => Ok(Kind::Engine),
        "cuda" => Ok(Kind::Cuda),
        "model" => Ok(Kind::Model),
        other => Err(CommandError::of(
            "invalid",
            format!("unknown download kind '{other}'"),
        )),
    }
}

/// Path resolution shared by every command: the test override wins, else
/// production resolution from app_local_data_dir.
fn paths_for(
    state: &std::sync::Arc<NativeEngineState>,
    app: &tauri::AppHandle,
) -> Result<super::EnginePaths, CommandError> {
    if let Some(p) = state.paths.lock().unwrap().clone() {
        return Ok(p);
    }
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| CommandError::of("io", e.to_string()))?;
    Ok(store::resolve_paths(&dir))
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, CommandError> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| CommandError::of("io", e.to_string()))
}

fn last_error_of(state: &NativeEngineState) -> Option<CommandError> {
    state
        .last_error
        .lock()
        .unwrap()
        .clone()
        .map(CommandError::from)
}

fn backend_string(b: &super::Backend) -> &'static str {
    match b {
        super::Backend::Unknown => "unknown",
        super::Backend::Vulkan => "vulkan",
        super::Backend::Cuda => "cuda",
        super::Backend::Metal => "metal",
        super::Backend::Cpu => "cpu",
    }
}

fn model_file_names() -> Vec<String> {
    super::manifest::manifest()
        .model
        .files
        .iter()
        .map(|f| f.path.clone())
        .collect()
}

#[tauri::command]
pub async fn native_engine_status(
    state: tauri::State<'_, std::sync::Arc<NativeEngineState>>,
    app: tauri::AppHandle,
) -> Result<NativeStatus, CommandError> {
    let paths = paths_for(&state, &app)?;
    let ald = app_data_dir(&app)?;
    let cuda_dir = store::engine_dir(&ald, "win-x64/cuda-12.4");
    let (phase, last_error) = {
        let p = state.phase.lock().unwrap().clone();
        (p, last_error_of(&state))
    };
    let engagement = state.status.lock().unwrap().clone();
    let (backend, cpu_fallback, devices) = match (&phase, &engagement) {
        (EnginePhase::Ready { status, .. }, _) => (
            Some(backend_string(&status.backend).to_string()),
            Some(status.cpu_fallback),
            Some(status.devices.clone()),
        ),
        (_, Some(s)) => (
            Some(backend_string(&s.backend).to_string()),
            Some(s.cpu_fallback),
            Some(s.devices.clone()),
        ),
        _ => (None, None, None),
    };
    let model_dir = paths
        .model
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| store::model_dir(&ald));
    Ok(NativeStatus {
        phase: phase_key(&phase).into(),
        backend,
        cpu_fallback,
        devices,
        engine_present: store::engine_present(&paths.engine_dir, super::install::SERVER_BINARY),
        model_present: store::model_present(&model_dir, &model_file_names()),
        cuda_present: store::engine_present(&cuda_dir, super::install::SERVER_BINARY),
        sizes: SizeBreakdown {
            engine: store::dir_size(&paths.engine_dir).unwrap_or(0),
            cuda: store::dir_size(&cuda_dir).unwrap_or(0),
            model: store::dir_size(&model_dir).unwrap_or(0),
        },
        last_error,
    })
}

/// One-shot `--list-devices` diagnostics (R2.3). Cached in state until the
/// next delete of the engine kind. Non-gating: empty on any failure.
#[tauri::command]
pub async fn native_engine_probe(
    state: tauri::State<'_, std::sync::Arc<NativeEngineState>>,
    app: tauri::AppHandle,
) -> Result<Vec<String>, CommandError> {
    {
        let cached = state.probe_devices.lock().unwrap();
        if !cached.is_empty() {
            return Ok(cached.clone());
        }
    }
    let paths = paths_for(&state, &app)?;
    let devices = supervisor::probe_devices(&paths, None);
    *state.probe_devices.lock().unwrap() = devices.clone();
    Ok(devices)
}

#[tauri::command]
pub async fn native_engine_download(
    kind: Kind,
    on_progress: Channel<ProgressFrame>,
    state: tauri::State<'_, std::sync::Arc<NativeEngineState>>,
    app: tauri::AppHandle,
) -> Result<u64, CommandError> {
    let ald = app_data_dir(&app)?;
    let on_frame = move |f: ProgressFrame| {
        let _ = on_progress.send(f);
    };
    // Cancellation flows through the registry's linked token
    // (native_cancel → flow::cancel_kind); this per-call token is a never-
    // cancelled placeholder by design.
    flow::download_kind(
        &state.downloads,
        kind,
        &ald,
        &on_frame,
        &CancellationToken::new(),
    )
    .await
    .map_err(|reason| CommandError::of("download", reason))
}

/// THE one cancel command (R4.1, review M5): kind 'ocr' cancels the
/// in-flight page (never the engine); kinds 'engine'|'cuda'|'model' cancel
/// the in-flight download of that kind; kind 'engine' on a RUNNING engine
/// IS the manual graceful stop.
#[tauri::command]
pub async fn native_cancel(
    kind: String,
    state: tauri::State<'_, std::sync::Arc<NativeEngineState>>,
) -> Result<(), CommandError> {
    match kind.as_str() {
        "ocr" => {
            if let Some(token) = state.page_cancel.lock().unwrap().take() {
                token.cancel();
            }
            Ok(())
        }
        "engine" | "cuda" | "model" => {
            let kind = kind_of(&kind)?;
            // 'engine' on a RUNNING engine is the manual stop, not a
            // download cancel.
            let running = state.phase.lock().unwrap().is_running();
            if kind == Kind::Engine && running {
                supervisor::shutdown_all(state.inner()).await;
                return Ok(());
            }
            flow::cancel_kind(&state.downloads, kind).await;
            Ok(())
        }
        other => Err(CommandError::of(
            "invalid",
            format!("unknown kind '{other}'"),
        )),
    }
}

/// Bytes freed. REFUSES while the engine is Running (R4.1 security note —
/// no deleting a binary out from under a live process). Cancels + awaits
/// any in-flight download of the kind first (review F9).
#[tauri::command]
pub async fn native_engine_delete(
    kind: Kind,
    state: tauri::State<'_, std::sync::Arc<NativeEngineState>>,
    app: tauri::AppHandle,
) -> Result<u64, CommandError> {
    if state.phase.lock().unwrap().is_running() {
        return Err(CommandError::of(
            "busy",
            "engine is running — stop it before deleting",
        ));
    }
    let ald = app_data_dir(&app)?;
    flow::cancel_kind(&state.downloads, kind).await;
    let dir = match kind {
        Kind::Engine => {
            *state.probe_devices.lock().unwrap() = Vec::new();
            store::engine_dir(&ald, super::manifest::target_engine_key())
        }
        Kind::Cuda => store::engine_dir(&ald, "win-x64/cuda-12.4"),
        Kind::Model => store::model_dir(&ald),
    };
    store::remove_dir_freed(&dir).map_err(io_err)
}

/// Idempotent start (R4.1): Ready → no-op. Requires engine + model
/// installed (a user-initiated start from Dead clears the restart budget,
/// phase 2 M4 — supervisor::start owns that).
#[tauri::command]
pub async fn native_engine_start(
    state: tauri::State<'_, std::sync::Arc<NativeEngineState>>,
    app: tauri::AppHandle,
) -> Result<NativeStatus, CommandError> {
    let paths = paths_for(&state, &app)?;
    if !store::engine_present(&paths.engine_dir, super::install::SERVER_BINARY) {
        return Err(CommandError::of(
            "quarantined",
            "engine is not installed (or was quarantined) — download it first",
        ));
    }
    let ald = app_data_dir(&app)?;
    if !store::model_present(&store::model_dir(&ald), &model_file_names()) {
        return Err(CommandError::of(
            "invalid",
            "model is not installed — download it first",
        ));
    }
    // wants_gpu = true always: CPU fallback is DETECTED from the engine's
    // own stdout (cpuFallback in the status), never requested down.
    supervisor::start(state.inner().clone(), paths, true, None)
        .await
        .map_err(CommandError::from)?;
    native_engine_status(state, app).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPageArgs {
    pub image_data_url: String,
    pub max_tokens: Option<u32>,
}

/// The OCR proxy command (R4.2). One page per call; concurrent calls QUEUE
/// on `state.page_slot` (Q3 by design). Payload is validated BEFORE
/// anything else (review M2). Empty content after a completed stream → ONE
/// retry with `reasoning_format: "none"` (quirk #20248).
#[tauri::command]
pub async fn native_ocr_page(
    args: OcrPageArgs,
    on_token: Channel<TokenFrame>,
    state: tauri::State<'_, std::sync::Arc<NativeEngineState>>,
) -> Result<OcrPageResult, CommandError> {
    ocr::validate_payload(&args.image_data_url).map_err(CommandError::from)?;

    let (port, api_key) = {
        let phase = state.phase.lock().unwrap().clone();
        match phase {
            EnginePhase::Ready { port, .. } => (port, state.api_key.lock().unwrap().clone()),
            _ => return Err(CommandError::of("busy", "engine is not ready")),
        }
    };
    let Some(api_key) = api_key else {
        return Err(CommandError::of("busy", "engine has no session token"));
    };

    let cancel = CancellationToken::new();
    *state.page_cancel.lock().unwrap() = Some(cancel.clone());
    supervisor::begin_page(state.inner());
    let _slot = state.page_slot.lock().await;
    let on_frame = move |f: TokenFrame| {
        let _ = on_token.send(f);
    };
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| CommandError::of("io", e.to_string()))?;
    let base_url = format!("http://127.0.0.1:{port}");
    let max_tokens = args.max_tokens.unwrap_or(ocr::DEFAULT_MAX_TOKENS);
    let image = args.image_data_url;
    let result = ocr::ocr_request(
        &client,
        &base_url,
        &api_key,
        &image,
        ocr::OCR_PROMPT,
        max_tokens,
        false,
        &on_frame,
        &cancel,
    )
    .await;
    // The quirk retry (R4.2): completed stream, empty text → one more
    // attempt with reasoning_format none.
    let result = match result {
        Ok(r) if r.text.trim().is_empty() && !cancel.is_cancelled() => {
            ocr::ocr_request(
                &client,
                &base_url,
                &api_key,
                &image,
                ocr::OCR_PROMPT,
                max_tokens,
                true,
                &on_frame,
                &cancel,
            )
            .await
        }
        other => other,
    };
    supervisor::end_page(state.inner());
    *state.page_cancel.lock().unwrap() = None;
    result.map_err(CommandError::from)
}
