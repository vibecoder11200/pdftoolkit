// Desktop-flavored front-end build for the desktop e2e project.
// Mirrors `npm run build` (tessdata sync first) but with the TAURI env set —
// the vite config switches base to '/' and swaps in the desktop CSP — and
// an isolated outDir so the web-flavored dist/ is never clobbered
// (tests/sw-precache.spec.ts guards that flavor).
process.env.TAURI_ENV_PLATFORM = process.env.TAURI_ENV_PLATFORM || 'windows';
await import('./sync-tessdata.mjs');
const { build } = await import('vite');
await build({ build: { outDir: 'dist-desktop', emptyOutDir: true } });
console.log('dist-desktop built (desktop flavor, base /)');
