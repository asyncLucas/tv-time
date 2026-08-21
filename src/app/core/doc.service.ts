import { Injectable } from '@angular/core';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import type {
  Seed,
  ShowState,
  MovieState,
  EpisodeWatch,
  EpisodeRating,
  AddedTitle,
} from './models';

export const DB_NAME = 'tvtime-revival';

/** Stable key for an episode watch within the CRDT. */
export function epKey(tvdbId: string, season: number, episode: number): string {
  return `${seasonKey(tvdbId, season)}:${episode}`;
}

/**
 * Stable key for a show-season. Not itself a CRDT key — it keys the per-season
 * indexes and caches derived from episode watches, and shares `epKey`'s prefix
 * so the two can never drift apart.
 */
export function seasonKey(tvdbId: string, season: number): string {
  return `${tvdbId}:${season}`;
}

/**
 * Stable id for a title added from TMDB search.
 *
 * Derived from the source id rather than random so that two devices adding the
 * same show independently write the *same* CRDT key and converge on one entry.
 * A random uuid would leave the user with duplicates after a sync.
 */
export function addedKey(kind: 'show' | 'movie', tmdbId: number): string {
  return `tmdb:${kind}:${tmdbId}`;
}

/**
 * Inverse of `addedKey`: recover the kind + TMDB id from a uuid. Because the id
 * is baked into the uuid, a detail page can preview a title straight from TMDB
 * before it's ever added — the route carries everything needed to fetch it.
 * Returns null for catalog uuids, which don't follow this scheme.
 */
export function parseAddedKey(uuid: string): { kind: 'show' | 'movie'; tmdbId: number } | null {
  const m = /^tmdb:(show|movie):(\d+)$/.exec(uuid);
  return m ? { kind: m[1] as 'show' | 'movie', tmdbId: Number(m[2]) } : null;
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
  /**
   * `${tvdbId}:${season}:${ep}` -> EpisodeRating: the user's per-episode score.
   *
   * Shares `episodeWatches`' key scheme but not its map, so clearing a watch
   * never clears the rating that went with it (see EpisodeRating).
   */
  readonly episodeRatings = this.doc.getMap<EpisodeRating>('episodeRatings');
  /** listId -> { name, description, items } */
  readonly lists = this.doc.getMap<any>('lists');
  /** addedKey -> AddedTitle: shows the user added from TMDB search. */
  readonly addedShows = this.doc.getMap<AddedTitle>('addedShows');
  /** addedKey -> AddedTitle: movies the user added from TMDB search. */
  readonly addedMovies = this.doc.getMap<AddedTitle>('addedMovies');
  /**
   * User-editable profile (name, avatar). Lives in the CRDT — not the seed —
   * so edits travel between devices. The avatar is a small downscaled data URI
   * (see LibraryStore.setProfileImage); keeping it here means sync providers
   * carry it for free, at the cost of a few tens of KB in the doc.
   */
  readonly profile = this.doc.getMap<any>('profile');
  /**
   * Synced app settings: the TMDB API key, the WebRTC signaling URL, and the P2P
   * sync room + passphrase. Lives in the doc so it travels to your other devices
   * — set it once and the whole fleet converges. The one credential that stays
   * device-local is the gist token, in LocalConfigService: you need it to reach
   * the gist, so a copy inside the gist would be unreachable.
   *
   * Because this map holds credentials (the sync passphrase in particular), the
   * only two channels it travels are the deliberate, trusted ones: your own
   * private gist and your own passphrase-encrypted WebRTC room. It is pointedly
   * excluded from exportJson() — a backup file is something people email
   * themselves, which is not a channel we control.
   */
  readonly settings = this.doc.getMap<any>('settings');
  /**
   * deviceId -> DeviceRecord: the fleet's linked devices (see DeviceService).
   *
   * Lives in the doc so every device sees the same roster — that's what makes
   * "active sessions" more than a per-device guess. Only the roster is synced;
   * whether a device is online *right now* comes from WebRTC awareness, which
   * is ephemeral by nature and never touches the doc.
   */
  readonly devices = this.doc.getMap<any>('devices');
  /**
   * deviceId -> ISO timestamp of when it was signed out from another device.
   *
   * Separate from `devices` because a device owns its own roster entry and
   * refreshes it on every launch: a revocation written as a *deletion* there
   * would simply lose to that next check-in (later CRDT write wins) and the
   * device would quietly re-register itself. Nothing ever writes its own id
   * here, so there is no race to lose — a device only reads this map, and only
   * a fresh pairing clears its entry.
   */
  readonly revokedDevices = this.doc.getMap<string>('revokedDevices');
  /**
   * `tv:<tvdbId>` / `mv:<imdbId>` -> TMDB poster path (e.g. `/abc123.jpg`).
   *
   * Artwork the catalog can't supply. TV Time backups carry a cached poster for
   * every show but none for films, so without this map a device with no TMDB key
   * shows 565 initial-tiles where the movie grid should be — and a shared public
   * profile, which bakes absolute URLs for visitors, has nothing to bake.
   *
   * So the first device that *does* have a key writes down what it resolved, and
   * the whole fleet (plus the published page) reads it forever after. Only the
   * path is stored, not the full URL: the size prefix is a render-time choice,
   * and paths keep the doc small enough that the entire library costs a few tens
   * of KB in the gist.
   */
  readonly posters = this.doc.getMap<string>('posters');
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
   * Synced settings (TMDB key, signaling URL, sync room + passphrase) live in
   * the `settings` map and the gist token stays in LocalConfigService — all are
   * deliberately absent here — a backup file is something people email
   * themselves, so it must never carry credentials.
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
        episodeRatings: this.episodeRatings.toJSON(),
        lists: this.lists.toJSON(),
        addedShows: this.addedShows.toJSON(),
        addedMovies: this.addedMovies.toJSON(),
        profile: this.profile.toJSON(),
        posters: this.posters.toJSON(),
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
      mergeEntries(this.episodeRatings, data.episodeRatings);
      mergeEntries(this.lists, data.lists);
      mergeEntries(this.addedShows, data.addedShows);
      mergeEntries(this.addedMovies, data.addedMovies);
      mergeEntries(this.profile, data.profile, { allowScalars: true });
      // Poster paths are the one section that ends up in an `<img src>`, so a
      // hand-edited file doesn't get to smuggle anything but a TMDB-shaped path.
      mergeEntries(this.posters, data.posters, {
        allowScalars: true,
        accept: (v) => typeof v === 'string' && v.startsWith('/'),
      });
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
 * opts in via `allowScalars`. A section whose values have a narrower shape still
 * (poster paths) passes an `accept` predicate on top.
 */
function mergeEntries(
  target: Y.Map<any>,
  source: unknown,
  { allowScalars = false, accept }: { allowScalars?: boolean; accept?: (v: unknown) => boolean } = {},
): void {
  if (!isPlainObject(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (!key) continue;
    if (!allowScalars && !isPlainObject(value)) continue;
    if (accept && !accept(value)) continue;
    target.set(key, value);
  }
}
