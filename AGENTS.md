<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **pdftoolkit** (801 symbols, 2026 relationships, 63 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
  `MATRIX_100MB=1 npx vitest run tests/matrix.spec.ts`. Fixture generation
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
- OCR assets: `scripts/sync-tessdata.mjs` copies tesseract core+tessdata
  from node_modules into `public/` (first step of `npm run build`). OCR
  binaries are NEVER committed; `scripts/tessdata-manifest.json` (committed)
  pins their sha256. They are deliberately NOT in the SW precache (~28MB
  measured vs the hard 17MB precache budget) — `src/lib/ocr.ts` fetches them
  same-origin on first use into a Cache API store (web: offline after the
  first OCR run; desktop: always on disk via the bundle).

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
