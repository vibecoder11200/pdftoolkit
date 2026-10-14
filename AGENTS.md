<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **pdftoolkit** (2860 symbols, 7168 relationships, 237 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/pdftoolkit/context` | Codebase overview, check index freshness |
| `gitnexus://repo/pdftoolkit/clusters` | All functional areas |
| `gitnexus://repo/pdftoolkit/processes` | All execution flows |
| `gitnexus://repo/pdftoolkit/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

# Operational rules (project-specific — each rule comes from a real incident)

## 1. Public-repo discipline (violated once already — do not repeat)

- **This repo is PUBLIC.** `plans/`, `docs/`, `wireframes/` are **local-only**
  (internal planning, research, design refs). They are gitignored. Never stage
  them; never run bare `git add -A` / `git add .` — stage explicit paths.
- Before every push, verify the index:
  `git ls-files | grep -E '^(plans|docs|wireframes|temp)/'` must print nothing.
- If internal content ever reaches history, deleting the files is not enough —
  rewrite history:
  `git filter-branch --index-filter 'git rm -r --cached --ignore-unmatch -q plans docs wireframes' -- --all`,
  then delete the `refs/original/*` backup refs, `git reflog expire --expire=now --all`,
  `git gc --prune=now --aggressive`, force-push, and re-point any tags/releases.
- `temp/`, `render-check/`, `test-results/`, `dist/`, and generated PDF
  fixtures are gitignored build/research artifacts too.

## 2. Git identity

- **Never** pass `-c user.name=...` / `-c user.email=...` overrides. The global
  git config (`vibecoder11200 <vpsviet11200@gmail.com>`) is authoritative — a
  `zk <zk@local>` override once produced a misattributed public history that
  had to be rewritten. Verify `git config user.email` before the first commit
  in any fresh clone or `git init`.

## 3. Two test runners share `tests/`

- `npm test` (vitest, node-side): everything EXCEPT `tests/*.e2e.spec.ts`
  (excluded in `vite.config.ts`). Plain `foo.spec.ts(x)` files are vitest.
- `npm run test:e2e` (Playwright, chromium): `testMatch` is
  `**/*.e2e.spec.ts` — browser specs MUST be named `foo.e2e.spec.ts`.
- New node-side spec: just add the file. New browser-side spec: name it
  `*.e2e.spec.ts` (the suffix is what keeps the runners apart — since phase 4
  there is no per-file config edit; getting the name wrong lands the spec in
  the wrong runner or in neither).
- `npm test` needs fixtures first: `node tests/fixtures/gen.mjs` (fixtures are
  gitignored).
- The 100MB tier is opt-in: `node tests/fixtures/gen.mjs --large` then
  `MATRIX_100MB=1 npx vitest run tests/matrix-100mb.spec.ts --no-file-parallelism`
  (its own file + own process since 2026-10-09 — the old single-process
  tier stacking OOM'd every nightly; lift the heap to 8192 for it too).
  Fixture generation
  needs a big heap: `NODE_OPTIONS=--max-old-space-size=8192`.

## 4. Build invariants (breaking any of these ships a broken app)

- `vite.config.ts` aliases `js-pdf-signer` → `src/index.js` (CJS). The
  package's `browser` field is an export-less IIFE; without the alias the
  digital-signature feature dies in the browser build while vitest stays
  green. Do not remove the alias — the Playwright test
  "digital self-sign downloads a signed PDF" guards it.
- pdf.js standard fonts are precached via workbox `globPatterns` (NOT
  `includeAssets`, which only sees `publicDir/`), with sha256 revisions pinned
  in `manifestTransforms`. Those revisions are recomputed from package
  contents in `vite.config.ts` at build time — keep that code when editing
  the config.
- The service worker is a custom `src/sw.ts` built via `injectManifest`
  (phase 6a, migrated from `generateSW`). `src/sw.ts` MUST keep:
  `precacheAndRoute(self.__WB_MANIFEST)` (the injection point — the build
  replaces it), `cleanupOutdatedCaches()`, `clientsClaim()` (generateSW
  parity — without it a controller-less page, e.g. after a hard reload,
  never gets controllerchange when the waiting worker activates), the
  `NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/api/] })`
  SPA fallback, and the `SKIP_WAITING` message listener (`registerType:
  'prompt'` depends on it; `use-app-update.tsx` sends the message). The
  update banner owns its reload itself — postMessage SKIP_WAITING + reload
  on controllerchange/activation/stall-timer — because the plugin's
  `updateServiceWorker` reload path is unreliable exactly there
  (vite-plugin-pwa#789); do not "simplify" it back to `updateServiceWorker`.
  The SW also answers `REQUEST_BUILD_COMMIT` with its inlined `BUILD_COMMIT`
  (define reaches the SW build — the identifier must stay bare; define never
  replaces string literals); a waiting worker reporting the SAME commit as
  the page is activated SILENTLY (hard-reload case — no banner), and
  `tests/update-flow.e2e.spec.ts` gates both scenarios by mutating
  `dist/sw.js` between page loads.
  Two gates
  guard the manifest: `scripts/precache-diff.mjs` (diff `{url, revision}` vs
  `plans/precache-baseline.sw.js` — local-only; refresh it when the diff shows
  only intentional deltas) and
  `tests/sw-precache.spec.ts` (qpdf.wasm + font sha256 pins in `dist/sw.js`).
  In 6b the share-target fetch handler was added to the same file, and its
  client-side listener MUST stay on `navigator.serviceWorker` (never `window`
  — same-origin messages on the github.io shared origin are spoofable).
- The pdf.js and pdfsigner chunks must stay lazy:
  `src/hooks/use-thumbnails.ts` loads the renderer via dynamic import. Do not
  convert it to a static import (~400KB+ would move into the entry bundle).
- On Windows, a stray `NUL` file (reserved name) blocks `git add` entirely;
  delete it with Node:
  `node -e "require('fs').unlinkSync('D:/pdftoolkit/NUL')"`.

### Desktop/Tauri invariants (v0.4.0 phase 1+)

- `vite.config.ts` `base` is `'/'` iff `TAURI_ENV_PLATFORM` is set (the tauri
  CLI sets it for both dev and build) — **NEVER `'./'`** (a reload at
  /tools/* resolves assets against the route; Tauri's no-redirect fallback
  serves index.html as JS → blank window, tauri#12332). Web keeps
  `/pdftoolkit/`.
- **CSP is per-target**: web meta CSP = v0.3.0 CSP + `'wasm-unsafe-eval'`
  ONLY (byte-guard: `temp/csp-baseline-index.html` diff / review gate);
  desktop swaps the meta via the `desktop-csp` transformIndexHtml plugin and
  carries the identical string in `src-tauri/tauri.conf.json`
  `security.csp` — edit the two together.
- `src/hooks/use-app-update.tsx` gates SW registration on `!isTauri()`
  (`src/lib/platform.ts`). Do NOT switch back to `useRegisterSW` — it calls
  `registerSW()` unconditionally (its `immediate` only shifts timing), so the
  gate must stay on the plain `virtual:pwa-register` `registerSW` call.
- `src-tauri/tauri.conf.json` has NO version literal — `"../package.json"`
  is the single version source (CI asserts tag == conf version == package).
- **Release channel split (D5/R6)**: web releases are ALWAYS cut with
  `gh release create v* --latest=false` — `releases/latest` must stay the
  DESKTOP channel (the updater endpoint resolves latest.json from it).
  Desktop releases: tag `app-v*` → `desktop-release.yml` (4 legs build with
  `includeUpdaterJson: false`; the `publish` job composes latest.json once,
  asserts 4 platform keys + tag==version, appends sha256 checksums). The
  updater minisign PRIVATE key lives ONLY in `temp/tauri-signing/`
  (gitignored) + GitHub Secrets — never commit it; losing key or password
  strands the desktop fleet on "up to date" forever.
- `dist/` is DESKTOP-flavored after `npm run tauri build` (base '/', desktop
  CSP). Before any web gate (`npm test` sw-precache specs / `test:e2e` /
  deploy), rerun plain `npm run build`; `tests/sw-precache.spec.ts` asserts
  every index.html asset URL stays under `/pdftoolkit/` as the tripwire.
- **Router basename follows `import.meta.env.BASE_URL`** (`src/routes.tsx`) —
  NEVER hardcode `/pdftoolkit`: it blank-rendered the entire desktop window
  (rc-probe regression; web looked fine because the app IS served under
  /pdftoolkit there).
- **Save flow (rc-probe regression #2)**: WebView2's `<a download>` drops
  files silently (no chooser, no visible path). Every tool deliver MUST go
  through `deliverBytes`/`deliverBytesMulti` (`src/lib/download.ts`) — on
  desktop they intercept to the native Save-As dialog (plugin-dialog +
  plugin-fs; multi-output = one dialog, siblings written beside via the
  `$HOME/**` fs scope). Never call `downloadBytes` directly from a tool.
  The FSA toggle (`canSaveElsewhere`) is web-only by design.
- **Desktop e2e**: `npm run test:e2e` runs BOTH projects — `chromium` (web
  dist, `/pdftoolkit/` base) and `desktop` (`*.desktop.e2e.spec.ts` against
  `dist-desktop/` served at ROOT with `__TAURI_INTERNALS__` mocked; scripts
  `scripts/build-desktop.mjs` + `preview-desktop.mjs`). Desktop specs must be
  named `*.desktop.e2e.spec.ts` so the web project ignores them.
- CI: macos-13 (Intel) runners are RETIRED (jobs queue forever) — the Intel
  macOS leg cross-compiles `x86_64-apple-darwin` on `macos-latest`.
- OCR assets: `scripts/sync-tessdata.mjs` copies tesseract core+tessdata
  from node_modules into `public/` (first step of `npm run build`). OCR
  binaries are NEVER committed; `scripts/tessdata-manifest.json` (committed)
  pins their sha256. They are deliberately NOT in the SW precache (~28MB
  measured vs the hard 17MB precache budget) — `src/lib/ocr.ts` fetches them
  same-origin on first use into a Cache API store (web: offline after the
  first OCR run; desktop: always on disk via the bundle).

### Native OCR engine invariants (v0.6.0, llama.cpp sidecar)

- **The updater `on_before_exit` hook is MANDATORY for any child-process
  feature** (Windows `exit(0)` bypasses RunEvent). DOCUMENTED DEVIATION:
  tauri-plugin-updater 2.13.1 exposes `on_before_exit` ONLY on
  `UpdaterBuilder` (updater.rs:407), never on the app-facing plugin
  `Builder`, and `UpdaterExt::updater_builder()` is blanket-impl'd
  (cannot override) — see the long comment at the plugin registration in
  `src-tauri/src/lib.rs`. The engine invariant holds through the pre-decided
  fallback: the child lives in a KILL_ON_JOB_CLOSE Job Object (kernel reaps
  it at the exact moment the process dies on `exit(0)`), plus the startup
  stray sweep. Do NOT "fix" the bare `.build()` without re-reading that
  comment.
- `restart_with_gpu_force` MUST call `shutdown_all` before its `exit(0)`s,
  and the Unix startup stray sweep is mandatory (`std::process::exit` skips
  the supervisor's Drop — review F6 of the v0.6.0 plan).
- Engine binaries + GGUFs are pinned in `scripts/native-engine-manifest.json`
  (committed; `scripts/sync-native-engine.mjs` re-pins API-only, `--check`
  gates CI). NEVER commit engine/model binaries; NEVER precache them (17MB
  SW budget). Extracted files are hash-mapped in `installed.json` markers
  and re-verified at EVERY engine start (quarantine = tamper detection).
- Engine storage lives under `app_local_data_dir()/pdftoolkit-native/` —
  NEVER roaming `app_data_dir` (1.4GB must not sync).
- The sidecar CSP is UNCHANGED by design: the webview never fetches the
  sidecar — all traffic is proxied through Rust (`native_engine::ocr`), so
  NO connect-src addition is ever needed. A PR touching the CSP triple
  (index.html meta / desktop-csp plugin / tauri.conf.json) "for the native
  engine" is a smell.
- llama-server argv is FROZEN from the phase 1 spike (`SERVER_ARGS_TAIL` in
  `native_engine/mod.rs`): b11553 removed `--no-log-colors` (→
  `--log-colors off`), needs `--verbose` for the device/engagement lines,
  and rejects unnormalized/`\\?\` paths (store::normalize). llamaTag is
  pinned (`PINNED_LLAMA_TAG`) and asserted against the manifest in cargo
  tests + against the authenticated `/props` `build_info` at every start.
- Startup classification (`classify_startup_exit`): the stderr-tail
  keywords (`classify_stderr_tail`) outrank BOTH the unix signal and the
  exit code on every platform — a real GGML assert dies via `abort()`
  (SIGABRT on unix) with the telltale line on stderr, and the signal
  branch must not mask it as `Crashed(-6)`. Only a SIGKILL with an empty
  tail keeps its special `BlockedByOs` meaning.
- Desktop native e2e specs are `*.desktop.e2e.spec.ts` and MUST use the
  `tests/helpers/tauri-mock.ts` seam (registry-based `transformCallback` +
  `{message,index}`/`{end,index}` frame shapes — byte-compat with the real
  Channel is pinned by `tests/tauri-mock-channel.spec.ts` running the REAL
  Channel class). Never a bespoke `__TAURI_INTERNALS__` in new specs.
  `tests/src-purity.spec.ts` is the src↛tests import gate (tsconfig is a
  single project — tsc does NOT enforce the boundary).

### OCR output invariants (v0.7.0)

- **Sandwich PDF** (`src/lib/ocr-sandwich.ts`): the invisible text layer is
  ALWAYS the subset Roboto via `drawText(..., { opacity: 0 })` — never raw
  `pushOperators`/Tr 3 (the `fontKey` trap: `font.name` instead of the mangled
  `page.fontKey` renders fine and is silently unsearchable). The build is
  CLICK-TIME from `files[0].bytes` + `aiResults[i].text` — never from bytes
  retained through the run loop, and never from the joined done-view artifact
  (its `--- N trang ---` separators are locale-dependent). The canvas is the
  module's OWN — never the run's shared canvas. Text layer carries DISPLAY
  text (`displayLines`), not markdown syntax.
- **DOCX export** (`src/lib/markdown-docx.ts`): `docx` chunks are lazy and
  only load inside the PDF worker on first export; Packer serialization forks
  on `Blob` (`toBlob` in the worker, `toBuffer` in node — jszip NODEBUFFER
  dies in the browser). Math interception happens INSIDE `ai-markdown.ts`'s
  inline stage (`data-latex` carrier spans, gated by the `mathSafe`
  length/brace-depth pre-check) — never a whole-string `$`-split (it shreds
  tables). `latexToMath` failures must never fail the export (docx/html's
  invalid-math path keeps the literal text).
- **Prompt parity**: the native `OCR_PROMPT` (`ocr.rs`) and the web worker's
  twin are byte-locked and ENFORCED by `tests/ocr-prompt-parity.spec.ts`
  (v0.7.0 A/B verdict: the long instruction prompt BEAT the terse
  trained-prefix prompts on headings; keep it). Web raster stays capped at
  1024 long edge (+700 MB RAM verdict); native ships uncapped 150-DPI PNGs.
  llama.cpp PR #17383 (CUDA rel-pos/window vision ops) is UNMERGED — the
  optional win-x64/cuda-12.4 leg would run GLM-OCR's vision encoder on CPU;
  win-x64/vulkan remains the shipped Windows backend.
- **Page selection**: `runAiPages({ pages })` (sorted selection) replaces the
  loop enumeration; resume filters it to `>= startPage`; progress/benchmark
  denominators use the selection count (`completedBefore` counts toward the
  benchmark record threshold, recorded ONCE per run). The benchmark record
  predicate is PRESET IDENTITY (`tuning === AI_TUNING_PRESETS.full`), never a
  literal 1024/4096 comparison.

## 5. GitHub Pages deploy

- Site: https://vibecoder11200.github.io/pdftoolkit/ — deployed from `main` by
  `.github/workflows/pages.yml` (`build_type=workflow`). PRs build but never
  deploy; the nightly job only runs the 100MB matrix.
- If deploy fails at `configure-pages` with "Resource not accessible by
  integration" on a fresh repo, enable Pages once with the user token:
  `gh api -X POST repos/<owner>/pdftoolkit/pages -f build_type=workflow`.
  The workflow's `configure-pages` step then acts as an idempotent guard.

## 6. Definition of done

All green before reporting complete:

```bash
npx tsc --noEmit && npm test && npm run build && npm run test:e2e
```

(e2e runs against `dist/`, so build must precede it.)
