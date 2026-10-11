// Kind-orchestrated acquisition (R3.3/R3.4 + review F9): engine / cuda /
// model downloads with SINGLE-FLIGHT per kind — a second caller attaches to
// the in-flight download's progress and outcome instead of racing on the
// same .part. `delete(kind)` first cancels + AWAITS the in-flight download
// before removing files (the Windows delete-pending race, review F9).
use super::download::{self, DownloadError, ProgressFrame};
use super::install;
use super::manifest::manifest;
use super::store::{self, Kind};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// Outcome of one in-flight download, watched by every attacher.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Running,
    Done(u64),
    Failed(String),
    Cancelled,
}

#[derive(Default)]
pub struct DownloadRegistry {
    /// kind → in-flight download. Tests drive this directly to simulate
    /// active downloads without network.
    pub inner: HashMap<Kind, ActiveDownload>,
}

pub struct ActiveDownload {
    pub token: CancellationToken,
    pub outcome: watch::Receiver<Outcome>,
}

impl DownloadRegistry {
    pub fn active(&self, kind: Kind) -> Option<Arc<ActiveDownload>> {
        self.inner.get(&kind).map(|a| {
            Arc::new(ActiveDownload {
                token: a.token.clone(),
                outcome: a.outcome.clone(),
            })
        })
    }
}

fn shared_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().build().expect("reqwest client"))
}

/// Download + install one kind. A second call while one is running attaches
/// to it (same outcome; no second writer, review F9).
pub async fn download_kind(
    registry: &tokio::sync::Mutex<DownloadRegistry>,
    kind: Kind,
    app_local_data_dir: &std::path::Path,
    on_frame: &(dyn Fn(ProgressFrame) + Send + Sync),
    external_cancel: &CancellationToken,
) -> Result<u64, String> {
    // Single-flight: attach if one is already running for this kind.
    {
        let reg = registry.lock().await;
        if let Some(active) = reg.active(kind) {
            let mut rx = active.outcome.clone();
            drop(reg);
            loop {
                if matches!(*rx.borrow(), Outcome::Running) {
                    if rx.changed().await.is_err() {
                        return Err("download watcher dropped".into());
                    }
                } else {
                    break;
                }
            }
            return match rx.borrow().clone() {
                Outcome::Done(n) => Ok(n),
                Outcome::Failed(e) => Err(e),
                Outcome::Cancelled => Err("download cancelled".into()),
                Outcome::Running => Err("download state confused".into()),
            };
        }
    }

    let token = CancellationToken::new();
    // External cancel (native_cancel) flips the ACTIVE download's token too.
    let ext = external_cancel.clone();
    let linked = CancellationToken::new();
    tokio::spawn({
        let linked = linked.clone();
        async move {
            tokio::select! {
                _ = ext.cancelled() => linked.cancel(),
                _ = linked.cancelled() => {}
            }
        }
    });

    let (tx, rx) = watch::channel(Outcome::Running);
    let mut reg = registry.lock().await;
    // Re-check under the lock (two callers may race past the first check).
    if let Some(active) = reg.active(kind) {
        drop(reg);
        let mut rx2 = active.outcome.clone();
        loop {
            if matches!(*rx2.borrow(), Outcome::Running) {
                if rx2.changed().await.is_err() {
                    return Err("download watcher dropped".into());
                }
            } else {
                break;
            }
        }
        return match rx2.borrow().clone() {
            Outcome::Done(n) => Ok(n),
            Outcome::Failed(e) => Err(e),
            Outcome::Cancelled => Err("download cancelled".into()),
            Outcome::Running => Err("download state confused".into()),
        };
    }
    reg.inner.insert(
        kind,
        ActiveDownload {
            token: linked.clone(),
            outcome: rx.clone(),
        },
    );
    drop(reg);

    let result = run_kind(kind, app_local_data_dir, on_frame, &linked).await;
    let outcome = match &result {
        Ok(n) => Outcome::Done(*n),
        Err(DownloadError::Cancelled) => Outcome::Cancelled,
        Err(e) => Outcome::Failed(e.to_string()),
    };
    tx.send_replace(outcome);
    registry.lock().await.inner.remove(&kind);
    // Keep the linked token alive in the registry only while running; the
    // external link task ends when either side cancels.
    let _ = token; // per-call token unused beyond linkage clarity
    result.map_err(|e| e.to_string())
}

/// Cancel + AWAIT the in-flight download of `kind` (delete's first step,
/// review F9).
pub async fn cancel_kind(registry: &tokio::sync::Mutex<DownloadRegistry>, kind: Kind) {
    let active = {
        let reg = registry.lock().await;
        reg.active(kind)
    };
    if let Some(active) = active {
        active.token.cancel();
        let mut rx = active.outcome.clone();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        while matches!(*rx.borrow(), Outcome::Running) {
            if tokio::time::Instant::now() > deadline {
                return; // bounded — the .part rename can't wedge forever
            }
            if rx.changed().await.is_err() {
                break;
            }
        }
    }
}

async fn run_kind(
    kind: Kind,
    app_local_data_dir: &std::path::Path,
    on_frame: &(dyn Fn(ProgressFrame) + Send + Sync),
    token: &CancellationToken,
) -> Result<u64, DownloadError> {
    let m = manifest();
    match kind {
        Kind::Engine => {
            let key = super::manifest::target_engine_key();
            let pin = m
                .engines
                .get(key)
                .ok_or_else(|| DownloadError::Network(format!("no engine pin for {key}")))?;
            let dir = store::engine_dir(app_local_data_dir, key);
            let archive = dir.join(format!("{}.zip", pin.sha256.get(..8).unwrap_or("engine")));
            let bytes = download_to_vec(
                &pin.url,
                &archive,
                &pin.sha256,
                pin.size_bytes,
                on_frame,
                token,
            )
            .await?;
            install::extract_and_install(
                bytes,
                &dir,
                key,
                &m.llama_tag,
                &pin.sha256,
                install::InstallMode::Replace,
            )
            .map_err(|e| DownloadError::Io(std::io::Error::other(e.to_string())))?;
            let _ = std::fs::remove_file(&archive); // extracted; archive no longer needed
            Ok(pin.size_bytes)
        }
        Kind::Cuda => {
            let key = "win-x64/cuda-12.4";
            let extra_key = "win-x64/cudart-12.4";
            let engine_pin = m
                .engines
                .get(key)
                .ok_or_else(|| DownloadError::Network("no cuda engine pin".into()))?;
            let cudart_pin = m
                .extras
                .get(extra_key)
                .ok_or_else(|| DownloadError::Network("no cudart pin".into()))?;
            let dir = store::engine_dir(app_local_data_dir, key);
            let engine_archive = dir.join(format!(
                "engine-{}.zip",
                engine_pin.sha256.get(..8).unwrap_or("")
            ));
            let engine_bytes = download_to_vec(
                &engine_pin.url,
                &engine_archive,
                &engine_pin.sha256,
                engine_pin.size_bytes,
                on_frame,
                token,
            )
            .await?;
            install::extract_and_install(
                engine_bytes,
                &dir,
                key,
                &m.llama_tag,
                &engine_pin.sha256,
                install::InstallMode::Replace,
            )
            .map_err(|e| DownloadError::Io(std::io::Error::other(e.to_string())))?;
            // cudart DLLs extract BESIDE the exe (release-notes layout).
            let cudart_archive = dir.join(format!(
                "cudart-{}.zip",
                cudart_pin.sha256.get(..8).unwrap_or("")
            ));
            let cudart_bytes = download_to_vec(
                &cudart_pin.url,
                &cudart_archive,
                &cudart_pin.sha256,
                cudart_pin.size_bytes,
                on_frame,
                token,
            )
            .await?;
            install::extract_and_install(
                cudart_bytes,
                &dir,
                key,
                &m.llama_tag,
                &cudart_pin.sha256,
                install::InstallMode::Merge,
            )
            .map_err(|e| DownloadError::Io(std::io::Error::other(e.to_string())))?;
            let _ = std::fs::remove_file(&engine_archive);
            let _ = std::fs::remove_file(&cudart_archive);
            Ok(engine_pin.size_bytes + cudart_pin.size_bytes)
        }
        Kind::Model => {
            let dir = store::model_dir(app_local_data_dir);
            std::fs::create_dir_all(&dir).map_err(DownloadError::Io)?;
            let mut total = 0u64;
            let mut marker_files = Vec::new();
            // SEQUENTIAL (R3.4): one resume UI, single retry surface.
            for pin in &m.model.files {
                let dest = dir.join(&pin.path);
                let n = download::download_file(
                    shared_client(),
                    &format!(
                        "https://huggingface.co/{}/resolve/{}/{}",
                        m.model.repo, m.model.revision, pin.path
                    ),
                    &dest,
                    &pin.sha256,
                    Some(pin.size_bytes),
                    on_frame,
                    token,
                )
                .await?;
                let sha = download::sha_of_file(&dest).map_err(DownloadError::Io)?;
                marker_files.push(store::MarkerFile {
                    path: pin.path.clone(),
                    sha256: sha,
                });
                total += n;
            }
            store::write_marker(
                &dir,
                &store::InstalledMarker {
                    key: "model/GLM-OCR".into(),
                    tag: m.model.revision.clone(),
                    sha256: m
                        .model
                        .files
                        .iter()
                        .map(|f| f.sha256.clone())
                        .collect::<Vec<_>>()
                        .join(""),
                    files: marker_files,
                    installed_at: "model".into(),
                },
            )
            .map_err(DownloadError::Io)?;
            Ok(total)
        }
    }
}

/// Download to a staging file then read back the bytes for extraction
/// (archives are ≤ ~400 MB — memory is acceptable; models stream to disk
/// directly and never take this path).
async fn download_to_vec(
    url: &str,
    staging: &PathBuf,
    sha: &str,
    total: u64,
    on_frame: &(dyn Fn(ProgressFrame) + Send + Sync),
    token: &CancellationToken,
) -> Result<Vec<u8>, DownloadError> {
    let bytes_on_disk = download::download_file(
        shared_client(),
        url,
        staging,
        sha,
        Some(total),
        on_frame,
        token,
    )
    .await?;
    let _ = bytes_on_disk;
    std::fs::read(staging).map_err(DownloadError::Io)
}
