// Supervision suite (v0.6.0 phase 2, step 7): drives the REAL supervisor
// against the fake child (the app's own debug binary routed through
// NATIVE_ENGINE_FAKE_CHILD — see native_engine/fake_child.rs). No test
// touches a real llama-server or a GPU; the healthy script serves REAL http
// on a real loopback port so the handshake runs integration-grade.
use pdftoolkit_lib::native_engine::supervisor::{self, shutdown_all, start};
use pdftoolkit_lib::native_engine::{EngineError, EnginePaths, EnginePhase, NativeEngineState};
use std::sync::Arc;
use std::time::Duration;

fn fake_paths(tag: &str) -> EnginePaths {
    let dir = std::env::temp_dir().join(format!(
        "pdftoolkit-native-supervision-{tag}-{}",
        std::process::id()
    ));
    let _ = std::fs::create_dir_all(&dir);
    EnginePaths {
        engine_exe: env!("CARGO_BIN_EXE_pdftoolkit").into(),
        engine_dir: dir.clone(),
        model: dir.join("fake-model.gguf"),
        mmproj: dir.join("fake-mmproj.gguf"),
    }
}

fn fresh_state() -> Arc<NativeEngineState> {
    let state = Arc::new(NativeEngineState::new());
    *state.startup_timeout_base.lock().unwrap() = Duration::from_secs(8);
    *state.idle_after.lock().unwrap() = Duration::from_secs(600);
    state
}

fn phase_of(state: &NativeEngineState) -> EnginePhase {
    state.phase.lock().unwrap().clone()
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        // Direct TerminateProcess — taskkill.exe subprocesses proved flaky
        // (one /T invocation hung the whole suite mid-run).
        unsafe {
            let h = windows_sys::Win32::System::Threading::OpenProcess(
                windows_sys::Win32::System::Threading::PROCESS_TERMINATE,
                0,
                pid,
            );
            if h != 0 {
                windows_sys::Win32::System::Threading::TerminateProcess(h, 1);
                windows_sys::Win32::Foundation::CloseHandle(h);
            }
        }
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|o| {
                let s = String::from_utf8_lossy(&o.stdout);
                !s.contains("INFO:") && s.contains(&pid.to_string())
            })
            .unwrap_or(false)
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
}

async fn wait_phase(
    state: &Arc<NativeEngineState>,
    secs: u64,
    pred: impl Fn(&EnginePhase) -> bool,
) -> EnginePhase {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let phase = phase_of(state);
        if pred(&phase) {
            return phase;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "phase never settled, last: {phase:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn healthy_start_reaches_ready_with_authenticated_probe_and_backend_parsed() {
    let state = fresh_state();
    let phase = start(
        state.clone(),
        fake_paths("healthy"),
        true,
        Some("healthy".into()),
    )
    .await
    .expect("start must succeed");
    let EnginePhase::Ready { pid, port, status } = phase else {
        panic!("expected Ready, got {phase:?}")
    };
    // Engagement verdict parsed from the fake's stderr lines (b11553 shape).
    assert_eq!(
        status.backend,
        pdftoolkit_lib::native_engine::Backend::Vulkan
    );
    assert!(!status.devices.is_empty(), "device name captured");
    assert!(!status.cpu_fallback);
    assert!(port > 0);
    // The engine really is alive and answers the AUTHENTICATED probe.
    let (code, body) = raw_get(
        port,
        "/props",
        state.api_key.lock().unwrap().as_deref().unwrap(),
    );
    assert_eq!(code, 200);
    assert!(body.contains("b11553"), "pinned tag in /props: {body}");
    // Unauthenticated probe is rejected (ownership is proven, not assumed).
    let (anon_code, _) = raw_get(port, "/props", "");
    assert_eq!(anon_code, 401);
    let _ = pid;
    shutdown_all(&state).await;
}

#[tokio::test]
async fn health_200_from_dying_child_is_never_ready() {
    let state = fresh_state();
    let result = start(
        state.clone(),
        fake_paths("toctou"),
        true,
        Some("http200-dead".into()),
    )
    .await;
    match result {
        Err(EngineError::LoadFailed(_)) | Err(EngineError::StartTimeout) => {}
        other => panic!("dead child must never reach Ready, got {other:?}"),
    }
}

#[tokio::test]
async fn startup_timeout_kills_child_and_consumes_no_crash_budget() {
    let state = fresh_state();
    *state.startup_timeout_base.lock().unwrap() = Duration::from_secs(2);
    let result = start(state.clone(), fake_paths("hang"), true, Some("hang".into())).await;
    assert!(
        matches!(result, Err(EngineError::StartTimeout)),
        "got {result:?}"
    );
    assert!(
        state.crash_times.lock().unwrap().is_empty(),
        "startup timeout never consumes the crash budget"
    );
    // Startup retries were consumed instead: 1 + STARTUP_RETRY_MAX attempts.
    assert_eq!(
        *state.startup_retries.lock().unwrap(),
        pdftoolkit_lib::native_engine::STARTUP_RETRY_MAX
    );
    shutdown_all(&state).await;
}

#[tokio::test]
async fn oom_at_startup_classifies_and_exhausts_retries_into_dead() {
    let state = fresh_state();
    let result = start(
        state.clone(),
        fake_paths("oom"),
        true,
        Some("exit1-oom".into()),
    )
    .await;
    assert!(matches!(result, Err(EngineError::Oom)), "got {result:?}");
    let phase = phase_of(&state);
    assert!(matches!(phase, EnginePhase::Dead { .. }));
}

#[tokio::test]
async fn load_failure_stderr_is_captured_and_classified() {
    let state = fresh_state();
    let result = start(
        state.clone(),
        fake_paths("loadfail"),
        true,
        Some("exit1-loadfail".into()),
    )
    .await;
    assert!(
        matches!(result, Err(EngineError::LoadFailed(_))),
        "got {result:?}"
    );
    // Last error retained for the UI.
    assert!(matches!(
        *state.last_error.lock().unwrap(),
        Some(EngineError::LoadFailed(_))
    ));
}

#[tokio::test]
async fn ggml_assert_classifies_backend_fault() {
    let state = fresh_state();
    let result = start(
        state.clone(),
        fake_paths("assert"),
        true,
        Some("ggml-assert".into()),
    )
    .await;
    assert!(
        matches!(result, Err(EngineError::BackendFault(_))),
        "got {result:?}"
    );
}

#[tokio::test]
async fn loader_error_classifies_os_too_old() {
    let state = fresh_state();
    let result = start(
        state.clone(),
        fake_paths("loader"),
        true,
        Some("loader-error".into()),
    )
    .await;
    assert!(
        matches!(result, Err(EngineError::OsTooOld(_))),
        "got {result:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn sigkill_without_stderr_classifies_blocked_by_os() {
    let state = fresh_state();
    let result = start(
        state.clone(),
        fake_paths("sigkill"),
        true,
        Some("sigkill-no-stderr".into()),
    )
    .await;
    assert!(
        matches!(result, Err(EngineError::BlockedByOs)),
        "got {result:?}"
    );
}

#[tokio::test]
async fn missing_binary_classifies_quarantined() {
    let state = fresh_state();
    let mut paths = fake_paths("missing");
    paths.engine_exe = paths.engine_dir.join("no-such-engine.exe");
    let result = start(state, paths, true, None).await;
    assert!(
        matches!(result, Err(EngineError::Quarantined { .. })),
        "got {result:?}"
    );
}

#[cfg(windows)]
#[tokio::test]
async fn running_crashes_restart_within_budget_then_die() {
    let state = fresh_state();
    start(
        state.clone(),
        fake_paths("crash"),
        true,
        Some("healthy".into()),
    )
    .await
    .expect("initial start");
    // Kill the RUNNING engine repeatedly — each is a crash → auto-restart,
    // until the sliding-window budget (3) is exceeded → Dead{Crashed}.
    for i in 0..5 {
        let pid = match phase_of(&state) {
            EnginePhase::Ready { pid, .. } => pid,
            other => {
                if matches!(other, EnginePhase::Dead { .. }) {
                    break;
                }
                panic!("unexpected phase {other:?} at kill {i}")
            }
        };
        eprintln!("kill {i}: pid {pid}");
        kill_pid(pid);
        // Let the monitor classify + restart (handshake ≈ 0.5 s).
        tokio::time::sleep(Duration::from_millis(1500)).await;
        eprintln!("after kill {i}: {:?}", phase_of(&state));
    }
    let phase = wait_phase(&state, 10, |p| matches!(p, EnginePhase::Dead { .. })).await;
    assert!(
        matches!(
            &phase,
            EnginePhase::Dead {
                cause: EngineError::Crashed(_),
                ..
            }
        ),
        "expected Dead{{Crashed}}, got {phase:?}"
    );
    // A USER start from Dead clears the budget and succeeds again (M4).
    let restart = start(
        state.clone(),
        fake_paths("crash"),
        true,
        Some("healthy".into()),
    )
    .await;
    assert!(
        matches!(restart, Ok(EnginePhase::Ready { .. })),
        "user start from Dead must escape, got {restart:?}"
    );
    assert!(
        state.crash_times.lock().unwrap().is_empty(),
        "budget cleared by user start"
    );
    shutdown_all(&state).await;
}

#[tokio::test]
async fn requested_stop_consumes_no_budget_and_is_idempotent() {
    let state = fresh_state();
    start(
        state.clone(),
        fake_paths("stop"),
        true,
        Some("healthy".into()),
    )
    .await
    .expect("start");
    shutdown_all(&state).await;
    assert!(matches!(phase_of(&state), EnginePhase::Stopped));
    assert!(
        state.crash_times.lock().unwrap().is_empty(),
        "requested stop never consumes budget"
    );
    // Idempotent: a second call is a no-op that leaves Stopped.
    shutdown_all(&state).await;
    assert!(matches!(phase_of(&state), EnginePhase::Stopped));
}

#[cfg(windows)]
#[tokio::test]
async fn teardown_reaps_the_child_no_orphans() {
    let state = fresh_state();
    let phase = start(
        state.clone(),
        fake_paths("orphan"),
        true,
        Some("healthy".into()),
    )
    .await
    .expect("start");
    let EnginePhase::Ready { pid, .. } = phase else {
        panic!("expected Ready")
    };
    assert!(pid_alive(pid), "child alive before teardown");
    shutdown_all(&state).await;
    // The Job Object / kill path reaps within the bounded wait.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while pid_alive(pid) {
        assert!(
            std::time::Instant::now() < deadline,
            "orphaned pid {pid} after teardown"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[tokio::test]
async fn idle_dispose_never_fires_under_a_busy_page() {
    let state = fresh_state();
    *state.idle_after.lock().unwrap() = Duration::from_millis(300);
    start(
        state.clone(),
        fake_paths("idle"),
        true,
        Some("healthy".into()),
    )
    .await
    .expect("start");
    supervisor::begin_page(&state); // in-flight page: the ONLY activity marker
    tokio::time::sleep(Duration::from_millis(700)).await;
    let phase = phase_of(&state);
    assert!(
        phase.is_running(),
        "busy-never-dispose: engine must survive the idle tick under a page, got {phase:?} (last_error {:?})",
        state.last_error.lock().unwrap()
    );
    supervisor::end_page(&state);
    // end_page only decrements the busy counter — the re-arm comes from the
    // idle timer itself: its tick fired while busy and re-armed, and the
    // NEXT tick (counter now 0, still Ready) disposes.
    let phase = wait_phase(&state, 5, |p| matches!(p, EnginePhase::Stopped)).await;
    assert!(matches!(phase, EnginePhase::Stopped));
}

#[tokio::test]
async fn slow_startup_lines_extend_the_deadline_liveness_anchor() {
    let state = fresh_state();
    *state.startup_timeout_base.lock().unwrap() = Duration::from_secs(2);
    // slow-then-ready prints progress lines 1 s apart — a fixed 2 s deadline
    // would trip before the 300 ms health gate + retries; the liveness
    // anchor re-arms on every line and the start succeeds on the first try.
    let result = start(
        state.clone(),
        fake_paths("slow"),
        true,
        Some("slow-then-ready".into()),
    )
    .await;
    assert!(
        matches!(result, Ok(EnginePhase::Ready { .. })),
        "got {result:?}"
    );
    shutdown_all(&state).await;
}

#[tokio::test]
async fn wants_gpu_false_reports_no_cpu_fallback() {
    let state = fresh_state();
    let phase = start(
        state.clone(),
        fake_paths("wantscpu"),
        false,
        Some("healthy".into()),
    )
    .await
    .expect("start");
    let EnginePhase::Ready { status, .. } = phase else {
        panic!("expected Ready")
    };
    assert!(!status.cpu_fallback, "cpuFallback requires a GPU-build key");
    shutdown_all(&state).await;
}

/// Minimal raw HTTP GET for test assertions (mirrors the supervisor probe).
fn raw_get(port: u16, path: &str, bearer: &str) -> (u16, String) {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let req = format!(
        "GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {bearer}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).unwrap();
    let mut buf = Vec::new();
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).into_owned();
    let status: u16 = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    (status, body)
}
