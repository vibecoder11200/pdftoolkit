// Static server for the desktop e2e project: serves dist-desktop at the
// ROOT (base '/', like the Tauri webview does) on port 4181.
process.env.TAURI_ENV_PLATFORM = process.env.TAURI_ENV_PLATFORM || 'windows';
const { preview } = await import('vite');
await preview({
  build: { outDir: 'dist-desktop' },
  preview: { port: 4181, strictPort: true },
});
await new Promise(() => {}); // keep the server alive for the runner
