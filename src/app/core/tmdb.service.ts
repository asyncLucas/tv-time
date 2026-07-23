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

/**
 * Outcome of pushing a rating to TMDB. Never a thrown error: the rating is
 * already stored locally by the time this runs, so the remote half failing is
 * a footnote the UI reports, not a failure of the user's action.
 */
export interface TmdbRatingResult {
  ok: boolean;
  /** Who the rating was filed under — an anonymous vote shouldn't be a surprise. */
  as: 'account' | 'guest' | null;
  error: string | null;
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
    // TMDB scores in half-points; the app's whole-number pips are a subset, so
    // this only ever guards against a caller passing something odd.
    const value = Math.min(MAX_RATING, Math.max(MIN_RATING, Math.round(rating * 2) / 2));
    return this.ratingRequest('POST', tvdbId, season, episode, { value });
  }

  /** Withdraw a previously filed score for an episode. */
  async clearEpisodeRating(
    tvdbId: string,
    season: number,
    episode: number,
  ): Promise<TmdbRatingResult> {
    return this.ratingRequest('DELETE', tvdbId, season, episode);
  }

  /**
   * Send one rating write, trying the linked account first and an anonymous
   * guest session after. A 401 means the session lapsed rather than that the
   * rating was bad, so the guest path is retried once with a fresh session.
   */
  private async ratingRequest(
    method: 'POST' | 'DELETE',
    tvdbId: string,
    season: number,
    episode: number,
    body?: unknown,
  ): Promise<TmdbRatingResult> {
    if (!this.apiKey()) return ratingFailed('No TMDB key set.');
    try {
      const tmdbId = await this.tmdbIdForTvdb(tvdbId);
      if (tmdbId == null) return ratingFailed('TMDB does not know this show.');
      const path = `/tv/${tmdbId}/season/${season}/episode/${episode}/rating`;

      const session = this.sessionId();
      if (session) {
        const r = await this.call(method, `${path}?session_id=${encodeURIComponent(session)}`, body);
        if (accepted(r.status)) return { ok: true, as: 'account', error: null };
        // Anything but "not authorized" is about the rating, not the session.
        if (r.status !== 401) return ratingFailed(statusMessage(r));
        // The session was revoked or expired: drop it (so `hasAccount` stops
        // claiming otherwise) and fall through to the anonymous path.
        this.docs.settings.delete('tmdbSessionId');
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
    this.docs.settings.set('tmdbSessionId', data.session_id);
  }

  /** Forget the linked account. Ratings fall back to anonymous guest sessions. */
  async unlinkAccount(): Promise<void> {
    const session = this.sessionId();
    // Local first: whatever TMDB says, this device must stop using the session.
    this.docs.settings.delete('tmdbSessionId');
    if (session) {
      await this.call('DELETE', '/authentication/session', { session_id: session }).catch(
        () => undefined,
      );
    }
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

/** TMDB's own explanation of a refusal, or the bare status if it gave none. */
function statusMessage(r: { status: number; data: any }): string {
  return r.data?.status_message || `TMDB returned ${r.status}.`;
}

function ratingFailed(error: string): TmdbRatingResult {
  return { ok: false, as: null, error };
}
