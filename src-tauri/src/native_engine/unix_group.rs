// Unix containment (R2.1/R2.7): the child runs in its OWN process group
// (process_group(0)) so teardown can address the whole tree — llama.cpp
// installs SIGTERM handlers (server.cpp 507-515) so the graceful layer is
// killpg(SIGTERM) → 3 s grace → killpg(SIGKILL).
//!
//! The startup stray sweep is MANDATORY (review F6): `std::process::exit` in
//! `restart_with_gpu_force` skips the supervisor's Drop, and the updater path
//! can bypass the event loop entirely — leftovers from a previous generation
//! are killed at app start, matched by our marker env or the engine dir in
//! the child's cmdline. A RESTARTING app's new generation is never matched
//! because the old instance's sweep runs before the new child is spawned.

use std::path::Path;

pub fn child_in_new_process_group(cmd: &mut tokio::process::Command) {
    use std::os::unix::process::CommandExt;
    cmd.as_std_mut().process_group(0);
}

fn killpg(pgid: libc::pid_t, sig: i32) {
    unsafe {
        libc::killpg(pgid, sig);
    }
}

/// Immediate SIGKILL to the group — the updater-hook / blocking-kill path.
pub fn killpg_now(pgid: libc::pid_t) {
    killpg(pgid, libc::SIGKILL);
}

/// Graceful teardown: SIGTERM → grace → SIGKILL (R2.7 sequence). Returns
/// after the child group is gone.
pub async fn terminate_group_graceful(pgid: libc::pid_t) {
    killpg(pgid, libc::SIGTERM);
    let deadline = tokio::time::Instant::now() + super::SIGTERM_GRACE;
    while tokio::time::Instant::now() < deadline {
        // killpg with signal 0 = liveness probe for the GROUP (any member).
        unsafe {
            if libc::killpg(pgid, 0) != 0 {
                return; // gone
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    killpg_now(pgid);
}

/// MANDATORY startup sweep (R2.7): SIGKILL any leftover llama-server child
/// of a previous generation. Matching = marker env in /proc/*/environ OR the
/// engine dir path in /proc/*/cmdline. On macOS /proc does not exist —
/// `pgrep -f <engine_dir>` is the pragmatic equivalent (the phase 6 smoke
/// matrix runs this natively and is the resolution path for its unknowns).
pub fn sweep_strays(engine_dir: &Path) {
    #[cfg(target_os = "linux")]
    {
        sweep_linux(engine_dir);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-9", "-f"])
            .arg(engine_dir.as_os_str())
            .status();
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = engine_dir;
    }
}

/// Count-only variant (R6.6 orphan enumeration): pids of OUR leftover
/// children, alive right now. Never kills.
pub fn enumerate_strays(engine_dir: &Path) -> Vec<i32> {
    #[cfg(target_os = "linux")]
    {
        let dir_str = engine_dir.to_string_lossy().into_owned();
        let mut strays = Vec::new();
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return strays;
        };
        for entry in entries.flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
                continue;
            };
            if pid == std::process::id() as i32 {
                continue;
            }
            let proc_dir = std::path::PathBuf::from("/proc").join(pid.to_string());
            let environ = std::fs::read_to_string(proc_dir.join("environ")).unwrap_or_default();
            let cmdline = std::fs::read_to_string(proc_dir.join("cmdline")).unwrap_or_default();
            let marker_prefix = format!("{}=", super::CHILD_MARKER_ENV);
            let ours = environ.split('\0').any(|kv| kv.starts_with(&marker_prefix))
                || cmdline.contains(&dir_str);
            if ours {
                strays.push(pid);
            }
        }
        strays
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("pgrep")
            .args(["-f"])
            .arg(engine_dir.as_os_str())
            .output()
            .ok();
        out.map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.trim().parse::<i32>().ok())
                .collect()
        })
        .unwrap_or_default()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = engine_dir;
        Vec::new()
    }
}

#[cfg(target_os = "linux")]
fn sweep_linux(engine_dir: &Path) {
    let dir_str = engine_dir.to_string_lossy().into_owned();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        if pid == std::process::id() as i32 {
            continue;
        }
        let proc_dir = std::path::PathBuf::from("/proc").join(pid.to_string());
        let environ = std::fs::read_to_string(proc_dir.join("environ")).unwrap_or_default();
        let cmdline = std::fs::read_to_string(proc_dir.join("cmdline")).unwrap_or_default();
        let marker_prefix = format!("{}=", super::CHILD_MARKER_ENV);
        let ours = environ.split('\0').any(|kv| kv.starts_with(&marker_prefix))
            || cmdline.contains(&dir_str);
        if ours {
            // Kill the whole group if it leads one; else the process.
            unsafe {
                let pgid = libc::getpgid(pid);
                if pgid > 0 && pgid == pid {
                    libc::killpg(pgid, libc::SIGKILL);
                } else {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }
}
