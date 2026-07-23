/**
 * Domain models.
 *
 * Two tiers, deliberately separated:
 *  - CATALOG (reference data): shipped in seed.json, identical on every device,
 *    enriched by TMDB at runtime. Never travels through the CRDT.
 *  - USER STATE: the small, mergeable set of facts that DOES sync — what you've
 *    watched, your watchlist, ratings, favorites, list edits. Lives in the Y.Doc.
 */

// ---------------------------------------------------------------------------
// Catalog (from seed.json)
// ---------------------------------------------------------------------------
export interface SeedShow {
  uuid: string;
  name: string;
  tvdbId: string | null;
  genres: string[];
  firstReleaseDate: string | null;
  overview: string | null;
  followedAt: string | null;
  showWatchedAt: string | null;
  isEnded: boolean | null;
  dayOfWeek: string | null;
  network: string | null;
  country: string | null;
  hashtag: string | null;
  cachedPoster: string | null;
  favorite: boolean;
}

export interface SeedMovie {
  uuid: string;
  name: string;
  imdbId: string | null;
  tvdbId: string | null;
  genres: string[];
  firstReleaseDate: string | null;
  overview: string | null;
  followedAt: string | null;
  watchedAt: string | null;
  favorite: boolean;
  /**
   * Ready-made artwork URL. TV Time backups don't carry one for films, so for
   * catalog entries it is whatever `tools/fetch-movie-posters.py` baked in — the
   * only way a first-run visitor, who has no TMDB key and so no way to resolve
   * artwork at all, sees a movie cover. For titles added from TMDB search it is
   * the poster path the search already returned, saving a round-trip.
   *
   * Still optional: a catalog built before that script ran has none, and the
   * synced poster cache (see PosterCacheService) covers the difference.
   */
  cachedPoster?: string | null;
}

export interface SeedWatchedMovie {
  uuid: string;
  name: string | null;
  imdbId: string | null;
  watchedAt: string | null;
  runtimeSec: number | null;
}

export interface SeedWatchedEpisode {
  show: string;
  showId: string | null;
  season: number | null;
  number: number | null;
  episodeTitle: string | null;
  episodeId: string | null;
  seen: boolean;
  seenDate: string | null;
  nbTimesWatched: number;
  network: string | null;
}

export interface SeedListItem {
  title: string;
  entityType: string | null;
  uuid: string | null;
}

export interface SeedCustomList {
  id: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  type: string | null;
  createdAt: string | null;
  items: SeedListItem[];
}

export interface SeedProfile {
  id: number;
  login: string;
  name: string;
  image: string | null;
  timezone: string | null;
  lang: string | null;
  createdAt: string | null;
  favoriteGenres: unknown[];
  stats: Record<string, number>;
}

export interface Seed {
  meta: {
    source: string;
    syncedApprox: string;
    backedUp: string;
    schema: number;
    note: string;
  };
  profile: SeedProfile;
  shows: SeedShow[];
  movies: SeedMovie[];
  watchedMovies: SeedWatchedMovie[];
  watchedEpisodes: SeedWatchedEpisode[];
  customLists: SeedCustomList[];
}

// ---------------------------------------------------------------------------
// User state (the CRDT doc)
// ---------------------------------------------------------------------------
export type ShowStatus = 'watching' | 'paused' | 'completed' | 'watchlist' | 'dropped' | 'none';

/** Per-show tracking state. Keyed by show uuid in the CRDT. */
export interface ShowState {
  status: ShowStatus;
  favorite: boolean;
  rating: number | null; // 1..10
  addedAt: string | null;
  updatedAt: string | null;
}

/** Per-movie tracking state. Keyed by movie uuid. */
export interface MovieState {
  watched: boolean;
  watchedAt: string | null;
  watchlist: boolean;
  favorite: boolean;
  rating: number | null;
  updatedAt: string | null;
}

/** A single episode watch. Keyed by `${tvdbId}:${season}:${episode}`. */
export interface EpisodeWatch {
  tvdbId: string;
  season: number;
  episode: number;
  watchedAt: string;
  nbTimes: number;
}

/**
 * The user's own score for one episode. Keyed exactly like the matching
 * EpisodeWatch, but deliberately kept in its own map rather than folded into
 * that record: un-ticking an episode deletes the watch, and it should not
 * silently take an opinion the user typed in down with it.
 */
export interface EpisodeRating {
  tvdbId: string;
  season: number;
  episode: number;
  /** 1..10, the same scale shows and movies are rated on. */
  rating: number;
  ratedAt: string;
  /**
   * True once TMDB accepted this same score. Ratings are stored locally first
   * and pushed after, so this is what distinguishes "filed with TMDB" from
   * "we tried while offline and only have it here".
   */
  syncedToTmdb: boolean;
}

/**
 * A title the user added from TMDB search that wasn't in the catalog.
 *
 * These live in the CRDT (not the device-local seed) so an added show follows
 * you to your other devices — the catalog itself never syncs. Enough reference
 * data is copied to render a card offline without a fresh TMDB call.
 *
 * The `uuid` is derived from the TMDB id (see addedKey), not random: two
 * devices adding the same title independently must converge on one entry
 * rather than each inserting its own.
 */
export interface AddedTitle {
  uuid: string;
  name: string;
  tmdbId: number;
  /** Series id — episode tracking is keyed by it, so shows need it resolved. */
  tvdbId: string | null;
  /** Movie id — movie enrichment resolves through it. */
  imdbId: string | null;
  posterPath: string | null;
  firstReleaseDate: string | null;
  overview: string | null;
  genres: string[];
  addedAt: string;
}

// ---------------------------------------------------------------------------
// View models (catalog + user state, merged — what the UI actually renders)
// ---------------------------------------------------------------------------
export interface ShowView extends SeedShow {
  state: ShowState;
  watchedEpisodeCount: number;
}

export interface MovieView extends SeedMovie {
  state: MovieState;
}

/**
 * One watch, placed in time and priced in minutes — the raw material behind any
 * "when did I watch" view (see LibraryStore.watchTimeline).
 *
 * Deliberately flat: an episode and a film differ only by how many minutes they
 * cost and what `titleKey` they carry, so a breakdown never has to branch on
 * which kind of thing it is looking at.
 */
export interface WatchPoint {
  /** Epoch ms. Points whose stored timestamp doesn't parse are dropped, not zeroed. */
  at: number;
  minutes: number;
  /** Stable per-title id (`show:<tvdbId>` / `movie:<uuid>`) — counts distinct titles. */
  titleKey: string;
}
