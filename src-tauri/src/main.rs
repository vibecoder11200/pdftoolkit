// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // GPU force-dGPU flag (phase 2): must be exported BEFORE the webview is
    // created — WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is read at browser-
    // process creation. Also consumes the flag-restart child marker.
    pdftoolkit_lib::apply_gpu_force_env();
    pdftoolkit_lib::run()
}
