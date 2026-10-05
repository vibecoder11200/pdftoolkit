/*
 * Theme boot — runs BEFORE first paint to prevent a light flash on dark.
 * CSP is script-src 'self', so this is an external file (no inline script).
 * Must mirror src/theme/theme.ts: same storage key, same resolution order
 * (stored value wins, otherwise follow prefers-color-scheme).
 *
 * Referenced from index.html as %BASE_URL%theme-boot.js — never a relative
 * "./" path: the service worker's navigateFallback serves index.html for
 * offline deep links (/pdftoolkit/tools/merge), where "./" would resolve
 * into /pdftoolkit/tools/ and miss the precached script.
 */
(function () {
  var value = null;
  try {
    value = localStorage.getItem('pdftoolkit-theme');
  } catch (e) {
    /* storage unavailable — follow the system */
  }
  var dark =
    value === 'dark' ||
    (value !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var resolved = dark ? 'dark' : 'light';
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
})();
