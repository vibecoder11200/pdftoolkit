// Test-only scripted child (R2 non-functional, phase 2 step 2): the debug
// app binary routes here from main() when NATIVE_ENGINE_FAKE_CHILD is set —
// the supervisor (tests only) injects that env var, so production
// llama-server never sees it and release builds compile this out.
//
// Scripts (the env value): healthy | http200-dead | slow-then-ready |
// exit1-oom | exit1-loadfail | ggml-assert | hang | sigkill-no-stderr |
// loader-error. Any invocation with `--version` prints a pinned-looking
// version line and exits 0 (the quarantine probe path).
#![cfg(debug_assertions)]

use std::io::{Read, Write};

const VERSION_LINE: &str = "version: 0.6.0-fake (build 11553, commit fake)";

pub fn run_scripted_main() -> i32 {
    let script = std::env::var("NATIVE_ENGINE_FAKE_CHILD").unwrap_or_default();
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") || args.iter().any(|a| a == "--list-devices") {
        if args.iter().any(|a| a == "--list-devices") {
            println!("Available devices:");
            println!("  Vulkan0: Fake GPU 4096 MiB (4096 MiB, 4096 MiB free)");
        } else {
            println!("{VERSION_LINE}");
        }
        return 0;
    }
    match script.as_str() {
        "healthy" => healthy(),
        "http200-dead" => http200_dead(),
        "slow-then-ready" => {
            // Progress lines at 1 s intervals — liveness anchoring keeps the
            // handshake alive past the base timeout in the dedicated test.
            for i in 0..2 {
                eprintln!("load_model: loading progress {i}");
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
            healthy()
        }
        "exit1-oom" => {
            eprintln!("llama_model_load_from_file_impl: failed to allocate tensor: out of memory");
            1
        }
        "exit1-loadfail" => {
            eprintln!("llama_model_load: error loading model: unknown model architecture: 'nope'");
            1
        }
        "ggml-assert" => {
            eprintln!("GGML_ASSERT: /src/ggml.c:100: fake assertion failed");
            std::process::abort();
        }
        "hang" => {
            // Listener up, /health permanently 503 — exercises StartTimeout.
            serve_forever_unready();
            0
        }
        "sigkill-no-stderr" => {
            #[cfg(unix)]
            unsafe {
                libc::kill(libc::getpid(), libc::SIGKILL);
                unreachable!()
            }
            #[cfg(not(unix))]
            std::process::exit(137);
        }
        "loader-error" => {
            eprintln!("./llama-server: version `GLIBC_2.38' not found (required by ./libllama-server-impl.so)");
            1
        }
        other => {
            eprintln!("fake_child: unknown script {other:?}");
            2
        }
    }
}

fn key_ok(req_head: &str) -> bool {
    let expected = format!(
        "Bearer {}",
        std::env::var("LLAMA_API_KEY").unwrap_or_default()
    );
    req_head
        .lines()
        .any(|l| l.eq_ignore_ascii_case(&format!("authorization: {expected}")))
}

fn respond(stream: &mut std::net::TcpStream, status: &str, body: &str) {
    let resp = format!("HTTP/1.0 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

/// Serves /health (503 for the first 300 ms, then 200) and the AUTHENTICATED
/// /props (401 without the bearer; 200 with it) — the integration-grade
/// handshake target. Blocks until killed.
fn healthy() -> i32 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    eprintln!("load_tensors: offloading output layer to GPU");
    eprintln!("load_tensors: offloaded 18/18 layers to GPU");
    eprintln!("using device Vulkan1 (Fake GPU 4096 MiB) (0000:00:00.0) - 4096 MiB free");
    println!("listening on http://127.0.0.1:{port}");
    let t0 = std::time::Instant::now();
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
            }
        }
        let head = String::from_utf8_lossy(&buf).into_owned();
        let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
        if path.starts_with("/health") {
            if t0.elapsed() < std::time::Duration::from_millis(300) {
                respond(
                    &mut stream,
                    "503 Service Unavailable",
                    r#"{"error":{"message":"Loading model"}}"#,
                );
            } else {
                respond(&mut stream, "200 OK", r#"{"status":"ok"}"#);
            }
        } else if path.starts_with("/props") {
            if key_ok(&head) {
                respond(
                    &mut stream,
                    "200 OK",
                    r#"{"build_info":"b11553-fake","model_path":"fake.gguf"}"#,
                );
            } else {
                respond(&mut stream, "401 Unauthorized", r#"{"error":{}}"#);
            }
        } else {
            respond(&mut stream, "404 Not Found", "{}");
        }
    }
    0
}

/// Serves /health 200 then EXITS — a health-200 from a dead child must be an
/// instant StartFailed, never Ready (review F15 TOCTOU).
fn http200_dead() -> i32 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    println!("listening on http://127.0.0.1:{port}");
    let (mut stream, _) = listener.accept().expect("accept");
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    respond(&mut stream, "200 OK", r#"{"status":"ok"}"#);
    7 // exit AFTER the 200 is flushed
}

fn serve_forever_unready() -> i32 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    println!("listening on http://127.0.0.1:{port}");
    let t0 = std::time::Instant::now();
    for mut stream in listener.incoming().flatten() {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
        respond(
            &mut stream,
            "503 Service Unavailable",
            r#"{"error":{"message":"Loading model"}}"#,
        );
        if t0.elapsed().as_secs() > 600 {
            return 0;
        }
    }
    0
}
