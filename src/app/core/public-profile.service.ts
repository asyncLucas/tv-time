import { Location } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { GithubApiError, GithubApiService, fetchPublicGistFile } from './github-api.service';
import { LibraryStore, finiteOr, isGistId, normalizeLogin, safeImageSrc } from './library.store';
import { PosterCacheService } from './poster-cache.service';
import { TmdbService } from './tmdb.service';

export { isGistId };

/** The one file in the public gist. Named so a curious visitor can tell what it is. */
export const PUBLIC_FILENAME = 'tvtime-profile.json';
/** Gist description — also what tells the two gists this app owns apart. */
export const PUBLIC_MARKER = 'tv-time-revival · public profile';
/** Discriminator the reader insists on before rendering anything. */
export const PUBLIC_KIND = 'tvtime-revival-public-profile';
const PUBLIC_SCHEMA = 1;

/** Caps on the published lists — a page, not a data dump. */
const MAX_FAVORITES = 24;
const MAX_GENRES = 10;
/** Longest free-text field we echo onto someone else's screen. */
const MAX_TEXT = 120;
/**
 * How stale a published snapshot may get before merely opening your own profile
 * page refreshes it. Long enough that a browsing session is one push at most,
 * short enough that a link shared last week isn't quoting last month's totals.
 */
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;

export interface PublicFavorite {
  name: string;
  /** Absolute https poster URL, baked in — a visitor has no TMDB key of their own. */
  poster: string | null;
  year: string | null;
}

export interface PublicGenre {
  name: string;
  count: number;
  /** Share of the top genre, 0–100 — the bar width, precomputed. */
  pct: number;
}

export interface PublicProfileStats {
  showsFollowed: number;
  showsCompleted: number;
  showsFavorite: number;
  moviesWatched: number;
  episodesWatched: number;
}

/**
 * The published snapshot: everything the public page renders, and nothing else.
 *
 * Deliberately a *snapshot* rather than a slice of the CRDT. The synced document
 * carries credentials (the TMDB key, the P2P passphrase), device records and the
 * full watch log with timestamps; none of that has any business in a file whose
 * whole point is that strangers can read it. Building a separate, explicit shape
 * means nothing can leak by being added to the doc later.
 *
 * Every field here is named in the consent dialog and rendered on the page. That
 * is the rule this shape is held to: nothing ships that the user wasn't shown,
 * and nothing ships that the page has no use for. The profile's timezone used to
 * be published and is deliberately absent — it is a location signal, it was
 * never rendered, and a reader had no way to know it was in the file.
 */
export interface PublicProfile {
  kind: string;
  schema: number;
  publishedAt: string;
  name: string;
  login: string;
  image: string | null;
  banner: string | null;
  memberSince: string | null;
  lifetimeMinutes: number;
  stats: PublicProfileStats;
  favoriteShows: PublicFavorite[];
  favoriteMovies: PublicFavorite[];
  genres: PublicGenre[];
}

/** What `packPublicProfile` needs, so it can stay a pure function. */
export interface PublicProfileInput {
  name: string;
  login: string;
  image: string | null;
  banner: string | null;
  memberSince: string | null;
  lifetimeMinutes: number;
  stats: PublicProfileStats;
  favoriteShows: PublicFavorite[];
  favoriteMovies: PublicFavorite[];
  genres: PublicGenre[];
  publishedAt: string;
}

/** Assemble the snapshot, trimmed to the caps above. */
export function packPublicProfile(input: PublicProfileInput): PublicProfile {
  return {
    kind: PUBLIC_KIND,
    schema: PUBLIC_SCHEMA,
    publishedAt: input.publishedAt,
    name: input.name.slice(0, MAX_TEXT),
    login: input.login.slice(0, MAX_TEXT),
    image: input.image,
    banner: input.banner,
    memberSince: input.memberSince,
    lifetimeMinutes: Math.max(0, Math.round(input.lifetimeMinutes)),
    stats: input.stats,
    favoriteShows: input.favoriteShows.slice(0, MAX_FAVORITES),
    favoriteMovies: input.favoriteMovies.slice(0, MAX_FAVORITES),
    genres: input.genres.slice(0, MAX_GENRES),
  };
}

/**
 * Read a snapshot back, treating every field as hostile.
 *
 * This is the one place in the app that renders a document *someone else* wrote:
 * a gist id in the URL can point at any public gist on GitHub, including one
 * hand-crafted to carry a `javascript:` avatar or a novel where a name should
 * be. So each field is checked for the shape the page expects and dropped
 * otherwise, rather than trusted because the `kind` marker matched.
 *
 * Returns null when the payload isn't one of ours at all.
 */
export function parsePublicProfile(text: string): PublicProfile | null {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || raw.kind !== PUBLIC_KIND) return null;

  return {
    kind: PUBLIC_KIND,
    schema: finiteOr(raw.schema) ?? PUBLIC_SCHEMA,
    publishedAt: str(raw.publishedAt),
    name: str(raw.name),
    login: normalizeLogin(str(raw.login)),
    image: safeImageSrc(raw.image) ?? null,
    banner: safeImageSrc(raw.banner) ?? null,
    memberSince: str(raw.memberSince) || null,
    lifetimeMinutes: finiteOr(raw.lifetimeMinutes) ?? 0,
    stats: {
      showsFollowed: finiteOr(raw.stats?.showsFollowed) ?? 0,
      showsCompleted: finiteOr(raw.stats?.showsCompleted) ?? 0,
      showsFavorite: finiteOr(raw.stats?.showsFavorite) ?? 0,
      moviesWatched: finiteOr(raw.stats?.moviesWatched) ?? 0,
      episodesWatched: finiteOr(raw.stats?.episodesWatched) ?? 0,
    },
    favoriteShows: favorites(raw.favoriteShows),
    favoriteMovies: favorites(raw.favoriteMovies),
    genres: genres(raw.genres),
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
}

/**
 * The cap is applied *last*, once the unusable entries are already gone.
 *
 * Slicing first would let junk at the head of the list consume the whole budget:
 * a file whose favourites begin with two dozen nameless objects would render an
 * empty rail even though every real entry sits just behind them. The cap exists
 * to bound what we draw, not to be spent on rows that were never going to draw.
 */
function favorites(value: unknown): PublicFavorite[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((f) => f && typeof f === 'object')
    .map((f: any) => ({
      name: str(f.name),
      poster: safeHttpsUrl(f.poster),
      year: str(f.year) || null,
    }))
    .filter((f) => !!f.name)
    .slice(0, MAX_FAVORITES);
}

function genres(value: unknown): PublicGenre[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((g) => g && typeof g === 'object')
    .map((g: any) => ({
      name: str(g.name),
      count: finiteOr(g.count) ?? 0,
      // Clamped rather than trusted: a bar told to be 4000% wide would draw
      // straight out of its track.
      pct: Math.min(100, finiteOr(g.pct) ?? 0),
    }))
    .filter((g) => !!g.name)
    .slice(0, MAX_GENRES);
}

/**
 * An `https:` URL, or null. Posters are remote images (TheTVDB, TMDB) and so
 * can't be data-URI-checked like the avatar — the scheme check is what keeps a
 * `javascript:` "poster" out of an `<img src>`.
 */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** Fetch and validate a published profile. Null means "private or gone". */
export async function loadPublicProfile(gistId: string): Promise<PublicProfile | null> {
  if (!isGistId(gistId)) return null;
  const content = await fetchPublicGistFile(gistId, PUBLIC_FILENAME);
  return content ? parsePublicProfile(content) : null;
}

/**
 * Publishing — and un-publishing — the profile page.
 *
 * The page is a *second* gist, public where the sync gist is private, holding a
 * rendered snapshot rather than CRDT state. Two gists rather than one because
 * visibility is fixed at creation on GitHub: a gist cannot be flipped from
 * private to public or back, so the private one that holds your library could
 * never have become the shared one. It also draws a hard line — the file people
 * can read contains only what `packPublicProfile` chose to put in it.
 *
 * Going private again *deletes* the gist. Nothing is left behind to be found by
 * an old link, which is the only version of "undo" worth offering here.
 */
@Injectable({ providedIn: 'root' })
export class PublicProfileService {
  private store = inject(LibraryStore);
  private posters = inject(PosterCacheService);
  private tmdb = inject(TmdbService);
  private gh = inject(GithubApiService);
  private location = inject(Location);

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /** The gist backing the page, or null while the profile is private. */
  readonly gistId = computed(() => this.store.profile()?.publicGistId ?? null);
  readonly isPublic = computed(() => !!this.gistId());
  readonly publishedAt = computed(() => this.store.profile()?.publishedAt ?? null);
  /**
   * Publishing needs the same GitHub token cloud sync uses. Without one there is
   * nowhere to put the page, so the UI offers to set that up first rather than
   * failing at the click.
   */
  readonly canPublish = this.gh.hasToken;

  /** The shareable link, honouring the deployed base href (`/tv-time/`). */
  readonly url = computed(() => {
    const id = this.gistId();
    if (!id) return null;
    return new URL(this.location.prepareExternalUrl(`/u/${id}`), window.location.origin).href;
  });

  /**
   * Make the profile public, or refresh the page that is already public.
   * Resolves to the link.
   */
  async publish(): Promise<string | null> {
    if (this.busy()) return this.url();
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.resolveMissingArtwork();
      const content = JSON.stringify(this.snapshot(), null, 2);
      const existing = this.gistId();
      if (existing) await this.patch(existing, content);
      else this.store.setPublicProfile(await this.create(content));
      return this.url();
    } catch (e: any) {
      this.error.set(String(e?.message ?? e));
      throw e;
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Update the existing page, re-creating it if the gist has been deleted on
   * GitHub since. Without that fallback, deleting the gist by hand would leave
   * the app permanently convinced it is public at a dead link.
   */
  private async patch(gistId: string, content: string): Promise<void> {
    try {
      await this.gh.request('PATCH', `/gists/${encodeURIComponent(gistId)}`, {
        files: { [PUBLIC_FILENAME]: { content } },
      });
      this.store.touchPublicProfile();
    } catch (e: unknown) {
      // Branch on the status, never on the message: the wording of a 404 is
      // user-facing copy, and this recovery must not depend on it.
      if (!GithubApiError.isMissing(e)) throw e;
      this.store.clearPublicProfile();
      this.store.setPublicProfile(await this.create(content));
    }
  }

  /** Create the public gist and return its id. */
  private async create(content: string): Promise<string> {
    const created: any = await this.gh.request('POST', '/gists', {
      description: PUBLIC_MARKER,
      public: true,
      files: { [PUBLIC_FILENAME]: { content } },
    });
    if (!created?.id) throw new Error('GitHub did not return a gist id');
    return created.id;
  }

  /**
   * Take the page down.
   *
   * The local pointer is cleared only once the gist is known to be gone —
   * deleted here, or already absent (404). Any other failure leaves the profile
   * showing as public, because it still is: saying otherwise would be a lie
   * about who can read the page, which is the one thing this screen must never
   * get wrong. The user sees the error and can try again.
   */
  async unpublish(): Promise<void> {
    const id = this.gistId();
    if (!id) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.gh.request('DELETE', `/gists/${encodeURIComponent(id)}`);
      this.store.clearPublicProfile();
    } catch (e: unknown) {
      // A 404 means it is already gone — the desired end state, so treat the
      // local cleanup as the success it is.
      if (GithubApiError.isMissing(e)) {
        this.store.clearPublicProfile();
        return;
      }
      this.error.set(String((e as any)?.message ?? e));
      throw e;
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Refresh a stale page, quietly. Called when the owner opens their own profile
   * — the natural moment to catch the published copy up, without turning every
   * ticked episode into a GitHub write.
   */
  async refreshIfStale(): Promise<void> {
    if (!this.isPublic() || !this.canPublish() || this.busy()) return;
    const at = Date.parse(this.publishedAt() ?? '');
    if (Number.isFinite(at) && Date.now() - at < REFRESH_AFTER_MS) return;
    await this.publish().catch(() => undefined); // background chore, never a blocker
  }

  /**
   * Fill in artwork for favourites that don't have any yet, right before we
   * publish.
   *
   * The page bakes absolute URLs because a visitor has no TMDB key of their own,
   * so whatever is missing at this moment is missing on the page until the next
   * publish. Favourite films are the ones that bite: the backup carries no film
   * artwork at all, so unless the owner happened to scroll past that exact card
   * with a key set, the published page shows initials where the covers belong.
   *
   * Bounded by the favourites cap (24 of each) and skipped entirely without a
   * key, and each hit lands in the shared cache — so this is a handful of
   * requests once, not a cost the owner pays on every refresh. Failures are
   * silent: a missing cover must never be the reason publishing fails.
   */
  private async resolveMissingArtwork(): Promise<void> {
    if (!this.tmdb.hasKey()) return;
    const shows = this.store
      .favoriteShows()
      .filter((s) => s.tvdbId && !s.cachedPoster && !this.posters.url({ tvdbId: s.tvdbId }))
      .map(async (s) => {
        const show = await this.tmdb.showByTvdb(s.tvdbId!);
        this.posters.remember({ tvdbId: s.tvdbId }, show?.posterPath);
      });
    const movies = this.store
      .favoriteMovies()
      .filter((m) => m.imdbId && !m.cachedPoster && !this.posters.url({ imdbId: m.imdbId }))
      .map(async (m) => {
        const found = await this.tmdb.findMovieByImdb(m.imdbId!);
        this.posters.remember({ imdbId: m.imdbId }, found?.poster_path);
      });
    await Promise.allSettled([...shows, ...movies]);
  }

  /** The current library, as the public page will show it. */
  private snapshot(): PublicProfile {
    const p = this.store.profile();
    const stats = this.store.stats();
    return packPublicProfile({
      name: p?.name ?? '',
      login: p?.login ?? '',
      image: p?.image ?? null,
      banner: p?.banner ?? null,
      memberSince: p?.createdAt ?? null,
      lifetimeMinutes: stats.lifetimeMinutes,
      stats: {
        showsFollowed: stats.showsFollowed,
        showsCompleted: stats.showsCompleted,
        showsFavorite: stats.showsFavorite,
        moviesWatched: stats.moviesWatched,
        episodesWatched: stats.episodesWatched,
      },
      // Posters fall back to the synced cache: favourite films have no cached
      // artwork of their own (TV Time backups don't carry any), so without it a
      // published page shows a wall of initials where the covers should be.
      favoriteShows: this.store.favoriteShows().map((s) => ({
        name: s.name,
        poster: safeHttpsUrl(s.cachedPoster ?? this.posters.url({ tvdbId: s.tvdbId })),
        year: null,
      })),
      favoriteMovies: this.store.favoriteMovies().map((m) => ({
        name: m.name,
        poster: safeHttpsUrl(m.cachedPoster ?? this.posters.url({ imdbId: m.imdbId })),
        year: m.firstReleaseDate ? String(m.firstReleaseDate).slice(0, 4) : null,
      })),
      genres: this.store.topGenres(),
      publishedAt: new Date().toISOString(),
    });
  }
}
