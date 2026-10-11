// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Fake-child hook (phase 2, test-only — compiled out of release builds):
    // the supervision tests spawn THIS binary with NATIVE_ENGINE_FAKE_CHILD
    // set; route to the scripted child main before anything else touches
    // stdout/stderr (the handshake parses them).
    #[cfg(debug_assertions)]
    {
        if std::env::var("NATIVE_ENGINE_FAKE_CHILD").is_ok() {
            let code = pdftoolkit_lib::native_engine::fake_child::run_scripted_main();
            std::process::exit(code);
        }
    }
    // The flag-restart child marker MUST be captured before anything clears
    // the env — run() gates the single-instance plugin on this captured
    // boolean, not on the env var.
    let is_flag_restart_child = pdftoolkit_lib::take_flag_restart_marker();
    // GPU force-dGPU flag (phase 2): must be exported BEFORE the webview is
    // created — WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is read at browser-
    // process creation.
    pdftoolkit_lib::apply_gpu_force_env();
    pdftoolkit_lib::run(is_flag_restart_child)
}
