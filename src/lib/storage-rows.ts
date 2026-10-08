/*
 * Storage manager model (v0.5.0 phase 5, F14/F15). The Settings page lists
 * ONLY storage this app owns — a fixed allowlist. caches.keys() and
 * indexedDB.databases() are consulted solely to classify everything ELSE as
 * "not ours", display-only: the github.io origin is shared with sibling
 * apps, so a blanket "clear everything" or a delete button on unknown
 * stores could wipe data this app cannot restore.
 *
 * Size honesty (F15): the AI row reports cache-state ∩ manifest bytes
 * (cachedModelBytes), never navigator.storage.estimate() — the estimate
 * mixes every origin store and would lie per-row.
 *
 * Everything is dependency-injected so the row model and delete flows are
 * node-unit-testable; defaultStorageDeps() binds the browser globals.
 */
import { AI_CACHE_STORE, cachedModelBytes } from './ai-models';
import { BENCHMARK_DB } from './idb-benchmarks';
import { isTauri } from './platform';

/**
 * tesseract.js's gunzipped traineddata IndexedDB (it embeds idb-keyval with
 * the default db/store names "keyval-store"/"keyval"). A literal, NOT an
 * import from ./ocr: ocr.ts statically imports pdf-lib and must stay out of
 * the entry bundle — tests/storage-rows.spec.ts pins the two constants
 * together so they cannot drift.
 */
export const TESSERACT_IDB_NAME = 'keyval-store';
export const TESSERACT_IDB_STORE = 'keyval';

/** Cache API store for the tesseract core + tessdata pins (ocr.ts). */
export const OCR_CACHE_NAME = 'pdftoolkit-ocr-v1';

const OWNED_CACHE_STORES = new Set([AI_CACHE_STORE, OCR_CACHE_NAME]);
const OWNED_DBS = new Set([TESSERACT_IDB_NAME, BENCHMARK_DB]);
const PRECACHE_PREFIX = 'workbox-precache-v2-';

export type StorageRowId = 'ai-model' | 'ocr-assets' | 'ocr-idb' | 'precache';

export interface StorageRow {
  id: StorageRowId;
  /** Bytes we can attribute to this row; null = present but unmeasurable. */
  bytes: number | null;
  /** false → the row renders in its "not downloaded yet" state. */
  present: boolean;
  /** Deletion must be refused while true (precache: offline). */
  disabled: boolean;
}

export interface StorageSnapshot {
  usage: number | null;
  quota: number | null;
  rows: StorageRow[];
  unknownCaches: string[];
  unknownDbs: string[];
}

export interface StorageDeps {
  tauri: boolean;
  online: boolean;
  /** This app's own SW scope URL (trailing slash), used to pick OUR
   *  workbox precache store out of the shared origin. */
  scopeUrl: string;
  estimate(): Promise<{ usage: number; quota: number } | null>;
  cacheNames(): Promise<string[]>;
  cacheStoreBytes(name: string): Promise<number>;
  dbNames(): Promise<string[]>;
  /** Bytes inside the tesseract IDB, or null when the db has no data. */
  ocrIdbBytes(): Promise<number | null>;
  aiModelBytes(): Promise<number>;
  deleteCacheStore(name: string): Promise<boolean>;
  deleteDatabase(name: string): Promise<void>;
}

function isOwnPrecacheStore(name: string, scopeUrl: string): boolean {
  return name.startsWith(PRECACHE_PREFIX) && name.endsWith(scopeUrl);
}

export async function collectStorageSnapshot(deps: StorageDeps): Promise<StorageSnapshot> {
  const [estimate, cacheNames, dbNames, aiBytes] = await Promise.all([
    deps.estimate(),
    deps.cacheNames(),
    deps.dbNames(),
    deps.aiModelBytes(),
  ]);

  const rows: StorageRow[] = [
    { id: 'ai-model', bytes: aiBytes, present: aiBytes > 0, disabled: false },
  ];

  if (cacheNames.includes(OCR_CACHE_NAME)) {
    rows.push({
      id: 'ocr-assets',
      bytes: await deps.cacheStoreBytes(OCR_CACHE_NAME),
      present: true,
      disabled: false,
    });
  } else {
    rows.push({ id: 'ocr-assets', bytes: 0, present: false, disabled: false });
  }

  if (dbNames.includes(TESSERACT_IDB_NAME)) {
    const idbBytes = await deps.ocrIdbBytes();
    rows.push({
      id: 'ocr-idb',
      bytes: idbBytes,
      present: (idbBytes ?? 0) > 0,
      disabled: false,
    });
  } else {
    rows.push({ id: 'ocr-idb', bytes: 0, present: false, disabled: false });
  }

  // The precache row is web-only: desktop has no service worker at all.
  if (!deps.tauri) {
    const precache = cacheNames.filter((n) => isOwnPrecacheStore(n, deps.scopeUrl));
    if (precache.length > 0) {
      let bytes = 0;
      for (const name of precache) bytes += await deps.cacheStoreBytes(name);
      rows.push({
        id: 'precache',
        bytes,
        present: true,
        // Offline the app can only boot from this store — deleting it would
        // strand the tab until the network returns.
        disabled: !deps.online,
      });
    } else {
      rows.push({ id: 'precache', bytes: 0, present: false, disabled: false });
    }
  }

  const unknownCaches = cacheNames.filter(
    (n) => !OWNED_CACHE_STORES.has(n) && !isOwnPrecacheStore(n, deps.scopeUrl),
  );
  const unknownDbs = dbNames.filter((n) => !OWNED_DBS.has(n));

  return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, rows, unknownCaches, unknownDbs };
}

/**
 * Delete the OCR assets row = the Cache API store AND the tesseract IDB
 * copies. tesseract reads its IDB first, so keeping it would resurrect the
 * old traineddata and make the "re-downloads next run" copy a lie.
 */
export async function deleteOcrRuntime(deps: StorageDeps): Promise<void> {
  await deps.deleteCacheStore(OCR_CACHE_NAME);
  await deps.deleteDatabase(TESSERACT_IDB_NAME);
}

/** Delete only the gunzipped IDB copies (the cache store keeps the pins). */
export async function deleteOcrIdb(deps: StorageDeps): Promise<void> {
  await deps.deleteDatabase(TESSERACT_IDB_NAME);
}

/** Byte size of a Cache API store, content-length first, body fallback. */
async function measureCacheStore(name: string): Promise<number> {
  const store = await caches.open(name);
  let bytes = 0;
  for (const req of await store.keys()) {
    const res = await store.match(req);
    if (!res) continue;
    const len = Number(res.headers.get('content-length'));
    bytes +=
      Number.isFinite(len) && len > 0 ? len : (await res.clone().arrayBuffer()).byteLength;
  }
  return bytes;
}

/** Read total bytes in the tesseract traineddata IDB, null when absent. */
function measureTesseractIdb(): Promise<number | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(TESSERACT_IDB_NAME);
    } catch {
      resolve(null);
      return;
    }
    // Never CREATE the db from here: tesseract owns its schema. An upgrade
    // request means the db does not exist (or changed hands) — abort.
    req.onupgradeneeded = () => {
      req.transaction?.abort();
      resolve(null);
    };
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      const done = (v: number | null) => {
        db.close();
        resolve(v);
      };
      try {
        if (!db.objectStoreNames.contains(TESSERACT_IDB_STORE)) return done(null);
        const getAll = db.transaction(TESSERACT_IDB_STORE, 'readonly')
          .objectStore(TESSERACT_IDB_STORE)
          .getAll();
        getAll.onsuccess = () => {
          let bytes = 0;
          for (const v of getAll.result ?? []) {
            if (v instanceof ArrayBuffer) bytes += v.byteLength;
            else if (ArrayBuffer.isView(v)) bytes += v.byteLength;
          }
          done(bytes);
        };
        getAll.onerror = () => done(null);
      } catch {
        done(null);
      }
    };
  });
}

export function defaultStorageDeps(): StorageDeps {
  const scopeUrl = new URL(import.meta.env.BASE_URL, self.location.href).href;
  return {
    tauri: isTauri(),
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    scopeUrl,
    async estimate() {
      try {
        const e = await navigator.storage.estimate();
        return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
      } catch {
        return null;
      }
    },
    async cacheNames() {
      try {
        return typeof caches === 'undefined' ? [] : await caches.keys();
      } catch {
        return [];
      }
    },
    async cacheStoreBytes(name) {
      try {
        return await measureCacheStore(name);
      } catch {
        return 0;
      }
    },
    async dbNames() {
      try {
        const dbs = typeof indexedDB !== 'undefined' ? await indexedDB.databases?.() : undefined;
        return (dbs ?? []).map((d) => d.name).filter((n): n is string => typeof n === 'string');
      } catch {
        return [];
      }
    },
    ocrIdbBytes: measureTesseractIdb,
    aiModelBytes: cachedModelBytes,
    async deleteCacheStore(name) {
      try {
        return typeof caches === 'undefined' ? false : await caches.delete(name);
      } catch {
        return false;
      }
    },
    deleteDatabase(name) {
      return new Promise((resolve) => {
        try {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        } catch {
          resolve();
        }
      });
    },
  };
}

/**
 * Pre-cache delete flow (web only): unregister OUR registrations first —
 * never delete a controlling SW's caches out from under it — then drop the
 * store, then reload so the page never runs controller-less with a wiped
 * cache.
 */
export async function deletePrecacheAndReload(deps: StorageDeps): Promise<void> {
  const regs = await navigator.serviceWorker.getRegistrations();
  for (const reg of regs) {
    if (reg.scope === deps.scopeUrl) await reg.unregister();
  }
  for (const name of await deps.cacheNames()) {
    if (isOwnPrecacheStore(name, deps.scopeUrl)) await deps.deleteCacheStore(name);
  }
  self.location.reload();
}
