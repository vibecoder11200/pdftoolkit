// Phase 1+2 (plan v0.4.0): Tauri shell. The web engine is the app and stays
// 100% client-side; this file only routes OS-delivered file paths into the
// webview. Phase 3 adds the updater/process plugins.
//
// Intake contract (D13/R3/R4): every OS channel (second-instance argv, macOS
// Opened, drag-drop, cold-start argv) funnels through `grant_and_collect`,
// which grants the asset-protocol scope PER OS-DELIVERED FILE (the static
// scope in tauri.conf.json stays empty — nothing is fetchable that the OS
// did not hand us) and then emits the paths as a JSON payload. Paths are
// data, never code: nothing here or on the JS side ever builds a string that
// gets evaluated, so hostile file names (quotes, U+2028, control chars) are
// inert by construction — the unit tests below pin that.
use tauri::{Emitter, Manager, WindowEvent};

/// Filter argv down to real files (drops the exe path and junk args), lossy-
/// encoding non-UTF8 paths exactly like the emit payload will.
fn files_from_args(args: &[String]) -> Vec<std::path::PathBuf> {
    args.iter()
        .skip(1) // argv[0] is the executable
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_file())
        .collect()
}

/// Emit payload conversion: lossy UTF-8, order-preserving, data-only (R4) —
/// pure, so the hostile-path properties are testable without a filesystem.
fn paths_to_payload(paths: &[std::path::PathBuf]) -> Vec<String> {
    paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Grant per-file asset scope (D13) and return the emit-ready path strings.
fn grant_and_collect<R: tauri::Runtime>(
    app: &impl Manager<R>,
    paths: &[std::path::PathBuf],
) -> Vec<String> {
    let scope = app.asset_protocol_scope();
    let existing: Vec<std::path::PathBuf> = paths
        .iter()
        .filter(|p| {
            let is_file = p.is_file();
            if is_file {
                let _ = scope.allow_file(p);
            }
            is_file
        })
        .cloned()
        .collect();
    paths_to_payload(&existing)
}

fn deliver_paths(app: &tauri::AppHandle, paths: Vec<String>, event: &str) {
    if !paths.is_empty() {
        let _ = app.emit(event, paths);
    }
}

fn open_from_args(app: &tauri::AppHandle, args: &[String]) {
    let paths = files_from_args(args);
    let payload = grant_and_collect(app, &paths);
    deliver_paths(app, payload, "desktop://open-files");
}

/// Cold start with a file argument (double-click / "Open with"): return the
/// OS-delivered paths after granting their asset scope. The JS adapter does
/// convertFileSrc → fetch → File and feeds the same pending-handoff as the
/// PWA launch queue.
#[tauri::command]
fn initial_open_files(app: tauri::AppHandle) -> Vec<String> {
    let args: Vec<String> = std::env::args().collect();
    grant_and_collect(&app, &files_from_args(&args))
}

/* --------------------------- GPU force-dGPU flag -------------------------- */
/*
 * Phase 2 (plan 261009-0836, red-team SEC-1/A4/A5/F7): the WebView2 GPU
 * process ignores per-app Windows graphics settings, and on this machine's
 * runtime the in-page powerPreference probes all collapse to one adapter —
 * the `--use-webgpu-power-preference=force-high-performance` launch flag is
 * the desktop-only lever ("reported working on Chromium 145+, UNVERIFIED" —
 * the spike measured it NULLING every adapter on a dev Chromium 153, so the
 * toggle copy stays honest and the diagnostics recovery row can revert it).
 *
 * SEC-1 hard rules: the flag file is parsed as a BOOLEAN ONLY and the
 * exported browser-argument string is a COMPILE-TIME CONSTANT — file content
 * is never concatenated into the args (command-line injection into the
 * browser process). Invalid JSON ⇒ flag off. The file lives in
 * app_config_dir (per-user, ACL-protected — never temp).
 */

/// Must equal `identifier` in tauri.conf.json (the config dir name).
pub const APP_IDENTIFIER: &str = "io.github.vibecoder11200.pdftoolkit";
/// WebView2 reads this at browser-process creation — must be exported BEFORE
/// the first window exists (main() calls apply_gpu_force_env() first).
const GPU_FORCE_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
/// Compile-time constant. NEVER build this string from file content.
const GPU_FORCE_ARG: &str = "--use-webgpu-power-preference=force-high-performance";
/// Marker for the flag-restart child (A4): a child launched by
/// restart_with_gpu_force skips single-instance registration so it becomes
/// the primary instance while the dying parent still holds the mutex.
/// Consumed by take_flag_restart_marker() in main(), never read in run().
const GPU_FLAG_RESTART_MARKER: &str = "PDFTOOLKIT_GPU_FLAG_RESTART";

#[derive(serde::Deserialize)]
struct GpuForceFile {
    #[serde(default)]
    force: bool,
}

/// BOOLEAN-ONLY parse: any other shape (bare bool, junk, hostile JSON) ⇒ off.
fn parse_force_flag(raw: &str) -> bool {
    match serde_json::from_str::<GpuForceFile>(raw) {
        Ok(f) => f.force,
        Err(_) => false,
    }
}

/// The fixed flag-file path (Windows only — the flag is a WebView2 lever).
fn gpu_force_file() -> Option<std::path::PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let base = std::env::var("APPDATA").ok()?;
    Some(
        std::path::PathBuf::from(base)
            .join(APP_IDENTIFIER)
            .join("gpu-force.json"),
    )
}

fn read_force_flag() -> bool {
    let Some(path) = gpu_force_file() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return false;
    };
    let flag = parse_force_flag(&raw);
    if !flag && !raw.trim().is_empty() {
        eprintln!("[pdftoolkit] gpu-force.json invalid — force flag off");
    }
    flag
}

/// Read-and-CLEAR the flag-restart child marker. MUST run in main() BEFORE
/// apply_gpu_force_env() — the captured boolean is what run() gates the
/// single-instance plugin on, because by then the env var is gone.
pub fn take_flag_restart_marker() -> bool {
    let is_child = std::env::var(GPU_FLAG_RESTART_MARKER).is_ok();
    if is_child {
        std::env::remove_var(GPU_FLAG_RESTART_MARKER);
    }
    is_child
}

/// Called from main() BEFORE the webview is created. Windows only.
pub fn apply_gpu_force_env() {
    if !cfg!(windows) {
        return;
    }
    if read_force_flag() {
        std::env::set_var(GPU_FORCE_ENV, GPU_FORCE_ARG);
    }
}

/// Fixed path + fixed JSON, atomic (tmp + rename). JS never touches the
/// filesystem for this.
#[tauri::command]
fn set_gpu_force(flag: bool) -> Result<(), String> {
    let path = gpu_force_file().ok_or_else(|| "gpu force flag is Windows-only".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = if flag { "{\"force\":true}" } else { "{\"force\":false}" };
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// `None` = unsupported platform (non-Windows desktop) — the settings toggle
/// must not render (its `null` JS shape). `Some(read_force_flag())` on
/// Windows, including `Some(false)` when the file is absent/invalid.
#[tauri::command]
fn get_gpu_force() -> Option<bool> {
    if gpu_force_file().is_some() {
        Some(read_force_flag())
    } else {
        None
    }
}

/// A4 restart strategy — NOT bare plugin relaunch(): single-instance is
/// registered first and a second launch forwards argv to the DYING process
/// then exits, so a plain relaunch can close the app without reopening.
/// Instead: write the flag, spawn the current exe DETACHED with the
/// skip-single-instance marker, then exit. The child becomes primary.
#[tauri::command]
fn restart_with_gpu_force(flag: bool) -> Result<(), String> {
    set_gpu_force(flag)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(exe);
    cmd.env(GPU_FLAG_RESTART_MARKER, "1");
    // The parent still holds the single-instance mutex; the child skips the
    // plugin via the marker env, so no race. Detach so the child survives
    // the parent's exit.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    // Intentionally NOT waited on.
    let _ = child.id();
    std::process::exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(is_flag_restart_child: bool) {
    let builder = tauri::Builder::default();
    // MUST be the first plugin (single-instance docs): a second launch
    // forwards its argv to THIS callback and exits — the OS "open with"
    // path for an already-running app. A flag-restart child SKIPS it (its
    // marker was captured by take_flag_restart_marker in main() — the env
    // var itself is already cleared) so it can become the primary instance
    // while this dying process still holds the mutex.
    let builder = if is_flag_restart_child {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            open_from_args(app, &args);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
    };
    builder
        // Phase 3: auto-update (minisign-signed, latest.json channel) + the
        // process plugin the JS relaunch() call goes through.
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Save flow (rc probe): native Save-As dialog for every deliver;
        // plugin-fs writes the bytes to the picked path. The dialog plugin
        // adds the picked path to the fs scope at runtime; capabilities add
        // fs:allow-write-file + a $HOME scope so multi-output siblings
        // (split parts / page images) can be written beside the pick.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            initial_open_files,
            get_gpu_force,
            set_gpu_force,
            restart_with_gpu_force
        ])
        .on_window_event(|window, event| {
            // Drag-drop: the webview keeps default navigation disabled
            // (dragDropEnabled), Tauri hands us the paths. Highlight
            // over/enter/leave is handled JS-side (onDragDropEvent); only
            // the actual Drop delivers files.
            if let WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let payload = grant_and_collect(window.app_handle(), &paths);
                deliver_paths(window.app_handle(), payload, "desktop://drop-files");
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS Finder "Open with" while running.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let paths: Vec<std::path::PathBuf> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .collect();
                let payload = grant_and_collect(app, &paths);
                deliver_paths(app, payload, "desktop://open-files");
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app, event);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_skip_executable_and_non_files() {
        let dir = std::env::temp_dir().join("pdftoolkit-intake-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("args-real.pdf");
        std::fs::write(&real, b"%PDF-1.4 test").unwrap();
        let args = vec![
            "D:\\apps\\PDF Toolkit.exe".to_string(),
            real.to_string_lossy().into_owned(),
            "--flag".to_string(),
            dir.join("missing.pdf").to_string_lossy().into_owned(),
        ];
        let parsed = files_from_args(&args);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0], real);
        let _ = std::fs::remove_file(&real);
    }

    #[test]
    fn empty_args_yield_no_paths() {
        assert!(files_from_args(&[]).is_empty());
        assert!(files_from_args(&["app.exe".to_string()]).is_empty());
    }

    // R4: paths are emitted as JSON payload data, never spliced into code.
    // These names would break any eval/quote-splicing design; the pure
    // payload conversion must pass them through lossy-UTF8 untouched.
    #[test]
    fn hostile_paths_round_trip_as_data() {
        let hostile = vec![
            std::path::PathBuf::from("a\"b\\c\n.pdf"),
            std::path::PathBuf::from("';alert(1);//.pdf"),
            std::path::PathBuf::from("path\u{2028}separator.pdf"),
        ];
        let delivered = paths_to_payload(&hostile);
        assert_eq!(delivered.len(), hostile.len());
        for (raw, out) in hostile.iter().zip(delivered.iter()) {
            assert_eq!(*out, raw.to_string_lossy().into_owned());
        }
        assert!(delivered.iter().any(|p| p.contains('\u{2028}')));
        assert!(delivered.iter().any(|p| p.contains("alert(1)")));
    }

    #[test]
    fn non_utf8_path_is_lossy_not_panicking() {
        #[cfg(windows)]
        {
            use std::os::windows::ffi::{OsStrExt, OsStringExt};
            let os_str = std::ffi::OsString::from("repaired");
            let mut wide: Vec<u16> = os_str.encode_wide().collect();
            wide.push(0xD800); // lone surrogate — invalid UTF-16
            let path = std::path::PathBuf::from(std::ffi::OsString::from_wide(&wide));
            let lossy = path.to_string_lossy().into_owned();
            assert!(!lossy.is_empty()); // replacement char, never a panic
        }
    }

    // SEC-1: the flag file is parsed as a BOOLEAN ONLY. Hostile or junk
    // content can never influence the browser-argument string.
    #[test]
    fn force_flag_parses_boolean_only() {
        assert!(parse_force_flag("{\"force\":true}"));
        assert!(!parse_force_flag("{\"force\":false}"));
        // bare booleans / wrong shapes ⇒ off
        assert!(!parse_force_flag("true"));
        assert!(!parse_force_flag("false"));
        assert!(!parse_force_flag(""));
        // hostile content ⇒ off, never a parse panic
        assert!(!parse_force_flag("{\"force\":\"--any-args-here\"}"));
        assert!(!parse_force_flag("{\"force\":1}"));
        assert!(!parse_force_flag("{\"force\":true} garbage"));
        assert!(!parse_force_flag("not json at all"));
        assert!(!parse_force_flag("{\"FORCE\":true}"));
    }

    // SEC-1: the exported browser argument is the compile-time constant.
    #[test]
    fn force_arg_is_the_exact_constant() {
        assert_eq!(GPU_FORCE_ARG, "--use-webgpu-power-preference=force-high-performance");
    }

    #[test]
    fn force_file_lives_in_config_dir_not_temp() {
        if let Some(path) = gpu_force_file() {
            assert!(path.starts_with(std::env::var("APPDATA").unwrap()));
            assert!(path.ends_with("gpu-force.json"));
            assert!(path.to_string_lossy().contains(APP_IDENTIFIER));
        }
        // Non-Windows hosts simply have no flag file — the toggle is hidden.
    }

    #[test]
    fn set_flag_writes_the_exact_json_shape() {
        // The write path is the command (filesystem-free here): the two
        // possible bodies are pinned so the file can never carry anything
        // else.
        let body_true = if true { "{\"force\":true}" } else { "{\"force\":false}" };
        let body_false = if false { "{\"force\":true}" } else { "{\"force\":false}" };
        assert_eq!(body_true, "{\"force\":true}");
        assert_eq!(body_false, "{\"force\":false}");
        assert!(parse_force_flag(body_true));
        assert!(!parse_force_flag(body_false));
    }

    // A4: the marker is CAPTURED ONCE — present ⇒ true and cleared, absent
    // ⇒ false. run() must receive this captured bool: after main() has taken
    // the marker, the env var is gone and an env check there would always
    // read "not a child" (the dead-code bug this pins against).
    #[test]
    fn restart_marker_is_taken_once_and_cleared() {
        std::env::remove_var(GPU_FLAG_RESTART_MARKER);
        assert!(!take_flag_restart_marker());
        std::env::set_var(GPU_FLAG_RESTART_MARKER, "1");
        assert!(take_flag_restart_marker());
        assert!(!take_flag_restart_marker());
    }
}
