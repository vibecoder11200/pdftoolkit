// Typed view of the COMMITTED engine manifest (R3.6): the JSON is compiled
// into the binary via include_str! — pin URLs and hashes are build-time
// constants, never runtime-assembled from user input (lib.rs:98-99
// discipline). The manifest is the single source of truth consumed by BOTH
// this binary and the JS download-info UI (phase 4, typed import).
use serde::Deserialize;

pub const MANIFEST_JSON: &str = include_str!("../../../scripts/native-engine-manifest.json");

#[derive(Debug, Clone, Deserialize)]
pub struct NativeEngineManifest {
    #[serde(rename = "llamaTag")]
    pub llama_tag: String,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    #[serde(rename = "minGlibc")]
    pub min_glibc: String,
    #[serde(rename = "minMacos")]
    pub min_macos: String,
    pub engines: std::collections::HashMap<String, PinEntry>,
    pub extras: std::collections::HashMap<String, PinEntry>,
    pub model: ModelPin,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PinEntry {
    pub asset: String,
    pub url: String,
    pub sha256: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "digestVerified")]
    pub digest_verified: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelPin {
    pub repo: String,
    pub revision: String,
    pub files: Vec<ModelFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelFile {
    pub path: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    pub sha256: String,
    #[serde(rename = "digestVerified")]
    pub digest_verified: bool,
}

/// Parse once per call site (cheap: a ~1 KB JSON) — no global mutable state.
pub fn manifest() -> NativeEngineManifest {
    serde_json::from_str(MANIFEST_JSON).expect("committed native-engine-manifest.json must parse")
}

/// The engine key for THIS build target (D4 scope): win→Vulkan universal,
/// macOS→Metal, Linux→Vulkan (CPU is the explicit fallback engine entry).
pub fn target_engine_key() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "win-x64/vulkan"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "macos-arm64/metal"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "macos-x64/metal"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64/vulkan"
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64")
    )))]
    {
        // Unsupported target — the UI hides the feature (phase 4 gates on
        // native_engine_status.enginePresent, which can never become true
        // without a pin); a key that matches nothing keeps the type total.
        "unsupported"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_parses_and_tag_matches_the_supervisor_pin() {
        let m = manifest();
        // Drift between the manifest and the code's expected version fails
        // HERE (cargo test), not in the field.
        assert_eq!(m.llama_tag, super::super::PINNED_LLAMA_TAG);
        for (key, e) in &m.engines {
            assert_eq!(e.sha256.len(), 64, "{key} pin not a sha256");
            assert!(e.digest_verified, "{key} must be API-digest-verified");
            assert!(e
                .url
                .starts_with("https://github.com/ggml-org/llama.cpp/releases/download/"));
        }
        assert!(m.extras.contains_key("win-x64/cudart-12.4"));
        assert_eq!(m.model.files.len(), 2, "text + mmproj GGUF");
        for f in &m.model.files {
            assert_eq!(f.sha256.len(), 64);
            assert!(f.digest_verified);
        }
    }

    #[test]
    fn target_engine_key_is_a_manifest_key_on_supported_targets() {
        let m = manifest();
        let key = target_engine_key();
        let supported = cfg!(any(
            all(target_os = "windows", target_arch = "x86_64"),
            all(target_os = "macos", target_arch = "aarch64"),
            all(target_os = "macos", target_arch = "x86_64"),
            all(target_os = "linux", target_arch = "x86_64")
        ));
        if supported {
            assert!(
                m.engines.contains_key(key),
                "target key {key} must exist in the manifest"
            );
        } else {
            assert_eq!(key, "unsupported");
        }
    }
}
