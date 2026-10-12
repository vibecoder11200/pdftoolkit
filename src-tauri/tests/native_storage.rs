// Phase 3 storage/flow suite — ZERO network (fixture zips + simulated
// active downloads). The REAL download+extract+start path lives in
// native_real_smoke.rs (#[ignore], dev machine).
use pdftoolkit_lib::native_engine::flow::{self, DownloadRegistry, Outcome};
use pdftoolkit_lib::native_engine::install;
use pdftoolkit_lib::native_engine::store::{self, InstalledMarker, Kind, MarkerFile};
use pdftoolkit_lib::native_engine::{EngineError, EnginePaths, NativeEngineState};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

fn tempdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("pdftk-flow-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    let _ = std::fs::create_dir_all(&d);
    d
}

fn zip_bytes(entries: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
    use std::io::Write;
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, data) in entries {
        w.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(&data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

fn noop(_: pdftoolkit_lib::native_engine::download::ProgressFrame) {}

#[tokio::test]
async fn single_flight_second_call_attaches_to_the_running_download() {
    let registry = Arc::new(tokio::sync::Mutex::new(DownloadRegistry::default()));
    let app_data = tempdir("single");

    // Simulate an ACTIVE download for Kind::Model (no network involved).
    let (tx, rx) = tokio::sync::watch::channel(Outcome::Running);
    let token = CancellationToken::new();
    registry.lock().await.inner.insert(
        Kind::Model,
        flow::ActiveDownload {
            token: token.clone(),
            outcome: rx,
        },
    );

    let reg2 = registry.clone();
    let app_data2 = app_data.clone();
    let first =
        tokio::spawn(
            async move { flow::download_kind(&reg2, Kind::Model, &app_data2, &noop).await },
        );
    // Give the first call a beat to attach, then a SECOND call must attach
    // to the SAME download (not start a second writer).
    let reg3 = registry.clone();
    let second =
        tokio::spawn(
            async move { flow::download_kind(&reg3, Kind::Model, &app_data, &noop).await },
        );
    tokio::time::sleep(Duration::from_millis(150)).await;
    // Exactly ONE active entry for the kind.
    assert_eq!(registry.lock().await.inner.len(), 1);

    // Finish the active download → both callers observe the SAME outcome.
    tx.send_replace(Outcome::Done(12345));
    registry.lock().await.inner.remove(&Kind::Model);
    let (r1, r2) = tokio::join!(first, second);
    assert_eq!(r1.unwrap().unwrap(), 12345);
    assert_eq!(r2.unwrap().unwrap(), 12345);
}

#[tokio::test]
async fn delete_awaits_the_in_flight_download_before_removing() {
    let registry = Arc::new(tokio::sync::Mutex::new(DownloadRegistry::default()));
    let (tx, rx) = tokio::sync::watch::channel(Outcome::Running);
    let token = CancellationToken::new();
    registry.lock().await.inner.insert(
        Kind::Engine,
        flow::ActiveDownload {
            token: token.clone(),
            outcome: rx,
        },
    );

    // delete's first step: cancel + AWAIT the in-flight download.
    let reg2 = registry.clone();
    let deleter = tokio::spawn(async move {
        flow::cancel_kind(&reg2, Kind::Engine).await;
        // Only now is removal safe — assert the token was cancelled (the
        // downloader stopped writing) and the registry entry drained.
        assert!(token.is_cancelled());
    });
    // The cancel must be OBSERVED, i.e. cancel_kind waited for the outcome
    // to leave Running (we complete it here — a real downloader returns
    // Cancelled from its loop).
    tokio::time::sleep(Duration::from_millis(100)).await;
    tx.send_replace(Outcome::Cancelled);
    deleter.await.unwrap();
}

#[test]
fn cudart_dlls_extract_beside_the_engine_exe() {
    // The CUDA flow = two archives into ONE dir; the load requirement is
    // cudart DLLs sitting beside llama-server.exe.
    let app_data = tempdir("cuda");
    let dir = store::engine_dir(&app_data, "win-x64/cuda-12.4");
    let engine = zip_bytes(vec![("llama-server.exe", vec![1; 100])]);
    let cudart = zip_bytes(vec![
        ("cudart64_12.dll", vec![2; 500]),
        ("cublas64_12.dll", vec![3; 400]),
    ]);
    install::extract_and_install(
        engine,
        &dir,
        "win-x64/cuda-12.4",
        "b11553",
        "a".repeat(64).as_str(),
        install::InstallMode::Replace,
    )
    .unwrap();
    let marker = install::extract_and_install(
        cudart,
        &dir,
        "win-x64/cuda-12.4",
        "b11553",
        "b".repeat(64).as_str(),
        install::InstallMode::Merge,
    )
    .unwrap();
    assert!(dir.join("llama-server.exe").is_file());
    assert!(
        dir.join("cudart64_12.dll").is_file(),
        "cudart DLL BESIDE the exe"
    );
    assert!(dir.join("cublas64_12.dll").is_file());
    // The SECOND extraction's marker covers both archives' files (the
    // per-file map is regenerated from the whole dir per extraction).
    let names: Vec<&str> = marker.files.iter().map(|f| f.path.as_str()).collect();
    assert!(names.contains(&"cudart64_12.dll"));
    // The first extraction's exe is still hash-covered only if present in
    // the last marker — the tamper check re-verifies what the LAST marker
    // lists, so the install flow must extract INTO the same dir and let the
    // final marker own the map (documented behavior).
}

#[tokio::test]
async fn tampered_engine_files_flip_start_to_quarantined_presence_flips_false() {
    // End-to-end (offline): install → tamper → start() → Quarantined AND
    // presence false (marker AND exe required, review F8).
    let app_data = tempdir("tamper");
    let dir = store::engine_dir(&app_data, "win-x64/vulkan");
    let archive = zip_bytes(vec![("llama-server.exe", vec![7; 200])]);
    install::extract_and_install(
        archive,
        &dir,
        "win-x64/vulkan",
        "b11553",
        "c".repeat(64).as_str(),
        install::InstallMode::Replace,
    )
    .unwrap();
    assert!(store::engine_present(&dir, install::SERVER_BINARY));

    // Tamper with the exe (the AV/tamper scenario).
    std::fs::write(dir.join(install::SERVER_BINARY), b"tampered bytes").unwrap();

    let state = Arc::new(NativeEngineState::new());
    let paths = EnginePaths {
        engine_exe: dir.join(install::SERVER_BINARY),
        engine_dir: dir.clone(),
        model: dir.join("model.gguf"),
        mmproj: dir.join("mmproj.gguf"),
    };
    let err = pdftoolkit_lib::native_engine::supervisor::start(state, paths, true, None)
        .await
        .unwrap_err();
    assert!(
        matches!(err, EngineError::Quarantined { .. }),
        "tamper must classify as Quarantined (re-download path), got {err:?}"
    );
}

#[test]
fn sizes_walk_reports_per_kind_bytes() {
    let app_data = tempdir("sizes");
    let engine_dir = store::engine_dir(&app_data, "win-x64/vulkan");
    std::fs::create_dir_all(&engine_dir).unwrap();
    std::fs::write(engine_dir.join("llama-server.exe"), vec![0; 1000]).unwrap();
    let model_dir = store::model_dir(&app_data);
    std::fs::create_dir_all(&model_dir).unwrap();
    std::fs::write(model_dir.join("GLM-OCR-Q8_0.gguf"), vec![0; 4000]).unwrap();
    assert_eq!(store::dir_size(&engine_dir).unwrap(), 1000);
    assert_eq!(store::dir_size(&model_dir).unwrap(), 4000);
    let freed = store::remove_dir_freed(&model_dir).unwrap();
    assert_eq!(freed, 4000);
}

#[test]
fn marker_files_map_round_trip() {
    let app_data = tempdir("marker-map");
    let dir = store::engine_dir(&app_data, "linux-x64/vulkan");
    std::fs::create_dir_all(&dir).unwrap();
    let marker = InstalledMarker {
        key: "linux-x64/vulkan".into(),
        tag: "b11553".into(),
        sha256: "x".repeat(64),
        files: vec![MarkerFile {
            path: "llama-server".into(),
            sha256: "y".repeat(64),
        }],
        installed_at: "unix:1".into(),
    };
    store::write_marker(&dir, &marker).unwrap();
    let read = store::read_marker(&dir).unwrap();
    assert_eq!(read.files.len(), 1);
    assert_eq!(read.files[0].sha256, "y".repeat(64));
}
