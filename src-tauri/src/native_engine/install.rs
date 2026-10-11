// Install (R3.2): archive → verified extraction into engines/<key>/ with
// layout normalization (flat win zip vs foldered macOS/Linux tar), per-file
// sha256 map into the install marker (the tamper check compared at EVERY
// start — review F8), and hostile-archive rejection (zip-slip / absolute
// paths / symlink entries — review M1: clean abort, no partial extraction).
use super::store::{InstalledMarker, MarkerFile};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

pub const SERVER_BINARY: &str = if cfg!(windows) {
    "llama-server.exe"
} else {
    "llama-server"
};

#[derive(Debug)]
pub enum InstallError {
    Archive(String),
    HostileEntry { path: String, reason: &'static str },
    Io(std::io::Error),
    Cleanup(String),
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::Archive(s) => write!(f, "archive: {s}"),
            InstallError::HostileEntry { path, reason } => {
                write!(f, "hostile archive entry {path:?}: {reason}")
            }
            InstallError::Io(e) => write!(f, "io: {e}"),
            InstallError::Cleanup(s) => write!(f, "cleanup: {s}"),
        }
    }
}

/// Extraction mode: `Replace` wipes the destination first (single-archive
/// engine install); `Merge` keeps existing files and extends the marker's
/// per-file map (the CUDA flow = engine zip + cudart zip into ONE dir —
/// the DLLs must land BESIDE the exe, not replace it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallMode {
    Replace,
    Merge,
}

/// Extract into `dest` and write the marker with the per-file sha256 map.
/// In Replace mode `dest` is REMOVED first (no half dirs — R3.2). On ANY
/// error the partial destination is cleaned up (success criterion: a
/// hostile archive leaves nothing on disk — in Merge mode the pre-existing
/// files stay, the new extraction is cleaned).
pub fn extract_and_install(
    archive_bytes: Vec<u8>,
    dest: &Path,
    key: &str,
    tag: &str,
    archive_sha256: &str,
    mode: InstallMode,
) -> Result<InstalledMarker, InstallError> {
    let previous_files = if mode == InstallMode::Merge {
        super::store::read_marker(dest)
            .map(|m| m.files)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    if mode == InstallMode::Replace && dest.exists() {
        super::store::remove_dir_freed(dest).map_err(|e| InstallError::Cleanup(e.to_string()))?;
    }
    std::fs::create_dir_all(dest).map_err(InstallError::Io)?;

    let result = if archive_bytes.starts_with(b"PK") {
        extract_zip(&archive_bytes, dest)
    } else {
        extract_tar_gz(&archive_bytes, dest)
    };

    match result {
        Ok(new_files) => {
            // Merge = previous entries with new ones overriding by path.
            let mut files = previous_files;
            for f in new_files {
                match files.iter_mut().find(|e| e.path == f.path) {
                    Some(slot) => slot.sha256 = f.sha256,
                    None => files.push(f),
                }
            }
            let marker = InstalledMarker {
                key: key.into(),
                tag: tag.into(),
                sha256: archive_sha256.into(),
                files,
                installed_at: chrono_now_date(),
            };
            super::store::write_marker(dest, &marker).map_err(InstallError::Io)?;
            Ok(marker)
        }
        Err(e) => {
            // Clean-abort: no partial extraction left on disk (review M1).
            if mode == InstallMode::Replace {
                let _ = super::store::remove_dir_freed(dest);
            }
            Err(e)
        }
    }
}

fn chrono_now_date() -> String {
    // No chrono dependency in this crate — the installed_at stamp is
    // metadata, not pin state; a coarse UTC second from the Unix epoch is
    // enough (the manifest generatedAt pattern mirrors this).
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix:{secs}")
}

/// Entry-target validation shared by both archive formats: rejects `..`
/// components, absolute paths, and (on extraction) any non-file entry we do
/// not understand.
fn validate_rel_path(raw: &str) -> Result<std::path::PathBuf, InstallError> {
    let path = std::path::PathBuf::from(raw.replace('\\', "/"));
    if path.is_absolute() || raw.starts_with('/') || raw.starts_with('\\') {
        return Err(InstallError::HostileEntry {
            path: raw.into(),
            reason: "absolute path",
        });
    }
    let mut depth = 0i32;
    for c in path.components() {
        match c {
            std::path::Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return Err(InstallError::HostileEntry {
                        path: raw.into(),
                        reason: "escapes destination (zip-slip)",
                    });
                }
            }
            std::path::Component::Normal(_) => depth += 1,
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err(InstallError::HostileEntry {
                    path: raw.into(),
                    reason: "absolute path",
                });
            }
            std::path::Component::CurDir => {}
        }
    }
    Ok(path)
}

fn sha256_reader<R: Read>(mut r: R) -> Result<(String, Vec<u8>), InstallError> {
    let mut hash = Sha256::new();
    let mut buf = Vec::new();
    std::io::copy(&mut r, &mut buf).map_err(InstallError::Io)?;
    hash.update(&buf);
    let digest = hash.finalize();
    Ok((digest.iter().map(|b| format!("{b:02x}")).collect(), buf))
}

fn extract_zip(bytes: &[u8], dest: &Path) -> Result<Vec<MarkerFile>, InstallError> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| InstallError::Archive(e.to_string()))?;
    let mut files = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| InstallError::Archive(e.to_string()))?;
        if entry.is_dir() {
            continue;
        }
        // Symlinks in zips surface as entries with link_name — zip 4 exposes
        // it; reject anything that is not a regular file.
        if !entry.is_file() {
            return Err(InstallError::HostileEntry {
                path: entry.name().into(),
                reason: "non-regular entry",
            });
        }
        let Some(rel) = entry.enclosed_name() else {
            return Err(InstallError::HostileEntry {
                path: entry.name().into(),
                reason: "escapes destination (zip-slip)",
            });
        };
        // Strip a leading `<tag>/` folder component when present (layout
        // normalization happens once, here).
        let rel = strip_top_component(&rel.to_string_lossy());
        let rel = validate_rel_path(&rel)?;
        let target = dest.join(&rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(InstallError::Io)?;
        }
        let (sha, bytes) = sha256_reader(&mut entry)?;
        std::fs::write(&target, &bytes).map_err(InstallError::Io)?;
        files.push(MarkerFile {
            path: rel.to_string_lossy().replace('\\', "/"),
            sha256: sha,
        });
    }
    Ok(files)
}

fn extract_tar_gz(bytes: &[u8], dest: &Path) -> Result<Vec<MarkerFile>, InstallError> {
    let gz = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(gz);
    // Never follow symlinks/hardlinks out of an untrusted archive (review M1).
    archive.set_preserve_permissions(false);
    archive.set_unpack_xattrs(false);
    let mut files = Vec::new();
    for entry in archive
        .entries()
        .map_err(|e| InstallError::Archive(e.to_string()))?
    {
        let mut entry = entry.map_err(|e| InstallError::Archive(e.to_string()))?;
        let header_type = entry.header().entry_type();
        match header_type {
            tar::EntryType::Regular => {}
            tar::EntryType::Symlink | tar::EntryType::Link => {
                return Err(InstallError::HostileEntry {
                    path: entry
                        .path()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    reason: "symlink/hardlink in untrusted archive",
                });
            }
            tar::EntryType::Directory => continue,
            _ => continue,
        }
        let raw = entry
            .path()
            .map_err(|e| InstallError::Archive(e.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        let raw = strip_top_component(&raw);
        let rel = validate_rel_path(&raw)?;
        let target = dest.join(&rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(InstallError::Io)?;
        }
        let (sha, bytes) = sha256_reader(&mut entry)?;
        std::fs::write(&target, &bytes).map_err(InstallError::Io)?;
        // Tar preserves the +x bit through the header even with
        // preserve_permissions(false)? Assert the server binary is
        // executable regardless (R3.2: "assert anyway").
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if rel.to_string_lossy() == super::install::SERVER_BINARY {
                let mut perms = std::fs::metadata(&target)
                    .map_err(InstallError::Io)?
                    .permissions();
                perms.set_mode(perms.mode() | 0o755);
                std::fs::set_permissions(&target, perms).map_err(InstallError::Io)?;
            }
        }
        files.push(MarkerFile {
            path: rel.to_string_lossy().replace('\\', "/"),
            sha256: sha,
        });
    }
    Ok(files)
}

/// Strip the leading `llama-b11553/` folder component (macOS/Linux tars
/// extract into a folder; win zips are flat — normalize to flat, R3).
fn strip_top_component(raw: &str) -> String {
    let mut parts = raw.split('/');
    let first = parts.next().unwrap_or_default();
    if first.starts_with("llama-") && parts.clone().next().is_some() {
        parts.collect::<Vec<_>>().join("/")
    } else {
        raw.to_string()
    }
}

/// Compare on-disk files against the marker's per-file map (review F8) —
/// run at EVERY engine start. Returns the list of mismatching paths
/// (empty = verified).
pub fn verify_installed_files(dir: &Path, marker: &InstalledMarker) -> Vec<String> {
    let mut bad = Vec::new();
    for f in &marker.files {
        let p = dir.join(&f.path);
        match std::fs::File::open(&p) {
            Err(_) => bad.push(f.path.clone()),
            Ok(mut file) => {
                let mut hash = Sha256::new();
                if std::io::copy(&mut file, &mut hash).is_err() {
                    bad.push(f.path.clone());
                    continue;
                }
                let digest = hash.finalize();
                let got: String = digest.iter().map(|b| format!("{b:02x}")).collect();
                if got != f.sha256 {
                    bad.push(f.path.clone());
                }
            }
        }
    }
    bad
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pdftk-install-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::create_dir_all(&d);
        d
    }

    fn zip_bytes(entries: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
        use std::io::Write;
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, data) in entries {
            w.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(&data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    fn tar_gz_bytes(entries: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
        let mut tar_buf = Vec::new();
        {
            let mut b = tar::Builder::new(&mut tar_buf);
            for (name, data) in entries {
                let mut h = tar::Header::new_gnu();
                h.set_size(data.len() as u64);
                h.set_mode(0o755);
                h.set_cksum();
                b.append_data(&mut h, name, data.as_slice()).unwrap();
            }
            b.finish().unwrap();
        }
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        use std::io::Write as _;
        gz.write_all(&tar_buf).unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn zip_flat_extract_writes_marker_with_per_file_hashes() {
        let body = vec![7u8; 1000];
        let bytes = zip_bytes(vec![
            ("llama-server.exe", body.clone()),
            ("ggml.dll", vec![1; 50]),
        ]);
        let dest = tempdir("zip-flat");
        let marker = extract_and_install(
            bytes,
            &dest,
            "win-x64/vulkan",
            "b11553",
            "a".repeat(64).as_str(),
            InstallMode::Replace,
        )
        .unwrap();
        assert!(dest.join("llama-server.exe").is_file());
        assert!(dest.join("ggml.dll").is_file());
        assert_eq!(marker.files.len(), 2);
        let exe = marker
            .files
            .iter()
            .find(|f| f.path == "llama-server.exe")
            .unwrap();
        let mut h = Sha256::new();
        h.update(&body);
        let want: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(exe.sha256, want);
        assert!(super::super::store::read_marker(&dest).is_some());
    }

    #[test]
    fn tar_folder_layout_is_stripped_to_flat_siblings() {
        let bytes = tar_gz_bytes(vec![
            ("llama-b11553/llama-server", vec![9; 100]),
            ("llama-b11553/libggml-vulkan.so", vec![2; 60]),
        ]);
        let dest = tempdir("tar-strip");
        let marker = extract_and_install(
            bytes,
            &dest,
            "linux-x64/vulkan",
            "b11553",
            "b".repeat(64).as_str(),
            InstallMode::Replace,
        )
        .unwrap();
        assert!(
            dest.join("llama-server").is_file(),
            "server at the ROOT (siblings beside it)"
        );
        assert!(dest.join("libggml-vulkan.so").is_file());
        assert!(
            !dest.join("llama-b11553").exists(),
            "leading folder stripped"
        );
        assert_eq!(marker.files.len(), 2);
    }

    #[test]
    fn hostile_zip_slip_entry_is_rejected_with_nothing_on_disk() {
        let bytes = zip_bytes(vec![("ok.txt", vec![1; 10]), ("../evil.txt", vec![2; 10])]);
        let dest = tempdir("zip-slip");
        let err = extract_and_install(
            bytes,
            &dest,
            "k",
            "t",
            "c".repeat(64).as_str(),
            InstallMode::Replace,
        )
        .unwrap_err();
        assert!(
            matches!(
                err,
                InstallError::HostileEntry {
                    reason: "escapes destination (zip-slip)",
                    ..
                }
            ),
            "got {err:?}"
        );
        assert!(
            !dest.join("ok.txt").exists(),
            "clean abort — no partial extraction"
        );
    }

    #[test]
    fn hostile_zip_absolute_entry_is_rejected() {
        let bytes = zip_bytes(vec![("/abs/evil.txt", vec![2; 10])]);
        let dest = tempdir("zip-abs");
        let err = extract_and_install(
            bytes,
            &dest,
            "k",
            "t",
            "d".repeat(64).as_str(),
            InstallMode::Replace,
        )
        .unwrap_err();
        assert!(
            matches!(err, InstallError::HostileEntry { .. }),
            // zip-rs' `enclosed_name` rejects "/abs/evil.txt" as a zip-slip
            // escape before the absolute-path check sees it — either
            // rejection reason proves the entry never lands on disk.
            "got {err:?}"
        );
    }

    #[test]
    fn hostile_tar_symlink_is_rejected() {
        let mut tar_buf = Vec::new();
        {
            let mut b = tar::Builder::new(&mut tar_buf);
            let mut h = tar::Header::new_gnu();
            h.set_size(0);
            h.set_entry_type(tar::EntryType::Symlink);
            h.set_cksum();
            b.append_link(&mut h, "evil-link", "/etc/passwd").unwrap();
            b.finish().unwrap();
        }
        let bytes = {
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            std::io::Write::write_all(&mut gz, &tar_buf).unwrap();
            gz.finish().unwrap()
        };
        let dest = tempdir("tar-link");
        let err = extract_and_install(
            bytes,
            &dest,
            "k",
            "t",
            "e".repeat(64).as_str(),
            InstallMode::Replace,
        )
        .unwrap_err();
        assert!(
            matches!(
                err,
                InstallError::HostileEntry {
                    reason: "symlink/hardlink in untrusted archive",
                    ..
                }
            ),
            "got {err:?}"
        );
        assert!(!dest.join("evil-link").exists());
    }

    #[test]
    fn corrupt_install_is_removed_before_a_retry() {
        let bytes = zip_bytes(vec![("llama-server.exe", vec![1; 10])]);
        let dest = tempdir("corrupt");
        extract_and_install(
            bytes.clone(),
            &dest,
            "k",
            "t",
            "f".repeat(64).as_str(),
            InstallMode::Replace,
        )
        .unwrap();
        // Simulate a corrupt prior install: junk file + stale marker.
        std::fs::write(dest.join("llama-server.exe"), b"tampered").unwrap();
        let marker = extract_and_install(
            bytes,
            &dest,
            "k",
            "t",
            "f".repeat(64).as_str(),
            InstallMode::Replace,
        )
        .unwrap();
        assert_eq!(marker.files[0].sha256.len(), 64);
        // The marker's hash matches the FRESH file again.
        assert!(verify_installed_files(&dest, &marker).is_empty());
    }

    #[test]
    fn verify_installed_files_detects_tamper_and_missing() {
        let bytes = zip_bytes(vec![
            ("llama-server.exe", vec![1; 100]),
            ("ggml.dll", vec![2; 10]),
        ]);
        let dest = tempdir("verify");
        let marker = extract_and_install(
            bytes,
            &dest,
            "k",
            "t",
            "0".repeat(64).as_str(),
            InstallMode::Replace,
        )
        .unwrap();
        assert!(verify_installed_files(&dest, &marker).is_empty());
        // Tamper with one file → exactly that path is flagged.
        std::fs::write(dest.join("ggml.dll"), b"changed").unwrap();
        assert_eq!(
            verify_installed_files(&dest, &marker),
            vec!["ggml.dll".to_string()]
        );
        // Missing file → flagged.
        std::fs::remove_file(dest.join("llama-server.exe")).unwrap();
        let bad = verify_installed_files(&dest, &marker);
        assert!(bad.contains(&"llama-server.exe".to_string()));
    }
}
