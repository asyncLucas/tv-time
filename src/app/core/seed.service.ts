import { Injectable, computed, signal } from '@angular/core';
import type { Seed, SeedShow, SeedMovie } from './models';

const DB = 'tvtime-catalog';
const STORE = 'kv';
const KEY = 'seed';

/** A catalog with no content — the offline fallback for an anonymous start. */
function emptySeed(): Seed {
  return {
    meta: { source: 'fresh', syncedApprox: '', backedUp: '', schema: 1, note: '' },
    profile: {
      id: 0,
      login: '',
      name: '',
      image: null,
      timezone: null,
      lang: 'en',
      createdAt: null,
      favoriteGenres: [],
      stats: {},
    },
    shows: [],
    movies: [],
    watchedMovies: [],
    watchedEpisodes: [],
    customLists: [],
  };
}

/**
 * Owns the user's catalog (their shows/movies reference data).
 *
 * Crucially, the catalog is NOT bundled with the app — shipping one person's
 * library to every visitor would leak their data. Instead each device stores its
 * own catalog in IndexedDB, established once via onboarding (import a TV Time
 * backup, or start empty). A fresh visitor sees an anonymous, empty app.
 *
 * The catalog is device-local reference data and is never synced through the
 * CRDT; only the small user-state doc travels between devices.
 */
@Injectable({ providedIn: 'root' })
export class SeedService {
  private _seed = signal<Seed | null>(null);
  readonly seed = this._seed.asReadonly();
  /** True once a catalog exists on this device (else: show onboarding). */
  readonly hasLibrary = computed(() => !!this._seed());

  private showByUuid = new Map<string, SeedShow>();
  private movieByUuid = new Map<string, SeedMovie>();

  private db?: IDBDatabase;
  private loading?: Promise<Seed | null>;

  /**
   * Load this device's catalog. Prefers a personal backup the user imported
   * (stored in IndexedDB); otherwise falls back to the bundled, sanitized
   * catalog.json that ships with the app — the shared, browsable content
   * database. Either way the app has content to show; nothing is user-linked.
   */
  load(): Promise<Seed | null> {
    if (!this.loading) {
      this.loading = this.open()
        .then(() => this.read())
        .catch(() => null)
        .then(async (stored) => stored ?? (await this.fetchBundledCatalog()))
        .then((seed) => {
          if (seed) this.apply(seed);
          return seed;
        })
        .catch(() => null);
    }
    return this.loading;
  }

  /** The sanitized catalog that ships with the build (public/catalog.json). */
  private async fetchBundledCatalog(): Promise<Seed | null> {
    try {
      const r = await fetch('catalog.json');
      return r.ok ? ((await r.json()) as Seed) : null;
    } catch {
      return null;
    }
  }

  /** Adopt an imported TV Time backup as this device's catalog. */
  async importSeed(seed: Seed): Promise<Seed> {
    if (!Array.isArray(seed?.shows) || !Array.isArray(seed?.movies)) {
      throw new Error('Not a TV Time library file (expected "shows" and "movies").');
    }
    await this.write(seed);
    this.apply(seed);
    return seed;
  }

  /**
   * Begin anonymously: no personal backup, just the shared catalog to browse
   * and TMDB search to add whatever isn't in it.
   *
   * Deliberately does NOT persist anything. Writing an empty catalog here would
   * store a truthy-but-empty seed that `load()` prefers over the bundled
   * catalog forever after — leaving the user with a permanently empty app and
   * no way back. Skipping the write means the next launch simply picks the
   * bundled catalog up again.
   */
  async startEmpty(): Promise<Seed> {
    const seed = (await this.fetchBundledCatalog()) ?? emptySeed();
    this.apply(seed);
    return seed;
  }

  /** Forget the catalog on this device (used by "Reset local data"). */
  static async destroy(): Promise<void> {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }

  getShow(uuid: string): SeedShow | undefined {
    return this.showByUuid.get(uuid);
  }
  getMovie(uuid: string): SeedMovie | undefined {
    return this.movieByUuid.get(uuid);
  }

  // -------------------------------------------------------------------------
  private apply(seed: Seed): void {
    this.showByUuid.clear();
    this.movieByUuid.clear();
    for (const s of seed.shows) this.showByUuid.set(s.uuid, s);
    for (const m of seed.movies) this.movieByUuid.set(m.uuid, m);
    this._seed.set(seed);
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  private read(): Promise<Seed | null> {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve(null);
      const req = this.db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as Seed) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  private write(seed: Seed): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve();
      const t = this.db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(seed, KEY);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
}
