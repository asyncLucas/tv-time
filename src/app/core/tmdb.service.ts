import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { LocalConfigService } from './local-config.service';
import { DocService } from './doc.service';

export type PosterSize = 'w185' | 'w342' | 'w500' | 'original';

export interface TmdbShow {
  id: number;
  name: string;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  firstAirDate: string | null;
  status: string | null;
  numberOfSeasons: number;
  genres: string[];
  seasons: { seasonNumber: number; episodeCount: number; name: string }[];
  nextEpisode: TmdbEpisode | null;
  networks: string[];
  /** TheTVDB series id, when TMDB knows it — episode watches are keyed by it. */
  tvdbId: string | null;
}

/** One row of a TMDB search response — enough to render a pick-list card. */
export interface TmdbSearchResult {
  tmdbId: number;
  name: string;
  overview: string;
  posterPath: string | null;
  year: string | null;
}

export interface TmdbMovie {
  id: number;
  title: string;
  tagline: string | null;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  runtime: number | null;
  status: string | null;
  voteAverage: number | null;
  genres: string[];
  directors: string[];
  cast: { name: string; character: string; profilePath: string | null }[];
  homepage: string | null;
  imdbId: string | null;
}

export interface TmdbEpisode {
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  overview: string;
  airDate: string | null;
  stillPath: string | null;
  runtime: number | null;
}

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

/**
 * Build a TMDB image URL. Exported as a plain function because non-injectable
 * code (the store's added-title mappers) needs it too, and it is pure.
 */
export function tmdbPosterUrl(path: string | null, size: PosterSize = 'w342'): string | null {
  return path ? `${IMG}/${size}${path}` : null;
}
const CACHE = 'tmdb-v1';
const TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days for JSON
/** Shorter query strings only return noise, so they never reach the API. */
const MIN_QUERY_LENGTH = 2;
const MAX_SEARCH_RESULTS = 20;

/**
 * TMDB metadata layer. Enriches the backup at runtime: posters, season/episode
 * lists, air dates, "what's next". Keyed off the tvdb_id/imdb_id already in the
 * seed, so resolution is exact rather than fuzzy title search.
 *
 * Caching is content-addressed by request URL via the Cache API — the id lives
 * in the URL, so the same resource resolves to the same cache entry across the
 * app, works offline once fetched, and never re-hits the network within its TTL.
 */
@Injectable({ providedIn: 'root' })
export class TmdbService {
  private docs = inject(DocService);
  private config = inject(LocalConfigService);

  // The TMDB key lives in the SYNCED doc so it persists in your gist and reaches
  // every device — set it once, posters light up everywhere. (It's your own
  // private gist / device fleet, so syncing the key is a convenience, not a leak.)
  private settingsSig = signal<Record<string, any>>({});
  private migrated = false;

  /** Reactive: flips on as soon as the key is loaded, set, or synced in. */
  readonly hasKey = computed(() => !!(this.settingsSig()['tmdbKey'] as string | undefined)?.trim());
  private tmdbIdByTvdb = new Map<string, number | null>();
  private tmdbIdByImdb = new Map<string, number | null>();

  constructor() {
    const refresh = () => this.settingsSig.set(this.docs.settings.toJSON());
    refresh();
    this.docs.settings.observe(refresh);
    // one-time migration of a pre-existing device-local key into the synced doc
    effect(() => {
      const local = this.config.tmdbKey()?.trim();
      const synced = (this.settingsSig()['tmdbKey'] as string | undefined)?.trim();
      if (!this.migrated && local && !synced) {
        this.migrated = true;
        this.docs.settings.set('tmdbKey', local);
        this.config.delete('tmdbKey');
      }
    });
  }

  apiKey(): string | undefined {
    return (this.settingsSig()['tmdbKey'] as string | undefined)?.trim() || undefined;
  }
  setKey(key: string): void {
    this.docs.settings.set('tmdbKey', key.trim());
  }

  poster(path: string | null, size: PosterSize = 'w342'): string | null {
    return tmdbPosterUrl(path, size);
  }
  profileImg(path: string | null, size: 'w185' | 'original' = 'w185'): string | null {
    return path ? `${IMG}/${size}${path}` : null;
  }

  // -------------------------------------------------------------------------
  // Discovery (search)
  // -------------------------------------------------------------------------
  /**
   * Search TMDB for shows/movies to add to the library.
   *
   * Unlike the rest of this service — which resolves titles the catalog already
   * names, by exact external id — this is the one genuinely open-ended lookup.
   * Results are ranked by TMDB and returned as-is; the caller picks one.
   *
   * A blank or one-character query returns nothing rather than hitting the API,
   * since it would only ever return noise.
   */
  searchShows(query: string): Promise<TmdbSearchResult[]> {
    return this.search('tv', query);
  }

  searchMovies(query: string): Promise<TmdbSearchResult[]> {
    return this.search('movie', query);
  }

  /**
   * This week's trending films. Same shape as a search result, so the same cards
   * render it. Only called when the caller actually asks — the Movies page holds
   * off until its Trending tab is opened.
   */
  async trendingMovies(): Promise<TmdbSearchResult[]> {
    const data = await this.get('/trending/movie/week');
    return ((data?.results ?? []) as any[]).slice(0, MAX_SEARCH_RESULTS).map((r) => ({
      tmdbId: r.id,
      name: r.title ?? r.name ?? '',
      overview: r.overview ?? '',
      posterPath: r.poster_path ?? null,
      year: (r.release_date || r.first_air_date || '').slice(0, 4) || null,
    }));
  }

  private async search(kind: 'tv' | 'movie', query: string): Promise<TmdbSearchResult[]> {
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) return [];
    const data = await this.get(
      `/search/${kind}?query=${encodeURIComponent(q)}&include_adult=false`,
    );
    return ((data?.results ?? []) as any[]).slice(0, MAX_SEARCH_RESULTS).map((r) => ({
      tmdbId: r.id,
      // /search/tv calls it `name`, /search/movie calls it `title`
      name: r.name ?? r.title ?? '',
      overview: r.overview ?? '',
      posterPath: r.poster_path ?? null,
      year: (r.first_air_date || r.release_date || '').slice(0, 4) || null,
    }));
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------
  /** Resolve a TheTVDB series id to a TMDB id (cached in-memory + Cache API). */
  async tmdbIdForTvdb(tvdbId: string): Promise<number | null> {
    if (this.tmdbIdByTvdb.has(tvdbId)) return this.tmdbIdByTvdb.get(tvdbId)!;
    const data = await this.get(`/find/${tvdbId}?external_source=tvdb_id`);
    const tv = data?.tv_results?.[0];
    const id = tv?.id ?? null;
    this.tmdbIdByTvdb.set(tvdbId, id);
    return id;
  }

  async findMovieByImdb(imdbId: string): Promise<any | null> {
    const data = await this.get(`/find/${imdbId}?external_source=imdb_id`);
    return data?.movie_results?.[0] ?? null;
  }

  /** Resolve an IMDb id to a TMDB movie id (cached in-memory + Cache API). */
  async tmdbIdForImdb(imdbId: string): Promise<number | null> {
    if (this.tmdbIdByImdb.has(imdbId)) return this.tmdbIdByImdb.get(imdbId)!;
    const m = await this.findMovieByImdb(imdbId);
    const id = m?.id ?? null;
    this.tmdbIdByImdb.set(imdbId, id);
    return id;
  }

  // -------------------------------------------------------------------------
  // Show + episode detail
  // -------------------------------------------------------------------------
  async showByTvdb(tvdbId: string): Promise<TmdbShow | null> {
    const id = await this.tmdbIdForTvdb(tvdbId);
    if (id == null) return null;
    return this.show(id);
  }

  async show(tmdbId: number): Promise<TmdbShow | null> {
    // external_ids rides along on the same request: adding a show from search
    // needs its TheTVDB id, and a second round-trip for it would be wasteful.
    const d = await this.get(
      `/tv/${tmdbId}?append_to_response=next_episode_to_air,external_ids`,
    );
    if (!d) return null;
    const next = d.next_episode_to_air;
    const tvdb = d.external_ids?.tvdb_id;
    return {
      tvdbId: tvdb ? String(tvdb) : null,
      id: d.id,
      name: d.name,
      overview: d.overview,
      posterPath: d.poster_path,
      backdropPath: d.backdrop_path,
      firstAirDate: d.first_air_date || null,
      status: d.status || null,
      numberOfSeasons: d.number_of_seasons ?? 0,
      genres: (d.genres ?? []).map((g: any) => g.name),
      networks: (d.networks ?? []).map((n: any) => n.name),
      seasons: (d.seasons ?? [])
        .filter((s: any) => s.season_number > 0)
        .map((s: any) => ({
          seasonNumber: s.season_number,
          episodeCount: s.episode_count,
          name: s.name,
        })),
      nextEpisode: next
        ? {
            seasonNumber: next.season_number,
            episodeNumber: next.episode_number,
            name: next.name,
            overview: next.overview,
            airDate: next.air_date,
            stillPath: next.still_path,
            runtime: next.runtime ?? null,
          }
        : null,
    };
  }

  async season(tmdbId: number, seasonNumber: number): Promise<TmdbEpisode[]> {
    const d = await this.get(`/tv/${tmdbId}/season/${seasonNumber}`);
    return (d?.episodes ?? []).map((e: any) => ({
      seasonNumber: e.season_number,
      episodeNumber: e.episode_number,
      name: e.name,
      overview: e.overview,
      airDate: e.air_date,
      stillPath: e.still_path,
      runtime: e.runtime ?? null,
    }));
  }

  // -------------------------------------------------------------------------
  // Movie detail
  // -------------------------------------------------------------------------
  async movieByImdb(imdbId: string): Promise<TmdbMovie | null> {
    const id = await this.tmdbIdForImdb(imdbId);
    if (id == null) return null;
    return this.movie(id);
  }

  async movie(tmdbId: number): Promise<TmdbMovie | null> {
    const d = await this.get(`/movie/${tmdbId}?append_to_response=credits`);
    if (!d) return null;
    const crew = d.credits?.crew ?? [];
    return {
      id: d.id,
      title: d.title,
      tagline: d.tagline || null,
      overview: d.overview,
      posterPath: d.poster_path,
      backdropPath: d.backdrop_path,
      releaseDate: d.release_date || null,
      runtime: d.runtime ?? null,
      status: d.status || null,
      voteAverage: d.vote_average ?? null,
      genres: (d.genres ?? []).map((g: any) => g.name),
      directors: crew.filter((c: any) => c.job === 'Director').map((c: any) => c.name),
      cast: (d.credits?.cast ?? []).slice(0, 12).map((c: any) => ({
        name: c.name,
        character: c.character,
        profilePath: c.profile_path,
      })),
      homepage: d.homepage || null,
      imdbId: d.imdb_id || null,
    };
  }

  // -------------------------------------------------------------------------
  // Cache-first fetch
  // -------------------------------------------------------------------------
  private async get(path: string): Promise<any | null> {
    const key = this.apiKey();
    if (!key) return null;
    const sep = path.includes('?') ? '&' : '?';
    // Build both URLs from the same base, differing only in the api_key value,
    // so the secret is never part of the cache key. (Deriving the cache URL by
    // string-replacing the key into the real URL would leak it the moment the
    // key contained a regex- or URL-significant character.)
    const base = `${BASE}${path}${sep}language=en-US&api_key=`;
    const url = base + encodeURIComponent(key);
    const cacheUrl = base + 'KEY';

    try {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(cacheUrl);
      if (hit) {
        const ts = Number(hit.headers.get('x-cached-at') ?? 0);
        if (Date.now() - ts < TTL_MS) return hit.json();
      }
      const res = await fetch(url);
      if (!res.ok) return hit ? hit.json() : null; // fall back to stale on error
      const body = await res.clone().json();
      const stamped = new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json', 'x-cached-at': String(Date.now()) },
      });
      await cache.put(cacheUrl, stamped);
      return body;
    } catch {
      return null; // offline & uncached
    }
  }

  async clearCache(): Promise<void> {
    await caches.delete(CACHE);
    this.tmdbIdByTvdb.clear();
    this.tmdbIdByImdb.clear();
  }
}
