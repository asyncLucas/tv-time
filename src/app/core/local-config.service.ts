import { Injectable, computed, signal } from '@angular/core';

const DB = 'tvtime-config';
const STORE = 'kv';

/**
 * Device-local configuration — TMDB API key and sync/peer settings — persisted
 * in its own IndexedDB store.
 *
 * Deliberately separate from the synced Yjs document: these are per-device
 * secrets and connection settings that must NOT travel over the P2P channel
 * (broadcasting your API key, or the very passphrase that secures the sync room,
 * to every peer would be a security smell). They persist across reloads but stay
 * on this device only.
 */
@Injectable({ providedIn: 'root' })
export class LocalConfigService {
  private db?: IDBDatabase;
  private cache = signal<Record<string, any>>({});

  readonly tmdbKey = computed<string | undefined>(() => this.cache()['tmdbKey']);
  readonly syncRoom = computed<string | undefined>(() => this.cache()['syncRoom']);
  readonly syncPass = computed<string | undefined>(() => this.cache()['syncPass']);

  private ready?: Promise<void>;

  /** Open the store and hydrate the in-memory cache. Idempotent. */
  init(): Promise<void> {
    if (!this.ready) {
      this.ready = this.open()
        .then((db) => {
          this.db = db;
          return this.readAll();
        })
        .then((all) => this.cache.set(all))
        .catch(() => this.cache.set({})); // storage blocked → in-memory only
    }
    return this.ready;
  }

  get<T = any>(key: string): T | undefined {
    return this.cache()[key];
  }

  async set(key: string, value: any): Promise<void> {
    this.cache.update((c) => ({ ...c, [key]: value }));
    await this.tx('readwrite', (store) => store.put(value, key));
  }

  async delete(key: string): Promise<void> {
    this.cache.update((c) => {
      const { [key]: _, ...rest } = c;
      return rest;
    });
    await this.tx('readwrite', (store) => store.delete(key));
  }

  /** Wipe the whole device-local config store (used by "Reset local data"). */
  static async destroy(): Promise<void> {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }

  // -------------------------------------------------------------------------
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private readAll(): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve({});
      const out: Record<string, any> = {};
      const cursor = this.db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) {
          out[String(c.key)] = c.value;
          c.continue();
        } else {
          resolve(out);
        }
      };
      cursor.onerror = () => reject(cursor.error);
    });
  }

  private tx(mode: IDBTransactionMode, run: (store: IDBObjectStore) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve(); // cache-only fallback
      const t = this.db.transaction(STORE, mode);
      run(t.objectStore(STORE));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
}
