import { Injectable, computed, inject, signal } from '@angular/core';
import * as Y from 'yjs';
import { DocService, epKey } from './doc.service';
import { SeedService } from './seed.service';
import type {
  ShowState,
  MovieState,
  EpisodeWatch,
  ShowView,
  MovieView,
  ShowStatus,
} from './models';

/**
 * The reactive facade the UI consumes. It bridges the Yjs CRDT (imperative,
 * event-based) into Angular signals, then derives view models by merging the
 * immutable catalog (SeedService) with mergeable user state (DocService).
 *
 * Bridge strategy: each Y.Map is mirrored into a signal holding a plain-object
 * snapshot, refreshed on every observed change. Snapshots are cheap at this
 * scale (~hundreds of small entries) and keep all downstream reactivity in
 * signal-land, so components never touch Yjs directly.
 */
@Injectable({ providedIn: 'root' })
export class LibraryStore {
  private docs = inject(DocService);
  private seedSvc = inject(SeedService);

  // --- raw CRDT mirrors (plain snapshots) ---
  private showStateSig = signal<Record<string, ShowState>>({});
  private movieStateSig = signal<Record<string, MovieState>>({});
  private episodeWatchesSig = signal<Record<string, EpisodeWatch>>({});
  private listsSig = signal<Record<string, any>>({});
  private profileSig = signal<Record<string, any>>({});

  private started = false;

  /** Wire seed + CRDT together. Call once at app start (APP_INITIALIZER). */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Load the catalog (browse content). We do NOT bootstrap user state from it
    // — the catalog is shared/anonymous; each person builds their own library.
    // Personal state is only ever seeded by an explicit backup import.
    await this.seedSvc.load();
    await this.docs.whenReady();

    this.bind(this.docs.showState, this.showStateSig);
    this.bind(this.docs.movieState, this.movieStateSig);
    this.bind(this.docs.episodeWatches, this.episodeWatchesSig);
    this.bind(this.docs.lists, this.listsSig);
    this.bind(this.docs.profile, this.profileSig);
  }

  private bind<T>(map: Y.Map<T>, sig: ReturnType<typeof signal<Record<string, T>>>): void {
    const refresh = () => sig.set(map.toJSON() as Record<string, T>);
    refresh();
    map.observe(refresh);
  }

  // -------------------------------------------------------------------------
  // Onboarding
  // -------------------------------------------------------------------------
  /** True once this device has a catalog; false → show onboarding. */
  readonly hasLibrary = computed(() => this.seedSvc.hasLibrary());

  /** Adopt an imported TV Time backup file as this device's library. */
  async importLibrary(text: string): Promise<void> {
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    if (parsed?.kind === 'tvtime-revival-state') {
      throw new Error(
        'That is a watch-state export — import it under Settings → Import state. ' +
          'Here you import your full library backup (seed).',
      );
    }
    const seed = await this.seedSvc.importSeed(parsed);
    this.docs.bootstrapFromSeed(seed);
  }

  /** Start with an empty, anonymous library. */
  startEmpty(): Promise<void> {
    return this.seedSvc.startEmpty().then(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Derived view models
  // -------------------------------------------------------------------------
  readonly ready = computed(() => !!this.seedSvc.seed());

  /** Episode-watch count per show TVDB id. */
  private watchedCountByTvdb = computed(() => {
    const counts: Record<string, number> = {};
    for (const w of Object.values(this.episodeWatchesSig())) {
      counts[w.tvdbId] = (counts[w.tvdbId] ?? 0) + 1;
    }
    return counts;
  });

  readonly shows = computed<ShowView[]>(() => {
    const seed = this.seedSvc.seed();
    if (!seed) return [];
    const state = this.showStateSig();
    const counts = this.watchedCountByTvdb();
    return seed.shows.map((s) => ({
      ...s,
      state: state[s.uuid] ?? this.defaultShowState(),
      watchedEpisodeCount: s.tvdbId ? counts[s.tvdbId] ?? 0 : 0,
    }));
  });

  readonly movies = computed<MovieView[]>(() => {
    const seed = this.seedSvc.seed();
    if (!seed) return [];
    const state = this.movieStateSig();
    return seed.movies.map((m) => ({
      ...m,
      state: state[m.uuid] ?? this.defaultMovieState(),
    }));
  });

  readonly watchingShows = computed(() => this.shows().filter((s) => s.state.status === 'watching'));

  readonly lists = computed(() => {
    const raw = this.listsSig();
    return Object.entries(raw).map(([id, v]) => ({ id, ...(v as any) }));
  });

  /** Resolve a custom-list item to the catalog movie/show it points at. */
  resolveListItem(item: { uuid?: string | null; title?: string | null }): {
    type: 'movie' | 'show';
    uuid: string;
    name: string;
    tvdbId: string | null;
    imdbId: string | null;
    cachedPoster: string | null;
  } | null {
    if (item.uuid) {
      const m = this.seedSvc.getMovie(item.uuid);
      if (m)
        return { type: 'movie', uuid: m.uuid, name: m.name, tvdbId: m.tvdbId, imdbId: m.imdbId, cachedPoster: null };
      const s = this.seedSvc.getShow(item.uuid);
      if (s)
        return { type: 'show', uuid: s.uuid, name: s.name, tvdbId: s.tvdbId, imdbId: null, cachedPoster: s.cachedPoster };
    }
    return null;
  }

  /** Remove an item from a custom list (matched by uuid, else title). */
  removeListItem(listId: string, item: { uuid?: string | null; title?: string | null }): void {
    const list = this.docs.lists.get(listId);
    if (!list?.items) return;
    const items = list.items.filter((it: any) =>
      item.uuid ? it.uuid !== item.uuid : it.title !== item.title,
    );
    this.docs.lists.set(listId, { ...list, items });
  }

  /** Delete an entire custom list. */
  deleteList(listId: string): void {
    this.docs.lists.delete(listId);
  }

  /**
   * The profile the UI shows: the device-local seed profile with any synced
   * CRDT edits layered on top. Editing never touches the seed, so the imported
   * backup stays a pristine record of what TV Time had.
   */
  readonly profile = computed(() => {
    const seed = this.seedSvc.seed()?.profile ?? null;
    const edits = this.profileSig();
    if (!seed && !Object.keys(edits).length) return null;
    const name = typeof edits['name'] === 'string' ? edits['name'] : undefined;
    const image = safeImageSrc(edits['image']);
    return {
      ...(seed ?? EMPTY_PROFILE),
      ...(name !== undefined ? { name } : {}),
      ...(image !== undefined ? { image } : {}),
    };
  });

  /** Rename the profile. Empty string clears back to the seed's name. */
  setProfileName(name: string): void {
    const trimmed = name.trim();
    if (trimmed) this.docs.profile.set('name', trimmed);
    else this.docs.profile.delete('name');
    this.docs.profile.set('updatedAt', this.now());
  }

  /**
   * Set the avatar from a picked file. The image is downscaled to a small
   * square data URI first — it lives in the CRDT and therefore in every sync
   * payload, so keeping it tiny matters more than keeping it sharp.
   */
  async setProfileImage(file: File): Promise<void> {
    const dataUri = await downscaleToDataUri(file, AVATAR_PX);
    this.docs.profile.set('image', dataUri);
    this.docs.profile.set('updatedAt', this.now());
  }

  /** Drop the custom avatar (falls back to the seed's, if any). */
  clearProfileImage(): void {
    this.docs.profile.delete('image');
    this.docs.profile.set('updatedAt', this.now());
  }

  /** Aggregate stats for the profile/dashboard view. */
  readonly stats = computed(() => {
    const shows = this.shows();
    const movies = this.movies();
    const episodeWatches = Object.values(this.episodeWatchesSig());
    return {
      // "my library" = titles the user has actually added, not the whole catalog
      showsFollowed: shows.filter((s) => s.state.status !== 'none').length,
      showsCompleted: shows.filter((s) => s.state.status === 'completed').length,
      showsFavorite: shows.filter((s) => s.state.favorite).length,
      moviesTracked: movies.filter((m) => m.state.watched || m.state.watchlist || m.state.favorite).length,
      moviesWatched: movies.filter((m) => m.state.watched).length,
      episodesWatched: episodeWatches.length,
      // seed-provided lifetime stats from TV Time
      lifetimeMinutes: this.seedSvc.seed()?.profile.stats?.['time_spent'] ?? 0,
    };
  });

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------
  show(uuid: string): ShowView | undefined {
    return this.shows().find((s) => s.uuid === uuid);
  }
  movie(uuid: string): MovieView | undefined {
    return this.movies().find((m) => m.uuid === uuid);
  }
  isEpisodeWatched(tvdbId: string, season: number, episode: number): boolean {
    return !!this.episodeWatchesSig()[epKey(tvdbId, season, episode)];
  }

  // -------------------------------------------------------------------------
  // Mutations (write straight to the CRDT; signals refresh via observers)
  // -------------------------------------------------------------------------
  setShowStatus(uuid: string, status: ShowStatus): void {
    const cur = this.docs.showState.get(uuid) ?? this.defaultShowState();
    this.docs.showState.set(uuid, { ...cur, status, updatedAt: this.now() });
  }
  toggleShowFavorite(uuid: string): void {
    const cur = this.docs.showState.get(uuid) ?? this.defaultShowState();
    this.docs.showState.set(uuid, { ...cur, favorite: !cur.favorite, updatedAt: this.now() });
  }
  rateShow(uuid: string, rating: number | null): void {
    const cur = this.docs.showState.get(uuid) ?? this.defaultShowState();
    this.docs.showState.set(uuid, { ...cur, rating, updatedAt: this.now() });
  }

  setMovieWatched(uuid: string, watched: boolean): void {
    const cur = this.docs.movieState.get(uuid) ?? this.defaultMovieState();
    this.docs.movieState.set(uuid, {
      ...cur,
      watched,
      watchedAt: watched ? cur.watchedAt ?? this.now() : cur.watchedAt,
      watchlist: watched ? false : cur.watchlist,
      updatedAt: this.now(),
    });
  }
  toggleMovieWatchlist(uuid: string): void {
    const cur = this.docs.movieState.get(uuid) ?? this.defaultMovieState();
    this.docs.movieState.set(uuid, { ...cur, watchlist: !cur.watchlist, updatedAt: this.now() });
  }
  toggleMovieFavorite(uuid: string): void {
    const cur = this.docs.movieState.get(uuid) ?? this.defaultMovieState();
    this.docs.movieState.set(uuid, { ...cur, favorite: !cur.favorite, updatedAt: this.now() });
  }
  rateMovie(uuid: string, rating: number | null): void {
    const cur = this.docs.movieState.get(uuid) ?? this.defaultMovieState();
    this.docs.movieState.set(uuid, { ...cur, rating, updatedAt: this.now() });
  }

  setEpisodeWatched(tvdbId: string, season: number, episode: number, watched: boolean): void {
    const key = epKey(tvdbId, season, episode);
    if (watched) {
      const cur = this.docs.episodeWatches.get(key);
      this.docs.episodeWatches.set(key, {
        tvdbId,
        season,
        episode,
        watchedAt: cur?.watchedAt ?? this.now(),
        nbTimes: (cur?.nbTimes ?? 0) + (cur ? 0 : 1),
      });
    } else {
      this.docs.episodeWatches.delete(key);
    }
  }

  /** Mark every episode up to and including (season, episode) as watched. */
  markWatchedUpTo(
    tvdbId: string,
    upToSeason: number,
    upToEpisode: number,
    seasons: { season: number; episodes: number[] }[],
  ): void {
    this.docs.doc.transact(() => {
      for (const s of seasons) {
        for (const ep of s.episodes) {
          if (s.season < upToSeason || (s.season === upToSeason && ep <= upToEpisode)) {
            this.setEpisodeWatched(tvdbId, s.season, ep, true);
          }
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  private now(): string {
    return new Date().toISOString();
  }
  private defaultShowState(): ShowState {
    return { status: 'none', favorite: false, rating: null, addedAt: null, updatedAt: null };
  }
  /** Neutral: a catalog title is "not in my library" until the user adds it. */
  private defaultMovieState(): MovieState {
    return { watched: false, watchedAt: null, watchlist: false, favorite: false, rating: null, updatedAt: null };
  }
}

/** Avatars are stored square at this edge length — small enough to sync cheaply. */
const AVATAR_PX = 256;

/**
 * Narrow an avatar coming out of the CRDT to something safe to put in `[src]`.
 *
 * The value arrives from a synced peer or an imported file, so it is untrusted.
 * We only ever *write* `data:image/...` here (see setProfileImage), and that is
 * the only form we accept back — which rules out `javascript:` and friends
 * without leaning on the template sanitizer as the sole line of defence.
 * `null` clears the avatar; `undefined` means "no edit, fall back to the seed".
 */
function safeImageSrc(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' && value.startsWith('data:image/') ? value : null;
}

/** Stand-in when the device has no seed but the user has edited their profile. */
const EMPTY_PROFILE = {
  id: 0,
  login: '',
  name: '',
  image: null as string | null,
  timezone: null,
  lang: 'en',
  createdAt: null,
  favoriteGenres: [] as unknown[],
  stats: {} as Record<string, number>,
};

/**
 * Center-crop an image file to a square and re-encode it as a JPEG data URI.
 * Runs entirely in-browser (no upload target exists — the app has no backend).
 */
async function downscaleToDataUri(file: File, size: number): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not an image.');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not process the image on this device.');
    const edge = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(
      bitmap,
      (bitmap.width - edge) / 2,
      (bitmap.height - edge) / 2,
      edge,
      edge,
      0,
      0,
      size,
      size,
    );
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    bitmap.close();
  }
}
