import { Injectable, computed, inject } from '@angular/core';
import { LocalConfigService } from './local-config.service';

export interface TmdbImages {
  poster: (path: string | null, size?: PosterSize) => string | null;
}
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
const CACHE = 'tmdb-v1';
const TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days for JSON

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
  private config = inject(LocalConfigService);

  /** Reactive: flips on as soon as the device-local key is loaded or set. */
  readonly hasKey = computed(() => !!this.config.tmdbKey()?.trim());
  private tmdbIdByTvdb = new Map<string, number | null>();
  private tmdbIdByImdb = new Map<string, number | null>();

  apiKey(): string | undefined {
    return this.config.tmdbKey()?.trim() || undefined;
  }
  setKey(key: string): void {
    this.config.set('tmdbKey', key.trim());
  }

  poster(path: string | null, size: PosterSize = 'w342'): string | null {
    return path ? `${IMG}/${size}${path}` : null;
  }
  still(path: string | null, size: 'w300' | 'original' = 'w300'): string | null {
    return path ? `${IMG}/${size}${path}` : null;
  }
  profileImg(path: string | null, size: 'w185' | 'original' = 'w185'): string | null {
    return path ? `${IMG}/${size}${path}` : null;
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
    const d = await this.get(`/tv/${tmdbId}?append_to_response=next_episode_to_air`);
    if (!d) return null;
    const next = d.next_episode_to_air;
    return {
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
    const url = `${BASE}${path}${sep}api_key=${key}&language=en-US`;
    const cacheUrl = url.replace(key, 'KEY'); // don't key the cache on the secret

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
