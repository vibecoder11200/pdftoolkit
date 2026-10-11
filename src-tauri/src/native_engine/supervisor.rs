// Supervisor core (R2.1–R2.7): spawn → handshake (authenticated ready) →
// monitor → classify → bounded restart → idle shutdown → orphan-proof
// teardown. The executable path is a parameter so tests inject the fake
// child; production resolves it through the store (phase 3).
use super::*;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::watch;

/// What `start()` and the session task agree on. Broadcast on every phase
/// transition so command callers can await a specific outcome.
#[derive(Debug, Clone)]
pub enum PhaseEvent {
    Ready {
        pid: u32,
        port: u16,
        status: EngineStatus,
    },
    Terminal(EnginePhase),
}

// ------------------------------ spawn layer -------------------------------

struct Spawned {
    child: tokio::process::Child,
    stdout: Option<BufReader<tokio::process::ChildStdout>>,
    stderr: Option<tokio::process::ChildStderr>,
    pid: u32,
    #[cfg(windows)]
    job_handle: isize,
}

fn spawn_engine(
    paths: &EnginePaths,
    api_key: &str,
    fake_script: Option<&str>,
) -> Result<Spawned, EngineError> {
    let exe_str = paths.engine_exe.to_string_lossy().into_owned();
    let mut cmd = tokio::process::Command::new(&paths.engine_exe);
    cmd.arg("-m")
        .arg(paths.model.to_string_lossy().as_ref())
        .arg("--mmproj")
        .arg(paths.mmproj.to_string_lossy().as_ref())
        .args(SERVER_ARGS_TAIL.iter())
        .env("LLAMA_API_KEY", api_key)
        .env(CHILD_MARKER_ENV, "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // Test injection (fake_child.rs): the supervised exe is the app's own
    // debug binary routed to the scripted child main by this env. Production
    // passes None and the real llama-server never sees the variable.
    if let Some(script) = fake_script {
        cmd.env("NATIVE_ENGINE_FAKE_CHILD", script);
    }

    #[cfg(windows)]
    {
        cmd.creation_flags(win_job::CREATE_SUSPENDED | win_job::CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    unix_group::child_in_new_process_group(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(EngineError::Quarantined { path: exe_str });
        }
        Err(e) => return Err(EngineError::Spawn(e.to_string())),
    };

    #[cfg(windows)]
    {
        // Suspended → assign → resume. Assign failure: kill the STILL
        // SUSPENDED child and abort — never resume unprotected (review F6).
        let job = win_job::create_kill_on_close_job()
            .ok_or_else(|| EngineError::Spawn("CreateJobObjectW failed".into()))?;
        let handle = child
            .raw_handle()
            .map(|h| h as isize)
            .ok_or_else(|| EngineError::Spawn("no child handle".into()))?;
        if !win_job::assign_process(job, handle) {
            win_job::close_handle(job);
            let _ = child.start_kill();
            return Err(EngineError::Spawn(format!(
                "AssignProcessToJobObject failed — refusing to resume unprotected engine ({exe_str})"
            )));
        }
        let pid = child.id().unwrap_or(0);
        if !win_job::resume_first_thread(pid) {
            win_job::terminate_job(job);
            win_job::close_handle(job);
            let _ = child.start_kill();
            return Err(EngineError::Spawn(
                "ResumeThread failed on suspended engine".into(),
            ));
        }
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| EngineError::Spawn("no stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| EngineError::Spawn("no stderr".into()))?;
        Ok(Spawned {
            child,
            stdout: Some(BufReader::new(stdout)),
            stderr: Some(stderr),
            pid,
            job_handle: job,
        })
    }
    #[cfg(unix)]
    {
        let pid = child.id().unwrap_or(0);
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| EngineError::Spawn("no stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| EngineError::Spawn("no stderr".into()))?;
        Ok(Spawned {
            child,
            stdout: Some(BufReader::new(stdout)),
            stderr: Some(stderr),
            pid,
        })
    }
}

// --------------------------- stdout/stderr parse --------------------------

#[derive(Default)]
struct StdParse {
    port: Option<u16>,
    backend: Backend,
    devices: Vec<String>,
    gpu_layers_offloaded: Option<(u32, u32)>,
    last_line_at: Option<std::time::Instant>,
    stderr_tail: VecDeque<String>,
}

fn parse_listening_port(line: &str) -> Option<u16> {
    const NEEDLE: &str = "listening on http://127.0.0.1:";
    let idx = line.find(NEEDLE)? + NEEDLE.len();
    let digits: String = line[idx..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// Engagement lines at b11553 (spike §5.4; the old `ggml_vulkan:` banner is
/// gone — parse the `using device Vulkan1 (name)` INFO line instead).
fn parse_device_line(line: &str) -> Option<(Backend, String)> {
    const NEEDLE: &str = "using device ";
    let idx = line.find(NEEDLE)? + NEEDLE.len();
    let rest = &line[idx..];
    let (token, tail) = match rest.find([' ', '(']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let (backend, _len) = if let Some(r) = token.strip_prefix("Vulkan") {
        (Backend::Vulkan, r.len())
    } else if let Some(r) = token.strip_prefix("CUDA") {
        (Backend::Cuda, r.len())
    } else if token == "Metal" {
        (Backend::Metal, 0)
    } else {
        return None;
    };
    // Device name = first parenthesised group after the token.
    let name = tail
        .split_once('(')
        .and_then(|(_, after)| after.split(')').next())
        .unwrap_or(token)
        .trim()
        .to_string();
    Some((backend, name))
}

fn parse_offload_line(line: &str) -> Option<(u32, u32)> {
    const NEEDLE: &str = "offloaded ";
    let idx = line.find(NEEDLE)? + NEEDLE.len();
    let mut nums = line[idx..]
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .map(str::parse::<u32>)
        .take(2);
    let offloaded = nums.next()?.ok()?;
    let total = nums.next()?.ok()?;
    Some((offloaded, total))
}

fn record_line(parse: &Mutex<StdParse>, is_stderr: bool, line: &str) {
    let mut p = parse.lock().unwrap();
    p.last_line_at = Some(std::time::Instant::now());
    // b11553 prints EVERYTHING (listening, device, offload lines) on stderr —
    // parse engagement signals from BOTH streams (spike §5.4).
    if let Some(port) = parse_listening_port(line) {
        p.port = Some(port);
    }
    if let Some((backend, name)) = parse_device_line(line) {
        if !p.devices.iter().any(|d| d == &name) {
            p.devices.push(name);
        }
        if p.backend == Backend::Unknown || p.backend == Backend::Cpu {
            p.backend = backend;
        }
    }
    if let Some((off, total)) = parse_offload_line(line) {
        p.gpu_layers_offloaded = Some((off, total));
    }
    if is_stderr {
        if p.stderr_tail.len() >= 50 {
            p.stderr_tail.pop_front();
        }
        p.stderr_tail.push_back(line.to_string());
    }
}

fn drain_lines<R>(
    mut reader: BufReader<R>,
    parse: Arc<Mutex<StdParse>>,
    is_stderr: bool,
) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buf = Vec::with_capacity(4096);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf);
                    let line = line.trim_end_matches(['\n', '\r']);
                    record_line(&parse, is_stderr, line);
                }
            }
        }
    })
}

// ------------------------------- HTTP probe -------------------------------

/// Minimal raw HTTP GET (HTTP/1.0 → no chunked bodies to parse). Returns
/// (status, body). Used for /health (public progress signal) and the
/// AUTHENTICATED /props ownership probe (review F15).
async fn http_probe(port: u16, path: &str, bearer: Option<&str>) -> Option<(u16, String)> {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .ok()?;
    let req = format!(
        "GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n{}\r\nConnection: close\r\n\r\n",
        bearer
            .map(|b| format!("Authorization: Bearer {b}\r\n"))
            .unwrap_or_default(),
    );
    stream.write_all(req.as_bytes()).await.ok()?;
    let mut buf = Vec::new();
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        stream.read_to_end(&mut buf),
    );
    match read.await {
        Ok(Ok(_)) => {}
        _ => return None,
    }
    let text = String::from_utf8_lossy(&buf);
    let status: u16 = text.split_whitespace().nth(1)?.parse().ok()?;
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    Some((status, body))
}

// ------------------------------ classification ----------------------------

const OOM_KEYWORDS: &[&str] = &[
    "out of memory",
    "failed to allocate",
    "cuda error",
    "vulkan device lost",
    "out_of_memory",
];
const LOADER_KEYWORDS: &[&str] = &[
    "glibc_",
    "cannot open shared object file",
    "image not found", // macOS dyld
];

fn tail_contains(tail: &VecDeque<String>, needles: &[&str]) -> bool {
    let joined = tail
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    needles.iter().any(|n| joined.contains(n))
}

/// Phase-aware classification (spike 5.9): on Windows a FORCED KILL is exit
/// code 1 with an empty tail — indistinguishable from a load failure by code
/// alone. Exit DURING startup → load-failure classes; exit AFTER Ready →
/// `Crashed` regardless of code.
fn classify_startup_exit(
    status: &std::process::ExitStatus,
    tail: &VecDeque<String>,
) -> EngineError {
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    #[cfg(unix)]
    if let Some(sig) = status.signal() {
        if sig == libc::SIGKILL && tail.is_empty() {
            return EngineError::BlockedByOs;
        }
        return EngineError::Crashed(-sig);
    }
    let code = status.code().unwrap_or(-1);
    if tail_contains(tail, LOADER_KEYWORDS) {
        let detail = tail
            .iter()
            .find(|l| {
                l.to_lowercase().contains("glibc")
                    || l.to_lowercase().contains("shared object")
                    || l.to_lowercase().contains("image not found")
            })
            .cloned()
            .unwrap_or_default();
        return EngineError::OsTooOld(detail);
    }
    if tail_contains(tail, OOM_KEYWORDS) {
        return EngineError::Oom;
    }
    if tail_contains(tail, &["ggml_assert", "backend error"]) {
        let detail = tail
            .iter()
            .find(|l| {
                l.to_lowercase().contains("ggml_assert")
                    || l.to_lowercase().contains("backend error")
            })
            .cloned()
            .unwrap_or_default();
        return EngineError::BackendFault(detail);
    }
    if code == 0 {
        return EngineError::LoadFailed("engine exited cleanly during startup".into());
    }
    // The stderr tail rides along — it is the UI's diagnostic and the only
    // way to tell a load failure from a flag/bind failure at a glance.
    let tail: Vec<String> = tail.iter().rev().take(5).rev().cloned().collect();
    EngineError::LoadFailed(if tail.is_empty() {
        format!("exit code {code} (no stderr)")
    } else {
        format!("exit code {code}: {}", tail.join(" | "))
    })
}

fn classify_running_exit(status: &std::process::ExitStatus) -> EngineError {
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    #[cfg(unix)]
    if let Some(sig) = status.signal() {
        return EngineError::Crashed(-sig);
    }
    EngineError::Crashed(status.code().unwrap_or(-1))
}

/// Quarantine probe (R2.4): `--version` at EVERY start, result never cached.
/// Detects ONLY that the OS removed/blocked the binary — its stdout is NOT
/// tamper evidence (that is phase 3's per-file hash map).
fn quarantine_probe(paths: &EnginePaths, fake_script: Option<&str>) -> Result<(), EngineError> {
    let mut cmd = std::process::Command::new(&paths.engine_exe);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(script) = fake_script {
        cmd.env("NATIVE_ENGINE_FAKE_CHILD", script);
    }
    let out = cmd.output();
    match out {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(EngineError::Quarantined {
            path: paths.engine_exe.to_string_lossy().into_owned(),
        }),
        Err(e) => Err(EngineError::Spawn(format!("--version probe: {e}"))),
        Ok(out) if !out.status.success() => {
            let stderr = String::from_utf8_lossy(&out.stderr).to_lowercase();
            if stderr.contains("glibc")
                || stderr.contains("shared object")
                || stderr.contains("image not found")
            {
                Err(EngineError::OsTooOld(
                    String::from_utf8_lossy(&out.stderr)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .to_string(),
                ))
            } else if out.stderr.is_empty() && out.stdout.is_empty() {
                // Ran and died silently (SAC DLL block / macOS SIGKILL).
                Err(EngineError::Quarantined {
                    path: paths.engine_exe.to_string_lossy().into_owned(),
                })
            } else {
                Err(EngineError::Quarantined {
                    path: paths.engine_exe.to_string_lossy().into_owned(),
                })
            }
        }
        Ok(_) => Ok(()),
    }
}

/// One-shot device probe (R2.3 / R4.1 `native_engine_probe`): spawn the
/// engine with `--list-devices`, collect the `VulkanN: name` lines, exit
/// code 0 required. Result is CACHED by the ipc caller until the next
/// install — this is diagnostics, never a gating path.
pub fn probe_devices(paths: &EnginePaths, fake_script: Option<&str>) -> Vec<String> {
    let mut cmd = std::process::Command::new(&paths.engine_exe);
    cmd.arg("--list-devices")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(script) = fake_script {
        cmd.env("NATIVE_ENGINE_FAKE_CHILD", script);
    }
    let Ok(out) = cmd.output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            (l.contains(':') && !l.is_empty()).then(|| l.to_string())
        })
        .filter(|l| !l.starts_with("Available devices"))
        .collect()
}

// ------------------------------ session task ------------------------------

struct StartOutcome {
    child: tokio::process::Child,
    pid: u32,
    port: u16,
    status: EngineStatus,
    #[cfg(windows)]
    job_handle: isize,
}

async fn spawn_and_handshake(
    paths: &EnginePaths,
    api_key: &str,
    wants_gpu: bool,
    token: &tokio_util::sync::CancellationToken,
    fake_script: Option<&str>,
    startup_timeout_base: std::time::Duration,
) -> Result<StartOutcome, Box<(Option<tokio::process::Child>, EngineError)>> {
    quarantine_probe(paths, fake_script).map_err(|e| Box::new((None, e)))?;

    let mut spawned = spawn_engine(paths, api_key, fake_script).map_err(|e| Box::new((None, e)))?;
    let parse: Arc<Mutex<StdParse>> = Arc::new(Mutex::new(StdParse {
        backend: Backend::Unknown,
        ..Default::default()
    }));
    let Some(stdout) = spawned.stdout.take() else {
        let _ = spawned.child.start_kill();
        return Err(Box::new((
            Some(spawned.child),
            EngineError::Spawn("stdout already taken".into()),
        )));
    };
    let Some(stderr) = spawned.stderr.take() else {
        let _ = spawned.child.start_kill();
        return Err(Box::new((
            Some(spawned.child),
            EngineError::Spawn("stderr already taken".into()),
        )));
    };
    let _stdout_task = drain_lines(stdout, parse.clone(), false);
    let _stderr_task = drain_lines(BufReader::new(stderr), parse.clone(), true);

    let started = std::time::Instant::now();
    loop {
        tokio::select! {
            _ = token.cancelled() => {
                let _ = spawned.child.start_kill();
                return Err(Box::new((Some(spawned.child), EngineError::Spawn("shutdown requested".into()))));
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {}
        }
        // Child died during startup → classify from code + stderr tail.
        match spawned.child.try_wait() {
            Ok(Some(status)) => {
                let tail = parse.lock().unwrap().stderr_tail.clone();
                return Err(Box::new((
                    Some(spawned.child),
                    classify_startup_exit(&status, &tail),
                )));
            }
            Ok(None) => {}
            Err(e) => {
                return Err(Box::new((
                    Some(spawned.child),
                    EngineError::Spawn(e.to_string()),
                )))
            }
        }
        // Liveness-anchored deadline (review M4): any stdout/stderr line
        // re-arms the base timeout, bounded by the hard cap.
        let (last_line, port) = {
            let p = parse.lock().unwrap();
            (p.last_line_at, p.port)
        };
        let base = last_line
            .unwrap_or(started)
            .checked_add(startup_timeout_base)
            .unwrap_or_else(|| std::time::Instant::now() + startup_timeout_base);
        let deadline = base.min(started + STARTUP_TIMEOUT_HARD_CAP);
        if std::time::Instant::now() > deadline {
            let _ = spawned.child.start_kill();
            return Err(Box::new((Some(spawned.child), EngineError::StartTimeout)));
        }
        let Some(port) = port else { continue };

        // /health 200 = PROGRESS ONLY (public endpoint — TOCTOU per F15).
        let Some((health_status, _)) = http_probe(port, "/health", None).await else {
            continue;
        };
        if health_status != 200 {
            continue;
        }
        // Ownership proof: authenticated /props + the pinned tag + the child
        // STILL alive. A 200 from a dead child or a foreign server is an
        // instant StartFailed, never Ready.
        let props = http_probe(port, "/props", Some(api_key)).await;
        if spawned.child.try_wait().ok().flatten().is_some() {
            return Err(Box::new((
                Some(spawned.child),
                EngineError::LoadFailed(
                    "engine exited between /health and the authenticated probe".into(),
                ),
            )));
        }
        let Some((props_status, props_body)) = props else {
            return Err(Box::new((
                Some(spawned.child),
                EngineError::LoadFailed("authenticated probe failed on a health-200 port".into()),
            )));
        };
        if props_status != 200 || !props_body.contains(PINNED_LLAMA_TAG) {
            return Err(Box::new((
                Some(spawned.child),
                EngineError::LoadFailed(format!(
                "port ownership probe failed (HTTP {props_status}, foreign or wrong-version server)"
            )),
            )));
        }
        let p = parse.lock().unwrap();
        let mut backend = p.backend;
        let mut devices = p.devices.clone();
        if let Some((off, _total)) = p.gpu_layers_offloaded {
            if off == 0 {
                backend = Backend::Cpu;
                devices.clear();
            }
        }
        if backend == Backend::Unknown && p.gpu_layers_offloaded.is_none() {
            backend = Backend::Cpu;
        }
        let cpu_fallback = wants_gpu && backend == Backend::Cpu;
        drop(p);
        return Ok(StartOutcome {
            child: spawned.child,
            pid: spawned.pid,
            port,
            status: EngineStatus {
                backend,
                devices,
                cpu_fallback,
            },
            #[cfg(windows)]
            job_handle: spawned.job_handle,
        });
    }
}

fn record_crash(state: &NativeEngineState) -> bool {
    let mut times = state.crash_times.lock().unwrap();
    let now = std::time::Instant::now();
    times.retain(|t| now.duration_since(*t) < RESTART_BUDGET_WINDOW);
    times.push(now);
    times.len() > RESTART_BUDGET_MAX
}

pub fn clear_restart_budget(state: &NativeEngineState) {
    state.crash_times.lock().unwrap().clear();
    *state.startup_retries.lock().unwrap() = 0;
}

/// One long-lived supervision session (spawn → monitor → restart loop).
/// Runs until Dead, user stop, or shutdown token.
async fn session(
    state: Arc<NativeEngineState>,
    paths: EnginePaths,
    wants_gpu: bool,
    fake_script: Option<String>,
    events: watch::Sender<Option<PhaseEvent>>,
    done: Arc<AtomicBool>,
) {
    loop {
        let token = state.shutdown.lock().unwrap().clone();
        let api_key = generate_api_key();
        *state.api_key.lock().unwrap() = Some(api_key.clone());

        let startup_timeout = *state.startup_timeout_base.lock().unwrap();
        match spawn_and_handshake(
            &paths,
            &api_key,
            wants_gpu,
            &token,
            fake_script.as_deref(),
            startup_timeout,
        )
        .await
        {
            Ok(outcome) => {
                #[cfg(windows)]
                {
                    *ACTIVE_CHILD.lock().unwrap() = Some(ActiveChild {
                        pid: outcome.pid,
                        job_handle: outcome.job_handle,
                    });
                }
                #[cfg(unix)]
                {
                    *ACTIVE_CHILD.lock().unwrap() = Some(ActiveChild {
                        pid: outcome.pid,
                        pgid: outcome.pid as libc::pid_t,
                    });
                }
                *state.status.lock().unwrap() = Some(outcome.status.clone());
                events.send_replace(Some(PhaseEvent::Ready {
                    pid: outcome.pid,
                    port: outcome.port,
                    status: outcome.status.clone(),
                }));
                {
                    let mut phase = state.phase.lock().unwrap();
                    *phase = EnginePhase::Ready {
                        pid: outcome.pid,
                        port: outcome.port,
                        status: outcome.status,
                    };
                }
                rearm_idle_timer(&state);

                // Monitor: any exit not requested by us is a crash.
                let mut child = outcome.child;
                let exit = tokio::select! {
                    _ = token.cancelled() => {
                        graceful_kill(&mut child).await;
                        None
                    }
                    status = child.wait() => match status {
                        Ok(st) => Some(classify_running_exit(&st)),
                        Err(_) => Some(EngineError::Crashed(-1)),
                    },
                };
                #[cfg(windows)]
                {
                    // Job termination is the actual reaper on Windows; close
                    // our job handle afterwards (kill-on-close already fired
                    // or was triggered explicitly).
                    if let Some(active) = ACTIVE_CHILD.lock().unwrap().take() {
                        if exit.is_none() {
                            win_job::terminate_job(active.job_handle);
                        }
                        win_job::close_handle(active.job_handle);
                    }
                }
                #[cfg(unix)]
                {
                    let _ = ACTIVE_CHILD.lock().unwrap().take();
                }
                let Some(cause) = exit else {
                    // Requested stop / shutdown.
                    let mut phase = state.phase.lock().unwrap();
                    *phase = EnginePhase::Stopped;
                    events.send_replace(Some(PhaseEvent::Terminal(EnginePhase::Stopped)));
                    break;
                };
                *state.last_error.lock().unwrap() = Some(cause.clone());
                if record_crash(&state) {
                    // Clone under the lock — the send_replace below would
                    // re-lock a non-reentrant Mutex and deadlock the
                    // supervisor (found by the crash-budget test).
                    let snapshot = {
                        let mut phase = state.phase.lock().unwrap();
                        *phase = EnginePhase::Dead { cause };
                        phase.clone()
                    };
                    events.send_replace(Some(PhaseEvent::Terminal(snapshot)));
                    break;
                }
                let mut phase = state.phase.lock().unwrap();
                *phase = EnginePhase::Starting {
                    since: std::time::Instant::now(),
                };
                drop(phase);
                continue;
            }
            Err(boxed) => {
                let (mut child, err) = *boxed;
                if let Some(c) = child.as_mut() {
                    let _ = c.start_kill();
                    let _ = c.wait().await;
                }
                // Shutdown request masquerading as a spawn error — not a
                // failure at all.
                if token.is_cancelled() {
                    let mut phase = state.phase.lock().unwrap();
                    *phase = EnginePhase::Stopped;
                    events.send_replace(Some(PhaseEvent::Terminal(EnginePhase::Stopped)));
                    break;
                }
                let startup_class = matches!(
                    err,
                    EngineError::Spawn(_)
                        | EngineError::StartTimeout
                        | EngineError::Quarantined { .. }
                        | EngineError::BlockedByOs
                        | EngineError::OsTooOld(_)
                        | EngineError::LoadFailed(_)
                        | EngineError::Oom
                        | EngineError::BackendFault(_)
                );
                *state.last_error.lock().unwrap() = Some(err.clone());
                let retriable = startup_class
                    && !matches!(
                        err,
                        EngineError::Quarantined { .. }
                            | EngineError::BlockedByOs
                            | EngineError::OsTooOld(_)
                    );
                if retriable {
                    let mut retries = state.startup_retries.lock().unwrap();
                    if *retries < STARTUP_RETRY_MAX {
                        *retries += 1;
                        drop(retries);
                        let mut phase = state.phase.lock().unwrap();
                        *phase = EnginePhase::Starting {
                            since: std::time::Instant::now(),
                        };
                        drop(phase);
                        continue;
                    }
                }
                let mut phase = state.phase.lock().unwrap();
                *phase = EnginePhase::Dead { cause: err };
                let snapshot = phase.clone();
                events.send_replace(Some(PhaseEvent::Terminal(snapshot)));
                break;
            }
        }
    }
    done.store(true, Ordering::SeqCst);
}

async fn graceful_kill(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    {
        // SIGTERM to the group (llama.cpp handles it), then escalate.
        if let Some(pid) = child.id() {
            unix_group::terminate_group_graceful(pid as libc::pid_t).await;
        }
        let _ = child.start_kill();
    }
    #[cfg(windows)]
    {
        // No /shutdown endpoint, no deliverable console event (research §1).
        let _ = child.start_kill();
    }
}

// ------------------------------- public API -------------------------------

/// User/operator entry (R4.7's `native_engine_start` builds on this):
/// idempotent when Ready/Starting; a start from Dead CLEARS the budget.
/// `fake_script` is test-only (see `fake_child.rs`).
pub async fn start(
    state: Arc<NativeEngineState>,
    paths: EnginePaths,
    wants_gpu: bool,
    fake_script: Option<String>,
) -> Result<EnginePhase, EngineError> {
    {
        let phase = state.phase.lock().unwrap().clone();
        match phase {
            EnginePhase::Ready { .. } | EnginePhase::Starting { .. } => return Ok(phase),
            EnginePhase::VersionChecking => return Ok(phase),
            EnginePhase::Stopping => {
                return Err(EngineError::Spawn(
                    "engine is stopping — retry in a moment".into(),
                ))
            }
            EnginePhase::Dead { .. } | EnginePhase::Stopped | EnginePhase::NotInstalled => {}
        }
    }
    if !paths.engine_exe.is_file() {
        return Err(EngineError::Quarantined {
            path: paths.engine_exe.to_string_lossy().into_owned(),
        });
    }
    // Per-file tamper check (review F8, R3.2): when an install marker with a
    // per-file sha256 map exists, EVERY start re-verifies the on-disk files
    // (cheap: ~35 MB engine). A mismatch means the engine was altered or
    // partially removed — classified as Quarantined so the UI's
    // re-download flow offers a way out (presence flips false).
    if let Some(marker) = super::store::read_marker(&paths.engine_dir) {
        let bad = super::install::verify_installed_files(&paths.engine_dir, &marker);
        if !bad.is_empty() {
            return Err(EngineError::Quarantined {
                path: format!(
                    "{} (engine files missing or altered: {})",
                    paths.engine_exe.to_string_lossy(),
                    bad.first().map(String::as_str).unwrap_or("?")
                ),
            });
        }
    }
    clear_restart_budget(&state);
    *state.shutdown.lock().unwrap() = tokio_util::sync::CancellationToken::new();
    {
        let mut phase = state.phase.lock().unwrap();
        *phase = EnginePhase::Starting {
            since: std::time::Instant::now(),
        };
    }
    rearm_idle_timer(&state); // explicit start IS activity (R2.6)
    let (events, mut rx) = watch::channel(None);
    let done = Arc::new(AtomicBool::new(false));
    *state.session.lock().unwrap() = Some(tokio::spawn(session(
        state.clone(),
        paths,
        wants_gpu,
        fake_script,
        events,
        done.clone(),
    )));
    loop {
        match rx.borrow().as_ref() {
            Some(PhaseEvent::Ready { pid, port, status }) => {
                return Ok(EnginePhase::Ready {
                    pid: *pid,
                    port: *port,
                    status: status.clone(),
                })
            }
            // Dead was checked above, so any remaining Terminal is Stopped.
            Some(PhaseEvent::Terminal(EnginePhase::Dead { cause })) => return Err(cause.clone()),
            Some(PhaseEvent::Terminal(_)) => return Ok(EnginePhase::Stopped),
            None => {}
        }
        if rx.changed().await.is_err() {
            return Err(EngineError::Spawn(
                "supervision session ended unexpectedly".into(),
            ));
        }
    }
}

/// Graceful teardown from any async context (R2.7 layers 1/2/4). Idempotent;
/// bounded wait, then the blocking kill as the fallback.
pub async fn shutdown_all(state: &Arc<NativeEngineState>) {
    state.shutdown.lock().unwrap().cancel();
    // The session observes the token within one poll cycle; give it up to
    // SIGTERM_GRACE + slack, then force.
    let deadline = tokio::time::Instant::now() + SIGTERM_GRACE + std::time::Duration::from_secs(2);
    while tokio::time::Instant::now() < deadline {
        if !state.phase.lock().unwrap().is_running() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    blocking_kill_active_child();
    let mut phase = state.phase.lock().unwrap();
    if phase.is_running() {
        *phase = EnginePhase::Stopped;
    }
}

// -------------------------------- idle timer ------------------------------

/// Re-arm the 10-minute idle shutdown (review F7 + R2.6). Status reads never
/// call this; OCR request begin/end + explicit start/stop do. Busy → re-arm,
/// NEVER dispose under an in-flight page. A stopped/dead engine does not
/// re-arm (the task ends).
pub fn rearm_idle_timer(state: &Arc<NativeEngineState>) {
    let mut slot = state.idle_task.lock().unwrap();
    if let Some(handle) = slot.take() {
        handle.abort();
    }
    let state = state.clone();
    *slot = Some(tokio::spawn(async move {
        let token = state.shutdown.lock().unwrap().clone();
        let idle_after = *state.idle_after.lock().unwrap();
        tokio::select! {
            _ = token.cancelled() => {}
            _ = tokio::time::sleep(idle_after) => {
                let busy = *state.page_in_flight.lock().unwrap() > 0;
                let ready = matches!(*state.phase.lock().unwrap(), EnginePhase::Ready { .. });
                if busy || !ready {
                    // Busy-never-dispose (review F7) — and a STARTUP in
                    // progress is user-requested activity too: the timer
                    // armed at start() must never kill a still-starting
                    // engine (the fake-child suite exercises exactly that
                    // race with a sub-startup idle delay).
                    rearm_idle_timer(&state);
                } else {
                    shutdown_all(&state).await;
                }
            }
        }
    }));
}

// ------------------------- page slot / activity (R4.2) --------------------

/// The single in-flight OCR slot. The idle timer consults the same counter —
/// busy pages are never disposed under (review F7 busy-never-dispose).
pub fn begin_page(state: &Arc<NativeEngineState>) {
    *state.page_in_flight.lock().unwrap() += 1;
    rearm_idle_timer(state);
}

pub fn end_page(state: &Arc<NativeEngineState>) {
    let mut n = state.page_in_flight.lock().unwrap();
    *n = n.saturating_sub(1);
}
