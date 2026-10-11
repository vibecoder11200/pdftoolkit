// native_engine (v0.6.0 phase 2): llama.cpp sidecar supervision — state
// machine, spawn/handshake/monitor/teardown. Phase 3 adds the downloader +
// on-disk store; phase 4 exposes the 7 IPC commands. The API token lives ONLY
// inside NativeEngineState and never crosses IPC (the JS-facing NativeStatus
// type in ipc.rs has no token/port fields — enforced by type, not convention).
//
// Exit-path invariants (review F5/F6): `shutdown_all` is wired into FOUR
// places in lib.rs — RunEvent, last-window CloseRequested, the updater's
// zero-arg blocking `on_before_exit` (the ONLY hook that runs before the
// Windows updater's `std::process::exit(0)`), and `restart_with_gpu_force`
// pre-exit. The Windows Job Object (kill-on-close) and the mandatory Unix
// startup stray sweep are the backstops that survive even a panicking app.
pub mod download;
#[cfg(debug_assertions)]
pub mod fake_child;
pub mod flow;
pub mod install;
pub mod manifest;
pub mod store;
pub mod supervisor;
#[cfg(unix)]
pub mod unix_group;
#[cfg(windows)]
pub mod win_job;

use rand::Rng;
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;

/// Base startup deadline (R2.2): max(30 s, 4× spike cold-start 6.1 s) → the
/// 30 s floor holds; every stdout load-progress line re-arms the deadline
/// (liveness-anchored, review M4) up to the hard cap.
pub const STARTUP_TIMEOUT_BASE: Duration = Duration::from_secs(30);
pub const STARTUP_TIMEOUT_HARD_CAP: Duration = Duration::from_secs(120);
/// Crash restart budget (review M4): max 3 auto-restarts per 5-minute
/// sliding window; user-initiated start from Dead clears it.
pub const RESTART_BUDGET_MAX: usize = 3;
pub const RESTART_BUDGET_WINDOW: Duration = Duration::from_secs(300);
/// Startup auto-retry cap (startup-timeout kills do NOT consume the crash
/// budget — they are capped separately here).
pub const STARTUP_RETRY_MAX: u32 = 2;
/// Idle shutdown (review F7): re-armed ONLY by OCR requests and explicit
/// start/stop commands; status reads are NON-activity by design.
pub const IDLE_SHUTDOWN_AFTER: Duration = Duration::from_secs(600);
/// Unix graceful stop: SIGTERM → this grace → SIGKILL.
pub const SIGTERM_GRACE: Duration = Duration::from_secs(3);
/// Pinned engine tag — asserted in the AUTHENTICATED `/props` probe
/// (`build_info` = "b11553-<sha>"); phase 3 cross-checks it against the
/// manifest's llamaTag in a cargo test.
pub const PINNED_LLAMA_TAG: &str = "b11553";

// argv frozen from the phase 1 spike (reports/spike-llamaserver.md §5.3):
// `--no-log-colors` died at b11553 → `--log-colors off`; `--verbose` is
// REQUIRED for the device/engagement lines phase 2 parses; the old
// `ggml_vulkan: Found N …` banner no longer exists.
pub const SERVER_ARGS_TAIL: &[&str] = &[
    "--port",
    "0",
    "--host",
    "127.0.0.1",
    "-ngl",
    "999",
    "-c",
    "8192",
    "-np",
    "1",
    "--no-webui",
    "--no-slots",
    "--jinja",
    "--log-colors",
    "off",
    "--verbose",
    "-lm",
    "mmap",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    #[default]
    Unknown,
    Vulkan,
    Cuda,
    Metal,
    Cpu,
}

/// R2.3: engagement verdict parsed from stdout. `cpuFallback` is true when
/// the engine build asked for a GPU backend but stdout shows none — the
/// phase 4/5 first-run gate and the benchmark `backend` dimension consume it.
#[derive(Debug, Clone, Serialize)]
pub struct EngineStatus {
    pub backend: Backend,
    pub devices: Vec<String>,
    pub cpu_fallback: bool,
}

/// Classified causes (R2.5 + review F13 spawn variants). Serialized into the
/// phase 4 status payload (`lastError`) — the JS side maps these 1:1 to
/// typed errors.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum EngineError {
    /// llama-server binary missing/blocked at the per-start quarantine probe.
    Quarantined { path: String },
    /// exit 1 + OOM keywords in the stderr tail.
    Oom,
    /// exit 1 during startup, not OOM-classified.
    LoadFailed(String),
    /// GGML_ASSERT / backend fault in the tail.
    BackendFault(String),
    /// any exit after Ready that we did not request (spike 5.9: on Windows a
    /// forced kill is exit code 1 with no distinguishing stderr).
    Crashed(i32),
    /// macOS Gatekeeper/code-signature kill: spawn ok, SIGKILL, no stderr.
    BlockedByOs,
    /// loader/glibc errors (`GLIBC_x.xx not found`, `cannot open shared object`).
    OsTooOld(String),
    /// authenticated ready probe never succeeded within the deadline.
    StartTimeout,
    /// process/job plumbing failed before the child ever ran.
    Spawn(String),
    /// downloader failures arrive in phase 3.
    DownloadFailed { reason: String },
}

impl EngineError {
    /// Stable short key — phase 5 i18n keys are derived from this.
    pub fn key(&self) -> &'static str {
        match self {
            EngineError::Quarantined { .. } => "quarantined",
            EngineError::Oom => "oom",
            EngineError::LoadFailed(_) => "load-failed",
            EngineError::BackendFault(_) => "backend-fault",
            EngineError::Crashed(_) => "crashed",
            EngineError::BlockedByOs => "os-blocked",
            EngineError::OsTooOld(_) => "os-too-old",
            EngineError::StartTimeout => "start-timeout",
            EngineError::Spawn(_) => "spawn",
            EngineError::DownloadFailed { .. } => "download",
        }
    }
}

/// R2.8 state machine.
#[derive(Debug, Clone)]
pub enum EnginePhase {
    NotInstalled,
    VersionChecking,
    Starting {
        since: std::time::Instant,
    },
    Ready {
        pid: u32,
        port: u16,
        status: EngineStatus,
    },
    Stopping,
    /// Teardown finished normally (startable again).
    Stopped,
    /// Restart budget exhausted or unrecoverable start — held for the UI.
    /// ESCAPABLE: a user-initiated start from Dead clears the budget.
    Dead {
        cause: EngineError,
    },
}

impl EnginePhase {
    pub fn is_running(&self) -> bool {
        matches!(
            self,
            EnginePhase::Ready { .. } | EnginePhase::Starting { .. }
        )
    }
}

/// Handle to the live child + its OS kill-proofing. Raw handles are plain
/// integers valid across threads (they outlive no thread boundary of their
/// own) — Send is safe; Sync is not claimed.
pub struct ActiveChild {
    pub pid: u32,
    /// Unix process group of the child (== child pid via process_group(0)).
    #[cfg(unix)]
    pub pgid: libc::pid_t,
    /// Windows Job Object handle (kill-on-close backstop). Closed at teardown.
    #[cfg(windows)]
    pub job_handle: isize,
}

/// Process-global registry of the live child for the BLOCKING kill paths
/// (`shutdown_all`'s last-resort + the sweeps' complement): Windows →
/// TerminateJobObject; Unix → immediate SIGKILL to the process group.
/// Idempotent by construction (an empty registry is a no-op).
pub static ACTIVE_CHILD: Mutex<Option<ActiveChild>> = Mutex::new(None);

/// Generation marker passed to every spawned engine child. The Unix startup
/// sweep and (as escalation) the Windows sweep kill only processes carrying
/// it — a RESTARTING app (new generation) is never targeted by an old
/// instance's cleanup.
pub const CHILD_MARKER_ENV: &str = "PDFTOOLKIT_NATIVE_ENGINE_CHILD";

/// 32-byte random hex token (R2.1) — env-only, never argv, never IPC.
pub fn generate_api_key() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Shared state behind `.manage(...)` (R2.8). Everything the later phases
/// need hangs off this struct; nothing but supervisor methods mutates it.
pub struct NativeEngineState {
    pub phase: Mutex<EnginePhase>,
    pub last_error: Mutex<Option<EngineError>>,
    pub api_key: Mutex<Option<String>>,
    /// The single in-flight OCR slot (R4.2): the idle timer consults this —
    /// busy → re-arm, NEVER dispose under a page. Owned here so phase 2's
    /// idle logic and phase 4's request mutex are the SAME object.
    pub page_in_flight: Mutex<u32>,
    /// Injectable for the fake-child test suite; production uses the
    /// STARTUP_TIMEOUT_BASE constant.
    pub startup_timeout_base: Mutex<std::time::Duration>,
    /// Injectable idle-shutdown delay (tests exercise the busy-never-dispose
    /// rule in milliseconds).
    pub idle_after: Mutex<std::time::Duration>,
    /// Sliding-window crash budget.
    pub crash_times: Mutex<Vec<std::time::Instant>>,
    pub startup_retries: Mutex<u32>,
    /// Cancel flag for the whole supervision loop (shutdown_all). Replaced
    /// with a fresh token on every user start.
    pub shutdown: Mutex<tokio_util::sync::CancellationToken>,
    /// The live supervision session task (spawn → monitor → restart loop).
    pub session: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// The armed idle-shutdown task (re-armed on activity only, review F7).
    pub idle_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Resolved paths (phase 3 store; test override until then).
    pub paths: Mutex<Option<EnginePaths>>,
    /// Single-flight download registry, keyed by kind (review F9).
    pub downloads: tokio::sync::Mutex<flow::DownloadRegistry>,
    /// Backend engagement verdict + diagnostics from the last start.
    pub status: Mutex<Option<EngineStatus>>,
    /// Probe devices from `--list-devices` (phase 4 `native_engine_probe`),
    /// cached until next install.
    pub probe_devices: Mutex<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct EnginePaths {
    pub engine_exe: std::path::PathBuf,
    pub engine_dir: std::path::PathBuf,
    pub model: std::path::PathBuf,
    pub mmproj: std::path::PathBuf,
}

impl NativeEngineState {
    pub fn new() -> Self {
        Self {
            phase: Mutex::new(EnginePhase::Stopped),
            last_error: Mutex::new(None),
            api_key: Mutex::new(None),
            page_in_flight: Mutex::new(0),
            startup_timeout_base: Mutex::new(STARTUP_TIMEOUT_BASE),
            idle_after: Mutex::new(IDLE_SHUTDOWN_AFTER),
            crash_times: Mutex::new(Vec::new()),
            startup_retries: Mutex::new(0),
            shutdown: Mutex::new(tokio_util::sync::CancellationToken::new()),
            session: Mutex::new(None),
            idle_task: Mutex::new(None),
            paths: Mutex::new(None),
            downloads: tokio::sync::Mutex::new(flow::DownloadRegistry::default()),
            status: Mutex::new(None),
            probe_devices: Mutex::new(Vec::new()),
        }
    }
}

impl Default for NativeEngineState {
    fn default() -> Self {
        Self::new()
    }
}

/// THE blocking kill (updater hook + Windows escalation). Zero args, no
/// async, no AppHandle (review F5): Windows → TerminateJobObject; Unix →
/// immediate SIGKILL to the process group. Idempotent by construction (an
/// empty registry is a no-op).
pub fn blocking_kill_active_child() {
    let guard = ACTIVE_CHILD.lock().unwrap();
    if let Some(child) = guard.as_ref() {
        #[cfg(windows)]
        win_job::terminate_job(child.job_handle);
        #[cfg(unix)]
        unix_group::killpg_now(child.pgid);
    }
}

/// Startup stray sweep (R2.7): MANDATORY on Unix (review F6), logged
/// escalation on Windows (phase 2 Risk 1's third line). Kills only OUR
/// previous-generation children (marker env / engine dir match), never a
/// restarting app's new generation.
pub fn startup_sweep(engine_dir: &std::path::Path) {
    #[cfg(unix)]
    unix_group::sweep_strays(engine_dir);
    #[cfg(windows)]
    win_job::sweep_strays(engine_dir);
    #[cfg(not(any(unix, windows)))]
    let _ = engine_dir;
}
