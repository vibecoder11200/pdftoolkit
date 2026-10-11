// Storage roots under app_local_data_dir (R3.2/R3.5): machine-LOCAL (never
// roaming — 1.4 GB must not sync), keyed by bundle identifier so NSIS /UPDATE
// in-place upgrades keep the data. NOTHING outside this root is ever written.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const ROOT_DIR_NAME: &str = "pdftoolkit-native";

/// Download kinds (R4.1's `native_engine_download` / `native_cancel` /
/// `native_engine_delete` all speak this vocabulary).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Engine,
    Cuda,
    Model,
}

/// The per-kind install marker written by install.rs after a verified
/// extraction (review F8: the per-file sha256 map is THE tamper check —
/// compared at EVERY engine start; `--version` is quarantine detection only).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledMarker {
    pub key: String,
    pub tag: String,
    pub sha256: String,
    #[serde(default)]
    pub files: Vec<MarkerFile>,
    #[serde(rename = "installedAt")]
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkerFile {
    pub path: String,
    pub sha256: String,
}

pub fn root(app_local_data_dir: &Path) -> PathBuf {
    normalize(&app_local_data_dir.join(ROOT_DIR_NAME))
}

/// Normalize a path the way the engine requires (learned in the phase 2
/// smoke): llama-server rejects BOTH unnormalized (`\..\`) and
/// extended-length (`\\?\D:\…`) argument paths — canonicalize, then strip
/// the `\\?\` prefix from plain drive paths.
pub fn normalize(path: &Path) -> PathBuf {
    let c = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    #[cfg(windows)]
    {
        let s = c.to_string_lossy().into_owned();
        match s.strip_prefix(r"\\?\") {
            Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
            _ => c,
        }
    }
    #[cfg(not(windows))]
    c
}

pub fn engines_dir(app_local_data_dir: &Path) -> PathBuf {
    root(app_local_data_dir).join("engines")
}

pub fn models_dir(app_local_data_dir: &Path) -> PathBuf {
    root(app_local_data_dir).join("models")
}

/// `<key>` → engines/<sanitized-key>/ (keys are manifest constants; the
/// sanitize is defense in depth for the marker's key field).
pub fn engine_dir(app_local_data_dir: &Path, key: &str) -> PathBuf {
    normalize(&engines_dir(app_local_data_dir).join(sanitize_key(key)))
}

pub fn model_dir(app_local_data_dir: &Path) -> PathBuf {
    normalize(&models_dir(app_local_data_dir).join("GLM-OCR"))
}

/// Production EnginePaths resolution (R4.1): the target platform's engine
/// dir + the manifest's model/mmproj file names. The `state.paths` test
/// override takes precedence when set (ipc::paths_for).
pub fn resolve_paths(app_local_data_dir: &Path) -> super::EnginePaths {
    let engine_dir = engine_dir(app_local_data_dir, super::manifest::target_engine_key());
    let model_dir = model_dir(app_local_data_dir);
    let (model, mmproj) = split_model_files(
        &super::manifest::manifest()
            .model
            .files
            .iter()
            .map(|f| f.path.clone())
            .collect::<Vec<_>>(),
    );
    super::EnginePaths {
        engine_exe: engine_dir.join(super::install::SERVER_BINARY),
        engine_dir,
        model: model_dir.join(&model),
        mmproj: model_dir.join(&mmproj),
    }
}

/// The mmproj file is the one whose name carries the `mmproj` prefix; the
/// text model is the other (manifest order is not load-bearing).
fn split_model_files(paths: &[String]) -> (String, String) {
    match paths {
        [a, b] if b.starts_with("mmproj") => (a.clone(), b.clone()),
        [a, b] => (b.clone(), a.clone()),
        _ => (
            "GLM-OCR-Q8_0.gguf".into(),
            "mmproj-GLM-OCR-Q8_0.gguf".into(),
        ),
    }
}

fn sanitize_key(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Presence = marker file AND the server binary exists on disk (review F8):
/// an AV quarantine that removes the exe flips presence false → the UI
/// offers re-download, never a dead end.
pub fn engine_present(dir: &Path, server_binary: &str) -> bool {
    read_marker(dir).is_some() && dir.join(server_binary).is_file()
}

pub fn model_present(dir: &Path, files: &[String]) -> bool {
    files.iter().all(|f| dir.join(f).is_file())
}

pub fn marker_path(dir: &Path) -> PathBuf {
    dir.join("installed.json")
}

pub fn read_marker(dir: &Path) -> Option<InstalledMarker> {
    let raw = std::fs::read_to_string(marker_path(dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn write_marker(dir: &Path, marker: &InstalledMarker) -> std::io::Result<()> {
    // Atomic fixed-path write (lib.rs pattern): tmp + rename.
    let tmp = dir.join("installed.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(marker).unwrap())?;
    std::fs::rename(&tmp, marker_path(dir))
}

/// Recursively delete a directory, returning bytes freed (best effort — the
/// walk and the unlink race harmlessly).
pub fn remove_dir_freed(dir: &Path) -> std::io::Result<u64> {
    let freed = dir_size(dir).unwrap_or(0);
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(freed),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e),
    }
}

pub fn dir_size(dir: &Path) -> std::io::Result<u64> {
    let mut total = 0u64;
    let stack = vec![dir.to_path_buf()];
    let mut stack = stack;
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let ft = match e.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                stack.push(e.path());
            } else {
                total += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    Ok(total)
}

/// Free bytes on the drive holding `path` (disk preflight, R3
/// non-functional: require totalBytes + 512 MB).
pub fn free_space(path: &Path) -> std::io::Result<u64> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path
            .ancestors()
            .last()
            .unwrap_or(path)
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut free: u64 = 0;
        let ok = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut free,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(free)
    }
    #[cfg(unix)]
    {
        let c = std::ffi::CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "nul in path"))?;
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::statvfs(c.as_ptr(), &mut stat) };
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(stat.f_bavail as u64 * stat.f_frsize as u64)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = path;
        Ok(u64::MAX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pdftk-store-{tag}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    #[test]
    fn marker_round_trips_and_presence_needs_both_marker_and_exe() {
        let dir = tempdir("marker");
        assert!(!engine_present(&dir, "llama-server.exe"), "no marker");
        let m = InstalledMarker {
            key: "win-x64/vulkan".into(),
            tag: "b11553".into(),
            sha256: "a".repeat(64),
            files: vec![MarkerFile {
                path: "llama-server.exe".into(),
                sha256: "b".repeat(64),
            }],
            installed_at: "2026-10-11".into(),
        };
        write_marker(&dir, &m).unwrap();
        assert!(
            !engine_present(&dir, "llama-server.exe"),
            "marker without exe"
        );
        std::fs::write(dir.join("llama-server.exe"), b"x").unwrap();
        assert!(engine_present(&dir, "llama-server.exe"));
        std::fs::remove_file(dir.join("llama-server.exe")).unwrap();
        assert!(
            !engine_present(&dir, "llama-server.exe"),
            "exe removed ⇒ presence flips false"
        );
    }

    #[test]
    fn dir_size_sums_recursively_and_remove_reports_freed_bytes() {
        let dir = tempdir("size");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.bin"), vec![0u8; 1000]).unwrap();
        std::fs::write(dir.join("sub/b.bin"), vec![0u8; 500]).unwrap();
        assert_eq!(dir_size(&dir).unwrap(), 1500);
        let freed = remove_dir_freed(&dir).unwrap();
        assert_eq!(freed, 1500);
        assert!(!dir.exists());
    }

    #[test]
    fn sanitize_key_never_escapes_the_root() {
        assert_eq!(sanitize_key("win-x64/vulkan"), "win-x64_vulkan");
        assert_eq!(sanitize_key("../../etc"), ".._.._etc");
        let d = engine_dir(&tempdir("sanitize"), "../../evil");
        assert!(!d.to_string_lossy().contains("/../"));
        assert!(!d.to_string_lossy().contains("\\..\\"));
    }

    #[test]
    fn free_space_reports_a_sane_number_on_the_real_drive() {
        let free = free_space(&std::env::temp_dir()).unwrap();
        assert!(free > 1024 * 1024, "a dev machine has more than 1 MB free");
    }
}
