// REAL-engine smoke (phase 2 SC "manual smoke", programmatic form). Ignored
// by default (CI never downloads engines): run explicitly with
//   cargo test --test native_real_smoke -- --ignored
// Requires the phase 1 spike artifacts in temp/native-engine-spike
// (llama-server b11553 win-vulkan + GLM-OCR GGUFs) and a Vulkan-capable GPU.
use pdftoolkit_lib::native_engine::supervisor::{shutdown_all, start};
use pdftoolkit_lib::native_engine::{EnginePaths, EnginePhase, NativeEngineState};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

fn spike_paths() -> Option<EnginePaths> {
    // Repo root = parent of src-tauri (the test's cwd is src-tauri/).
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let dir = root.join("temp/native-engine-spike");
    let exe = if cfg!(windows) {
        dir.join("engine/llama-server.exe")
    } else {
        dir.join("engine/llama-server")
    };
    let model = dir.join("GLM-OCR-Q8_0.gguf");
    let mmproj = dir.join("mmproj-GLM-OCR-Q8_0.gguf");
    if !exe.is_file() || !model.is_file() || !mmproj.is_file() {
        return None;
    }
    // llama-server rejects BOTH unnormalized (`\..\`) and extended-length
    // (`\\?\D:\…`) argument paths — normalize the way phase 3's store will:
    // canonicalize, then strip the \\?\ prefix from plain drive paths.
    let canon = |p: std::path::PathBuf| {
        let c = p.canonicalize().unwrap_or(p);
        let s = c.to_string_lossy().into_owned();
        let s = match s.strip_prefix(r"\\?\") {
            Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
            _ => s,
        };
        std::path::PathBuf::from(s)
    };
    Some(EnginePaths {
        engine_exe: canon(exe),
        engine_dir: canon(dir.join("engine")),
        model: canon(model),
        mmproj: canon(mmproj),
    })
}

#[cfg(windows)]
fn kill_and_alive(pid: u32) -> (bool /*killed*/, bool /*alive after*/) {
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if h == 0 {
            return (false, false);
        }
        TerminateProcess(h, 1);
        windows_sys::Win32::Foundation::CloseHandle(h);
    }
    (true, pid_alive(pid))
}

#[cfg(unix)]
fn kill_and_alive(pid: u32) -> (bool, bool) {
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    (true, pid_alive(pid))
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    unsafe {
        // OpenProcess SUCCEEDS on terminated-but-unreaped processes — the
        // exit code is the liveness signal (STILL_ACTIVE = 259).
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h == 0 {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code);
        windows_sys::Win32::Foundation::CloseHandle(h);
        ok != 0 && code == 259
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
}

#[tokio::test]
#[ignore = "real engine + GPU required; run with --ignored on the dev machine"]
async fn real_llama_server_reaches_ready_then_survives_a_kill_and_teardown_reaps() {
    let Some(paths) = spike_paths() else {
        eprintln!("spike artifacts missing — smoke skipped");
        return;
    };
    let state = Arc::new(NativeEngineState::new());
    // Spike cold start was 6.1 s — 4× + slack; the liveness anchor covers it.
    *state.startup_timeout_base.lock().unwrap() = Duration::from_secs(45);
    let phase = start(state.clone(), paths, true, None)
        .await
        .expect("real engine must reach Ready");
    let EnginePhase::Ready { pid, port, status } = &phase else {
        panic!("expected Ready, got {phase:?}")
    };
    println!(
        "READY pid={pid} port={port} backend={:?} devices={:?} cpu_fallback={}",
        status.backend, status.devices, status.cpu_fallback
    );
    assert!(
        matches!(
            status.backend,
            pdftoolkit_lib::native_engine::Backend::Vulkan
        ),
        "the motivating machine must engage the RTX 3050 via Vulkan"
    );

    // Kill mid-run (Task Manager equivalence) → classified restart → Ready.
    assert!(kill_and_alive(*pid).0, "kill must succeed");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let p = state.phase.lock().unwrap().clone();
        match p {
            // The kill takes a moment to propagate — a stale Ready with the
            // OLD pid is not a restart; keep waiting.
            EnginePhase::Ready { pid: new_pid, .. } if new_pid != *pid => {
                println!("RESTARTED pid={new_pid}");
                break;
            }
            other => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "no restart, phase {other:?}"
                );
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
    }

    // Teardown reaps: zero orphans within the bounded wait.
    let orphan_pid = match state.phase.lock().unwrap().clone() {
        EnginePhase::Ready { pid, .. } => pid,
        other => panic!("expected Ready before teardown, got {other:?}"),
    };
    shutdown_all(&state).await;
    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    while pid_alive(orphan_pid) {
        assert!(
            std::time::Instant::now() < deadline,
            "orphan {orphan_pid} survived teardown"
        );
        std::thread::sleep(Duration::from_millis(150));
    }
    println!("TEARDOWN clean — zero orphans");
}

/// Phase 3 real smoke: the ACTUAL download+extract+start flow against the
/// committed manifest pins (33 MB engine from GitHub; models reused from
/// the spike dir when present). Resumable across runs via the .part design.
#[tokio::test]
#[ignore = "real downloads (33 MB engine) + GPU; run with --ignored"]
async fn real_download_extract_and_start_reaches_ready() {
    let app_data = temp_root("real-download");
    let state = Arc::new(NativeEngineState::new());
    *state.startup_timeout_base.lock().unwrap() = Duration::from_secs(45);
    let noop = |_: pdftoolkit_lib::native_engine::download::ProgressFrame| {};

    // Engine: the REAL manifest pin — download + extract + marker.
    let n = pdftoolkit_lib::native_engine::flow::download_kind(
        &state.downloads,
        pdftoolkit_lib::native_engine::store::Kind::Engine,
        &app_data,
        &noop,
        &CancellationToken::new(),
    )
    .await
    .expect("engine download+install");
    println!("ENGINE installed ({n} bytes)");

    // Models: reuse the spike dir's GGUFs when present (saves 1.4 GB).
    let engine_key = pdftoolkit_lib::native_engine::manifest::target_engine_key();
    let engine_dir = pdftoolkit_lib::native_engine::store::engine_dir(&app_data, engine_key);
    let model_dir = pdftoolkit_lib::native_engine::store::model_dir(&app_data);
    std::fs::create_dir_all(&model_dir).unwrap();
    let spike =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../temp/native-engine-spike");
    for f in ["GLM-OCR-Q8_0.gguf", "mmproj-GLM-OCR-Q8_0.gguf"] {
        let dest = model_dir.join(f);
        if !dest.is_file() && std::fs::copy(spike.join(f), &dest).is_ok() {
            println!("MODEL {f} reused from spike dir");
        }
    }
    let model_start = std::time::Instant::now();
    let mn = pdftoolkit_lib::native_engine::flow::download_kind(
        &state.downloads,
        pdftoolkit_lib::native_engine::store::Kind::Model,
        &app_data,
        &noop,
        &CancellationToken::new(),
    )
    .await
    .expect("model download");
    println!(
        "MODEL ready ({mn} bytes, {} s)",
        model_start.elapsed().as_secs()
    );

    // Start the REAL engine from the freshly extracted dir → Ready.
    let paths = pdftoolkit_lib::native_engine::EnginePaths {
        engine_exe: engine_dir.join(pdftoolkit_lib::native_engine::install::SERVER_BINARY),
        engine_dir,
        model: model_dir.join("GLM-OCR-Q8_0.gguf"),
        mmproj: model_dir.join("mmproj-GLM-OCR-Q8_0.gguf"),
    };
    let phase = pdftoolkit_lib::native_engine::supervisor::start(state.clone(), paths, true, None)
        .await
        .expect("freshly-installed engine must reach Ready");
    println!("PHASE {phase:?}");
    shutdown_all(&state).await;
}

fn temp_root(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("pdftk-real-{tag}-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&d);
    d
}
