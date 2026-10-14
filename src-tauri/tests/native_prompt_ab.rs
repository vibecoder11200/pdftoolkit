// Prompt A/B matrix runner (v0.7.0 plan phase 1 — the evidence harness the
// phase-2 fidelity spike runs on). IGNORED by default (CI has no engine/GPU):
//   cargo test --test native_prompt_ab -- --ignored --test-threads=1
// Env narrowing: AB_CELLS=p0-current-1024,p4-explicit-1280 and/or
// AB_PAGES=vn-en-1,math-1 (default: every cell × every golden page).
//
// Drives the SAME Rust proxy path production uses (`ocr::ocr_request`) so a
// measured prompt change transfers 1:1. Cells are (prompt × long-edge-px)
// tuples in the table below; rasters are pre-rendered per long edge by
// tests/fixtures/gen.mjs (the Rust side cannot rasterize PDFs — production
// rasters come from pdf.js in the webview). Outputs land in
// temp/ocr-ab/<cell>/<page>.md + a metrics.jsonl line per page.
use pdftoolkit_lib::native_engine::ocr::{
    ocr_request, IMAGE_DATAURI_PREFIX, TokenFrame,
};
use pdftoolkit_lib::native_engine::store;
use pdftoolkit_lib::native_engine::supervisor::{shutdown_all, start};
use pdftoolkit_lib::native_engine::{EnginePaths, EnginePhase, NativeEngineState};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Cell 0 — the locked parity baseline (ocr.rs OCR_PROMPT).
const PROMPT_0: &str =
    "Convert this document page to markdown. Preserve headings and tables. Keep Vietnamese diacritics.";
/// Cell 4 — researcher §4: the current intent made explicit about OUTPUT
/// FORMAT (GFM pipes, LaTeX delimiters, reading order).
const PROMPT_4: &str = "OCR this page as markdown. Use # headings, GFM pipe tables, $...$ for inline math and $$...$$ for display math. Preserve reading order and Vietnamese diacritics.";

struct Cell {
    name: &'static str,
    prompt: &'static str,
    long_edge: u32,
}

/// The matrix: prompts 0–4 (researcher §4) at the parity 1024 px, plus ONE
/// native-only resolution cell (web stays 1024 — its worker carries the
/// recorded +700 MB RAM verdict; see phase-2 red-team corrections).
fn cells() -> Vec<Cell> {
    vec![
        Cell { name: "p0-current-1024", prompt: PROMPT_0, long_edge: 1024 },
        Cell { name: "p1-ocr-1024", prompt: "OCR", long_edge: 1024 },
        Cell { name: "p2-textrec-1024", prompt: "Text Recognition:", long_edge: 1024 },
        Cell { name: "p3-md-sentence-1024", prompt: "Convert the document to markdown.", long_edge: 1024 },
        Cell { name: "p4-explicit-1024", prompt: PROMPT_4, long_edge: 1024 },
        Cell { name: "p4-explicit-1280", prompt: PROMPT_4, long_edge: 1280 },
    ]
}

/// Golden pages: raster stem == ground-truth stem under
/// tests/fixtures/ocr-ab-truth/.
const GOLDEN_PAGES: [&str; 4] = ["vn-en-1", "vn-en-2", "math-1", "noisy-1"];

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn raster_path(long_edge: u32, stem: &str) -> PathBuf {
    repo_root()
        .join(format!("tests/fixtures/ocr-ab-rasters/{long_edge}/{stem}.png"))
}

fn truth_path(stem: &str) -> PathBuf {
    repo_root().join(format!("tests/fixtures/ocr-ab-truth/{stem}.txt"))
}

fn out_root() -> PathBuf {
    repo_root().join("temp/ocr-ab")
}

/// The dev machine's v0.6.0 install (proves the installed engine survives)
/// with the phase-1 spike dir as fallback (native_real_smoke precedent).
fn engine_paths() -> Option<EnginePaths> {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let app = PathBuf::from(local).join("io.github.vibecoder11200.pdftoolkit");
        let p = store::resolve_paths(&app);
        if p.engine_exe.is_file() && p.model.is_file() && p.mmproj.is_file() {
            eprintln!("engine source: installed v0.6.0 store");
            return Some(p);
        }
    }
    let dir = repo_root().join("temp/native-engine-spike");
    let exe = if cfg!(windows) {
        dir.join("engine/llama-server.exe")
    } else {
        dir.join("engine/llama-server")
    };
    let model = dir.join("GLM-OCR-Q8_0.gguf");
    let mmproj = dir.join("mmproj-GLM-OCR-Q8_0.gguf");
    if exe.is_file() && model.is_file() && mmproj.is_file() {
        eprintln!("engine source: spike dir");
        let canon = |p: PathBuf| store::normalize(&p);
        return Some(EnginePaths {
            engine_exe: canon(exe),
            engine_dir: canon(dir.join("engine")),
            model: canon(model),
            mmproj: canon(mmproj),
        });
    }
    None
}

fn selected_cells() -> Vec<Cell> {
    let all = cells();
    match std::env::var("AB_CELLS") {
        Ok(spec) => {
            let want: Vec<&str> = spec.split(',').map(str::trim).collect();
            all.into_iter().filter(|c| want.contains(&c.name)).collect()
        }
        Err(_) => all,
    }
}

fn selected_pages() -> Vec<String> {
    match std::env::var("AB_PAGES") {
        Ok(spec) => spec.split(',').map(str::trim).map(String::from).collect(),
        Err(_) => GOLDEN_PAGES.iter().map(|s| (*s).to_string()).collect(),
    }
}

/// Dependency-free standard base64 (the payload is a PNG data URI; no b64
/// crate is in the dependency tree).
fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Vietnamese diacritic letters (precomposed) whose presence is the
/// byte-correctness probe for the vi pages.
const DIACRITICS: &str = "ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵĂÂĐÊÔƠƯ";

struct Metrics {
    chars: usize,
    pipe_rows: usize,
    has_html_table: bool,
    heading_lines: usize,
    dollar_count: usize,
    diacritics: usize,
    truth_tokens: usize,
    truth_hits: usize,
}

fn measure(text: &str, truth: &str) -> Metrics {
    let pipe_rows = text.lines().filter(|l| l.trim_start().starts_with('|')).count();
    let heading_lines = text
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            t.starts_with('#') && !t.starts_with("#!") && t.trim_start_matches('#').starts_with(' ')
        })
        .count();
    let truth_tokens: Vec<String> = truth
        .split_whitespace()
        .map(|w| w.to_lowercase())
        .filter(|w| w.chars().count() >= 3)
        .collect();
    let lower = text.to_lowercase();
    let truth_hits = truth_tokens.iter().filter(|w| lower.contains(w.as_str())).count();
    Metrics {
        chars: text.chars().count(),
        pipe_rows,
        has_html_table: text.contains("<table"),
        heading_lines,
        dollar_count: text.matches('$').count(),
        diacritics: text.chars().filter(|c| DIACRITICS.contains(*c)).count(),
        truth_tokens: truth_tokens.len(),
        truth_hits,
    }
}

#[tokio::test]
#[ignore = "real engine + GPU required; run with --ignored on the dev machine"]
async fn prompt_ab_matrix_runs_golden_pages_over_prompt_cells() {
    let Some(paths) = engine_paths() else {
        panic!(
            "no engine found — install via the app Settings (v0.6.0 path) or provide \
             temp/native-engine-spike artifacts"
        );
    };
    for cell in selected_cells() {
        for stem in selected_pages() {
            let raster = raster_path(cell.long_edge, &stem);
            assert!(
                raster.is_file(),
                "missing raster {} — run: NODE_OPTIONS=--max-old-space-size=8192 node tests/fixtures/gen.mjs",
                raster.display()
            );
        }
    }

    let state = Arc::new(NativeEngineState::new());
    *state.startup_timeout_base.lock().unwrap() = Duration::from_secs(45);
    let EnginePhase::Ready { port, .. } = start(state.clone(), paths, true, None)
        .await
        .expect("engine must reach Ready")
    else {
        unreachable!()
    };
    let api_key = state.api_key.lock().unwrap().clone().unwrap();
    let client = reqwest::Client::builder().build().unwrap();
    let base_url = format!("http://127.0.0.1:{port}");

    let out_dir = out_root();
    std::fs::create_dir_all(&out_dir).unwrap();

    for cell in selected_cells() {
        let cell_dir = out_dir.join(cell.name);
        std::fs::create_dir_all(&cell_dir).unwrap();
        let mut metrics_log = String::new();
        for stem in selected_pages() {
            let png = std::fs::read(raster_path(cell.long_edge, &stem)).unwrap();
            let data_url = format!("{IMAGE_DATAURI_PREFIX}{}", base64(&png));
            let truth = std::fs::read_to_string(truth_path(&stem)).unwrap();
            let frames: Arc<std::sync::Mutex<Vec<TokenFrame>>> =
                Arc::new(std::sync::Mutex::new(Vec::new()));
            let sink = frames.clone();
            let r = ocr_request(
                &client,
                &base_url,
                &api_key,
                &data_url,
                cell.prompt,
                pdftoolkit_lib::native_engine::ocr::DEFAULT_MAX_TOKENS,
                false,
                &move |f| sink.lock().unwrap().push(f),
                &CancellationToken::new(),
            )
            .await
            .unwrap_or_else(|e| panic!("cell {} page {stem}: {e}", cell.name));
            std::fs::write(cell_dir.join(format!("{stem}.md")), &r.text).unwrap();
            let m = measure(&r.text, &truth);
            metrics_log.push_str(&format!(
                "{{\"page\":\"{stem}\",\"ms\":{},\"first_token_ms\":{},\"gen_tokens\":{},\"tok_per_sec\":{:.1},\"chars\":{},\"pipe_rows\":{},\"has_html_table\":{},\"heading_lines\":{},\"dollar_count\":{},\"diacritics\":{},\"truth_tokens\":{},\"truth_hits\":{}}}\n",
                r.ms,
                r.first_token_ms,
                r.gen_tokens,
                r.tok_per_sec,
                m.chars,
                m.pipe_rows,
                m.has_html_table,
                m.heading_lines,
                m.dollar_count,
                m.diacritics,
                m.truth_tokens,
                m.truth_hits,
            ));
            println!(
                "[{}] {stem}: ms={} tok/s={:.0} chars={} pipe_rows={} headings={} $={} diag={} truth={}/{}",
                cell.name,
                r.ms,
                r.tok_per_sec,
                m.chars,
                m.pipe_rows,
                m.heading_lines,
                m.dollar_count,
                m.diacritics,
                m.truth_hits,
                m.truth_tokens,
            );
        }
        std::fs::write(cell_dir.join("metrics.jsonl"), &metrics_log).unwrap();
    }

    shutdown_all(&state).await;
    println!("outputs in {}", out_dir.display());
}
