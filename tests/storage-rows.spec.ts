import { describe, expect, it } from 'vitest';
import {
  OCR_CACHE_NAME,
  TESSERACT_IDB_NAME,
  collectStorageSnapshot,
  deleteOcrIdb,
  deleteOcrRuntime,
  type StorageDeps,
} from '../src/lib/storage-rows';
import { AI_CACHE_STORE } from '../src/lib/ai-models';
import { BENCHMARK_DB } from '../src/lib/idb-benchmarks';

/*
 * Storage manager row model (v0.5.0 phase 5, F14/F15). All deps faked —
 * the unit contract is the OWNED ALLOWLIST itself: which rows exist, where
 * sizes come from, what is classified unknown (display-only), and which
 * deletes touch which stores.
 */

const SCOPE = 'https://vibecoder11200.github.io/pdftoolkit/';
const OUR_PRECACHE = `workbox-precache-v2-${SCOPE}`;
const SIBLING_PRECACHE = 'workbox-precache-v2-https://vibecoder11200.github.io/other-app/';

function makeDeps(over: Partial<StorageDeps> = {}): StorageDeps {
  return {
    tauri: false,
    online: true,
    scopeUrl: SCOPE,
    estimate: async () => ({ usage: 100, quota: 1000 }),
    cacheNames: async () => [],
    cacheStoreBytes: async () => 0,
    dbNames: async () => [],
    ocrIdbBytes: async () => null,
    aiModelBytes: async () => 0,
    deleteCacheStore: async () => true,
    deleteDatabase: async () => undefined,
    ...over,
  };
}

describe('collectStorageSnapshot — owned allowlist rows', () => {
  it('empty device: all four rows render in their "not downloaded" state', async () => {
    const snap = await collectStorageSnapshot(makeDeps());
    expect(snap.rows.map((r) => [r.id, r.present, r.bytes])).toEqual([
      ['ai-model', false, 0],
      ['ocr-assets', false, 0],
      ['ocr-idb', false, 0],
      ['precache', false, 0],
    ]);
    expect(snap.usage).toBe(100);
    expect(snap.quota).toBe(1000);
  });

  it('AI row size = manifest ∩ cache bytes (never the storage estimate)', async () => {
    const snap = await collectStorageSnapshot(
      makeDeps({ aiModelBytes: async () => 652_000_000, estimate: async () => ({ usage: 9_999_999, quota: 9_999_999 }) }),
    );
    const ai = snap.rows.find((r) => r.id === 'ai-model');
    expect(ai).toMatchObject({ present: true, bytes: 652_000_000 });
  });

  it('partial AI download shows partial bytes but still "present"', async () => {
    const snap = await collectStorageSnapshot(makeDeps({ aiModelBytes: async () => 1_000 }));
    expect(snap.rows.find((r) => r.id === 'ai-model')).toMatchObject({ present: true, bytes: 1_000 });
  });

  it('ocr-assets row present only when the cache store exists', async () => {
    const snap = await collectStorageSnapshot(
      makeDeps({ cacheNames: async () => [OCR_CACHE_NAME], cacheStoreBytes: async () => 26_400_000 }),
    );
    expect(snap.rows.find((r) => r.id === 'ocr-assets')).toMatchObject({ present: true, bytes: 26_400_000 });
  });

  it('ocr-idb row: db listed but empty → present with null bytes (honest "unknown")', async () => {
    const snap = await collectStorageSnapshot(
      makeDeps({ dbNames: async () => [TESSERACT_IDB_NAME], ocrIdbBytes: async () => null }),
    );
    expect(snap.rows.find((r) => r.id === 'ocr-idb')).toMatchObject({ present: false, bytes: null });
  });

  it('precache row: matched by OUR scope, byte-summed, delete allowed online', async () => {
    const snap = await collectStorageSnapshot(
      makeDeps({ cacheNames: async () => [OUR_PRECACHE], cacheStoreBytes: async () => 17_000_000 }),
    );
    expect(snap.rows.find((r) => r.id === 'precache')).toMatchObject({
      present: true,
      bytes: 17_000_000,
      disabled: false,
    });
  });

  it('precache row disabled when offline (reload would strand the app)', async () => {
    const snap = await collectStorageSnapshot(
      makeDeps({ online: false, cacheNames: async () => [OUR_PRECACHE] }),
    );
    expect(snap.rows.find((r) => r.id === 'precache')?.disabled).toBe(true);
  });

  it('desktop (tauri): the precache row does not exist at all', async () => {
    const snap = await collectStorageSnapshot(makeDeps({ tauri: true, cacheNames: async () => [OUR_PRECACHE] }));
    expect(snap.rows.map((r) => r.id)).toEqual(['ai-model', 'ocr-assets', 'ocr-idb']);
  });
});

describe('collectStorageSnapshot — unknown store classification (display-only)', () => {
  it('owned caches, own-scope precache and owned dbs are NOT unknown', async () => {
    const snap = await collectStorageSnapshot(
      makeDeps({
        cacheNames: async () => [AI_CACHE_STORE, OCR_CACHE_NAME, OUR_PRECACHE],
        dbNames: async () => [TESSERACT_IDB_NAME, BENCHMARK_DB],
      }),
    );
    expect(snap.unknownCaches).toEqual([]);
    expect(snap.unknownDbs).toEqual([]);
  });

  it("a sibling app's precache (shared github.io origin) stays unknown", async () => {
    const snap = await collectStorageSnapshot(
      makeDeps({ cacheNames: async () => [SIBLING_PRECACHE, 'some-other-app-v1'] }),
    );
    expect(snap.unknownCaches).toEqual([SIBLING_PRECACHE, 'some-other-app-v1']);
  });

  it('foreign IndexedDBs are listed as unknown', async () => {
    const snap = await collectStorageSnapshot(makeDeps({ dbNames: async () => ['not-ours'] }));
    expect(snap.unknownDbs).toEqual(['not-ours']);
  });
});

describe('delete flows', () => {
  it('deleteOcrRuntime removes BOTH the cache store and the tesseract IDB', async () => {
    const deletedCaches: string[] = [];
    const deletedDbs: string[] = [];
    await deleteOcrRuntime(
      makeDeps({
        deleteCacheStore: async (n) => (deletedCaches.push(n), true),
        deleteDatabase: async (n) => void deletedDbs.push(n),
      }),
    );
    expect(deletedCaches).toEqual([OCR_CACHE_NAME]);
    expect(deletedDbs).toEqual([TESSERACT_IDB_NAME]);
  });

  it('deleteOcrIdb touches ONLY the IndexedDB (cache pins survive)', async () => {
    const deletedCaches: string[] = [];
    const deletedDbs: string[] = [];
    await deleteOcrIdb(
      makeDeps({
        deleteCacheStore: async (n) => (deletedCaches.push(n), true),
        deleteDatabase: async (n) => void deletedDbs.push(n),
      }),
    );
    expect(deletedCaches).toEqual([]);
    expect(deletedDbs).toEqual([TESSERACT_IDB_NAME]);
  });
});

describe('constant pinning (drift guards)', () => {
  it('OCR_CACHE_NAME matches ocr.ts (a literal there because importing it would pull pdf-lib into the entry bundle)', async () => {
    const ocr = await import('../src/lib/ocr');
    expect(OCR_CACHE_NAME).toBe(ocr.OCR_CACHE_NAME);
  });
});
