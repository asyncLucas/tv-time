import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { LocalConfigService } from './local-config.service';
import { DocService } from './doc.service';

export type PosterSize = 'w185' | 'w342' | 'w500' | 'original';

/** One streaming/rental service a title is available on, per TMDB (JustWatch). */
export interface WatchProvider {
  name: string;
  logoPath: string | null;
}

/**
 * Where a title can be watched, in the viewer's region. `streaming` folds
 * together subscription, free and ad-supported services (the "it's included"
 * ways to watch); `rent`/`buy` are the paid-per-title options. `link` is the
 * TMDB/JustWatch page listing them all for the region.
 */
export interface WatchProviders {
  link: string | null;
  streaming: WatchProvider[];
  rent: WatchProvider[];
  buy: WatchProvider[];
}

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
  /**
   * The most recent episode to have aired. It is the cheap way to tell whether
   * a given episode is watchable yet: `seasons[].episodeCount` counts episodes
   * that are merely *scheduled*, so "what's next" can point past the air line,
   * and this marks where that line is without a season fetch per show. Null for
   * a show that hasn't premiered.
   */
  lastEpisode: TmdbEpisode | null;
  networks: string[];
  /** TheTVDB series id, when TMDB knows it — episode watches are keyed by it. */
  tvdbId: string | null;
  /** IMDb id, when TMDB knows it — used to build a Stremio deep link. */
  imdbId: string | null;
  cast: { id: number; name: string; character: string; profilePath: string | null }[];
  /** Streaming/rental availability in the viewer's region, or null if unknown. */
  watchProviders: WatchProviders | null;
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
  cast: { id: number; name: string; character: string; profilePath: string | null }[];
  homepage: string | null;
  imdbId: string | null;
  /** Best available YouTube trailer, as a watch URL — null if TMDB has none. */
  trailerUrl: string | null;
  /** Streaming/rental availability in the viewer's region, or null if unknown. */
  watchProviders: WatchProviders | null;
}

export interface TmdbEpisode {
  /**
   * TMDB's own id for this episode. Unused by the UI (which addresses episodes
   * by season + number), but it is the only *per-episode* identifier we can
   * obtain — and a Trakt import file identifies episodes by id, never by
   * show + S/E. Null when the source payload didn't carry one.
   */
  id: number | null;
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  overview: string;
  airDate: string | null;
  stillPath: string | null;
  runtime: number | null;
  /** TMDB's community score out of 10, or null when nobody has rated it. */
  voteAverage: number | null;
}

/** How TMDB names the two kinds of title in its own URLs and payloads. */
export type TmdbMediaKind = 'tv' | 'movie';

/**
 * Outcome of pushing one change to TMDB. Never a thrown error: the change is
 * already stored locally by the time this runs, so the remote half failing is
 * a footnote the UI reports, not a failure of the user's action.
 */
export interface TmdbWriteResult {
  ok: boolean;
  /** Who it was filed under — an anonymous vote shouldn't be a surprise. */
  as: 'account' | 'guest' | null;
  error: string | null;
  /**
   * True when nothing was even attempted — no key, or an account-only write
   * (watchlist, favorites) with no account linked. Distinguished from a failure
   * so the UI can stay quiet about a mirror the user never asked to set up,
   * rather than reporting an error against every edit they make.
   */
  skipped?: boolean;
}

/** Historic name for the same shape — ratings were the first thing we pushed. */
export type TmdbRatingResult = TmdbWriteResult;

/** One title as TMDB's v4 list endpoints name it. */
export interface TmdbListItemRef {
  media_type: TmdbMediaKind;
  media_id: number;
}

/** A list write, carrying the remote list's id when the write created one. */
export interface TmdbListResult extends TmdbWriteResult {
  listId: number | null;
}

const BASE = 'https://api.themoviedb.org/3';
/**
 * Lists are the one part of the profile v3 can't hold: its list endpoints take
 * a movie id and nothing else, and half of what people put on a list here is a
 * show. v4's do take `{media_type, media_id}`, so custom lists — and only they
 * — talk to v4. See the auth note on `readToken`.
 */
const V4 = 'https://api.themoviedb.org/4';
const IMG = 'https://image.tmdb.org/t/p';

/**
 * Build a TMDB image URL. Exported as a plain function because non-injectable
 * code (the store's added-title mappers) needs it too, and it is pure.
 */
export function tmdbPosterUrl(path: string | null, size: PosterSize = 'w342'): string | null {
  return path ? `${IMG}/${size}${path}` : null;
}

/**
 * True when the credential is a v4 "API Read Access Token" rather than a v3 key.
 *
 * TMDB's settings page shows both, one above the other, and the v4 token is the
 * one people copy. It is a JWT and is rejected outright as an `api_key=` query
 * param, so pasting it used to fail every request while the app still reported
 * "key active" — shows kept their backup artwork and looked fine, films (which
 * have none) went blank, and the app looked broken only for movies. Detecting
 * the shape and sending it as a bearer token instead makes either form work.
 */
export function isBearerToken(key: string): boolean {
  return key.split('.').length === 3 && key.startsWith('ey');
}

/**
 * Pick the single most watch-worthy YouTube clip from a TMDB `videos` result set
 * and return its watch URL. Prefers official trailers, then any trailer, then
 * teasers; ignores non-YouTube sites we can't link cleanly. Null if none fit.
 */
function bestTrailerUrl(videos: any[]): string | null {
  const score = (v: any): number => {
    if (v.site !== 'YouTube' || !v.key) return -1;
    const type = v.type === 'Trailer' ? 2 : v.type === 'Teaser' ? 1 : 0;
    if (type === 0) return -1; // clips, featurettes, behind-the-scenes: not a trailer
    return type * 2 + (v.official ? 1 : 0);
  };
  const best = videos.reduce<any>((top, v) => (score(v) > score(top ?? {}) ? v : top), null);
  return best && score(best) > 0 ? `https://www.youtube.com/watch?v=${best.key}` : null;
}

/**
 * Reshape one TMDB episode node — they are identical whether they come from a
 * season listing or from a show's next/last-episode-to-air block. Null in, null
 * out, so a show with no such episode passes straight through.
 */
function mapEpisode(e: any): TmdbEpisode | null {
  if (!e) return null;
  return {
    id: e.id ?? null,
    seasonNumber: e.season_number,
    episodeNumber: e.episode_number,
    name: e.name,
    overview: e.overview,
    airDate: e.air_date ?? null,
    stillPath: e.still_path ?? null,
    runtime: e.runtime ?? null,
    // 0 means "no votes yet", which is not the same as scoring zero — coerce it
    // to null so the UI can leave the badge off entirely.
    voteAverage: e.vote_average || null,
  };
}

/**
 * The two-letter region to ask TMDB for watch providers in — availability is
 * country-specific, so we key off the browser's locale (e.g. `pt-BR` → `BR`)
 * and fall back to the US when it carries no region.
 */
export function userRegion(): string {
  try {
    const region = new Intl.Locale(navigator.language).region;
    if (region) return region.toUpperCase();
  } catch {
    /* older engines / malformed locale: fall through */
  }
  return 'US';
}

/**
 * Reshape TMDB's `watch/providers` block for one region into our flat view.
 * Subscription, free and ad-supported services all mean "you can just watch
 * it", so they collapse into one `streaming` list (deduped — a service can be
 * listed as both free and ad-supported). Returns null when the region has no
 * providers at all, so callers can hide the row entirely.
 */
function parseWatchProviders(node: any, region: string): WatchProviders | null {
  const r = node?.results?.[region];
  if (!r) return null;
  const map = (arr: any[] | undefined): WatchProvider[] =>
    (arr ?? []).map((p) => ({ name: p.provider_name, logoPath: p.logo_path ?? null }));
  const byName = new Map<string, WatchProvider>();
  for (const p of [...map(r.flatrate), ...map(r.free), ...map(r.ads)]) {
    if (!byName.has(p.name)) byName.set(p.name, p);
  }
  const streaming = [...byName.values()];
  const rent = map(r.rent);
  const buy = map(r.buy);
  if (!streaming.length && !rent.length && !buy.length) return null;
  return { link: r.link ?? null, streaming, rent, buy };
}

const CACHE = 'tmdb-v1';
const TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days for JSON

/**
 * What the UI shows when a TMDB request fails. One string, because every
 * caller means the same thing by it and they were drifting apart.
 */
export const TMDB_UNREACHABLE = 'Could not reach TMDB. Check your connection and try again.';
/** Shorter query strings only return noise, so they never reach the API. */
const MIN_QUERY_LENGTH = 2;
const MAX_SEARCH_RESULTS = 20;

/** TMDB accepts 0.5–10 in half-points; the app's 1–10 pips are a subset. */
const MIN_RATING = 0.5;
const MAX_RATING = 10;
/** Device-local key holding the current guest session (see guestSession). */
const GUEST_SESSION_KEY = 'tmdbGuestSession';
/**
 * Synced settings key holding the linked account's numeric id. TMDB addresses
 * account state (`/account/{id}/watchlist`) by id rather than by session, so it
 * is resolved once and cached beside the session it belongs to.
 */
const ACCOUNT_ID_KEY = 'tmdbAccountId';
/**
 * Synced settings keys for the v4 half of the integration (custom lists only).
 *
 * `V4_READ_TOKEN_KEY` is the *application* credential — the "API Read Access
 * Token" printed under the v3 key on TMDB's own settings page. `V4_ACCESS_KEY`
 * is the *user* token the three-legged v4 flow returns, and the only thing that
 * can write to someone's lists.
 */
const V4_READ_TOKEN_KEY = 'tmdbV4Token';
const V4_ACCESS_KEY = 'tmdbV4Access';
const V4_ACCOUNT_KEY = 'tmdbV4AccountId';
/** Re-mint a guest session this long before TMDB says it lapses. */
const GUEST_SESSION_MARGIN_MS = 60_000;
/** TMDB guest sessions lapse after an hour; the fallback when it won't say. */
const GUEST_SESSION_FALLBACK_MS = 60 * 60 * 1000;

/**
 * Turn TMDB's `expires_at` ("2016-08-27 16:26:40 UTC") into epoch millis.
 * An absent or unparseable stamp is treated as the standard hour rather than
 * as "never expires" — a session we wrongly believe is live just fails the
 * next rating, and we'd rather re-mint one for nothing.
 */
export function parseTmdbExpiry(value: unknown): number {
  const t =
    typeof value === 'string' ? Date.parse(value.replace(' UTC', 'Z').replace(' ', 'T')) : NaN;
  return Number.isFinite(t) ? t : Date.now() + GUEST_SESSION_FALLBACK_MS;
}

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
  /**
   * True when a TMDB account is linked, so ratings post under the user's own
   * name instead of through an anonymous guest session.
   */
  readonly hasAccount = computed(() => !!this.sessionId());
  /** True when a v4 read access token is available to drive the list flow. */
  readonly hasV4Token = computed(() => !!this.readToken());
  /** True when the user has authorized this app to write to their TMDB lists. */
  readonly hasListAccess = computed(() => !!this.listToken());
  private tmdbIdByTvdb = new Map<string, number | null>();
  private tmdbIdByImdb = new Map<string, number | null>();
  /** In-flight requests by cache URL, so concurrent callers share one fetch. */
  private inflight = new Map<string, Promise<any | null>>();

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

  /**
   * The linked account's session id, if any. Lives beside the API key in the
   * synced settings map, so linking once reaches the whole device fleet — the
   * same trade-off (and the same trusted channels) as the key itself.
   */
  private sessionId(): string | undefined {
    return (this.settingsSig()['tmdbSessionId'] as string | undefined)?.trim() || undefined;
  }

  /**
   * The application-level v4 credential the list flow is signed with.
   *
   * Someone who pasted the v4 read access token as their key already has it —
   * `isBearerToken` is how the read path recognises the same string — so this
   * only needs its own setting for the far more common case of a v3 key, where
   * TMDB simply prints two different credentials and the app was given the
   * other one. Nothing here can be derived from the v3 key: the two are issued
   * separately, and TMDB converts only v4 → v3, never back.
   */
  private readToken(): string | undefined {
    const explicit = (this.settingsSig()[V4_READ_TOKEN_KEY] as string | undefined)?.trim();
    if (explicit) return explicit;
    const key = this.apiKey();
    return key && isBearerToken(key) ? key : undefined;
  }

  /** The user access token authorizing writes to their lists, if linked. */
  private listToken(): string | undefined {
    return (this.settingsSig()[V4_ACCESS_KEY] as string | undefined)?.trim() || undefined;
  }

  setV4Token(token: string): void {
    const trimmed = token.trim();
    if (trimmed) this.docs.settings.set(V4_READ_TOKEN_KEY, trimmed);
    else this.docs.settings.delete(V4_READ_TOKEN_KEY);
  }

  poster(path: string | null, size: PosterSize = 'w342'): string | null {
    return tmdbPosterUrl(path, size);
  }
  profileImg(path: string | null, size: 'w185' | 'original' = 'w185'): string | null {
    return path ? `${IMG}/${size}${path}` : null;
  }
  /** A watch-provider logo (Netflix, Prime, …), sized for a small badge. */
  providerLogo(path: string | null, size: 'w45' | 'w92' | 'original' = 'w92'): string | null {
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
  trendingMovies(): Promise<TmdbSearchResult[]> {
    return this.trending('movie');
  }

  /** This week's trending series. The Shows page holds off the same way. */
  trendingShows(): Promise<TmdbSearchResult[]> {
    return this.trending('tv');
  }

  private async trending(kind: 'tv' | 'movie'): Promise<TmdbSearchResult[]> {
    const data = await this.get(`/trending/${kind}/week`);
    return ((data?.results ?? []) as any[]).slice(0, MAX_SEARCH_RESULTS).map((r) => ({
      tmdbId: r.id,
      // /trending/tv calls it `name`, /trending/movie calls it `title`
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
      `/tv/${tmdbId}?append_to_response=next_episode_to_air,external_ids,credits,watch/providers`,
    );
    if (!d) return null;
    const tvdb = d.external_ids?.tvdb_id;
    return {
      tvdbId: tvdb ? String(tvdb) : null,
      imdbId: d.external_ids?.imdb_id || null,
      watchProviders: parseWatchProviders(d['watch/providers'], userRegion()),
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
      cast: (d.credits?.cast ?? []).slice(0, 12).map((c: any) => ({
        id: c.id,
        name: c.name,
        character: c.character,
        profilePath: c.profile_path,
      })),
      nextEpisode: mapEpisode(d.next_episode_to_air),
      lastEpisode: mapEpisode(d.last_episode_to_air),
    };
  }

  async season(tmdbId: number, seasonNumber: number): Promise<TmdbEpisode[]> {
    const d = await this.get(`/tv/${tmdbId}/season/${seasonNumber}`);
    return ((d?.episodes ?? []) as any[])
      .map(mapEpisode)
      .filter((e): e is TmdbEpisode => e !== null);
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
    const d = await this.get(`/movie/${tmdbId}?append_to_response=credits,videos,watch/providers`);
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
        id: c.id,
        name: c.name,
        character: c.character,
        profilePath: c.profile_path,
      })),
      homepage: d.homepage || null,
      imdbId: d.imdb_id || null,
      trailerUrl: bestTrailerUrl(d.videos?.results ?? []),
      watchProviders: parseWatchProviders(d['watch/providers'], userRegion()),
    };
  }

  // -------------------------------------------------------------------------
  // Ratings (the one place this service writes back to TMDB)
  // -------------------------------------------------------------------------
  /**
   * File the user's 1-10 score for one episode with TMDB.
   *
   * Ratings go to the linked account when there is one and to a throwaway guest
   * session otherwise — TMDB counts both toward the episode's public average,
   * and a guest session needs no sign-in, so rating works the moment a key is
   * set. A 401 on either path means the session lapsed rather than that the
   * rating was bad, so it is retried once with a fresh guest session.
   *
   * Takes the TheTVDB id because that is what the app tracks episodes by; the
   * TMDB id it resolves to is already memoized from rendering the show.
   */
  async rateEpisode(
    tvdbId: string,
    season: number,
    episode: number,
    rating: number,
  ): Promise<TmdbRatingResult> {
    return this.episodeRatingRequest('POST', tvdbId, season, episode, {
      value: clampRating(rating),
    });
  }

  /** Withdraw a previously filed score for an episode. */
  async clearEpisodeRating(
    tvdbId: string,
    season: number,
    episode: number,
  ): Promise<TmdbRatingResult> {
    return this.episodeRatingRequest('DELETE', tvdbId, season, episode);
  }

  /**
   * File the user's 1-10 score for a whole show or film. Same path as episode
   * ratings — account first, guest session otherwise — so a score reaches TMDB
   * with nothing more than an API key set.
   */
  async rateTitle(kind: TmdbMediaKind, tmdbId: number, rating: number): Promise<TmdbWriteResult> {
    return this.ratingWrite('POST', `/${kind}/${tmdbId}/rating`, { value: clampRating(rating) });
  }

  /** Withdraw a previously filed score for a show or film. */
  async clearTitleRating(kind: TmdbMediaKind, tmdbId: number): Promise<TmdbWriteResult> {
    return this.ratingWrite('DELETE', `/${kind}/${tmdbId}/rating`);
  }

  /**
   * Resolve an episode to its rating endpoint and write to it. Takes the
   * TheTVDB id because that is what the app tracks episodes by; the TMDB id it
   * resolves to is already memoized from rendering the show.
   */
  private async episodeRatingRequest(
    method: 'POST' | 'DELETE',
    tvdbId: string,
    season: number,
    episode: number,
    body?: unknown,
  ): Promise<TmdbRatingResult> {
    if (!this.apiKey()) return skippedWrite('No TMDB key set.');
    try {
      const tmdbId = await this.tmdbIdForTvdb(tvdbId);
      if (tmdbId == null) return ratingFailed('TMDB does not know this show.');
      return this.ratingWrite(
        method,
        `/tv/${tmdbId}/season/${season}/episode/${episode}/rating`,
        body,
      );
    } catch {
      return ratingFailed(TMDB_UNREACHABLE);
    }
  }

  /**
   * Send one rating write, trying the linked account first and an anonymous
   * guest session after. A 401 means the session lapsed rather than that the
   * rating was bad, so the guest path is retried once with a fresh session.
   */
  private async ratingWrite(
    method: 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<TmdbWriteResult> {
    if (!this.apiKey()) return skippedWrite('No TMDB key set.');
    try {
      const session = this.sessionId();
      if (session) {
        const r = await this.call(
          method,
          `${path}?session_id=${encodeURIComponent(session)}`,
          body,
        );
        if (accepted(r.status)) return { ok: true, as: 'account', error: null };
        // Anything but "not authorized" is about the rating, not the session.
        if (r.status !== 401) return ratingFailed(statusMessage(r));
        // A 401 that blames the *session* means it was revoked or expired: drop
        // it (so `hasAccount` stops claiming otherwise). One that blames the key
        // says nothing about the session, and unlinking over it would cost the
        // user their account link every time a key was mistyped or rotated.
        if (blamesSession(r)) this.forgetAccount();
        // Either way the account path is closed for this write; try anonymously.
      }

      // The second pass forces a brand-new guest session, for the case where
      // the cached one lapsed earlier than its stated expiry.
      for (const forceNew of [false, true]) {
        const guest = await this.guestSession(forceNew);
        if (!guest) return ratingFailed('TMDB would not open a guest session.');
        const r = await this.call(
          method,
          `${path}?guest_session_id=${encodeURIComponent(guest)}`,
          body,
        );
        if (accepted(r.status)) return { ok: true, as: 'guest', error: null };
        if (r.status !== 401) return ratingFailed(statusMessage(r));
      }
      return ratingFailed('TMDB rejected the guest session.');
    } catch {
      return ratingFailed(TMDB_UNREACHABLE);
    }
  }

  // -------------------------------------------------------------------------
  // Account state (watchlist + favorites)
  // -------------------------------------------------------------------------
  /**
   * Put a title on the user's TMDB watchlist, or take it off again.
   *
   * Unlike ratings there is no anonymous fallback: a watchlist belongs to an
   * account, and TMDB's guest sessions have none. With no account linked this
   * reports `skipped` rather than an error — the local library is unaffected
   * either way, and someone who never linked an account hasn't failed at
   * anything.
   */
  async setWatchlist(
    kind: TmdbMediaKind,
    tmdbId: number,
    onList: boolean,
  ): Promise<TmdbWriteResult> {
    return this.accountState('watchlist', kind, tmdbId, onList);
  }

  /** Mark a title as a TMDB favorite, or clear it. Account-only, as above. */
  async setFavorite(
    kind: TmdbMediaKind,
    tmdbId: number,
    favorite: boolean,
  ): Promise<TmdbWriteResult> {
    return this.accountState('favorite', kind, tmdbId, favorite);
  }

  /**
   * The linked account's numeric id — what account-state endpoints are keyed by.
   * Resolved once and cached in the synced settings beside the session, so the
   * fleet shares one lookup; forgotten with the session it belongs to.
   */
  private async accountId(): Promise<number | null> {
    const session = this.sessionId();
    if (!session) return null;
    const cached = this.settingsSig()[ACCOUNT_ID_KEY];
    if (typeof cached === 'number' && Number.isFinite(cached)) return cached;
    const { status, data } = await this.call(
      'GET',
      `/account?session_id=${encodeURIComponent(session)}`,
    );
    if (status !== 200 || typeof data?.id !== 'number') return null;
    this.docs.settings.set(ACCOUNT_ID_KEY, data.id);
    return data.id;
  }

  /** One `POST /account/{id}/{watchlist|favorite}` write. */
  private async accountState(
    what: 'watchlist' | 'favorite',
    kind: TmdbMediaKind,
    tmdbId: number,
    on: boolean,
  ): Promise<TmdbWriteResult> {
    if (!this.apiKey()) return skippedWrite('No TMDB key set.');
    if (!this.sessionId()) return skippedWrite('No TMDB account linked.');
    try {
      const accountId = await this.accountId();
      const session = this.sessionId();
      if (accountId == null || !session) {
        return ratingFailed('TMDB would not identify your account.');
      }
      const r = await this.call(
        'POST',
        `/account/${accountId}/${what}?session_id=${encodeURIComponent(session)}`,
        { media_type: kind, media_id: tmdbId, [what]: on },
      );
      if (accepted(r.status) || r.status === 204) return { ok: true, as: 'account', error: null };
      if (r.status === 401) {
        if (!blamesSession(r)) return ratingFailed(statusMessage(r)); // bad key, not a bad session
        // Revoked or expired. Drop the session — and the account id cached
        // against it — so `hasAccount` stops claiming otherwise.
        this.forgetAccount();
        return ratingFailed('Your TMDB session has expired — link the account again.');
      }
      return ratingFailed(statusMessage(r));
    } catch {
      return ratingFailed(TMDB_UNREACHABLE);
    }
  }

  /** Drop the linked session and everything derived from it. */
  private forgetAccount(): void {
    this.docs.settings.delete('tmdbSessionId');
    this.docs.settings.delete(ACCOUNT_ID_KEY);
  }

  /**
   * A guest session id, minted on demand and cached on THIS device only — it is
   * short-lived and device-scoped, so syncing it would be noise. `forceNew`
   * skips the cache after a 401.
   */
  private async guestSession(forceNew = false): Promise<string | null> {
    const cached = this.config.get<{ id: string; expiresAt: number }>(GUEST_SESSION_KEY);
    if (!forceNew && cached?.id && cached.expiresAt - GUEST_SESSION_MARGIN_MS > Date.now()) {
      return cached.id;
    }
    const { status, data } = await this.call('GET', '/authentication/guest_session/new');
    if (status !== 200 || !data?.guest_session_id) return null;
    await this.config.set(GUEST_SESSION_KEY, {
      id: data.guest_session_id,
      expiresAt: parseTmdbExpiry(data.expires_at),
    });
    return data.guest_session_id;
  }

  // -------------------------------------------------------------------------
  // Account linking (optional — ratings work without it, anonymously)
  // -------------------------------------------------------------------------
  /**
   * Step one of TMDB's three-legged login: mint a request token and return the
   * page the user must approve it on. Nothing is stored until they do.
   *
   * The approval URL is handed back rather than opened here because the user
   * has to click it themselves — a popup opened from an async continuation is
   * exactly what popup blockers exist to stop.
   */
  async startAccountLink(): Promise<{ requestToken: string; approveUrl: string }> {
    const { status, data } = await this.call('GET', '/authentication/token/new');
    if (status !== 200 || !data?.request_token) {
      throw new Error(data?.status_message || TMDB_UNREACHABLE);
    }
    return {
      requestToken: data.request_token,
      approveUrl: `https://www.themoviedb.org/authenticate/${data.request_token}`,
    };
  }

  /** Step two: trade an approved request token for a durable session id. */
  async finishAccountLink(requestToken: string): Promise<void> {
    const { status, data } = await this.call('POST', '/authentication/session/new', {
      request_token: requestToken,
    });
    if (status !== 200 || !data?.session_id) {
      throw new Error(
        data?.status_message ||
          'TMDB has not seen that token approved yet — approve it in the tab that opened, then try again.',
      );
    }
    // The id cached against the previous session may belong to another account
    // entirely, so it goes before the new session lands.
    this.docs.settings.delete(ACCOUNT_ID_KEY);
    this.docs.settings.set('tmdbSessionId', data.session_id);
  }

  /** Forget the linked account. Ratings fall back to anonymous guest sessions. */
  async unlinkAccount(): Promise<void> {
    const session = this.sessionId();
    // Local first: whatever TMDB says, this device must stop using the session.
    this.forgetAccount();
    if (session) {
      await this.call('DELETE', '/authentication/session', { session_id: session }).catch(
        () => undefined,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Custom lists (TMDB v4)
  //
  // A second, separate authorization from the one above. It buys exactly one
  // thing the v3 session cannot do — put a *show* on a custom list — and it is
  // kept apart from the rest of the integration so that everything else keeps
  // working untouched for someone who never links it.
  // -------------------------------------------------------------------------
  /**
   * Step one of the v4 login: mint a request token and hand back the page to
   * approve it on. Signed with the app's read token, not the user's — there is
   * no user yet. Nothing is stored until they approve.
   */
  async startListLink(): Promise<{ requestToken: string; approveUrl: string }> {
    const token = this.readToken();
    if (!token) {
      throw new Error('Add your TMDB v4 read access token first — lists are a v4 feature.');
    }
    const { status, data } = await this.callV4('POST', '/auth/request_token', token, {});
    if (status !== 200 || !data?.request_token) {
      throw new Error(data?.status_message || TMDB_UNREACHABLE);
    }
    return {
      requestToken: data.request_token,
      // Note the different host path from the v3 flow's /authenticate/{token}.
      approveUrl: `https://www.themoviedb.org/auth/access?request_token=${data.request_token}`,
    };
  }

  /** Step two: trade an approved request token for a durable access token. */
  async finishListLink(requestToken: string): Promise<void> {
    const token = this.readToken();
    if (!token) throw new Error('No TMDB v4 read access token set.');
    const { status, data } = await this.callV4('POST', '/auth/access_token', token, {
      request_token: requestToken,
    });
    if (status !== 200 || !data?.access_token) {
      throw new Error(
        data?.status_message ||
          'TMDB has not seen that token approved yet — approve it in the tab that opened, then try again.',
      );
    }
    this.docs.doc.transact(() => {
      this.docs.settings.set(V4_ACCESS_KEY, data.access_token);
      if (data.account_id) this.docs.settings.set(V4_ACCOUNT_KEY, data.account_id);
      else this.docs.settings.delete(V4_ACCOUNT_KEY);
    });
  }

  /**
   * Revoke the list authorization. Local first, as with the v3 unlink: whatever
   * TMDB makes of the request, this device must stop using the token.
   *
   * The lists already on TMDB stay there — they are the user's, and this app
   * only ever wrote to them. So do the remote ids held against the local lists,
   * so re-linking the same account picks the same lists back up instead of
   * making a second copy of every one. Linking a *different* account afterwards
   * leaves those ids pointing at lists it doesn't own: TMDB refuses the writes,
   * which surfaces as a failed mirror rather than as damage to either account.
   */
  async unlinkLists(): Promise<void> {
    const access = this.listToken();
    const read = this.readToken();
    this.forgetListAccess();
    if (access && read) {
      await this.callV4('DELETE', '/auth/access_token', read, { access_token: access }).catch(
        () => undefined,
      );
    }
  }

  /** Create an empty private list and return its TMDB id. */
  async createList(name: string, description = ''): Promise<TmdbListResult> {
    // Private by default: a list made in this app was never offered to anyone
    // else, and publishing someone's viewing plans is not ours to decide.
    const { res, data } = await this.listRequest('POST', '/list', {
      name,
      description,
      iso_639_1: 'en',
      iso_3166_1: userRegion(),
      public: false,
    });
    return { ...res, listId: typeof data?.id === 'number' ? data.id : null };
  }

  /** Rename (or re-describe) an existing list. */
  async updateList(listId: number, name: string, description = ''): Promise<TmdbWriteResult> {
    const { res } = await this.listRequest('PUT', `/list/${listId}`, { name, description });
    return res;
  }

  async deleteList(listId: number): Promise<TmdbWriteResult> {
    const { res } = await this.listRequest('DELETE', `/list/${listId}`);
    return res;
  }

  /**
   * Add titles to a list. TMDB answers per item, and a false result there is
   * almost always "already on the list" — which is success as far as a mirror
   * is concerned — so only a wholesale rejection counts as a failure.
   */
  async addListItems(listId: number, items: TmdbListItemRef[]): Promise<TmdbWriteResult> {
    if (!items.length) return { ok: true, as: 'account', error: null };
    const { res, data } = await this.listRequest('POST', `/list/${listId}/items`, { items });
    if (!res.ok) return res;
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    if (results.length && results.every((r) => r?.success === false)) {
      return ratingFailed('TMDB did not accept any of those titles.');
    }
    return res;
  }

  async removeListItems(listId: number, items: TmdbListItemRef[]): Promise<TmdbWriteResult> {
    if (!items.length) return { ok: true, as: 'account', error: null };
    const { res } = await this.listRequest('DELETE', `/list/${listId}/items`, { items });
    return res;
  }

  /**
   * One v4 list write, with the same "skipped is not failed" contract as the
   * account-state writes above: an app that was never linked for lists reports
   * that it did nothing, not that something went wrong.
   */
  private async listRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ res: TmdbWriteResult; data: any }> {
    const read = this.readToken();
    if (!read) return { res: skippedWrite('No TMDB v4 read access token set.'), data: null };
    const token = this.listToken();
    if (!token) return { res: skippedWrite('TMDB lists are not linked.'), data: null };
    try {
      const r = await this.callV4(method, path, token, body);
      if (accepted(r.status) || r.status === 204) {
        return { res: { ok: true, as: 'account', error: null }, data: r.data };
      }
      if (r.status === 401) {
        // Same reasoning as the v3 path: a 401 that blames the *key* must not
        // cost the user an authorization that was never the problem.
        if (!blamesSession(r)) return { res: ratingFailed(statusMessage(r)), data: null };
        this.forgetListAccess();
        return {
          res: ratingFailed('Your TMDB list authorization has expired — link lists again.'),
          data: null,
        };
      }
      return { res: ratingFailed(statusMessage(r)), data: null };
    } catch {
      return { res: ratingFailed(TMDB_UNREACHABLE), data: null };
    }
  }

  private forgetListAccess(): void {
    this.docs.doc.transact(() => {
      this.docs.settings.delete(V4_ACCESS_KEY);
      this.docs.settings.delete(V4_ACCOUNT_KEY);
    });
  }

  /**
   * A v4 request. Always a bearer token — v4 has no `api_key=` query form at
   * all — and never cached: everything routed here mutates state.
   */
  private async callV4(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; data: any }> {
    const res = await fetch(`${V4}${path}`, {
      method,
      headers: {
        'content-type': 'application/json;charset=utf-8',
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  /**
   * A plain, uncached TMDB request.
   *
   * The read path below is cache-first and content-addressed by URL. Auth and
   * ratings are neither — they mutate state and their responses are single-use
   * — so they take this route instead, and callers inspect the status rather
   * than getting a flattened `null`.
   */
  private async call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: any }> {
    const key = this.apiKey();
    if (!key) return { status: 0, data: null };
    const sep = path.includes('?') ? '&' : '?';
    const bearer = isBearerToken(key);
    const url = `${BASE}${path}` + (bearer ? '' : `${sep}api_key=${encodeURIComponent(key)}`);
    const res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json;charset=utf-8',
        ...(bearer ? { authorization: `Bearer ${key}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
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
    //
    // A v4 read access token doesn't ride in the query string at all — it goes
    // in the Authorization header — so its URL carries no credential to hide and
    // the cache key is just the base. Both forms cache under the same entries.
    const bearer = isBearerToken(key);
    const base = `${BASE}${path}${sep}language=en-US`;
    const url = bearer ? base : `${base}&api_key=${encodeURIComponent(key)}`;
    const cacheUrl = `${base}&api_key=KEY`;
    const headers = bearer ? { authorization: `Bearer ${key}` } : undefined;

    // Collapse concurrent requests for the same resource onto one round-trip.
    // Detail pages routinely ask for the same show from several places at once
    // (the header, the season list, a list row), and without this each of them
    // opened its own fetch — same URL, same response, N times the latency.
    const pending = this.inflight.get(cacheUrl);
    if (pending) return pending;
    const run = this.fetchCacheFirst(url, cacheUrl, headers).finally(() =>
      this.inflight.delete(cacheUrl),
    );
    this.inflight.set(cacheUrl, run);
    return run;
  }

  /**
   * Cache-first, with stale-on-failure as the offline floor.
   *
   * The TTL decides whether we *try* the network, never whether a cached copy is
   * still usable: if the request fails — offline, rate-limited, TMDB down — an
   * expired entry is served anyway. Anything else would blank out every detail
   * page after a week away from the network despite the data sitting right here,
   * which is the opposite of what a local-first app should do.
   */
  private async fetchCacheFirst(
    url: string,
    cacheUrl: string,
    headers?: Record<string, string>,
  ): Promise<any | null> {
    // The Cache API is absent on insecure origins and in some private modes.
    // That costs us persistence, not correctness — the fetch path still works.
    let cache: Cache | undefined;
    let hit: Response | undefined;
    try {
      cache = await caches.open(CACHE);
      hit = await cache.match(cacheUrl);
    } catch {
      /* no cache storage available */
    }

    if (hit) {
      const ts = Number(hit.headers.get('x-cached-at') ?? 0);
      if (Date.now() - ts < TTL_MS) return hit.json();
    }

    try {
      const res = await fetch(url, headers ? { headers } : undefined);
      if (!res.ok) return hit ? hit.json() : null; // fall back to stale on error
      const body = await res.json();
      if (cache) {
        const stamped = new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json', 'x-cached-at': String(Date.now()) },
        });
        await cache.put(cacheUrl, stamped);
      }
      return body;
    } catch {
      // Network unreachable. Stale beats empty — this is what keeps detail
      // pages readable offline once their TTL has run out.
      return hit ? hit.json() : null;
    }
  }

  async clearCache(): Promise<void> {
    await caches.delete(CACHE);
    this.inflight.clear();
    this.tmdbIdByTvdb.clear();
    this.tmdbIdByImdb.clear();
  }
}

/** TMDB answers a new rating with 201 and an updated one with 200. */
function accepted(status: number): boolean {
  return status === 200 || status === 201;
}

/**
 * TMDB's code for "invalid API key". It answers 401 for that as readily as for
 * a dead session, and the two call for opposite responses — see `blamesSession`.
 */
const STATUS_INVALID_API_KEY = 7;

/**
 * Does this 401 mean the *session* is no good, rather than the API key?
 *
 * Mirroring fires on ordinary actions now — adding a title, starring one — so a
 * user with a mistyped or rotated key would hit a 401 on their next click. Read
 * as "session expired", that silently unlinks a TMDB account which was never
 * the problem. A response that doesn't say (no body, an unexpected shape) is
 * treated as a session failure, which is the reading that at least self-heals:
 * the next link re-authorizes, where a wrongly-kept dead session never works.
 */
export function blamesSession(r: { data: any }): boolean {
  return r.data?.status_code !== STATUS_INVALID_API_KEY;
}

/** TMDB's own explanation of a refusal, or the bare status if it gave none. */
function statusMessage(r: { status: number; data: any }): string {
  return r.data?.status_message || `TMDB returned ${r.status}.`;
}

function ratingFailed(error: string): TmdbWriteResult {
  return { ok: false, as: null, error };
}

/** Nothing was attempted — see `TmdbWriteResult.skipped`. */
function skippedWrite(error: string): TmdbWriteResult {
  return { ok: false, as: null, error, skipped: true };
}

/**
 * A score TMDB will accept: it rates in half-points from 0.5 to 10, and the
 * app's whole-number pips are a subset, so this only ever guards against a
 * caller passing something odd.
 */
function clampRating(rating: number): number {
  return Math.min(MAX_RATING, Math.max(MIN_RATING, Math.round(rating * 2) / 2));
}
