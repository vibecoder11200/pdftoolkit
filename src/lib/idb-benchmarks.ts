/*
 * Minimal IndexedDB helper for the per-model benchmark records (v0.5.0
 * phase 3). One object store, promise-wrapped — no dependency. The database
 * handle is injectable so unit tests can pass a fake (F17: benchmark
 * persistence is part of the tier resolution contract).
 */

export const BENCHMARK_DB = 'pdftoolkit-ai';
export const BENCHMARK_STORE = 'benchmarks';

export interface IdbLike {
  open(name: string): Promise<IDBDatabaseLike>;
  deleteDatabase?(name: string): Promise<void>;
}

export interface IDBDatabaseLike {
  get(key: string): Promise<unknown>;
  put(value: unknown, key: string): Promise<void>;
  delete(key: string): Promise<void>;
  deleteStoreKeys?(): Promise<string[]>;
  getAllKeys(): Promise<string[]>;
  close(): void;
}

/** Open (creating the store as needed) with the default global indexedDB. */
export function openBenchmarkDb(
  factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB,
): Promise<IDBDatabaseLike> {
  if (!factory) return Promise.reject(new Error('IndexedDB unavailable'));
  return new Promise((resolve, reject) => {
    const req = factory.open(BENCHMARK_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BENCHMARK_STORE)) {
        db.createObjectStore(BENCHMARK_STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const wrap = {
        get: (key: string) =>
          new Promise<unknown>((res, rej) => {
            const r = db.transaction(BENCHMARK_STORE, 'readonly').objectStore(BENCHMARK_STORE).get(key);
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          }),
        put: (value: unknown, key: string) =>
          new Promise<void>((res, rej) => {
            const r = db.transaction(BENCHMARK_STORE, 'readwrite').objectStore(BENCHMARK_STORE).put(value, key);
            r.onsuccess = () => res();
            r.onerror = () => rej(r.error);
          }),
        delete: (key: string) =>
          new Promise<void>((res, rej) => {
            const r = db.transaction(BENCHMARK_STORE, 'readwrite').objectStore(BENCHMARK_STORE).delete(key);
            r.onsuccess = () => res();
            r.onerror = () => rej(r.error);
          }),
        getAllKeys: () =>
          new Promise<string[]>((res, rej) => {
            const r = db.transaction(BENCHMARK_STORE, 'readonly').objectStore(BENCHMARK_STORE).getAllKeys();
            r.onsuccess = () => res(r.result.map(String));
            r.onerror = () => rej(r.error);
          }),
        close: () => db.close(),
      };
      resolve(wrap);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}
