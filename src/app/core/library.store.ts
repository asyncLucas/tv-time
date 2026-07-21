import { Injectable, computed, inject, signal } from '@angular/core';
import * as Y from 'yjs';
import { DocService, addedKey, epKey } from './doc.service';
import { SeedService } from './seed.service';
import {
  TmdbService,
  tmdbPosterUrl,
  type TmdbSearchResult,
  type TmdbShow,
  type TmdbMovie,
} from './tmdb.service';
import type {
  Seed,
  ShowState,
  MovieState,
  EpisodeWatch,
  ShowView,
  MovieView,
  ShowStatus,
  AddedTitle,
  SeedShow,
  SeedMovie,
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
  private tmdb = inject(TmdbService);

  // --- raw CRDT mirrors (plain snapshots) ---
  private showStateSig = signal<Record<string, ShowState>>({});
  private movieStateSig = signal<Record<string, MovieState>>({});
  private episodeWatchesSig = signal<Record<string, EpisodeWatch>>({});
  private listsSig = signal<Record<string, any>>({});
  private profileSig = signal<Record<string, any>>({});
  private addedShowsSig = signal<Record<string, AddedTitle>>({});
  private addedMoviesSig = signal<Record<string, AddedTitle>>({});

  private started = false;

  /** Wire seed + CRDT together. Call once at app start (APP_INITIALIZER). */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Load the catalog (browse content). We do NOT bootstrap user state from it
    // — the catalog is shared/anonymous; each person builds their own library.
    // Personal state is only ever seeded by an explicit backup import.
    const seed = await this.seedSvc.load();
    await this.docs.whenReady();

    this.bind(this.docs.showState, this.showStateSig);
    this.bind(this.docs.movieState, this.movieStateSig);
    this.bind(this.docs.episodeWatches, this.episodeWatchesSig);
    this.bind(this.docs.lists, this.listsSig);
    this.bind(this.docs.profile, this.profileSig);
    this.bind(this.docs.addedShows, this.addedShowsSig);
    this.bind(this.docs.addedMovies, this.addedMoviesSig);

    // Lift a local identity (from a backup imported on THIS device) into the
    // synced doc, if it isn't there yet. On an anonymous device the seed has no
    // name, so this is a no-op — it only ever promotes a real profile to sync,
    // fixing installs whose backup was imported before identity-sync existed.
    if (seed) this.seedIdentityIntoCrdt(seed);
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
    this.seedIdentityIntoCrdt(seed);
  }

  /**
   * Copy the backup's identity (name, lifetime-watched) into the CRDT so it
   * SYNCS to your other devices. The seed profile itself is device-local and
   * never travels; without this, a device that only has the gist token would
   * show an anonymous profile. Runs on every import but never clobbers an
   * existing (edited or already-synced) value.
   */
  private seedIdentityIntoCrdt(seed: Seed): void {
    const p = seed.profile;
    const imported = finiteOr(p?.stats?.['time_spent']);
    this.docs.doc.transact(() => {
      if (p?.name && !this.docs.profile.get('name')) this.docs.profile.set('name', p.name);
      // The lifetime "offset" (the historical total TV Time reported, minus the
      // part our own arithmetic can reconstruct from the backup's rows) can only
      // be priced on a device that actually HOLDS the backup. Compute it once
      // here and SYNC it, so every device — including a fresh install that only
      // has the gist — reads the same constant. A seed-less device recomputing
      // it from the bundled catalog would see 0 rows, keep the whole imported
      // figure as the offset, and then double-count the synced watch log on top
      // (this was why lifetime differed between devices).
      if (imported != null && this.docs.profile.get('lifetimeOffset') == null) {
        this.docs.profile.set('lifetimeMinutes', imported); // kept for back-compat
        this.docs.profile.set('lifetimeOffset', Math.max(0, imported - seedDerivedMinutes(seed)));
      }
    });
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

  /**
   * Most recent episode `watchedAt` per show TVDB id. Ticking off an episode
   * doesn't touch `ShowState.updatedAt` (see setEpisodeWatched), so this is the
   * only signal of "I watched this show recently" — it's what makes Continue
   * watching reflect real viewing activity rather than just status edits.
   */
  private lastWatchedByTvdb = computed(() => {
    const latest: Record<string, string> = {};
    for (const w of Object.values(this.episodeWatchesSig())) {
      if (!latest[w.tvdbId] || w.watchedAt > latest[w.tvdbId]) latest[w.tvdbId] = w.watchedAt;
    }
    return latest;
  });

  /**
   * The furthest-along watched episode per show TVDB id — the anchor "what's
   * next" counts forward from.
   *
   * Furthest, deliberately, not most-recent-by-date: re-watching an old episode
   * shouldn't rewind your position, and a backup's `watchedAt` timestamps are
   * only as trustworthy as the service that wrote them. Season then episode
   * compare numerically (an episode key sorts as a string, so a plain max over
   * the keys would put S10 before S9).
   */
  readonly furthestWatchedByTvdb = computed(() => {
    const furthest: Record<string, { season: number; episode: number }> = {};
    for (const w of Object.values(this.episodeWatchesSig())) {
      const cur = furthest[w.tvdbId];
      if (!cur || w.season > cur.season || (w.season === cur.season && w.episode > cur.episode)) {
        furthest[w.tvdbId] = { season: w.season, episode: w.episode };
      }
    }
    return furthest;
  });

  /** Episode-watch count per `${tvdbId}:${season}` — backs watchedInSeason(). */
  private watchedCountBySeason = computed(() => {
    const counts: Record<string, number> = {};
    for (const w of Object.values(this.episodeWatchesSig())) {
      const key = `${w.tvdbId}:${w.season}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  });

  /**
   * The browsable show list: the device's catalog plus anything the user added
   * from TMDB search.
   *
   * Added titles are filtered against the catalog by TheTVDB id, so adding a
   * show you already had doesn't produce a second card. The catalog entry wins
   * — it carries the richer backup data (follow dates, cached artwork).
   */
  readonly shows = computed<ShowView[]>(() => {
    const seed = this.seedSvc.seed();
    const state = this.showStateSig();
    const counts = this.watchedCountByTvdb();

    const catalog = seed?.shows ?? [];
    const known = new Set(catalog.map((s) => s.tvdbId).filter(Boolean));
    const added = Object.values(this.addedShowsSig())
      .filter((a) => !a.tvdbId || !known.has(a.tvdbId))
      .map(addedToSeedShow);

    return [...catalog, ...added].map((s) => ({
      ...s,
      state: state[s.uuid] ?? this.defaultShowState(),
      watchedEpisodeCount: s.tvdbId ? counts[s.tvdbId] ?? 0 : 0,
    }));
  });

  /** As `shows`, for films — deduped against the catalog by IMDb id. */
  readonly movies = computed<MovieView[]>(() => {
    const seed = this.seedSvc.seed();
    const state = this.movieStateSig();

    const catalog = seed?.movies ?? [];
    const known = new Set(catalog.map((m) => m.imdbId).filter(Boolean));
    const added = Object.values(this.addedMoviesSig())
      .filter((a) => !a.imdbId || !known.has(a.imdbId))
      .map(addedToSeedMovie);

    return [...catalog, ...added].map((m) => ({
      ...m,
      state: state[m.uuid] ?? this.defaultMovieState(),
    }));
  });

  /**
   * Shows in progress, most-recently-active first — the Continue watching feed.
   *
   * Ordered solely by the show's last-watched episode `watchedAt`, so only
   * ticking an episode floats a show back to the top (status changes, ratings
   * and other state edits don't). ISO timestamps sort chronologically as plain
   * strings; shows with no watched episode yet fall to the end.
   */
  readonly watchingShows = computed(() => {
    const lastWatched = this.lastWatchedByTvdb();
    const watchedAt = (s: ShowView): string =>
      (s.tvdbId ? lastWatched[s.tvdbId] : undefined) ?? '';
    return this.shows()
      .filter((s) => s.state.status === 'watching')
      .sort((a, b) => watchedAt(b).localeCompare(watchedAt(a)));
  });

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

      // Not in the seed catalog — fall back to titles the user added from TMDB,
      // so a film/show put on a list still resolves and renders.
      const mv = this.movie(item.uuid);
      if (mv)
        return { type: 'movie', uuid: mv.uuid, name: mv.name, tvdbId: mv.tvdbId, imdbId: mv.imdbId, cachedPoster: mv.cachedPoster ?? null };
      const sv = this.show(item.uuid);
      if (sv)
        return { type: 'show', uuid: sv.uuid, name: sv.name, tvdbId: sv.tvdbId, imdbId: null, cachedPoster: sv.cachedPoster ?? null };
    }
    return null;
  }

  /** True if the list already contains this item (matched by uuid). */
  isInList(listId: string, uuid: string): boolean {
    const list = this.docs.lists.get(listId);
    return !!list?.items?.some((it: any) => it.uuid === uuid);
  }

  /**
   * Add a title to a custom list. Idempotent — a uuid already on the list is a
   * no-op, so toggling from the UI can call this freely.
   */
  addListItem(
    listId: string,
    item: { uuid: string; title: string; entityType: 'movie' | 'show' },
  ): void {
    const list = this.docs.lists.get(listId);
    if (!list) return;
    const items = list.items ?? [];
    if (items.some((it: any) => it.uuid === item.uuid)) return;
    this.docs.lists.set(listId, { ...list, items: [...items, item] });
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

  /** Create an empty custom list. Returns its id. */
  createList(name: string): string {
    const id = crypto.randomUUID();
    this.docs.lists.set(id, { name, description: '', createdAt: this.now(), items: [] });
    return id;
  }

  /** Rename an existing custom list (no-op if it's gone). */
  renameList(listId: string, name: string): void {
    const list = this.docs.lists.get(listId);
    if (!list) return;
    this.docs.lists.set(listId, { ...list, name });
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

  /**
   * Lifetime watch time from the live watch log, priced identically on every
   * device so two devices never disagree.
   *
   * Everything here reads SYNCED CRDT state and uses flat per-item averages:
   * episode and film runtimes aren't in the data we sync, and pricing films by
   * the backup's real runtimes would only work on the device that imported it —
   * the very split that made this number differ between devices. Rewatches count
   * each time through. The imported historical remainder is added separately as
   * a synced, device-independent offset (see seedIdentityIntoCrdt).
   */
  private computedLifetimeMinutes = computed(() => {
    let total = 0;
    for (const w of Object.values(this.episodeWatchesSig())) {
      total += AVG_EPISODE_MINUTES * Math.max(1, finiteOr(w.nbTimes) ?? 1);
    }
    for (const m of this.movies()) {
      if (m.state.watched) total += AVG_MOVIE_MINUTES;
    }
    return total;
  });

  /** Aggregate stats for the profile/dashboard view. */
  readonly stats = computed(() => {
    const shows = this.shows();
    const movies = this.movies();
    const episodeWatches = Object.values(this.episodeWatchesSig());
    const derived = this.computedLifetimeMinutes();
    // Synced, computed-once offset — the same on every device (see
    // seedIdentityIntoCrdt). Absent until the backup-holding device sets it.
    const offset = finiteOr(this.profileSig()['lifetimeOffset']) ?? 0;
    return {
      // "my library" = titles the user has actually added, not the whole catalog
      showsFollowed: shows.filter((s) => s.state.status !== 'none').length,
      showsCompleted: shows.filter((s) => s.state.status === 'completed').length,
      showsFavorite: shows.filter((s) => s.state.favorite).length,
      moviesTracked: movies.filter((m) => m.state.watched || m.state.watchlist || m.state.favorite).length,
      moviesWatched: movies.filter((m) => m.state.watched).length,
      episodesWatched: episodeWatches.length,
      // Lifetime total: your live watch log plus the synced historical offset.
      // The offset is constant, so every episode you tick moves this number.
      lifetimeMinutes: derived + offset,
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

  /**
   * Episodes of a show-season marked watched — reactive, no episode list needed.
   *
   * Reads a memoized index rather than scanning: this is called from a template
   * loop (once per season), so a linear scan per call would be O(seasons ×
   * watches) on every change detection.
   */
  watchedInSeason(tvdbId: string, season: number): number {
    return this.watchedCountBySeason()[`${tvdbId}:${season}`] ?? 0;
  }

  // -------------------------------------------------------------------------
  // Adding titles from TMDB search
  // -------------------------------------------------------------------------
  /** True if this TMDB title is already in the library (catalog or added). */
  isInLibrary(kind: 'show' | 'movie', tmdbId: number): boolean {
    return kind === 'show'
      ? !!this.addedShowsSig()[addedKey('show', tmdbId)]
      : !!this.addedMoviesSig()[addedKey('movie', tmdbId)];
  }

  /**
   * Add a show found through TMDB search, and start following it.
   *
   * The detail fetch is what resolves the TheTVDB id that episode tracking is
   * keyed by, so a show added without one still appears and is trackable at the
   * show level — it just can't log individual episodes. If the fetch fails
   * (offline, no key) we fall back to the search row rather than refusing.
   *
   * Returns the uuid so the caller can navigate to the new detail page.
   *
   * `prefetched` lets a caller that already loaded the TMDB detail (the preview
   * detail page) hand it in, skipping a redundant round-trip. Pass `undefined`
   * — the search flow — to fetch it here.
   */
  async addShow(result: TmdbSearchResult, prefetched?: TmdbShow | null): Promise<string> {
    const detail =
      prefetched !== undefined ? prefetched : await this.tmdb.show(result.tmdbId).catch(() => null);
    const uuid = addedKey('show', result.tmdbId);
    const now = this.now();

    this.docs.doc.transact(() => {
      this.docs.addedShows.set(uuid, {
        uuid,
        name: detail?.name || result.name,
        tmdbId: result.tmdbId,
        tvdbId: detail?.tvdbId ?? null,
        imdbId: null,
        posterPath: detail?.posterPath ?? result.posterPath,
        firstReleaseDate: detail?.firstAirDate ?? yearToDate(result.year),
        overview: detail?.overview || result.overview || null,
        genres: detail?.genres ?? [],
        addedAt: now,
      });
      this.docs.showState.set(uuid, {
        ...this.defaultShowState(),
        status: 'watching',
        addedAt: now,
        updatedAt: now,
      });
    });
    return uuid;
  }

  /**
   * Add a movie found through TMDB search, onto the watchlist. `prefetched`
   * skips the detail round-trip when the caller already has it (see addShow).
   */
  async addMovie(result: TmdbSearchResult, prefetched?: TmdbMovie | null): Promise<string> {
    const detail =
      prefetched !== undefined ? prefetched : await this.tmdb.movie(result.tmdbId).catch(() => null);
    const uuid = addedKey('movie', result.tmdbId);
    const now = this.now();

    this.docs.doc.transact(() => {
      this.docs.addedMovies.set(uuid, {
        uuid,
        name: detail?.title || result.name,
        tmdbId: result.tmdbId,
        tvdbId: null,
        imdbId: detail?.imdbId ?? null,
        posterPath: detail?.posterPath ?? result.posterPath,
        firstReleaseDate: detail?.releaseDate ?? yearToDate(result.year),
        overview: detail?.overview || result.overview || null,
        genres: detail?.genres ?? [],
        addedAt: now,
      });
      this.docs.movieState.set(uuid, {
        ...this.defaultMovieState(),
        watchlist: true,
        updatedAt: now,
      });
    });
    return uuid;
  }

  /**
   * Remove a title the user added. Its watch state goes too — leaving orphaned
   * state behind would silently resurrect the title's ratings if it were ever
   * re-added.
   */
  removeAdded(kind: 'show' | 'movie', uuid: string): void {
    this.docs.doc.transact(() => {
      if (kind === 'show') {
        this.docs.addedShows.delete(uuid);
        this.docs.showState.delete(uuid);
      } else {
        this.docs.addedMovies.delete(uuid);
        this.docs.movieState.delete(uuid);
      }
    });
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

  /**
   * Mark (or clear) a whole season in one CRDT transaction, so it syncs as a
   * single change rather than one write per episode.
   */
  setSeasonWatched(tvdbId: string, season: number, episodes: number[], watched: boolean): void {
    this.docs.doc.transact(() => {
      for (const ep of episodes) this.setEpisodeWatched(tvdbId, season, ep, watched);
    });
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

/**
 * Project a user-added title into the catalog's shape, so every downstream
 * view model, filter and detail page treats it identically to a seeded title.
 * Fields the backup would have supplied (network, air day, follow date) are
 * simply absent — the UI already renders them conditionally.
 */
function addedToSeedShow(a: AddedTitle): SeedShow {
  return {
    uuid: a.uuid,
    name: a.name,
    tvdbId: a.tvdbId,
    genres: a.genres ?? [],
    firstReleaseDate: a.firstReleaseDate,
    overview: a.overview,
    followedAt: a.addedAt,
    showWatchedAt: null,
    isEnded: null,
    dayOfWeek: null,
    network: null,
    country: null,
    hashtag: null,
    cachedPoster: tmdbPosterUrl(a.posterPath),
    favorite: false,
  };
}

function addedToSeedMovie(a: AddedTitle): SeedMovie {
  return {
    uuid: a.uuid,
    name: a.name,
    imdbId: a.imdbId,
    tvdbId: null,
    genres: a.genres ?? [],
    firstReleaseDate: a.firstReleaseDate,
    overview: a.overview,
    followedAt: a.addedAt,
    watchedAt: null,
    favorite: false,
    cachedPoster: tmdbPosterUrl(a.posterPath),
  };
}

/** Avatars are stored square at this edge length — small enough to sync cheaply. */
const AVATAR_PX = 256;

/**
 * Watch-time pricing for titles whose real runtime we don't have. Episode
 * runtime is never in the data — not in the TV Time backup, not in our own
 * watch records — so every episode is priced the same; 42 is the usual midpoint
 * between half-hour comedies and hour-long dramas once ad breaks come out.
 * Films are flat-priced too: the backup knows their real runtimes, but only the
 * device holding the backup does, and a number that depends on which device you
 * open is worse than one that is uniformly approximate.
 */
const AVG_EPISODE_MINUTES = 42;
const AVG_MOVIE_MINUTES = 115;

/**
 * Price the backup's OWN watch rows with the exact arithmetic the live tally
 * uses (see computedLifetimeMinutes), so the two can be compared. Whatever the
 * imported TV Time total has beyond this is the historical remainder we keep as
 * a fixed, synced offset. Same flat averages as the live side — never the
 * backup's real film runtimes — so the offset a backup-holding device stores is
 * consistent with what every device then recomputes live.
 */
function seedDerivedMinutes(seed: Seed): number {
  let total = 0;
  for (const e of seed.watchedEpisodes ?? []) {
    if (e.seen) total += AVG_EPISODE_MINUTES * Math.max(1, finiteOr(e.nbTimesWatched) ?? 1);
  }
  total += (seed.watchedMovies?.length ?? 0) * AVG_MOVIE_MINUTES;
  return total;
}

/**
 * Narrow an avatar coming out of the CRDT to something safe to put in `[src]`.
 *
 * The value arrives from a synced peer or an imported file, so it is untrusted.
 * We only ever *write* `data:image/...` here (see setProfileImage), and that is
 * the only form we accept back — which rules out `javascript:` and friends
 * without leaning on the template sanitizer as the sole line of defence.
 * `null` clears the avatar; `undefined` means "no edit, fall back to the seed".
 */
/** Widen a bare year from a search row into the ISO-ish date the models use. */
function yearToDate(year: string | null): string | null {
  return year ? `${year}-01-01` : null;
}

/** A usable non-negative number, or undefined so the caller can fall through. */
export function finiteOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function safeImageSrc(value: unknown): string | null | undefined {
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
