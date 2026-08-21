import { Injectable, inject } from '@angular/core';
import { DocService, parseAddedKey } from './doc.service';
import { LibraryStore } from './library.store';
import { TmdbService } from './tmdb.service';
import type { EpisodeWatch, MovieView, ShowView } from './models';

/**
 * Export the library as a Trakt-compatible JSON import file.
 *
 * This is a *lossy, one-way* projection, deliberately separate from
 * DocService.exportJson(): that file is our own backup format and has to round-
 * trip back into the CRDT, while this one has to satisfy someone else's schema.
 * Trakt's importer takes a flat array of items, each identified by ONE external
 * id and carrying at most a watch date, a watchlist date and a rating:
 *
 *   { "imdb_id": "tt0068646", "type": "movie",
 *     "watched_at": "…", "watchlisted_at": "…", "rating": 6, "rated_at": "…" }
 *
 * Everything the format has no field for — favorites, custom lists, follow
 * status, rewatch counts — simply cannot travel. The counters returned by
 * `build()` say out loud what was left behind rather than letting it vanish
 * silently.
 */

export type TraktType = 'movie' | 'show' | 'season' | 'episode';

/**
 * One row of the import file. Exactly one of the four id keys is present — the
 * key name *is* the id's namespace, which is why this isn't `{ id, source }`.
 */
export interface TraktItem {
  trakt_id?: string;
  imdb_id?: string;
  tmdb_id?: string;
  tvdb_id?: string;
  type: TraktType;
  watched_at?: string;
  watchlisted_at?: string;
  rating?: number;
  rated_at?: string;
}

/** What the export contains, and what it couldn't carry. */
export interface TraktExportResult {
  items: TraktItem[];
  movies: number;
  shows: number;
  episodes: number;
  /** Titles dropped for want of any id Trakt accepts. */
  skippedTitles: number;
  /** Episode watches whose episode id TMDB couldn't resolve. */
  skippedEpisodes: number;
}

export interface TraktExportProgress {
  done: number;
  total: number;
}

/**
 * The only watch date the format accepts when the real one is missing. Trakt
 * documents it for `watched_at` alone — `watchlisted_at` and `rated_at` must be
 * real timestamps or be omitted.
 */
const UNKNOWN_DATE = 'unknown';

/** How many shows we resolve episode ids for at once (TMDB is rate-limited). */
const SHOW_CONCURRENCY = 4;

@Injectable({ providedIn: 'root' })
export class TraktExportService {
  private docs = inject(DocService);
  private store = inject(LibraryStore);
  private tmdb = inject(TmdbService);

  /**
   * Build the import file. `onProgress` reports per-show episode resolution,
   * which is the only slow part (one TMDB season request per season watched,
   * served from the HTTP cache on a second run).
   */
  async build(onProgress?: (p: TraktExportProgress) => void): Promise<TraktExportResult> {
    const now = new Date().toISOString();
    const items: TraktItem[] = [];
    let skippedTitles = 0;

    for (const m of this.store.movies()) {
      const item = movieItem(m, now);
      if (item) items.push(item);
      else if (isTracked(m)) skippedTitles++;
    }
    const movies = items.length;

    const watchedTvdbIds = new Set(
      Object.values(this.docs.episodeWatches.toJSON() as Record<string, EpisodeWatch>).map(
        (w) => w.tvdbId,
      ),
    );
    for (const s of this.store.shows()) {
      const item = showItem(s, watchedTvdbIds.has(s.tvdbId ?? ''), now);
      if (item) items.push(item);
      else if (s.state.status !== 'none' && !watchedTvdbIds.has(s.tvdbId ?? '')) skippedTitles++;
    }
    const shows = items.length - movies;

    const episodes = await this.episodeItems(onProgress);
    items.push(...episodes.items);

    return {
      items,
      movies,
      shows,
      episodes: episodes.items.length,
      skippedTitles,
      skippedEpisodes: episodes.skipped,
    };
  }

  /**
   * Turn the episode-watch log into Trakt rows.
   *
   * The log is keyed by `${tvdbId}:${season}:${episode}` — a *show* id plus
   * coordinates — but Trakt identifies an episode by its own id, so every watch
   * has to be resolved through TMDB (series id → season listing → episode id).
   * Watches we can't resolve (no TMDB key, unknown series, an episode TMDB
   * doesn't list) are counted, never guessed at.
   */
  private async episodeItems(
    onProgress?: (p: TraktExportProgress) => void,
  ): Promise<{ items: TraktItem[]; skipped: number }> {
    const byShow = new Map<string, EpisodeWatch[]>();
    for (const w of Object.values(
      this.docs.episodeWatches.toJSON() as Record<string, EpisodeWatch>,
    )) {
      const list = byShow.get(w.tvdbId);
      if (list) list.push(w);
      else byShow.set(w.tvdbId, [w]);
    }

    // A title added from TMDB search already knows its TMDB id (it's baked into
    // the uuid), so prefer that over a /find round-trip for those shows.
    const tmdbIdByTvdb = new Map<string, number>();
    for (const s of this.store.shows()) {
      const added = parseAddedKey(s.uuid);
      if (added?.kind === 'show' && s.tvdbId) tmdbIdByTvdb.set(s.tvdbId, added.tmdbId);
    }

    const groups = [...byShow.entries()];
    let done = 0;
    onProgress?.({ done, total: groups.length });

    const results = await mapLimit(groups, SHOW_CONCURRENCY, async ([tvdbId, watches]) => {
      const out = await this.showEpisodeItems(tvdbId, watches, tmdbIdByTvdb.get(tvdbId));
      onProgress?.({ done: ++done, total: groups.length });
      return out;
    });

    return {
      items: results.flatMap((r) => r.items),
      skipped: results.reduce((n, r) => n + r.skipped, 0),
    };
  }

  private async showEpisodeItems(
    tvdbId: string,
    watches: EpisodeWatch[],
    knownTmdbId?: number,
  ): Promise<{ items: TraktItem[]; skipped: number }> {
    const tmdbId = knownTmdbId ?? (await this.tmdb.tmdbIdForTvdb(tvdbId).catch(() => null));
    if (tmdbId == null) return { items: [], skipped: watches.length };

    // One request per *season watched*, not per episode — and the TMDB layer
    // caches by URL, so re-exporting later is mostly free.
    const seasons = [...new Set(watches.map((w) => w.season))];
    const episodeIds = new Map<string, number>();
    for (const season of seasons) {
      const list = await this.tmdb.season(tmdbId, season).catch(() => []);
      for (const ep of list) {
        if (ep.id != null) episodeIds.set(`${season}:${ep.episodeNumber}`, ep.id);
      }
    }

    const items: TraktItem[] = [];
    let skipped = 0;
    for (const w of watches) {
      const id = episodeIds.get(`${w.season}:${w.episode}`);
      if (id == null) {
        skipped++;
        continue;
      }
      // Rewatches collapse to a single row: `nbTimes` counts plays but we only
      // ever stored one timestamp, and N identical watched_at values would be
      // one play to any importer anyway.
      items.push({
        tmdb_id: String(id),
        type: 'episode',
        watched_at: traktDate(w.watchedAt) ?? UNKNOWN_DATE,
      });
    }
    return { items, skipped };
  }
}

// ---------------------------------------------------------------------------
// Pure mappers (exported for unit tests — no injector, no network)
// ---------------------------------------------------------------------------

/**
 * Normalize a stored date into the ISO 8601 the format requires, or null.
 *
 * Dates reach us from three places with three shapes: our own `toISOString()`
 * output, a TV Time backup's `"2019-09-03 10:32:47"`, and a hand-edited import
 * file. Only the first is already valid, so everything goes through Date —
 * anything unparseable becomes null rather than a string Trakt would reject.
 */
export function traktDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  // "2019-09-03 10:32:47" is not ISO 8601 and parses inconsistently across
  // engines; the space is the only thing separating it from a valid stamp.
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:/.test(raw) ? raw.replace(' ', 'T') : raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A rating Trakt will accept (whole number, 1–10), or undefined. */
export function traktRating(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.round(value);
  return n >= 1 && n <= 10 ? n : undefined;
}

/**
 * Pick the id key for a title. IMDb/TheTVDB ids come from the imported backup;
 * a title added in-app has only its TMDB id, which the uuid encodes. Returns
 * null when we hold no id Trakt can resolve — such a title can't be exported.
 */
export function traktId(
  uuid: string,
  ids: { imdbId?: string | null; tvdbId?: string | null },
): Pick<TraktItem, 'imdb_id' | 'tmdb_id' | 'tvdb_id'> | null {
  if (ids.imdbId) return { imdb_id: ids.imdbId };
  if (ids.tvdbId) return { tvdb_id: ids.tvdbId };
  const added = parseAddedKey(uuid);
  return added ? { tmdb_id: String(added.tmdbId) } : null;
}

/** True if the user has expressed anything at all about this film. */
function isTracked(m: MovieView): boolean {
  const s = m.state;
  return s.watched || s.watchlist || s.favorite || s.rating != null;
}

/**
 * Project a film onto one import row. Watch, watchlist and rating ride in a
 * single object — Trakt reads all three off the same item.
 *
 * `fallbackDate` (the moment of export) backfills a watchlist entry whose own
 * date we never recorded: `watchlisted_at` has no "unknown" escape hatch, so
 * the choice is an approximate date or dropping the entry, and an entry on the
 * watchlist dated today is far closer to the truth than no entry at all.
 */
export function movieItem(m: MovieView, fallbackDate: string): TraktItem | null {
  const id = traktId(m.uuid, { imdbId: m.imdbId });
  if (!id) return null;

  const s = m.state;
  const item: TraktItem = { ...id, type: 'movie' };
  if (s.watched) item.watched_at = traktDate(s.watchedAt) ?? traktDate(m.watchedAt) ?? UNKNOWN_DATE;
  if (s.watchlist) {
    item.watchlisted_at = traktDate(m.followedAt) ?? traktDate(s.updatedAt) ?? fallbackDate;
  }
  const rating = traktRating(s.rating);
  if (rating !== undefined) {
    item.rating = rating;
    // Only parsed alongside a rating, and we don't store a separate "rated at";
    // `updatedAt` is the write that most likely set it.
    item.rated_at = traktDate(s.updatedAt) ?? fallbackDate;
  }

  // Favorites have no field in this format. A film that is *only* favorited
  // therefore has nothing to say here and is reported as skipped.
  return item.watched_at || item.watchlisted_at || item.rating !== undefined ? item : null;
}

/**
 * Project a show onto one import row — watchlist and rating only, plus one
 * special case for whole-show completion.
 *
 * Watch history normally travels as episode rows, so a show with any episode
 * watch deliberately gets no `watched_at`: a show-level watch date tells Trakt
 * to mark *every* episode watched, which would overwrite the precise history
 * the episode rows carry. The exception is a show marked completed with no
 * episode rows at all (common for backups that only recorded show status) —
 * there, whole-show completion is the only fact we have, and dropping it would
 * lose the show entirely.
 */
export function showItem(
  s: ShowView,
  hasEpisodeWatches: boolean,
  fallbackDate: string,
): TraktItem | null {
  const id = traktId(s.uuid, { tvdbId: s.tvdbId });
  if (!id) return null;

  const st = s.state;
  const item: TraktItem = { ...id, type: 'show' };
  if (st.status === 'watchlist') {
    item.watchlisted_at = traktDate(st.addedAt) ?? traktDate(s.followedAt) ?? fallbackDate;
  }
  if (st.status === 'completed' && !hasEpisodeWatches) {
    item.watched_at = traktDate(s.showWatchedAt) ?? traktDate(st.updatedAt) ?? UNKNOWN_DATE;
  }
  const rating = traktRating(st.rating);
  if (rating !== undefined) {
    item.rating = rating;
    item.rated_at = traktDate(st.updatedAt) ?? fallbackDate;
  }

  return item.watched_at || item.watchlisted_at || item.rating !== undefined ? item : null;
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving order.
 * A library can hold hundreds of shows; firing every TMDB request at once
 * would earn a 429 and turn a slow export into a broken one.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
