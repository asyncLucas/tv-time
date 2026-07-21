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
  private settingsSig = signal<Record<string, any>>({});

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
    this.bind(this.docs.settings, this.settingsSig);
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

  readonly favoriteShows = computed(() => this.shows().filter((s) => s.state.favorite));
  readonly watchingShows = computed(() => this.shows().filter((s) => s.state.status === 'watching'));
  readonly watchlistMovies = computed(() => this.movies().filter((m) => m.state.watchlist && !m.state.watched));
  readonly watchedMovies = computed(() => this.movies().filter((m) => m.state.watched));

  readonly lists = computed(() => {
    const raw = this.listsSig();
    return Object.entries(raw).map(([id, v]) => ({ id, ...(v as any) }));
  });

  readonly profile = computed(() => this.seedSvc.seed()?.profile ?? null);

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

  // --- settings passthrough ---
  getSetting<T = any>(key: string): T | undefined {
    return this.settingsSig()[key];
  }
  setSetting(key: string, value: any): void {
    this.docs.settings.set(key, value);
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
