# PDF Toolkit

Merge, split, compress, convert and sign PDFs — 100% in your browser. Files never leave your device; after the first load the app works fully offline.

**Live app:** https://vibecoder11200.github.io/pdftoolkit/

[![pages](https://github.com/vibecoder11200/pdftoolkit/actions/workflows/pages.yml/badge.svg)](https://github.com/vibecoder11200/pdftoolkit/actions/workflows/pages.yml)
[![agpl-grep](https://github.com/vibecoder11200/pdftoolkit/actions/workflows/agpl-grep.yml/badge.svg)](https://github.com/vibecoder11200/pdftoolkit/actions/workflows/agpl-grep.yml)

## Why

Most "free PDF tools" upload your documents to a server. This one doesn't: every operation runs client-side in a Web Worker (pdf-lib + qpdf-wasm + pdf.js). There is no backend, no account, no telemetry, no runtime CDN.

## Tools (12)

| Organize | Convert & optimize | Security & sign |
|---|---|---|
| Merge · Split ranges · Extract pages · Delete pages · Reorder (drag & drop) · Rotate | Compress (lossless vector pack + opt-in image recompress) · PDF → images · Images → PDF | Encrypt / decrypt (AES-256) · Metadata view & edit · Sign (image stamp or self-signed PKCS#7) |

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
npm run dev                      # dev server
npm run build                    # typecheck + production build to dist/
npm test                         # engine + matrix suites (vitest)
npm run test:e2e                 # Playwright (Chromium) against the preview build

MATRIX_100MB=1 node tests/fixtures/gen.mjs --large   # optional: 100MB nightly fixture
MATRIX_100MB=1 npx vitest run tests/matrix.spec.ts   # run the 100MB matrix tier
```

The app is deployed to GitHub Pages under `/pdftoolkit/` (see `.github/workflows/pages.yml`: PRs run the 1/10MB matrix, a nightly job runs the 100MB tier and publishes the report as an artifact).

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Idea-level attribution in [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md); no third-party application code is vendored.
