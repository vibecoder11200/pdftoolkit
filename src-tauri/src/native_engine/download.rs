// Streaming downloader (R3.1): reqwest → <dest>.part → sha256-while-write →
// atomic rename. Range resume across network drops AND across process
// generations (the hasher state is not serializable — the existing .part
// prefix is streamed through the hasher first, review F10; the "no second
// pass" property applies to the COMPLETED file only). A 200 answer to a
// Range request restarts cleanly — a lost partial, never corruption.
use super::store;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio_util::sync::CancellationToken;

/// Progress frames (R4.1) — shaped for the JS `DownloadProgress` mapping
/// (phase, loaded, total, percent).
#[derive(Debug, Clone, Serialize)]
pub struct ProgressFrame {
    pub phase: String,
    pub loaded: u64,
    pub total: u64,
    pub percent: f64,
}

#[derive(Debug)]
pub enum DownloadError {
    Cancelled,
    HashMismatch { expected: String, got: String },
    InsufficientDisk { needed: u64, free: u64 },
    Network(String),
    Io(std::io::Error),
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DownloadError::Cancelled => write!(f, "download cancelled"),
            DownloadError::HashMismatch { expected, got } => {
                write!(f, "sha256 mismatch: expected {expected}, got {got}")
            }
            DownloadError::InsufficientDisk { needed, free } => {
                write!(
                    f,
                    "insufficient disk: need {needed} free bytes, have {free}"
                )
            }
            DownloadError::Network(s) => write!(f, "network: {s}"),
            DownloadError::Io(e) => write!(f, "io: {e}"),
        }
    }
}

/// Minimum free-bytes headroom before any download (plan: totalBytes +
/// 512 MB).
pub const DISK_HEADROOM: u64 = 512 * 1024 * 1024;

fn sha256_hex(hash: &Sha256) -> String {
    let digest = hash.clone().finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn file_sha256(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash)?;
    Ok(sha256_hex(&hash))
}

/// Hash a completed file (used by the model flow's marker + tests).
pub(crate) fn sha_of_file(path: &Path) -> std::io::Result<String> {
    file_sha256(path)
}

/// Progress callback: invoked at most every 250 ms or every 4 MiB.
pub struct ProgressGate {
    last_time: std::time::Instant,
    last_bytes: u64,
}

impl ProgressGate {
    pub fn new() -> Self {
        Self {
            last_time: std::time::Instant::now(),
            last_bytes: 0,
        }
    }
    pub fn ready(&mut self, loaded: u64) -> bool {
        loaded - self.last_bytes >= 4 * 1024 * 1024
            || self.last_time.elapsed() >= std::time::Duration::from_millis(250)
    }
    pub fn sent(&mut self, loaded: u64) {
        self.last_bytes = loaded;
        self.last_time = std::time::Instant::now();
    }
}

impl Default for ProgressGate {
    fn default() -> Self {
        Self::new()
    }
}

/// Download `url` → `dest` (via `<dest>.part`), verifying sha256.
/// Returns bytes on disk (verified). Idempotent: an already-verified `dest`
/// short-circuits (the marker flow reuses it).
#[allow(clippy::too_many_arguments)]
pub async fn download_file(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    expected_sha256: &str,
    known_total: Option<u64>,
    on_progress: &(dyn Fn(ProgressFrame) + Send + Sync),
    token: &CancellationToken,
) -> Result<u64, DownloadError> {
    let Some(parent) = dest.parent() else {
        return Err(DownloadError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination has no parent",
        )));
    };
    std::fs::create_dir_all(parent).map_err(DownloadError::Io)?;

    // Idempotent fast path.
    if dest.is_file() {
        if let Ok(got) = file_sha256(dest) {
            if got == expected_sha256 {
                let total =
                    known_total.unwrap_or_else(|| dest.metadata().map(|m| m.len()).unwrap_or(0));
                on_progress(ProgressFrame {
                    phase: "done".into(),
                    loaded: total,
                    total,
                    percent: 100.0,
                });
                return Ok(total);
            }
        }
        // Corrupt completed file → remove, fall through to a fresh download.
        let _ = std::fs::remove_file(dest);
    }

    // Disk preflight BEFORE any bytes are written.
    if let Some(total) = known_total {
        let need = total + DISK_HEADROOM;
        let free = store::free_space(parent).map_err(DownloadError::Io)?;
        if free < need {
            return Err(DownloadError::InsufficientDisk { needed: need, free });
        }
    }

    let part = dest.with_extension("part");
    let mut resumed = 0u64;
    let mut hash = Sha256::new();
    if part.is_file() {
        let part_len = part.metadata().map(|m| m.len()).unwrap_or(0);
        if let Some(total) = known_total {
            if part_len > total {
                // Truncated/reset metadata — a stale part is not resumable.
                let _ = std::fs::remove_file(&part);
            }
        }
        if part.is_file() {
            // F10: stream the existing prefix through the hasher so the
            // final digest covers the WHOLE file (no post-completion pass).
            let mut f = std::fs::File::open(&part).map_err(DownloadError::Io)?;
            std::io::copy(&mut f, &mut hash).map_err(DownloadError::Io)?;
            resumed = part_len;
        }
    }

    let mut request = client.get(url);
    if resumed > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={resumed}-"));
    }
    let response = request
        .send()
        .await
        .map_err(|e| DownloadError::Network(e.to_string()))?;
    let status = response.status();

    if resumed > 0 && status == reqwest::StatusCode::OK {
        // Server ignored the Range — restart from zero (delete part).
        let _ = std::fs::remove_file(&part);
        hash = Sha256::new();
        resumed = 0;
    } else if resumed > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(DownloadError::Network(format!(
            "unexpected status {status} for a ranged resume"
        )));
    } else if resumed == 0 && !status.is_success() {
        return Err(DownloadError::Network(format!("HTTP {status} for {url}")));
    }

    let total: u64 = response
        .content_length()
        .map(|len| len + resumed)
        .or(known_total)
        .unwrap_or(0);

    let mut part_file = if resumed > 0 {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .await
            .map_err(DownloadError::Io)?
    } else {
        tokio::fs::File::create(&part)
            .await
            .map_err(DownloadError::Io)?
    };

    let mut response = response;
    let mut loaded = resumed;
    let mut gate = ProgressGate::new();
    use tokio::io::AsyncWriteExt;
    loop {
        tokio::select! {
            _ = token.cancelled() => {
                // Leave the .part — resume across process lifetimes (R3).
                let _ = part_file.flush().await;
                return Err(DownloadError::Cancelled);
            }
            chunk = response.chunk() => {
                let Some(chunk) = chunk.map_err(|e| DownloadError::Network(e.to_string()))? else { break };
                part_file.write_all(&chunk).await.map_err(DownloadError::Io)?;
                hash.update(&chunk);
                loaded += chunk.len() as u64;
                if gate.ready(loaded) {
                    gate.sent(loaded);
                    on_progress(ProgressFrame {
                        phase: "downloading".into(),
                        loaded,
                        total,
                        percent: if total > 0 { loaded as f64 / total as f64 * 100.0 } else { 0.0 },
                    });
                }
            }
        }
    }
    part_file.flush().await.map_err(DownloadError::Io)?;
    drop(part_file);

    // Verify BEFORE the rename — a mismatch never becomes a completed file.
    let got = sha256_hex(&hash);
    if got != expected_sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(DownloadError::HashMismatch {
            expected: expected_sha256.into(),
            got,
        });
    }
    std::fs::rename(&part, dest).map_err(DownloadError::Io)?;
    on_progress(ProgressFrame {
        phase: "done".into(),
        loaded,
        total,
        percent: 100.0,
    });
    Ok(loaded)
}

#[cfg(test)]
pub(crate) mod test_support {
    /// Fixture HTTP server (R3 non-functional): serves a known buffer;
    /// configurable Range honoring (for the 200-to-a-Range-request restart
    /// path), mid-stream drops, and a per-chunk delay that makes
    /// cancel/drop races deterministic. Returns (port, join_handle).
    pub struct FixtureConfig {
        pub fail: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        pub honor_range: bool,
        pub delay_ms: u64,
    }

    pub fn fixture_server(
        body: std::sync::Arc<Vec<u8>>,
        cfg: FixtureConfig,
    ) -> (u16, tokio::task::JoinHandle<()>) {
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        std_listener.set_nonblocking(true).unwrap();
        let port = std_listener.local_addr().unwrap().port();
        let listener = tokio::net::TcpListener::from_std(std_listener).unwrap();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                let body = body.clone();
                let fail = cfg.fail.clone();
                let honor_range = cfg.honor_range;
                let delay = std::time::Duration::from_millis(cfg.delay_ms);
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let mut stream = stream;
                    loop {
                        use tokio::io::AsyncReadExt;
                        match stream.read(&mut chunk).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                buf.extend_from_slice(&chunk[..n]);
                                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                    break;
                                }
                            }
                        }
                    }
                    let head = String::from_utf8_lossy(&buf);
                    let range = head
                        .lines()
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            k.eq_ignore_ascii_case("range")
                                .then(|| v.trim().to_string())
                        })
                        .unwrap_or_default();
                    let (status, start) = if honor_range && range.starts_with("bytes=") {
                        let start: u64 = range["bytes=".len()..]
                            .split('-')
                            .next()
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(0);
                        (
                            "206 Partial Content".to_string(),
                            start.min(body.len() as u64),
                        )
                    } else {
                        ("200 OK".to_string(), 0)
                    };
                    let slice = &body[start as usize..];
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                        slice.len()
                    );
                    use tokio::io::AsyncWriteExt;
                    if stream.write_all(resp.as_bytes()).await.is_err() {
                        return;
                    }
                    if fail.fetch_sub(1, std::sync::atomic::Ordering::SeqCst) > 0 {
                        // Drop mid-stream (after 10 bytes) — resume test.
                        let _ = stream.write_all(&slice[..10.min(slice.len())]).await;
                        let _ = stream.flush().await;
                        return;
                    }
                    for c in slice.chunks(4096) {
                        if stream.write_all(c).await.is_err() {
                            return;
                        }
                        if !delay.is_zero() {
                            tokio::time::sleep(delay).await;
                        }
                    }
                    let _ = stream.flush().await;
                });
            }
        });
        (port, handle)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn client() -> reqwest::Client {
        reqwest::Client::builder().build().unwrap()
    }

    fn tempdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pdftk-dl-{tag}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    fn noop(_: ProgressFrame) {}

    /// Common fixture: honors Range, no artificial delay, `fail` drops.
    fn fx(body: Vec<u8>, fail: usize) -> (u16, tokio::task::JoinHandle<()>) {
        fixture_server(
            std::sync::Arc::new(body),
            FixtureConfig {
                fail: std::sync::Arc::new(AtomicUsize::new(fail)),
                honor_range: true,
                delay_ms: 0,
            },
        )
    }

    fn sha_of(bytes: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(bytes);
        sha256_hex(&h)
    }

    #[tokio::test]
    async fn happy_path_downloads_and_verifies() {
        let body: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        let url = format!("http://127.0.0.1:{}/x.bin", fx(body.clone(), 0).0);
        let dest = tempdir("happy").join("x.bin");
        let n = download_file(
            &client(),
            &url,
            &dest,
            &sha_of(&body),
            Some(body.len() as u64),
            &noop,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(n as usize, body.len());
        assert_eq!(file_sha256(&dest).unwrap(), sha_of(&body));
        assert!(!dest.with_extension("part").exists(), "part renamed away");
    }

    #[tokio::test]
    async fn resume_after_midstream_drop_and_across_generations_hashes_the_whole_file() {
        let body: Vec<u8> = (0..300_000u32).map(|i| (i % 253) as u8).collect();
        let sha = sha_of(&body);
        let dir = tempdir("resume");
        let dest = dir.join("m.bin");
        let part = dest.with_extension("part");

        // Generation 1: server drops the connection mid-stream.
        let (port, _srv) = fx(body.clone(), 1);
        let url = format!("http://127.0.0.1:{port}/m.bin");
        let result = download_file(
            &client(),
            &url,
            &dest,
            &sha,
            Some(body.len() as u64),
            &noop,
            &CancellationToken::new(),
        )
        .await;
        assert!(
            matches!(result, Err(DownloadError::Network(_))),
            "got {result:?}"
        );
        assert!(part.is_file(), "partial remains resumable");

        // Generation 2: downloader state dropped + re-created around the
        // same .part — the final hash must equal the manifest sha256 (F10).
        let (port2, _srv2) = fx(body.clone(), 0);
        let url2 = format!("http://127.0.0.1:{port2}/m.bin");
        let n = download_file(
            &client(),
            &url2,
            &dest,
            &sha,
            Some(body.len() as u64),
            &noop,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(n as usize, body.len());
        assert_eq!(file_sha256(&dest).unwrap(), sha);
    }

    #[tokio::test]
    async fn cancel_mid_stream_leaves_a_resumable_part() {
        let body: Vec<u8> = (0..3_000_000u32).map(|i| (i % 7) as u8).collect();
        let (port, _srv) = fixture_server(
            std::sync::Arc::new(body.clone()),
            FixtureConfig {
                fail: std::sync::Arc::new(AtomicUsize::new(0)),
                honor_range: true,
                // 4096-byte chunk every 20 ms — the 3 MB body needs ~15 s,
                // so the 150 ms cancel lands deterministically mid-stream.
                delay_ms: 20,
            },
        );
        let url = format!("http://127.0.0.1:{port}/c.bin");
        let dest = tempdir("cancel").join("c.bin");
        let token = CancellationToken::new();
        let t2 = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            t2.cancel();
        });
        let result = download_file(
            &client(),
            &url,
            &dest,
            &sha_of(&body),
            Some(body.len() as u64),
            &noop,
            &token,
        )
        .await;
        assert!(matches!(result, Err(DownloadError::Cancelled)));
        assert!(
            dest.with_extension("part").is_file(),
            "part survives for resume"
        );
    }

    #[tokio::test]
    async fn server_ignoring_range_restarts_from_zero() {
        // A server that answers 200 to a Range request must not corrupt the
        // file: the downloader restarts cleanly (lost partial, never bad
        // bytes). honor_range=false + a pre-seeded junk part drives the
        // 200-to-Range branch; the observable contract is the successful
        // full-hash verification of bytes 0..len.
        let body: Vec<u8> = vec![9u8; 50_000];
        let (port, _srv) = fixture_server(
            std::sync::Arc::new(body.clone()),
            FixtureConfig {
                fail: std::sync::Arc::new(AtomicUsize::new(0)),
                honor_range: false,
                delay_ms: 0,
            },
        );
        let url = format!("http://127.0.0.1:{port}/r.bin");
        let dir = tempdir("range");
        let dest = dir.join("r.bin");
        std::fs::write(dest.with_extension("part"), [1u8; 1000]).unwrap();
        let n = download_file(
            &client(),
            &url,
            &dest,
            &sha_of(&body),
            Some(body.len() as u64),
            &noop,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(n as usize, body.len());
        assert_eq!(file_sha256(&dest).unwrap(), sha_of(&body));
    }

    #[tokio::test]
    async fn hash_mismatch_destroys_the_part_and_classifies() {
        let body: Vec<u8> = vec![1u8; 10_000];
        let (port, _srv) = fx(body.clone(), 0);
        let url = format!("http://127.0.0.1:{port}/h.bin");
        let dest = tempdir("mismatch").join("h.bin");
        let result = download_file(
            &client(),
            &url,
            &dest,
            &[0u8; 64].map(|b| format!("{b:02x}")).join(""),
            Some(body.len() as u64),
            &noop,
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        match result {
            DownloadError::HashMismatch { got, .. } => assert_eq!(got, sha_of(&body)),
            other => panic!("expected HashMismatch, got {other:?}"),
        }
        assert!(
            !dest.with_extension("part").exists(),
            "mismatched part destroyed"
        );
        assert!(!dest.exists(), "mismatch never becomes a completed file");
    }

    #[tokio::test]
    async fn disk_preflight_refuses_before_any_bytes() {
        let body = vec![0u8; 100];
        let (port, _srv) = fx(body.clone(), 0);
        let url = format!("http://127.0.0.1:{port}/d.bin");
        let dest = tempdir("preflight").join("d.bin");
        // A known_total of u64::MAX cannot fit any drive → InsufficientDisk.
        let result = download_file(
            &client(),
            &url,
            &dest,
            &sha_of(&body),
            Some(u64::MAX / 2),
            &noop,
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(result, DownloadError::InsufficientDisk { .. }),
            "got {result:?}"
        );
        assert!(
            !dest.with_extension("part").exists(),
            "no bytes written before preflight fails"
        );
    }

    #[tokio::test]
    async fn completed_verified_file_short_circuits_idempotently() {
        let body = vec![3u8; 2048];
        let dir = tempdir("idem");
        let dest = dir.join("i.bin");
        std::fs::write(&dest, &body).unwrap();
        let (port, _srv) = fx(body.clone(), 0);
        let url = format!("http://127.0.0.1:{port}/i.bin");
        let phases = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let p2 = phases.clone();
        let n = download_file(
            &client(),
            &url,
            &dest,
            &sha_of(&body),
            Some(body.len() as u64),
            &move |f| {
                p2.lock().unwrap().push(f.phase);
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(n as usize, body.len());
        assert_eq!(
            *phases.lock().unwrap(),
            vec!["done".to_string()],
            "no network needed"
        );
    }
}
