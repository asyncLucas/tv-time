import { Injectable } from '@angular/core';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import type { Seed, ShowState, MovieState, EpisodeWatch } from './models';

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
  /** listId -> { name, description, items } */
  readonly lists = this.doc.getMap<any>('lists');
  /**
   * User-editable profile (name, avatar). Lives in the CRDT — not the seed —
   * so edits travel between devices. The avatar is a small downscaled data URI
   * (see LibraryStore.setProfileImage); keeping it here means sync providers
   * carry it for free, at the cost of a few tens of KB in the doc.
   */
  readonly profile = this.doc.getMap<any>('profile');
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

  /**
   * Serialize the whole user-state doc to a portable JSON blob (export/backup).
   *
   * Device-local config (TMDB key, sync room + passphrase, gist token) lives in
   * LocalConfigService and is deliberately absent here — a backup file is
   * something people email themselves, so it must never carry credentials.
   */
  exportJson(): string {
    return JSON.stringify(
      {
        kind: STATE_FILE_KIND,
        schema: this.meta.get('schema') ?? 1,
        exportedAt: new Date().toISOString(),
        showState: this.showState.toJSON(),
        movieState: this.movieState.toJSON(),
        episodeWatches: this.episodeWatches.toJSON(),
        lists: this.lists.toJSON(),
        profile: this.profile.toJSON(),
      },
      null,
      2,
    );
  }

  /**
   * Merge an exported blob back in (used by import + as a manual sync path).
   *
   * An import file is untrusted input — it may have been hand-edited or come
   * from someone else — so each section is shape-checked before it reaches the
   * CRDT. Anything that isn't a plain `{ key: object }` map is skipped rather
   * than merged, which keeps a malformed file from poisoning the doc that then
   * replicates to every other device.
   */
  importJson(json: string): void {
    const data = JSON.parse(json);
    if (data?.kind !== STATE_FILE_KIND) {
      throw new Error('Not a TV Time Revival state file');
    }
    this.doc.transact(() => {
      mergeEntries(this.showState, data.showState);
      mergeEntries(this.movieState, data.movieState);
      mergeEntries(this.episodeWatches, data.episodeWatches);
      mergeEntries(this.lists, data.lists);
      mergeEntries(this.profile, data.profile, { allowScalars: true });
    });
  }
}

/** Discriminator every state file must carry for import to accept it. */
const STATE_FILE_KIND = 'tvtime-revival-state';

/** A JSON object literal — not an array, not null, not a boxed primitive. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Copy `source`'s entries into a Y.Map, skipping anything malformed.
 *
 * Most sections map an id to a record, so non-object values are rejected. The
 * profile is the exception — it stores scalars (`name`, `image`) directly — and
 * opts in via `allowScalars`.
 */
function mergeEntries(
  target: Y.Map<any>,
  source: unknown,
  { allowScalars = false } = {},
): void {
  if (!isPlainObject(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (!key) continue;
    if (!allowScalars && !isPlainObject(value)) continue;
    target.set(key, value);
  }
}
