/*
 * Shared precache-manifest parser (plan v0.3.0 phase 6a).
 *
 * Used by scripts/precache-diff.mjs (baseline gate) and tests/sw-precache.spec.ts
 * (revision-pin assertions). Both generateSW (`self.precacheManifest =
 * [{url:"…",revision:"…"}]`, minified → unquoted keys) and injectManifest
 * (`precacheAndRoute(self.__WB_MANIFEST = [{…}])`, JSON.stringify'd → quoted
 * keys, revision-first) inline the manifest as an array literal, so entries
 * are extracted by scanning for entry-object literals in either key order
 * and with optional quotes.
 */
import { readFileSync } from 'node:fs';

// Matches minified or pretty-printed precache entry objects in either key
// order. revision may be null (hash-in-filename assets like JS/CSS chunks).
const ENTRY_RES = [
  /\{\s*["']?url["']?\s*:\s*"([^"]+)"\s*,\s*["']?revision["']?\s*:\s*(?:"([^"]*)"|null)\s*\}/g,
  /\{\s*["']?revision["']?\s*:\s*(?:"([^"]*)"|null)\s*,\s*["']?url["']?\s*:\s*"([^"]+)"\s*\}/g,
];

/**
 * Parse the precache manifest out of a built sw.js.
 * @param {string} swPath path to a built sw.js
 * @returns {Map<string, string|null>} url → revision (null = hash-in-filename)
 * @throws if no entries parse (shape change — fail the gate loudly)
 */
export function extractPrecacheEntries(swPath) {
  const source = readFileSync(swPath, 'utf8');
  const map = new Map();
  for (const re of ENTRY_RES) {
    let m;
    while ((m = re.exec(source)) !== null) {
      const [url, rev] = re === ENTRY_RES[0] ? [m[1], m[2]] : [m[2], m[1]];
      const revision = rev === undefined ? null : rev;
      // generateSW lists icons + webmanifest twice (glob + PWA manifest) with
      // identical revisions; dedupe silently, but conflicting revisions inside
      // one file would make a 1:1 diff order-dependent — fail loudly.
      const prev = map.get(url);
      if (prev !== undefined && prev !== revision) {
        throw new Error(`${swPath}: conflicting revisions for ${url}: ${prev} vs ${revision}`);
      }
      map.set(url, revision);
    }
    re.lastIndex = 0;
  }
  if (map.size === 0) {
    throw new Error(`${swPath}: no precache entries parsed — check manifest shape`);
  }
  return map;
}
