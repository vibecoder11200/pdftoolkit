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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // MUST be the first plugin (single-instance docs): a second launch
        // forwards its argv to THIS callback and exits — the OS "open with"
        // path for an already-running app.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            open_from_args(app, &args);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
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
        .invoke_handler(tauri::generate_handler![initial_open_files])
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
}
