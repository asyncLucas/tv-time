import { Injectable, signal } from '@angular/core';
import type { Seed, SeedShow, SeedMovie } from './models';

/**
 * Loads the immutable catalog (seed.json) once and exposes fast lookups.
 * This data is identical on every device and is NEVER synced through the CRDT —
 * only the small user-state doc travels between devices.
 */
@Injectable({ providedIn: 'root' })
export class SeedService {
  private _seed = signal<Seed | null>(null);
  readonly seed = this._seed.asReadonly();

  private showByUuid = new Map<string, SeedShow>();
  private showByTvdb = new Map<string, SeedShow>();
  private movieByUuid = new Map<string, SeedMovie>();

  private loading?: Promise<Seed>;

  /** Idempotent — safe to call from multiple bootstrap paths. */
  load(): Promise<Seed> {
    if (this.loading) return this.loading;
    this.loading = fetch('seed.json')
      .then((r) => {
        if (!r.ok) throw new Error(`seed.json ${r.status}`);
        return r.json() as Promise<Seed>;
      })
      .then((seed) => {
        for (const s of seed.shows) {
          this.showByUuid.set(s.uuid, s);
          if (s.tvdbId) this.showByTvdb.set(s.tvdbId, s);
        }
        for (const m of seed.movies) this.movieByUuid.set(m.uuid, m);
        this._seed.set(seed);
        return seed;
      });
    return this.loading;
  }

  getShow(uuid: string): SeedShow | undefined {
    return this.showByUuid.get(uuid);
  }
  getShowByTvdb(tvdbId: string): SeedShow | undefined {
    return this.showByTvdb.get(tvdbId);
  }
  getMovie(uuid: string): SeedMovie | undefined {
    return this.movieByUuid.get(uuid);
  }
}
