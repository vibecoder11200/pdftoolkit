// OCR proxy (R4.2) — the ONLY consumer of the sidecar API token. The
// webview never fetches the sidecar (contract: CSP stays byte-identical);
// every page raster crosses IPC exactly once (canvas PNG dataURL, R4.3),
// and tokens stream back as ~40 ms batched Channel frames. Each frame
// carries `tokenDelta` because the web `onToken` fires PER TOKEN and the
// client-side counter must sum the batched counts (review F4).
//
// Parity reference LOCKED in phase 1 (golden-page matrix, review F3):
// prompt below + 1024px long edge (the raster happens JS-side at
// AI_DPI=150; this module never rescales). `temperature: 0` was
// spike-verified. The empty-content → `reasoning_format: "none"` retry
// is llama.cpp quirk #20248 (one retry — the ipc layer owns it).
use serde::Serialize;
use tokio_util::sync::CancellationToken;

pub const MAX_IMAGE_DATAURL_BYTES: usize = 16 * 1024 * 1024;
pub const IMAGE_DATAURI_PREFIX: &str = "data:image/png;base64,";
/// LOCKED parity reference prompt (phase 1 golden-page matrix — webmd cell).
pub const OCR_PROMPT: &str =
    "Convert this document page to markdown. Preserve headings and tables. Keep Vietnamese diacritics.";
pub const DEFAULT_MAX_TOKENS: u32 = 4096;
/// Frame batching window (R4.2) — plan Risk 1's first tuning knob.
pub const FRAME_INTERVAL_MS: u64 = 40;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenFrame {
    pub delta: String,
    pub token_delta: u32,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPageResult {
    pub text: String,
    pub ms: u64,
    pub first_token_ms: u64,
    pub gen_tokens: u32,
    pub tok_per_sec: f64,
}

#[derive(Debug)]
pub enum OcrError {
    /// Engine not in Ready (no port to proxy to).
    NotReady,
    /// Payload validation failure (review M2) — rejected BEFORE any
    /// serde-heavy forwarding.
    BadPayload(&'static str),
    Cancelled,
    Network(String),
}

impl std::fmt::Display for OcrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OcrError::NotReady => write!(f, "engine is not ready"),
            OcrError::BadPayload(why) => write!(f, "image payload rejected: {why}"),
            OcrError::Cancelled => write!(f, "page cancelled"),
            OcrError::Network(s) => write!(f, "engine http: {s}"),
        }
    }
}

/// R4.2/M2 validation: exact PNG data-URI prefix, ≤ 16 MB. The request
/// build forwards the data-URI VERBATIM — no Rust-side re-encoding.
pub fn validate_payload(image_data_url: &str) -> Result<(), OcrError> {
    if image_data_url.len() > MAX_IMAGE_DATAURL_BYTES {
        return Err(OcrError::BadPayload("payload exceeds 16 MB"));
    }
    if !image_data_url.starts_with(IMAGE_DATAURI_PREFIX) {
        return Err(OcrError::BadPayload("must be a PNG data URI"));
    }
    Ok(())
}

/// One chat-completions call. `reasoning_none` sets
/// `reasoning_format: "none"` (the empty-content retry path).
#[allow(clippy::too_many_arguments)]
pub async fn ocr_request(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    image_data_url: &str,
    prompt: &str,
    max_tokens: u32,
    reasoning_none: bool,
    on_frame: &(dyn Fn(TokenFrame) + Send + Sync),
    cancel: &CancellationToken,
) -> Result<OcrPageResult, OcrError> {
    validate_payload(image_data_url)?;
    let started = std::time::Instant::now();

    let mut body = serde_json::json!({
        "model": "glm-ocr",
        "stream": true,
        "temperature": 0,
        "max_tokens": max_tokens,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_data_url}}
            ]
        }]
    });
    if reasoning_none {
        body["reasoning_format"] = serde_json::json!("none");
    }

    let url = format!("{base_url}/v1/chat/completions");
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err(OcrError::Cancelled),
        r = client
            .post(&url)
            .bearer_auth(api_key)
            .json(&body)
            .send() =>
    {
        r.map_err(|e| OcrError::Network(e.to_string()))?
    }
    };
    if !response.status().is_success() {
        return Err(OcrError::Network(format!("HTTP {}", response.status())));
    }

    let mut text = String::new();
    let mut first_token_ms: Option<u64> = None;
    let mut total_tokens: u32 = 0;
    let mut pending = String::new();
    let mut pending_tokens: u32 = 0;
    let mut last_flush = std::time::Instant::now();
    // BYTES, not a String: SSE chunks can split a multi-byte UTF-8 code
    // point mid-character; lossy conversion happens per COMPLETE line only
    // (the '\n' delimiter is ASCII, so a line never splits a code point).
    let mut sse_buf: Vec<u8> = Vec::new();
    let mut response = response;
    let mut done = false;

    loop {
        let Some(bytes) = tokio::select! (
            _ = cancel.cancelled() => return Err(OcrError::Cancelled),
            r = response.chunk() => {
                r.map_err(|e| OcrError::Network(e.to_string()))?
            }
        ) else {
            break;
        };
        sse_buf.extend_from_slice(&bytes);
        while let Some(pos) = sse_buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = sse_buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line[..line.len() - 1]);
            let line = line.trim_end_matches('\r');
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                done = true;
                break;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            let Some(delta) = v
                .pointer("/choices/0/delta/content")
                .and_then(|c| c.as_str())
            else {
                continue;
            };
            if delta.is_empty() {
                continue;
            }
            if first_token_ms.is_none() {
                first_token_ms = Some(started.elapsed().as_millis() as u64);
            }
            pending.push_str(delta);
            pending_tokens += 1;
            if last_flush.elapsed().as_millis() as u64 >= FRAME_INTERVAL_MS {
                text.push_str(&pending);
                total_tokens += pending_tokens;
                on_frame(TokenFrame {
                    delta: std::mem::take(&mut pending),
                    token_delta: std::mem::take(&mut pending_tokens),
                    done: false,
                });
                last_flush = std::time::Instant::now();
            }
        }
        if done {
            break;
        }
    }
    if !pending.is_empty() || pending_tokens > 0 {
        text.push_str(&pending);
        total_tokens += pending_tokens;
        on_frame(TokenFrame {
            delta: std::mem::take(&mut pending),
            token_delta: std::mem::take(&mut pending_tokens),
            done: false,
        });
    }

    let ms = started.elapsed().as_millis() as u64;
    Ok(OcrPageResult {
        text,
        ms,
        first_token_ms: first_token_ms.unwrap_or(ms),
        gen_tokens: total_tokens,
        tok_per_sec: if ms > 0 {
            total_tokens as f64 / (ms as f64 / 1000.0)
        } else {
            0.0
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpStream;

    fn client() -> reqwest::Client {
        reqwest::Client::builder().build().unwrap()
    }

    /// Drain one HTTP request: read the header block, then exactly
    /// content-length body bytes (the client never half-closes — reading
    /// until EOF would hang the fixture).
    async fn read_request(stream: &mut TcpStream) -> String {
        let mut raw: Vec<u8> = Vec::new();
        let mut buf = [0u8; 16384];
        let head_end = loop {
            let n = stream.read(&mut buf).await.unwrap();
            if n == 0 {
                return String::from_utf8_lossy(&raw).into_owned();
            }
            raw.extend_from_slice(&buf[..n]);
            if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                break pos + 4;
            }
        };
        let head = String::from_utf8_lossy(&raw[..head_end]).to_lowercase();
        let content_length: usize = head
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0);
        let goal = head_end + content_length;
        while raw.len() < goal {
            let n = stream.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            raw.extend_from_slice(&buf[..n]);
        }
        String::from_utf8_lossy(&raw).into_owned()
    }

    /// Canned-SSE fixture server: serves `chunks` as `data:` lines with a
    /// delay between writes. `empty_content` blanks the deltas (quirk
    /// #20248 fixture). Returns (port, request counter).
    fn sse_server(
        chunks: Vec<serde_json::Value>,
        delay_ms: u64,
        empty_content: bool,
    ) -> (u16, Arc<AtomicUsize>) {
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = std_listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits2 = hits.clone();
        std_listener.set_nonblocking(true).unwrap();
        let listener = tokio::net::TcpListener::from_std(std_listener).unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    continue;
                };
                hits2.fetch_add(1, Ordering::SeqCst);
                let chunks = chunks.clone();
                let empty = empty_content;
                let delay = std::time::Duration::from_millis(delay_ms);
                tokio::spawn(async move {
                    let _head = read_request(&mut stream).await;
                    let mut body = String::new();
                    for c in &chunks {
                        let mut c = c.clone();
                        if empty {
                            c["choices"][0]["delta"]["content"] = serde_json::json!("");
                        }
                        body.push_str(&format!("data: {}\n\n", c));
                    }
                    body.push_str("data: [DONE]\n\n");
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    use tokio::io::AsyncWriteExt;
                    if stream.write_all(head.as_bytes()).await.is_err() {
                        return;
                    }
                    for part in body.as_bytes().chunks(24) {
                        if stream.write_all(part).await.is_err() {
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
        (port, hits)
    }

    fn collector() -> (
        Arc<Mutex<Vec<TokenFrame>>>,
        impl Fn(TokenFrame) + Send + Sync + Clone,
    ) {
        let frames: Arc<Mutex<Vec<TokenFrame>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = frames.clone();
        let cb = move |f: TokenFrame| sink.lock().unwrap().push(f);
        (frames, cb)
    }

    fn delta(content: &str) -> serde_json::Value {
        serde_json::json!({
            "choices": [{"delta": {"content": content}}]
        })
    }

    fn png_dataurl() -> String {
        format!("{IMAGE_DATAURI_PREFIX}aGVsbG8=")
    }

    #[tokio::test]
    async fn happy_path_streams_frames_and_returns_result() {
        let (port, _hits) = sse_server(
            vec![delta("# Tiêu"), delta(" đề"), delta("\n\nBảng.")],
            15,
            false,
        );
        let (frames, cb) = collector();
        let r = ocr_request(
            &client(),
            &format!("http://127.0.0.1:{port}"),
            "tok",
            &png_dataurl(),
            OCR_PROMPT,
            DEFAULT_MAX_TOKENS,
            false,
            &cb,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(r.text, "# Tiêu đề\n\nBảng.");
        assert_eq!(r.gen_tokens, 3);
        assert!(r.first_token_ms <= r.ms);
        assert!(r.tok_per_sec > 0.0);
        let frames = frames.lock().unwrap();
        assert!(
            frames.iter().all(|f| !f.done),
            "done is carried by the RESULT, never a terminal frame"
        );
        let total: u32 = frames.iter().map(|f| f.token_delta).sum();
        assert_eq!(total, 3, "tokenDelta sums to the token count (F4)");
        let joined: String = frames.iter().map(|f| f.delta.as_str()).collect();
        assert_eq!(joined, r.text);
    }

    #[tokio::test]
    async fn payload_validation_rejects_non_png_and_oversize() {
        for bad in [
            "data:image/jpeg;base64,AAA",
            "http://127.0.0.1/x.png",
            "data:image/png,jpeg-in-disguise",
        ] {
            let err = ocr_request(
                &client(),
                "http://127.0.0.1:1",
                "t",
                bad,
                OCR_PROMPT,
                0,
                false,
                &|_| {},
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert!(matches!(err, OcrError::BadPayload(_)), "got {err:?}");
        }
        let huge = format!("{}{}", IMAGE_DATAURI_PREFIX, "A".repeat(17 * 1024 * 1024));
        let err = ocr_request(
            &client(),
            "http://127.0.0.1:1",
            "t",
            &huge,
            OCR_PROMPT,
            0,
            false,
            &|_| {},
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, OcrError::BadPayload("payload exceeds 16 MB")));
    }

    #[tokio::test]
    async fn empty_content_marks_the_quirk_for_the_retry_path() {
        // text == "" after done — the ipc layer retries ONCE with
        // reasoning_format none (this fixture is what that retry consumes).
        let (port, hits) = sse_server(vec![delta("# x")], 1, true);
        let r = ocr_request(
            &client(),
            &format!("http://127.0.0.1:{port}"),
            "tok",
            &png_dataurl(),
            OCR_PROMPT,
            DEFAULT_MAX_TOKENS,
            false,
            &|_| {},
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(r.text, "");
        assert_eq!(r.gen_tokens, 0);
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "the retry lives in ipc, not here"
        );
    }

    #[tokio::test]
    async fn cancel_mid_stream_returns_cancelled() {
        let big: Vec<serde_json::Value> = (0..400).map(|i| delta(&format!("t{i} "))).collect();
        let (port, _hits) = sse_server(big, 5, false);
        let token = CancellationToken::new();
        let t2 = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
            t2.cancel();
        });
        let r = ocr_request(
            &client(),
            &format!("http://127.0.0.1:{port}"),
            "tok",
            &png_dataurl(),
            OCR_PROMPT,
            DEFAULT_MAX_TOKENS,
            false,
            &|_| {},
            &token,
        )
        .await
        .unwrap_err();
        assert!(matches!(r, OcrError::Cancelled));
    }

    #[tokio::test]
    async fn http_error_surfaces_as_network() {
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = std_listener.local_addr().unwrap().port();
        std_listener.set_nonblocking(true).unwrap();
        let listener = tokio::net::TcpListener::from_std(std_listener).unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    continue;
                };
                tokio::spawn(async move {
                    use tokio::io::AsyncWriteExt;
                    let _head = read_request(&mut stream).await;
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .await;
                });
            }
        });
        let r = ocr_request(
            &client(),
            &format!("http://127.0.0.1:{port}"),
            "tok",
            &png_dataurl(),
            OCR_PROMPT,
            DEFAULT_MAX_TOKENS,
            false,
            &|_| {},
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert!(matches!(r, OcrError::Network(s) if s.contains("500")));
    }

    #[tokio::test]
    async fn dataurl_crosses_the_wire_verbatim() {
        // Echo the request body back through the SSE content so the
        // assertion runs against what the server actually received.
        let expected = png_dataurl();
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = std_listener.local_addr().unwrap().port();
        std_listener.set_nonblocking(true).unwrap();
        let listener = tokio::net::TcpListener::from_std(std_listener).unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    continue;
                };
                let expected = expected.clone();
                tokio::spawn(async move {
                    use tokio::io::AsyncWriteExt;
                    let raw = read_request(&mut stream).await;
                    let echoed = if raw.contains(&expected) {
                        "VERBATIM"
                    } else {
                        "MANGLED"
                    };
                    let payload = format!("data: {}\n\ndata: [DONE]\n\n", delta(echoed));
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        payload.len()
                    );
                    let _ = stream.write_all(head.as_bytes()).await;
                    let _ = stream.write_all(payload.as_bytes()).await;
                });
            }
        });
        let r = ocr_request(
            &client(),
            &format!("http://127.0.0.1:{port}"),
            "tok",
            &png_dataurl(),
            OCR_PROMPT,
            DEFAULT_MAX_TOKENS,
            false,
            &|_| {},
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(r.text, "VERBATIM", "data URI crossed byte-identical");
    }

    #[test]
    fn prompt_is_the_locked_parity_reference() {
        assert_eq!(
            OCR_PROMPT,
            "Convert this document page to markdown. Preserve headings and tables. Keep Vietnamese diacritics."
        );
    }
}
