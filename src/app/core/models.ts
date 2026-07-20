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
export type ShowStatus = 'watching' | 'completed' | 'watchlist' | 'dropped' | 'none';

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
 * A show added by the user that was NOT in the seed catalog. Minimal reference
 * data so other devices can render it without a fresh TMDB lookup.
 */
export interface AddedShowRef {
  uuid: string;
  name: string;
  tvdbId: string | null;
  tmdbId: number | null;
  posterPath: string | null;
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
