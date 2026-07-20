import { Injectable } from '@angular/core';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import type {
  Seed,
  ShowState,
  MovieState,
  EpisodeWatch,
  AddedShowRef,
} from './models';

export const DB_NAME = 'tvtime-revival';

/** Stable key for an episode watch within the CRDT. */
export function epKey(tvdbId: string, season: number, episode: number): string {
  return `${tvdbId}:${season}:${episode}`;
}

/**
 * Owns the single Y.Doc that holds all *user state* and its local IndexedDB
 * persistence. The doc is intentionally small — only mergeable facts live here,
 * never the 600KB catalog. Sync providers (Phase 4) attach to this same doc.
 */
@Injectable({ providedIn: 'root' })
export class DocService {
  readonly doc = new Y.Doc();

  /** uuid -> ShowState */
  readonly showState = this.doc.getMap<ShowState>('showState');
  /** uuid -> MovieState */
  readonly movieState = this.doc.getMap<MovieState>('movieState');
  /** `${tvdbId}:${season}:${ep}` -> EpisodeWatch */
  readonly episodeWatches = this.doc.getMap<EpisodeWatch>('episodeWatches');
  /** uuid -> AddedShowRef (shows the user added that weren't in the seed) */
  readonly addedShows = this.doc.getMap<AddedShowRef>('addedShows');
  /** listId -> { name, description, items } */
  readonly lists = this.doc.getMap<any>('lists');
  /** app settings (tmdb api key, sync room, etc.) */
  readonly settings = this.doc.getMap<any>('settings');
  /** bookkeeping (schema version, bootstrap flag) */
  readonly meta = this.doc.getMap<any>('meta');

  private persistence?: IndexeddbPersistence;
  private ready?: Promise<void>;

  /** Resolves once the local IndexedDB store has been loaded into the doc. */
  whenReady(): Promise<void> {
    if (!this.ready) {
      this.persistence = new IndexeddbPersistence(DB_NAME, this.doc);
      this.ready = new Promise<void>((resolve) => {
        this.persistence!.once('synced', () => resolve());
      });
    }
    return this.ready;
  }

  /**
   * One-time import of the seed's initial user state into the CRDT. Runs inside
   * a single transaction so it lands as one atomic update. No-op after the first
   * successful run (guarded by meta.bootstrapped), so re-opening never clobbers
   * edits or re-imports.
   */
  bootstrapFromSeed(seed: Seed): void {
    if (this.meta.get('bootstrapped')) return;

    this.doc.transact(() => {
      const now = new Date(seed.meta.backedUp).toISOString();

      for (const s of seed.shows) {
        const status = s.showWatchedAt ? 'completed' : 'watching';
        this.showState.set(s.uuid, {
          status,
          favorite: s.favorite,
          rating: null,
          addedAt: s.followedAt,
          updatedAt: s.followedAt ?? now,
        });
      }

      for (const m of seed.movies) {
        const watched = !!m.watchedAt;
        this.movieState.set(m.uuid, {
          watched,
          watchedAt: m.watchedAt,
          watchlist: !watched,
          favorite: m.favorite,
          rating: null,
          updatedAt: m.watchedAt ?? m.followedAt ?? now,
        });
      }

      for (const e of seed.watchedEpisodes) {
        if (!e.showId || e.season == null || e.number == null || !e.seen) continue;
        const key = epKey(e.showId, e.season, e.number);
        this.episodeWatches.set(key, {
          tvdbId: e.showId,
          season: e.season,
          episode: e.number,
          watchedAt: e.seenDate ?? now,
          nbTimes: e.nbTimesWatched || 1,
        });
      }

      for (const list of seed.customLists) {
        this.lists.set(list.id, {
          name: list.name,
          description: list.description,
          createdAt: list.createdAt,
          items: list.items.map((i) => ({
            title: i.title,
            uuid: i.uuid,
            entityType: i.entityType,
          })),
        });
      }

      this.meta.set('schema', seed.meta.schema);
      this.meta.set('bootstrapped', true);
      this.meta.set('bootstrappedAt', now);
    });
  }

  /** Serialize the whole user-state doc to a portable JSON blob (export/backup). */
  exportJson(): string {
    return JSON.stringify(
      {
        kind: 'tvtime-revival-state',
        schema: this.meta.get('schema') ?? 1,
        exportedAt: new Date().toISOString(),
        showState: this.showState.toJSON(),
        movieState: this.movieState.toJSON(),
        episodeWatches: this.episodeWatches.toJSON(),
        addedShows: this.addedShows.toJSON(),
        lists: this.lists.toJSON(),
        settings: this.settings.toJSON(),
      },
      null,
      2,
    );
  }

  /** Merge an exported blob back in (used by import + as a manual sync path). */
  importJson(json: string): void {
    const data = JSON.parse(json);
    if (data?.kind !== 'tvtime-revival-state') {
      throw new Error('Not a TV Time Revival state file');
    }
    this.doc.transact(() => {
      const apply = (map: Y.Map<any>, obj: Record<string, any>) => {
        for (const [k, v] of Object.entries(obj ?? {})) map.set(k, v);
      };
      apply(this.showState, data.showState);
      apply(this.movieState, data.movieState);
      apply(this.episodeWatches, data.episodeWatches);
      apply(this.addedShows, data.addedShows);
      apply(this.lists, data.lists);
      apply(this.settings, data.settings);
    });
  }
}
