# PDF Toolkit

Merge, split, compress, convert and sign PDFs — 100% in your browser. Files never leave your device; after the first load the app works fully offline.

**Live app:** https://vibecoder11200.github.io/pdftoolkit/

[![pages](https://github.com/vibecoder11200/pdftoolkit/actions/workflows/pages.yml/badge.svg)](https://github.com/vibecoder11200/pdftoolkit/actions/workflows/pages.yml)
[![agpl-grep](https://github.com/vibecoder11200/pdftoolkit/actions/workflows/agpl-grep.yml/badge.svg)](https://github.com/vibecoder11200/pdftoolkit/actions/workflows/agpl-grep.yml)

## Why

Most "free PDF tools" upload your documents to a server. This one doesn't: every operation runs client-side in a Web Worker (pdf-lib + qpdf-wasm + pdf.js). There is no backend, no account, no telemetry, no runtime CDN.

## Tools (24)

| Organize | Convert & optimize | Security & sign |
|---|---|---|
| Merge · Split ranges · Extract pages · Delete pages · Reorder (drag & drop, touch-friendly) · Rotate · Fill form · **Blank-page removal** (detect → review → remove) | Compress (lossless vector pack · opt-in image recompress · web-optimizer/linearize) · PDF → images (multi-page: one ZIP) · **PDF → Word (.docx)** · Images → PDF (pick a whole folder) · OCR (Tesseract → searchable PDF; AI → Markdown/text/HTML/DOCX) · Watermark (text or image stamp, tiled, page-scoped — **plus removal**) · Page numbers (presets + token templates) · **Compare PDFs** (word-level diff) | Encrypt / decrypt (AES-256) · Metadata view & edit · Sign (image stamp or self-signed PKCS#7) · **Editor** (redact · annotate · edit text · crop) |

**Watermark & page numbers** (v0.8.0): form-based stamping with a 9-grid anchor, rotation-aware placement (correct on rotated pages with crop boxes), Vietnamese-safe text through the embedded subset font, optional tiled mode, per-page scope, and day-1 whole-folder batch on the watermark tool (per-file report, one native Save-As on desktop). **Watermark removal** (v0.8.1): files this app stamped are removed exactly (ownership tag); foreign text watermarks get a best-effort heuristic removal (type the watermark text as a hint) — content is never touched: only fully-matching stamp blocks are removed, anything ambiguous fails safe with a typed error.

**Editor** (v0.9.0 — 'Sửa PDF', four tabs in one tool; desktop/tablet screens — on a phone the tool says so honestly instead of pretending):

- **Redact** ('Che đi'): two modes, stated up front. *Surgical* removes text objects matching your marks or sensitive keywords and rewrites the whole file, then scrubs the document channels (metadata, XObjects, patterns) — every output passes a byte-level verification scan for the removed secrets in 5 encodings, and any residue fails the export (nothing is delivered). Flagged page types (Type3 fonts, no-ToUnicode text, patterns, OCR-style layers) fall back to a *burned-in raster* mode that cannot leak. Signed files are refused up front.
- **Edit text** ('Sửa chữ'): click a text run, white it out and re-typeset the replacement in a matching embedded font — for fixing typos and small phrases, not full reflow.
- **Annotate** ('Ghi chú'): text, highlight, notes, ellipse/rectangle/line stamps — real /AP annotations, still selectable in other readers.
- **Crop** ('Cắt'): drag a crop box or let auto-suggest find the content bounds; CropBox only (MediaBox untouched, rotation-aware). Crop is honest about not destroying content — an explicit "crop as redaction" toggle routes the trimmed-away area through the verified redact pipeline instead.

![Redact demo](screenshots/editor-demo.gif)

| Redact (Che đi) | Annotate (Ghi chú) |
|---|---|
| ![Redact](screenshots/editor-redact-vi.jpg) | ![Annotate](screenshots/editor-annotate-vi.jpg) |

| Crop auto-suggest | On a phone (honest copy) |
|---|---|
| ![Crop](screenshots/editor-crop-vi.jpg) | ![Phone](screenshots/editor-phone-en.jpg) |

**On phones**: all classic tools are designed phone-first (large touch targets, sheet-based controls; page reorder works by pointer drag). The editor's canvases need a larger screen for precise marking, so on phone widths it shows guidance instead.

**PDF → Word** (v0.10.0 — 'PDF sang Word', 100% on-device like everything else): digital PDFs convert from the text layer through a layout engine built in-house — baseline line grouping, recursive XY-cut reading order, x-projection gutter columns for two-column documents, ruled-table recovery by cell alignment, and (v0.10.2) borderless-table recovery by whitespace-gutter geometry — right-aligned numbers, sparse cells and statement-style tables without ruling lines (pipes, dollars and hostile cell text survive intact). Output is Markdown in the same dialect the AI-OCR path emits, rendered to DOCX with real Word headings, lists and bordered tables. Scanned pages route through the on-device AI OCR engine — after your explicit confirmation (the model is a ~652 MB one-time download). The fidelity contract is stated in the tool: you get text, headings, lists, ruled and borderless tables in reading order — not layout-identical pages; magazine layouts and exact fonts may need cleanup, and borderless detection is best-effort (guarded refusals degrade to plain lines, never false tables). Algorithm references (concepts only, no code adopted): Nagy et al.'s XY-cut; pdfminer.six's LAParams tuning surface; pdfplumber's alignment and borderless strategies (all MIT).

**Compare PDFs** (v0.11.0 — 'So sánh PDF'): word-level diff between two revisions, 100% on-device. Pages align by content (an edited page stays paired with its original; inserted/removed pages get honest banners), then the word diff paints green inserted boxes on the revised page and red strikethrough on the original — a single-pair viewer with an A/B toggle and changed/added page badges. Pages with too little text in common (replaced pages) are reported as removed+added instead of pretending; whole-document structural mismatches say so up front. Optional export produces TWO annotated PDFs (marks drawn into both files). Scanned pages have no text layer — after your explicit confirmation the on-device AI OCR reads them and shows a text-level clause list instead (never in the annotated export). Everything streams with cancel; an engine crash surfaces with Retry.

**Blank-page removal** (v0.11.0 — 'Xóa trang trắng'): scans at ~30 DPI with two criteria (ink ≤ 0.5% AND grey stddev ≤ 5) so scanner-noise white reads blank while solid-colored pages never do. Pages with a text layer are kept without rendering; blank pages auto-check for removal, near-blank and unverifiable pages never do — a failed raster allocation reads "unverifiable", never blank, so real content cannot be silently deleted. You review the verdict badges per page before anything is removed.

**Organizer** (v0.12.0 ): drag-to-reorder across multiple source documents, page rotation, extraction to a new file, and bookmarks — all in one canvas (category 'org', tool #21).

**Tables** (v0.12.0 ): multi-table detection per page (band-split reuse of the pdf2word detector, rotated bands refused), editable grid with undo/redo, join across pages, and safe export — CSV neutralizes formula injection (=, +, -, @, tab, full-width variants; raw mode is explicit) and XLSX is data-only via ExcelJS (leading-zero IDs stay text, >15-digit precision fallback, ISO-only dates). Scanned pages route through the on-device AI OCR with review warnings + null confidence (tool #22).

**Scan cleanup** (v0.12.0): deskew (projection-variance search verified by a plant-skew closure test), manual rotation with an OS-orientation SUGGESTION (never auto-applied — the local detector mirrored 90/270 in the spike corpus, disclosed in-app), grayscale/flatten/threshold enhancement, and page-cap/edge budgets (tool #23).

**Diagnostics & repair** (v0.12.0 — tool #24): a read-only qpdf '--check' report (openability, password requirement, page count, sanitized structural warnings) that is explicitly NOT a security scan, plus user-triggered best-effort repair writing NEW output only — signed inputs refuse, encrypted inputs need the password (used for the run, never stored), unrecoverable damage refuses with NO output, and when the original is unreadable the result is labelled unverifiable (no parity claim). The same operations are batchable in the queue panel.

**Batch queue** (v0.12.0): merge/compress/diagnose/repair over picked files with an explicit state machine (illegal transitions throw), cardinality validation naming the exact bad step BEFORE any execution, one heavy-executor slot, pause/resume at safe boundaries, cooperative cancellation, and a delivery LEDGER — a partial save retries ONLY the undelivered ids, never re-delivering successes. The queue holds an active job while work can resume so the updater/restart confirmation includes it.

**Continue with result**: after a successful single-PDF run, the done view offers a handoff chip — pick the next PDF tool (OCR included since v0.8.1), the output parks there automatically, and you keep chaining (merge → page numbers → watermark …) without re-uploading anything. OCR's AI searchable-PDF builds at click time — nothing is retained until you pick a target.

**Chuỗi nhanh** (v0.8.1): four one-click chains on the home page — Gộp → Nén, Ảnh scan → OCR → Đánh số, Watermark → Nén, Giải mã → Gộp. Each step opens pre-filled with sensible defaults you can edit before running, and the result flows into the next step automatically.

## OCR — Tesseract + on-device AI (experimental)

The OCR tool ships two engines. **Tesseract** (eng+vie) produces searchable PDFs. The optional **AI engine — GLM-OCR — runs fully on your device** and targets complex layouts — tables, multi-column pages, poor scans — with richer outputs: Markdown, plain text, sanitized HTML, DOCX, and (since v0.7.0) a **searchable PDF** with an invisible text layer (per-word highlight positions are approximate). A page-range picker limits the run to the pages you choose.

- **WebGPU required** (browser engine). The tool checks your GPU first and reports the detected tier honestly: strong (fast), weak (roughly a minute per page on integrated graphics) or none (the AI engine stays disabled; Tesseract works everywhere). A real throughput benchmark runs after your first pages and stays on-device.
- **~652 MB one-time model download** (browser engine) from HuggingFace (pinned revision, sha256-verified per file). The model then lives in your browser's storage and AI OCR works fully offline — manage or delete it any time under **Settings → Storage on this device**.
- **Desktop app only: a native engine.** The desktop build can additionally install a native OCR engine (llama.cpp, Vulkan on Windows) — same AI outputs, noticeably faster than the browser engine. ~1.4 GB download, managed under Settings.
- **Your documents never leave the machine.** Only the model itself is downloaded, once; pages are rasterized and processed locally.
- Known limits: generation peaks around 4 GB RAM, so 8 GB machines may swap.

## Extras

- **Batch folders**: merge, Images→PDF, compress and watermark can ingest an entire folder (filter, name-sort, 0-byte skip; 500 MB total batch budget).
- **Open with PDF** (Chromium/Edge installed as PWA): OS "Open with" hands PDFs straight to the app — an existing session is never disturbed (focus-existing; files land in the suggestion sheet on Home, or a banner on tool pages). Firefox/Safari are unaffected.

## Download (desktop, Windows/macOS/Linux)

Grab the current installer from the [latest desktop release](https://github.com/vibecoder11200/pdftoolkit/releases/latest) (`app-v*` tag):

| Platform | File |
|---|---|
| Windows 10/11 x64 | `PDF Toolkit_<version>_x64-setup.exe` (NSIS) |
| macOS Apple Silicon | `PDF Toolkit_<version>_aarch64.app.tar.gz` |
| macOS Intel | `PDF Toolkit_<version>_x64.app.tar.gz` |
| Linux | `pdf-toolkit_<version>_amd64.AppImage` / `.deb` |

Verify with the sha256 checksum table in each release body. **The builds are unsigned** (no paid code-signing certificate): Windows SmartScreen shows "unknown publisher" (More info → Run anyway); macOS needs right-click → Open or `xattr -cr "/Applications/PDF Toolkit.app"` after copying to /Applications. The desktop app auto-updates through a minisign-signed manifest (`latest.json`) published with every `app-v*` release; macOS and Linux binaries are build-verified but not smoke-tested — Windows is the probed platform.

## Privacy

- All processing runs 100% client-side; files do not leave the machine.
- No telemetry, no runtime CDN imports — the service worker precaches everything.
- Passwords are never stored after the operation completes.
- Self-signed digital signatures are created on your device and will be flagged "untrusted" by readers — no CA is involved.

## Development

Requires Node 24.

```bash
npm install
node tests/fixtures/gen.mjs      # generate test PDF fixtures (gitignored)
node scripts/gen-icons.mjs       # regenerate favicon/app icons from src/assets/logo.svg geometry
npm run dev                      # dev server
npm run build                    # typecheck + production build to dist/
npm test                         # engine + matrix suites (vitest)
npm run test:e2e                 # Playwright (Chromium) against the preview build

NODE_OPTIONS=--max-old-space-size=8192 MATRIX_100MB=1 node tests/fixtures/gen.mjs --large   # optional: 100MB nightly fixture
NODE_OPTIONS=--max-old-space-size=8192 MATRIX_100MB=1 npx vitest run tests/matrix-100mb.spec.ts --no-file-parallelism   # 100MB matrix tier (own process — it OOMs when stacked)
```

The app is deployed to GitHub Pages under `/pdftoolkit/` (see `.github/workflows/pages.yml`: PRs run the 1/10MB matrix, a nightly job runs the 100MB tier and publishes the report as an artifact).

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

**Attribution:** written from scratch; no third-party application code is vendored. The product shape was informed by studying public tools — PDFCraft and Stirling-PDF (both AGPL-3.0: studied only, no code taken), PDFLince, and private-pdf (MIT, direct pattern reference) — without reusing their code. CI keeps `src/` free of AGPL code, telemetry beacons and runtime CDN imports.
