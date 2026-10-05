<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **pdftoolkit** (491 symbols, 1250 relationships, 38 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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

- `npm test` (vitest, node-side): `engine.spec.ts`, `matrix.spec.ts`,
  `thumbnails.spec.tsx`. `tests/smoke.spec.ts` is excluded in `vite.config.ts`.
- `npm run test:e2e` (Playwright, chromium): `testMatch` is only
  `**/smoke.spec.ts`.
- New node-side spec: just add the file. New browser-side spec: update BOTH
  `playwright.config.ts` (`testMatch`) and `vite.config.ts` (vitest `exclude`)
  — otherwise each runner picks up the other's specs and both suites go red.
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
- The pdf.js and pdfsigner chunks must stay lazy:
  `src/hooks/use-thumbnails.ts` loads the renderer via dynamic import. Do not
  convert it to a static import (~400KB+ would move into the entry bundle).
- On Windows, a stray `NUL` file (reserved name) blocks `git add` entirely;
  delete it with Node:
  `node -e "require('fs').unlinkSync('D:/pdftoolkit/NUL')"`.

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