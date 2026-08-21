import { Injectable, computed, inject, signal } from '@angular/core';
import * as Y from 'yjs';
import { DocService, addedKey, epKey, parseAddedKey, seasonKey } from './doc.service';
import { SeedService } from './seed.service';
import {
  TmdbService,
  tmdbPosterUrl,
  type TmdbMediaKind,
  type TmdbSearchResult,
  type TmdbShow,
  type TmdbMovie,
  type TmdbWriteResult,
  type TmdbListItemRef,
} from './tmdb.service';
import type {
  Seed,
  ShowState,
  MovieState,
  EpisodeWatch,
  EpisodeRating,
  ShowView,
  MovieView,
  ShowStatus,
  AddedTitle,
  SeedShow,
  SeedMovie,
  WatchPoint,
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
  private episodeRatingsSig = signal<Record<string, EpisodeRating>>({});
  private listsSig = signal<Record<string, any>>({});
  private profileSig = signal<Record<string, any>>({});
  private addedShowsSig = signal<Record<string, AddedTitle>>({});
  private addedMoviesSig = signal<Record<string, AddedTitle>>({});

  private started = false;

  constructor() {
    // Mirror the CRDT into signals straight away, rather than at the end of
    // `init()`. These mirrors read the doc and subscribe to it — no catalog
    // fetch, no IndexedDB — so nothing about them needs to wait, and binding
    // here means every read goes through the same path whether the doc is
    // still empty, being restored from disk, or arriving over sync. (Yjs
    // notifies observers for each of those equally, so the late-bound version
    // only ever differed in when the *first* snapshot was taken.)
    this.bind(this.docs.showState, this.showStateSig);
    this.bind(this.docs.movieState, this.movieStateSig);
    this.bind(this.docs.episodeWatches, this.episodeWatchesSig);
    this.bind(this.docs.episodeRatings, this.episodeRatingsSig);
    this.bind(this.docs.lists, this.listsSig);
    this.bind(this.docs.profile, this.profileSig);
    this.bind(this.docs.addedShows, this.addedShowsSig);
    this.bind(this.docs.addedMovies, this.addedMoviesSig);
  }

  /** Wire seed + CRDT together. Call once at app start (APP_INITIALIZER). */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Load the catalog (browse content). We do NOT bootstrap user state from it
    // — the catalog is shared/anonymous; each person builds their own library.
    // Personal state is only ever seeded by an explicit backup import.
    const seed = await this.seedSvc.load();
    await this.docs.whenReady();

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

  /**
   * Every per-show index derived from the episode-watch map, built in one pass.
   *
   * These four used to be four computeds, each doing its own full scan — so
   * ticking a single episode walked a library-sized map (thousands of entries
   * on a restored backup) four times over. They share one traversal because
   * they share one input and always invalidate together.
   */
  private episodeIndexes = computed(() => {
    /** Episode-watch count per show TVDB id. */
    const countByTvdb: Record<string, number> = {};
    /**
     * Most recent episode `watchedAt` per show TVDB id. Ticking off an episode
     * doesn't touch `ShowState.updatedAt` (see setEpisodeWatched), so this is
     * the only signal of "I watched this show recently" — it's what makes
     * Continue watching reflect real viewing activity, not just status edits.
     */
    const lastWatchedByTvdb: Record<string, string> = {};
    /**
     * The furthest-along watched episode per show — the anchor "what's next"
     * counts forward from.
     *
     * Furthest, deliberately, not most-recent-by-date: re-watching an old
     * episode shouldn't rewind your position, and a backup's `watchedAt`
     * timestamps are only as trustworthy as the service that wrote them.
     * Season then episode compare numerically (an episode key sorts as a
     * string, so a plain max over the keys would put S10 before S9).
     */
    const furthestByTvdb: Record<string, { season: number; episode: number }> = {};
    /** Episode-watch count per `${tvdbId}:${season}` — backs watchedInSeason(). */
    const countBySeason: Record<string, number> = {};

    for (const w of Object.values(this.episodeWatchesSig())) {
      countByTvdb[w.tvdbId] = (countByTvdb[w.tvdbId] ?? 0) + 1;

      const sKey = seasonKey(w.tvdbId, w.season);
      countBySeason[sKey] = (countBySeason[sKey] ?? 0) + 1;

      const last = lastWatchedByTvdb[w.tvdbId];
      if (!last || w.watchedAt > last) lastWatchedByTvdb[w.tvdbId] = w.watchedAt;

      const cur = furthestByTvdb[w.tvdbId];
      if (!cur || w.season > cur.season || (w.season === cur.season && w.episode > cur.episode)) {
        furthestByTvdb[w.tvdbId] = { season: w.season, episode: w.episode };
      }
    }
    return { countByTvdb, lastWatchedByTvdb, furthestByTvdb, countBySeason };
  });

  readonly furthestWatchedByTvdb = computed(() => this.episodeIndexes().furthestByTvdb);

  /** Most recent episode `watchedAt` per show TVDB id — recency ordering for show lists. */
  readonly lastWatchedByTvdb = computed(() => this.episodeIndexes().lastWatchedByTvdb);

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
    const counts = this.episodeIndexes().countByTvdb;

    const catalog = seed?.shows ?? [];
    const known = new Set(catalog.map((s) => s.tvdbId).filter(Boolean));
    const added = Object.values(this.addedShowsSig())
      .filter((a) => !a.tvdbId || !known.has(a.tvdbId))
      .map(addedToSeedShow);

    return [...catalog, ...added].map((s) => ({
      ...s,
      state: state[s.uuid] ?? this.defaultShowState(),
      watchedEpisodeCount: s.tvdbId ? (counts[s.tvdbId] ?? 0) : 0,
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
    const lastWatched = this.episodeIndexes().lastWatchedByTvdb;
    const watchedAt = (s: ShowView): string => (s.tvdbId ? lastWatched[s.tvdbId] : undefined) ?? '';
    return this.shows()
      .filter((s) => s.state.status === 'watching')
      .sort((a, b) => watchedAt(b).localeCompare(watchedAt(a)));
  });

  /**
   * Shelved shows, most-recently-active first — same ordering rule as
   * `watchingShows`, so "what I put down last" sits at the top of the list.
   */
  readonly pausedShows = computed(() => {
    const lastWatched = this.episodeIndexes().lastWatchedByTvdb;
    const watchedAt = (s: ShowView): string => (s.tvdbId ? lastWatched[s.tvdbId] : undefined) ?? '';
    return this.shows()
      .filter((s) => s.state.status === 'paused')
      .sort((a, b) => watchedAt(b).localeCompare(watchedAt(a)));
  });

  /**
   * The watch log as a feed: individual episode watches, newest first, each
   * paired with the show it belongs to.
   *
   * Unlike `lastWatchedByTvdb` this keeps every entry rather than one per show,
   * because the home feed is a history of episodes — binge three of the same
   * series and all three belong in it. Watches whose show is no longer in the
   * library are dropped; there is nothing to render for them.
   */
  readonly recentEpisodeWatches = computed<
    { key: string; show: ShowView; season: number; episode: number; watchedAt: string }[]
  >(() => {
    const byTvdb = new Map<string, ShowView>();
    for (const s of this.shows()) if (s.tvdbId && !byTvdb.has(s.tvdbId)) byTvdb.set(s.tvdbId, s);

    const rows: {
      key: string;
      show: ShowView;
      season: number;
      episode: number;
      watchedAt: string;
    }[] = [];
    for (const w of Object.values(this.episodeWatchesSig())) {
      const show = byTvdb.get(w.tvdbId);
      if (!show || !w.watchedAt) continue;
      rows.push({
        key: epKey(w.tvdbId, w.season, w.episode),
        show,
        season: w.season,
        episode: w.episode,
        watchedAt: w.watchedAt,
      });
    }
    return rows.sort(byWatchRecency);
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
        return {
          type: 'movie',
          uuid: m.uuid,
          name: m.name,
          tvdbId: m.tvdbId,
          imdbId: m.imdbId,
          cachedPoster: null,
        };
      const s = this.seedSvc.getShow(item.uuid);
      if (s)
        return {
          type: 'show',
          uuid: s.uuid,
          name: s.name,
          tvdbId: s.tvdbId,
          imdbId: null,
          cachedPoster: s.cachedPoster,
        };

      // Not in the seed catalog — fall back to titles the user added from TMDB,
      // so a film/show put on a list still resolves and renders.
      const mv = this.movie(item.uuid);
      if (mv)
        return {
          type: 'movie',
          uuid: mv.uuid,
          name: mv.name,
          tvdbId: mv.tvdbId,
          imdbId: mv.imdbId,
          cachedPoster: mv.cachedPoster ?? null,
        };
      const sv = this.show(item.uuid);
      if (sv)
        return {
          type: 'show',
          uuid: sv.uuid,
          name: sv.name,
          tvdbId: sv.tvdbId,
          imdbId: null,
          cachedPoster: sv.cachedPoster ?? null,
        };
    }
    return null;
  }

  /**
   * True if the list already contains this item (matched by uuid).
   *
   * Reads the mirrored signal rather than the Y.Map directly: this is called
   * from templates, and a raw CRDT read is invisible to change detection — an
   * OnPush component would never learn that the answer had changed.
   */
  isInList(listId: string, uuid: string): boolean {
    const list = this.listsSig()[listId];
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
    this.mirrorListItems(listId, 'add', [item]);
  }

  /** Remove an item from a custom list (matched by uuid, else title). */
  removeListItem(listId: string, item: { uuid?: string | null; title?: string | null }): void {
    const list = this.docs.lists.get(listId);
    if (!list?.items) return;
    const items = list.items.filter((it: any) =>
      item.uuid ? it.uuid !== item.uuid : it.title !== item.title,
    );
    this.docs.lists.set(listId, { ...list, items });
    this.mirrorListItems(listId, 'remove', [item]);
  }

  /** Create an empty custom list. Returns its id. */
  createList(name: string): string {
    const id = crypto.randomUUID();
    this.docs.lists.set(id, { name, description: '', createdAt: this.now(), items: [] });
    // No remote counterpart yet: an empty list is nothing to mirror, and the
    // first item added creates it (see `remoteListId`) with its name settled.
    return id;
  }

  /** Rename an existing custom list (no-op if it's gone). */
  renameList(listId: string, name: string): void {
    const list = this.docs.lists.get(listId);
    if (!list) return;
    this.docs.lists.set(listId, { ...list, name });
    // Renames only follow a list that already exists on TMDB — renaming one
    // that was never mirrored has nothing to rename, and creating it here would
    // publish an empty list the user never asked to sync.
    this.mirrorListOp(listId, `Renamed “${name}” on TMDB.`, false, (remote) =>
      this.tmdb.updateList(remote, name, list.description ?? ''),
    );
  }

  /** Delete an entire custom list. */
  deleteList(listId: string): void {
    const remote = this.docs.lists.get(listId)?.tmdbListId;
    this.docs.lists.delete(listId);
    // Read before the delete, then addressed directly: with the local list gone
    // there is nothing left to resolve the remote id from.
    if (typeof remote === 'number') {
      this.queueList(listId, async () => {
        this.reportList(await this.tmdb.deleteList(remote), 'Deleted that list on TMDB.');
      });
    }
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
    const login = typeof edits['login'] === 'string' ? edits['login'] : undefined;
    const image = safeImageSrc(edits['image']);
    return {
      ...(seed ?? EMPTY_PROFILE),
      ...(name !== undefined ? { name } : {}),
      ...(login !== undefined ? { login } : {}),
      ...(image !== undefined ? { image } : {}),
      // Unlike the avatar, a banner has no seed counterpart — TV Time never had
      // one — so it is purely an edit, and absent simply means "none set".
      banner: safeImageSrc(edits['banner']) ?? null,
      /**
       * The gist backing the public profile page, or null while private. Synced
       * rather than device-local so every device shows the same "you are public
       * at this link" state — and so any of them can take the page down again.
       *
       * Shape-checked on the way *out* rather than only on the way in: this is
       * the single point every reader goes through, so a value that reached the
       * document by some path other than `setPublicProfile` — an imported state
       * file, an older client — still cannot reach a request URL. A rejected id
       * reads as "private", which fails closed.
       */
      publicGistId: isGistId(edits['publicGistId']) ? edits['publicGistId'] : null,
      /** When the public snapshot was last written, for the staleness check. */
      publishedAt: typeof edits['publishedAt'] === 'string' ? edits['publishedAt'] : null,
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
   * Set the username shown as `@handle`. Empty clears back to the backup's own
   * login (TV Time had one), which is why this deletes rather than stores "".
   *
   * It is a display handle and nothing more: nothing resolves a profile *by* it
   * — the public page is addressed by its gist id — so two people picking the
   * same one costs nothing and there is no registry to check against.
   */
  setProfileLogin(login: string): void {
    const normalized = normalizeLogin(login);
    if (normalized) this.docs.profile.set('login', normalized);
    else this.docs.profile.delete('login');
    this.docs.profile.set('updatedAt', this.now());
  }

  /**
   * Record that this profile is published, and where. Written to the CRDT so the
   * fact travels with the rest of the profile: a second device must not think it
   * is private and quietly publish a *second* page.
   */
  setPublicProfile(gistId: string): void {
    // Refuse to record an id we would refuse to read back — storing one would
    // leave the UI showing "private" with a live gist behind it that no device
    // can now take down.
    if (!isGistId(gistId)) throw new Error('GitHub returned a malformed gist id');
    this.docs.profile.set('publicGistId', gistId);
    this.docs.profile.set('publishedAt', this.now());
    this.docs.profile.set('updatedAt', this.now());
  }

  /** Note a re-publish of an already-public page (same gist, fresher snapshot). */
  touchPublicProfile(): void {
    this.docs.profile.set('publishedAt', this.now());
  }

  /** Back to private: the page is gone, so the pointer to it goes too. */
  clearPublicProfile(): void {
    this.docs.profile.delete('publicGistId');
    this.docs.profile.delete('publishedAt');
    this.docs.profile.set('updatedAt', this.now());
  }

  /**
   * Set the avatar from a picked file. The image is downscaled to a small
   * square data URI first — it lives in the CRDT and therefore in every sync
   * payload, so keeping it tiny matters more than keeping it sharp.
   */
  async setProfileImage(file: File): Promise<void> {
    const dataUri = await downscaleToDataUri(file, AVATAR_PX, AVATAR_PX, 0.85);
    this.docs.profile.set('image', dataUri);
    this.docs.profile.set('updatedAt', this.now());
  }

  /** Drop the custom avatar (falls back to the seed's, if any). */
  clearProfileImage(): void {
    this.docs.profile.delete('image');
    this.docs.profile.set('updatedAt', this.now());
  }

  /**
   * Set the profile banner from a picked file. Same one-way trip as the avatar
   * — cropped and re-encoded here, stored as a data URI, synced to your other
   * devices — just wider and a little more compressed (see BANNER_W).
   */
  async setProfileBanner(file: File): Promise<void> {
    const dataUri = await downscaleToDataUri(file, BANNER_W, BANNER_H, BANNER_QUALITY);
    this.docs.profile.set('banner', dataUri);
    this.docs.profile.set('updatedAt', this.now());
  }

  /** Remove the banner, returning the profile header to its plain state. */
  clearProfileBanner(): void {
    this.docs.profile.delete('banner');
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

  /**
   * Every watch as a timestamped, priced point, oldest first — the log of *when*
   * viewing happened.
   *
   * Priced by the same flat averages as `computedLifetimeMinutes` (see there for
   * why runtimes aren't used), so a week's total can never disagree with the
   * lifetime figure about what an episode is worth. The imported historical
   * offset carries no timestamps at all, so it appears here nowhere. Rewatches
   * are folded into the one timestamp we have for them.
   *
   * Catch-up ticks are dropped (see dropBulkTicks): marking a season — or a
   * whole backup's worth of shows — logs the moment the *bookkeeping* happened,
   * not the viewing. Those watches still count towards lifetime totals, which
   * only ask how much; they cannot honestly answer when, so they stay out of
   * anything that plots time.
   */
  readonly watchTimeline = computed<WatchPoint[]>(() => {
    const points: WatchPoint[] = [];
    for (const w of Object.values(this.episodeWatchesSig())) {
      const at = Date.parse(w.watchedAt);
      if (!Number.isFinite(at)) continue;
      points.push({
        at,
        minutes: AVG_EPISODE_MINUTES * Math.max(1, finiteOr(w.nbTimes) ?? 1),
        titleKey: `show:${w.tvdbId}`,
      });
    }
    for (const m of this.movies()) {
      if (!m.state.watched || !m.state.watchedAt) continue;
      const at = Date.parse(m.state.watchedAt);
      if (!Number.isFinite(at)) continue;
      points.push({ at, minutes: AVG_MOVIE_MINUTES, titleKey: `movie:${m.uuid}` });
    }
    return dropBulkTicks(points);
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
      moviesTracked: movies.filter((m) => m.state.watched || m.state.watchlist || m.state.favorite)
        .length,
      moviesWatched: movies.filter((m) => m.state.watched).length,
      episodesWatched: episodeWatches.length,
      // Lifetime total: your live watch log plus the synced historical offset.
      // The offset is constant, so every episode you tick moves this number.
      lifetimeMinutes: derived + offset,
    };
  });

  readonly favoriteShows = computed(() => this.shows().filter((s) => s.state.favorite));
  readonly favoriteMovies = computed(() => this.movies().filter((m) => m.state.favorite));

  /**
   * The user's genres, ranked — counting watch activity, not library size: a
   * show needs at least one watched episode and a movie needs to be marked
   * watched. Each title scores once no matter how long it ran, so a single
   * 200-episode binge can't pin its genres to the top forever.
   *
   * Lives here rather than in the profile page because the published snapshot
   * shows the same ranking; two copies of this arithmetic would eventually
   * disagree, and the disagreement would be visible to strangers.
   */
  readonly topGenres = computed(() => {
    const counts: Record<string, number> = {};
    for (const s of this.shows()) {
      if (s.watchedEpisodeCount === 0) continue;
      for (const g of s.genres) counts[g] = (counts[g] ?? 0) + 1;
    }
    for (const m of this.movies()) {
      if (!m.state.watched) continue;
      for (const g of m.genres) counts[g] = (counts[g] ?? 0) + 1;
    }
    const arr = Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    const max = arr[0]?.count || 1;
    return arr.map((g) => ({ ...g, pct: Math.round((g.count / max) * 100) }));
  });

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------
  /**
   * uuid → view indexes, rebuilt only when the underlying lists change.
   *
   * `show()`/`movie()` are called from template context — `resolveListItem` runs
   * once per list row, per change detection cycle — and each used to be a
   * `.find()` over the whole library. That made rendering a list O(rows × 853)
   * on every tick; the map makes it O(rows).
   */
  private showIndex = computed(() => new Map(this.shows().map((s) => [s.uuid, s])));
  private movieIndex = computed(() => new Map(this.movies().map((m) => [m.uuid, m])));

  show(uuid: string): ShowView | undefined {
    return this.showIndex().get(uuid);
  }
  movie(uuid: string): MovieView | undefined {
    return this.movieIndex().get(uuid);
  }

  /**
   * Added-title uuid → the catalog uuid that superseded it.
   *
   * `shows`/`movies` drop an added title whose TheTVDB/IMDb id is already in the
   * catalog, so its own `tmdb:show:<id>` uuid resolves to nothing even though the
   * title is very much in the library. Anything addressing a title by that uuid —
   * a Trending card, a link shared between devices — would otherwise land on a
   * detail page convinced the show is unknown, offering to add it a second time
   * while the real entry (with the user's watch history) sits elsewhere.
   */
  private readonly uuidAliases = computed(() => {
    const seed = this.seedSvc.seed();
    return new Map([
      ...supersededUuids(
        (seed?.shows ?? []).map((s) => ({ uuid: s.uuid, id: s.tvdbId })),
        Object.values(this.addedShowsSig()).map((a) => ({ uuid: a.uuid, id: a.tvdbId })),
      ),
      ...supersededUuids(
        (seed?.movies ?? []).map((m) => ({ uuid: m.uuid, id: m.imdbId })),
        Object.values(this.addedMoviesSig()).map((a) => ({ uuid: a.uuid, id: a.imdbId })),
      ),
    ]);
  });

  /**
   * The uuid that actually holds this title, when `uuid` names an added entry
   * that was deduped away — null when `uuid` is the one to use (the common case,
   * including uuids that aren't in the library at all).
   *
   * Added keys carry their kind (`tmdb:show:…` / `tmdb:movie:…`), so one lookup
   * serves both.
   */
  canonicalUuid(uuid: string): string | null {
    return this.uuidAliases().get(uuid) ?? null;
  }
  isEpisodeWatched(tvdbId: string, season: number, episode: number): boolean {
    return !!this.episodeWatchesSig()[epKey(tvdbId, season, episode)];
  }

  /** When an episode was marked watched, or null if it isn't. */
  episodeWatchedAt(tvdbId: string, season: number, episode: number): string | null {
    return this.episodeWatchesSig()[epKey(tvdbId, season, episode)]?.watchedAt ?? null;
  }

  /** The user's own 1-10 score for an episode, or null if unrated. */
  episodeRating(tvdbId: string, season: number, episode: number): number | null {
    return this.episodeRatingsSig()[epKey(tvdbId, season, episode)]?.rating ?? null;
  }

  /**
   * Episodes of a show-season marked watched — reactive, no episode list needed.
   *
   * Reads a memoized index rather than scanning: this is called from a template
   * loop (once per season), so a linear scan per call would be O(seasons ×
   * watches) on every change detection.
   */
  watchedInSeason(tvdbId: string, season: number): number {
    return this.episodeIndexes().countBySeason[seasonKey(tvdbId, season)] ?? 0;
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
    // Adding a title to the library is the thing worth having on the TMDB
    // profile too — TMDB's watchlist is the nearest shelf it has to "I'm
    // tracking this".
    this.mirrorWatchlist('show', uuid, true);
    return uuid;
  }

  /**
   * Add a movie found through TMDB search, onto the watchlist. `prefetched`
   * skips the detail round-trip when the caller already has it (see addShow).
   */
  async addMovie(result: TmdbSearchResult, prefetched?: TmdbMovie | null): Promise<string> {
    const detail =
      prefetched !== undefined
        ? prefetched
        : await this.tmdb.movie(result.tmdbId).catch(() => null);
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
    this.mirrorWatchlist('movie', uuid, true);
    return uuid;
  }

  /**
   * Remove a title the user added. Its watch state goes too — leaving orphaned
   * state behind would silently resurrect the title's ratings if it were ever
   * re-added.
   */
  removeAdded(kind: 'show' | 'movie', uuid: string): void {
    // Taking a title out of the library takes everything this app put on the
    // TMDB profile with it — a film you've un-tracked shouldn't stay starred
    // over there with nothing here left to unstar it. Read before the delete;
    // mirrored after, from the uuid, which carries the TMDB id either way.
    const state: ShowState | MovieState | undefined =
      kind === 'show' ? this.docs.showState.get(uuid) : this.docs.movieState.get(uuid);
    this.mirrorWatchlist(kind, uuid, false);
    if (state?.favorite) this.mirrorFavorite(kind, uuid, false);
    if (state?.rating != null) this.mirrorRating(kind, uuid, null);

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

    // `parseAddedKey` is what tells a title added here — which the add already
    // put on the TMDB watchlist — from a catalog title that has never been near
    // it. See `watchlistIntent`.
    const wanted = watchlistIntent(cur.status, status, parseAddedKey(uuid) !== null);
    if (wanted !== null) this.mirrorWatchlist('show', uuid, wanted);
  }
  toggleShowFavorite(uuid: string): void {
    const cur = this.docs.showState.get(uuid) ?? this.defaultShowState();
    const favorite = !cur.favorite;
    this.docs.showState.set(uuid, { ...cur, favorite, updatedAt: this.now() });
    this.mirrorFavorite('show', uuid, favorite);
  }
  rateShow(uuid: string, rating: number | null): void {
    const cur = this.docs.showState.get(uuid) ?? this.defaultShowState();
    this.docs.showState.set(uuid, { ...cur, rating, updatedAt: this.now() });
    this.mirrorRating('show', uuid, rating);
  }

  setMovieWatched(uuid: string, watched: boolean): void {
    const cur = this.docs.movieState.get(uuid) ?? this.defaultMovieState();
    this.docs.movieState.set(uuid, {
      ...cur,
      watched,
      watchedAt: watched ? (cur.watchedAt ?? this.now()) : cur.watchedAt,
      watchlist: watched ? false : cur.watchlist,
      updatedAt: this.now(),
    });
    // Marking a film watched takes it off the watchlist here, so it comes off
    // the TMDB one too — otherwise a film you've seen sits there for ever.
    if (watched && cur.watchlist) this.mirrorWatchlist('movie', uuid, false);
  }
  toggleMovieWatchlist(uuid: string): void {
    const cur = this.docs.movieState.get(uuid) ?? this.defaultMovieState();
    const watchlist = !cur.watchlist;
    this.docs.movieState.set(uuid, { ...cur, watchlist, updatedAt: this.now() });
    this.mirrorWatchlist('movie', uuid, watchlist);
  }
  toggleMovieFavorite(uuid: string): void {
    const cur = this.docs.movieState.get(uuid) ?? this.defaultMovieState();
    const favorite = !cur.favorite;
    this.docs.movieState.set(uuid, { ...cur, favorite, updatedAt: this.now() });
    this.mirrorFavorite('movie', uuid, favorite);
  }
  rateMovie(uuid: string, rating: number | null): void {
    const cur = this.docs.movieState.get(uuid) ?? this.defaultMovieState();
    this.docs.movieState.set(uuid, { ...cur, rating, updatedAt: this.now() });
    this.mirrorRating('movie', uuid, rating);
  }

  // -------------------------------------------------------------------------
  // Mirroring to the TMDB profile
  //
  // Everything below is a one-way echo of a change that has ALREADY landed in
  // the CRDT. TMDB is a mirror, never the system of record: these run in the
  // background, they are never awaited by the code that made the edit, and a
  // failure is a note in the UI rather than anything the user has to undo. With
  // no API key set none of it runs at all.
  // -------------------------------------------------------------------------
  /**
   * What became of the last change mirrored to TMDB, for the UI to report —
   * null once there is nothing to say. Successes are reported too: sending your
   * watchlist to another service is the kind of thing you want to see confirmed.
   */
  readonly tmdbNote = signal<TmdbNote | null>(null);

  /**
   * The state last accepted by TMDB, per title and field. Several paths can ask
   * for the same fact — adding a show from the save menu files it as *watching*
   * and then as *watchlist* — and re-posting an unchanged value would spend a
   * round-trip to tell TMDB what it already knows, then announce it again.
   */
  private readonly mirrored = new Map<string, string>();

  /**
   * The chain of writes outstanding for each title+field, so they reach TMDB in
   * the order the user made them.
   *
   * Two edits to the same fact — star then un-star, remove then re-add — are two
   * requests with no ordering guarantee between them. Landing them out of order
   * would leave the profile in the opposite state from the library, and (since
   * each write records what it sent) leave it there: the corrective write would
   * look like a duplicate of a value already mirrored. Serializing per key makes
   * the last edit the last write.
   */
  private readonly mirrorQueue = new Map<string, Promise<void>>();

  /** Whether the "link an account" nudge has already been shown this session. */
  private nudgedAboutAccount = false;

  private mirrorWatchlist(kind: 'show' | 'movie', uuid: string, onList: boolean): void {
    this.mirrorTitle(kind, uuid, 'watchlist', onList, (id, media) =>
      this.tmdb.setWatchlist(media, id, onList),
    );
  }

  private mirrorFavorite(kind: 'show' | 'movie', uuid: string, favorite: boolean): void {
    this.mirrorTitle(kind, uuid, 'favorite', favorite, (id, media) =>
      this.tmdb.setFavorite(media, id, favorite),
    );
  }

  private mirrorRating(kind: 'show' | 'movie', uuid: string, rating: number | null): void {
    this.mirrorTitle(kind, uuid, 'rating', rating, (id, media) =>
      rating == null
        ? this.tmdb.clearTitleRating(media, id)
        : this.tmdb.rateTitle(media, id, rating),
    );
  }

  /**
   * Resolve a title to its TMDB id and push one field of its state, then report
   * the outcome. Fire-and-forget by design — see the section note above.
   */
  private mirrorTitle(
    kind: 'show' | 'movie',
    uuid: string,
    field: 'watchlist' | 'favorite' | 'rating',
    value: unknown,
    push: (tmdbId: number, media: TmdbMediaKind) => Promise<TmdbWriteResult>,
  ): void {
    if (!this.tmdb.hasKey()) return;
    const cacheKey = `${kind}:${uuid}:${field}`;
    const wanted = JSON.stringify(value ?? null);

    // Queue behind whatever is already in flight for this fact, and swallow its
    // failure — one write that didn't land must not cancel the next.
    const previous = this.mirrorQueue.get(cacheKey) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        // Checked here rather than when queued: what TMDB already holds is only
        // known once the write ahead of this one has finished.
        if (this.mirrored.get(cacheKey) === wanted) return;
        const tmdbId = await this.tmdbIdFor(kind, uuid);
        if (tmdbId == null) return; // not a title TMDB knows — nothing to mirror

        const res = await push(tmdbId, kind === 'show' ? 'tv' : 'movie');
        if (res.ok) {
          this.mirrored.set(cacheKey, wanted);
          this.note(mirrorDone(field, value));
          return;
        }
        if (res.skipped) {
          // Watchlist and favorites need a linked account, and someone who never
          // linked one hasn't failed at anything — so say it once, not per edit.
          if (this.nudgedAboutAccount) return;
          this.nudgedAboutAccount = true;
          this.note(
            'Saved here. Link your TMDB account in Settings to mirror watchlist, ratings and favorites there.',
          );
          return;
        }
        this.note(`Saved here, but TMDB didn't take it — ${res.error}`);
      })
      .finally(() => {
        // Last one out clears the slot, so the map doesn't grow with the library.
        if (this.mirrorQueue.get(cacheKey) === run) this.mirrorQueue.delete(cacheKey);
      });

    this.mirrorQueue.set(cacheKey, run);
  }

  /**
   * Put a note up. Always a fresh object, even for the same words: two identical
   * confirmations are two events, and a signal that compared equal would leave
   * the second one riding out the first one's dismissal timer.
   */
  private note(text: string): void {
    this.tmdbNote.set({ text });
  }

  // -------------------------------------------------------------------------
  // Mirroring custom lists (TMDB v4)
  //
  // Same one-way contract as above, with one structural difference: a title
  // already exists on TMDB, but a *list* does not — it has to be created before
  // anything can go on it, and its id remembered. That id lives on the list in
  // the CRDT, so the whole device fleet writes to the one remote list rather
  // than each device creating its own.
  // -------------------------------------------------------------------------
  /** Outstanding writes per local list, so create-then-add stays in that order. */
  private readonly listQueue = new Map<string, Promise<void>>();

  /**
   * Push the whole local list collection to TMDB — the one-off catch-up for
   * lists that predate linking. Returns what it managed, for the UI to report.
   *
   * Adds are idempotent at TMDB's end (an item already on the list comes back
   * as a per-item failure, which `addListItems` treats as success), so running
   * this twice is safe.
   */
  async syncAllLists(): Promise<{ lists: number; items: number; unresolved: number }> {
    const summary = { lists: 0, items: 0, unresolved: 0 };
    for (const list of this.lists()) {
      await this.queueList(list.id, async () => {
        const remote = await this.remoteListId(list.id, true);
        if (remote == null) return;
        summary.lists++;
        const refs: TmdbListItemRef[] = [];
        for (const item of list.items ?? []) {
          const ref = await this.listItemRef(item);
          if (ref) refs.push(ref);
          else summary.unresolved++;
        }
        const res = await this.tmdb.addListItems(remote, refs);
        if (res.ok) summary.items += refs.length;
        else summary.unresolved += refs.length;
      });
    }
    return summary;
  }

  /** Add or remove titles on the TMDB copy of a local list. */
  private mirrorListItems(
    listId: string,
    op: 'add' | 'remove',
    items: { uuid?: string | null; title?: string | null }[],
  ): void {
    void this.queueList(listId, async () => {
      // Resolved before the list is: a title TMDB can't name is nothing to
      // send, and finding that out afterwards would have created an empty list
      // over there to hold it.
      const refs: TmdbListItemRef[] = [];
      for (const item of items) {
        const ref = await this.listItemRef(item);
        if (ref) refs.push(ref);
      }
      if (!refs.length) return;

      // An add may be the first thing that ever touches this list, so it is
      // allowed to create the remote one; a remove of something that was never
      // mirrored has nothing to act on.
      const remote = await this.remoteListId(listId, op === 'add');
      if (remote == null) return;
      const res =
        op === 'add'
          ? await this.tmdb.addListItems(remote, refs)
          : await this.tmdb.removeListItems(remote, refs);
      this.reportList(
        res,
        op === 'add' ? 'Added to that list on TMDB too.' : 'Taken off that list on TMDB.',
      );
    });
  }

  /**
   * Run one write against a list's TMDB counterpart, in order behind whatever
   * else that list has outstanding. `create` decides whether a list with no
   * remote counterpart gets one made or is simply left alone.
   */
  private mirrorListOp(
    listId: string,
    done: string,
    create: boolean,
    run: (remote: number) => Promise<TmdbWriteResult>,
  ): void {
    void this.queueList(listId, async () => {
      const remote = await this.remoteListId(listId, create);
      if (remote == null) return;
      this.reportList(await run(remote), done);
    });
  }

  /** Chain a task behind this list's outstanding writes; nothing runs unlinked. */
  private queueList(listId: string, run: () => Promise<void>): Promise<void> {
    // Lists are the one part of the mirror behind a second, explicit opt-in, so
    // an unlinked app stays silent rather than nudging on every list edit.
    if (!this.tmdb.hasListAccess()) return Promise.resolve();
    const previous = this.listQueue.get(listId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(run)
      .catch(() => undefined)
      .finally(() => {
        if (this.listQueue.get(listId) === task) this.listQueue.delete(listId);
      });
    this.listQueue.set(listId, task);
    return task;
  }

  /**
   * The TMDB list backing a local one, creating it on first use when asked.
   *
   * The new id is written back into the CRDT, so it syncs: another device
   * adding to the same list finds this one instead of creating a second.
   */
  private async remoteListId(listId: string, create: boolean): Promise<number | null> {
    const list = this.docs.lists.get(listId);
    if (!list) return null;
    if (typeof list.tmdbListId === 'number') return list.tmdbListId;
    if (!create) return null;

    const res = await this.tmdb.createList(list.name || 'Untitled list', list.description ?? '');
    if (!res.ok || res.listId == null) {
      this.reportList(res, '');
      return null;
    }
    const fresh = this.docs.lists.get(listId);
    if (!fresh) {
      // Deleted while we were creating its counterpart — don't leave an orphan
      // list behind on the profile.
      void this.tmdb.deleteList(res.listId);
      return null;
    }
    this.docs.lists.set(listId, { ...fresh, tmdbListId: res.listId });
    return res.listId;
  }

  /** Resolve a list entry to the `{media_type, media_id}` TMDB wants. */
  private async listItemRef(item: {
    uuid?: string | null;
    title?: string | null;
  }): Promise<TmdbListItemRef | null> {
    const resolved = this.resolveListItem(item);
    if (!resolved) return null;
    const tmdbId = await this.tmdbIdFor(resolved.type, resolved.uuid);
    if (tmdbId == null) return null;
    return { media_type: resolved.type === 'show' ? 'tv' : 'movie', media_id: tmdbId };
  }

  /** Report a list write, unless it was a success the caller has no words for. */
  private reportList(res: TmdbWriteResult, done: string): void {
    if (res.ok) {
      if (done) this.note(done);
      return;
    }
    if (res.skipped) return;
    this.note(`Saved here, but TMDB didn't take it — ${res.error}`);
  }

  /**
   * The TMDB id behind a library title.
   *
   * A title added from TMDB search carries it in its own uuid (see `addedKey`),
   * so no lookup is needed — and none is possible once the entry is deleted,
   * which is exactly when a removal is mirrored. A catalog title has only the
   * backup's TheTVDB/IMDb id, which TMDB resolves (and memoizes) for us.
   */
  private async tmdbIdFor(kind: 'show' | 'movie', uuid: string): Promise<number | null> {
    const added = parseAddedKey(uuid);
    if (added?.kind === kind) return added.tmdbId;
    try {
      if (kind === 'show') {
        const tvdbId = this.show(uuid)?.tvdbId;
        return tvdbId ? await this.tmdb.tmdbIdForTvdb(tvdbId) : null;
      }
      const imdbId = this.movie(uuid)?.imdbId;
      return imdbId ? await this.tmdb.tmdbIdForImdb(imdbId) : null;
    } catch {
      return null; // offline, or TMDB unreachable — the local edit still stands
    }
  }

  setEpisodeWatched(
    tvdbId: string,
    season: number,
    episode: number,
    watched: boolean,
    at?: string,
  ): void {
    const key = epKey(tvdbId, season, episode);
    if (watched) {
      const cur = this.docs.episodeWatches.get(key);
      this.docs.episodeWatches.set(key, {
        tvdbId,
        season,
        episode,
        watchedAt: cur?.watchedAt ?? at ?? this.now(),
        nbTimes: (cur?.nbTimes ?? 0) + (cur ? 0 : 1),
      });
      this.resumeIfPaused(tvdbId);
    } else {
      this.docs.episodeWatches.delete(key);
    }
  }

  /**
   * A paused show resumes the moment one of its episodes is ticked watched.
   * Reads state straight from the CRDT, not the signal — inside a season-wide
   * transaction the signal hasn't refreshed yet, and only the doc shows that a
   * previous iteration already flipped the status.
   */
  private resumeIfPaused(tvdbId: string): void {
    const show = this.shows().find((s) => s.tvdbId === tvdbId);
    if (!show) return;
    const cur = this.docs.showState.get(show.uuid);
    if (cur?.status === 'paused') {
      this.docs.showState.set(show.uuid, { ...cur, status: 'watching', updatedAt: this.now() });
    }
  }

  /** Set — or with `null`, clear — the user's score for one episode. */
  rateEpisode(tvdbId: string, season: number, episode: number, rating: number | null): void {
    const key = epKey(tvdbId, season, episode);
    if (rating == null) {
      this.docs.episodeRatings.delete(key);
      return;
    }
    this.docs.episodeRatings.set(key, {
      tvdbId,
      season,
      episode,
      rating,
      ratedAt: this.now(),
      syncedToTmdb: false,
    });
  }

  /**
   * Record a score for an episode — or with `null`, withdraw it — and mirror
   * the change to TMDB, returning a short note about the remote half.
   *
   * The local write lands first and unconditionally: TMDB is a mirror, not the
   * system of record, so a failure there must never look like the rating was
   * lost. Both the home rail and the episode list go through here so the two
   * can't drift apart.
   */
  async rateEpisodeAndPush(
    tvdbId: string,
    season: number,
    episode: number,
    rating: number | null,
  ): Promise<string> {
    this.rateEpisode(tvdbId, season, episode, rating);
    const res =
      rating == null
        ? await this.tmdb.clearEpisodeRating(tvdbId, season, episode)
        : await this.tmdb.rateEpisode(tvdbId, season, episode, rating);

    if (!res.ok) {
      return rating == null
        ? `cleared here, but TMDB didn't take it — ${res.error}`
        : `saved here, but TMDB didn't take it — ${res.error}`;
    }
    if (rating != null) this.markEpisodeRatingSynced(tvdbId, season, episode, rating);
    const where = res.as === 'account' ? 'your TMDB account' : 'TMDB anonymously';
    return rating == null ? `withdrawn from ${where}.` : `sent to ${where}.`;
  }

  /**
   * Flag a rating as accepted by TMDB. `rating` is checked against what's
   * stored so a slow response can't stamp a score the user has since changed.
   */
  private markEpisodeRatingSynced(
    tvdbId: string,
    season: number,
    episode: number,
    rating: number,
  ): void {
    const key = epKey(tvdbId, season, episode);
    const cur = this.docs.episodeRatings.get(key);
    if (cur?.rating === rating) this.docs.episodeRatings.set(key, { ...cur, syncedToTmdb: true });
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

  /**
   * Mark every episode up to and including (season, episode) as watched.
   *
   * Bulk marks are backfills, not tonight's viewing, so each watch is stamped
   * with the episode's air date rather than "now" — otherwise completing a
   * back-catalog show would claim its whole run was watched today and skew
   * every date-derived view (stats, recency ordering, exports). Episodes with
   * no air date, or one in the future, fall back to the current time.
   */
  markWatchedUpTo(
    tvdbId: string,
    upToSeason: number,
    upToEpisode: number,
    seasons: { season: number; episodes: { number: number; airDate: string | null }[] }[],
  ): void {
    const now = this.now();
    this.docs.doc.transact(() => {
      for (const s of seasons) {
        for (const ep of s.episodes) {
          if (s.season < upToSeason || (s.season === upToSeason && ep.number <= upToEpisode)) {
            this.setEpisodeWatched(
              tvdbId,
              s.season,
              ep.number,
              true,
              this.airStamp(ep.airDate, now),
            );
          }
        }
      }
    });
  }

  /** An air date as a watch timestamp — midnight UTC that day, never in the future. */
  private airStamp(airDate: string | null, now: string): string {
    if (!airDate) return now;
    const iso = `${airDate}T00:00:00.000Z`;
    return iso < now ? iso : now;
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
    return {
      watched: false,
      watchedAt: null,
      watchlist: false,
      favorite: false,
      rating: null,
      updatedAt: null,
    };
  }
}

/**
 * What a show's status means for the TMDB watchlist: on, off, or none of TMDB's
 * business.
 *
 * TMDB has one shelf for "I mean to watch this" and no notion of being partway
 * through a series, so only the ends of our status ladder map onto it.
 * `watchlist` puts a show there; dropping it or taking it out of the library
 * removes it. The states in between — watching, paused, completed — are ours
 * alone, and leaving TMDB untouched for them is the deliberate part: starting a
 * show is not a reason to quietly rearrange someone's profile on another site.
 */
export function watchlistIntent(
  from: ShowStatus,
  to: ShowStatus,
  addedFromTmdb: boolean,
): boolean | null {
  if (from === to) return null;
  if (to === 'watchlist') return true;
  if (to !== 'none' && to !== 'dropped') return null;
  // Only take a title off a shelf we put it on. A title added here went onto
  // the TMDB watchlist as part of being added, and a `watchlist` show was put
  // there explicitly — but a catalog show the user shelved as *dropped* was
  // never mirrored anywhere, and posting a removal for it would report having
  // changed a profile that never held it.
  return addedFromTmdb || from === 'watchlist' ? false : null;
}

/**
 * One thing to tell the user about their TMDB profile. An object rather than a
 * bare string so that each note is a distinct value — see `LibraryStore.note`.
 */
export interface TmdbNote {
  text: string;
}

/** How a mirrored change reads back once TMDB has accepted it. */
export function mirrorDone(field: 'watchlist' | 'favorite' | 'rating', value: unknown): string {
  if (field === 'watchlist') {
    return value ? 'Added to your TMDB watchlist.' : 'Removed from your TMDB watchlist.';
  }
  if (field === 'favorite') {
    return value ? 'Added to your TMDB favorites.' : 'Removed from your TMDB favorites.';
  }
  return value == null ? 'Rating withdrawn from TMDB.' : `Rated ${value}/10 on TMDB.`;
}

/** A title reduced to what the dedupe cares about: its uuid and its source id. */
interface Identified {
  uuid: string;
  /** TheTVDB id for shows, IMDb id for films — null when unresolved. */
  id: string | null;
}

/**
 * Added-title uuid → the catalog uuid holding the same title.
 *
 * This is the inverse of the filter in `shows`/`movies`: those drop an added
 * title whose source id the catalog already carries, and this records which entry
 * absorbed it, so a uuid that no longer resolves can be redirected to one that
 * does. The two must agree — change the dedupe rule and change this with it.
 * Titles with no source id can't be matched and so are never superseded.
 *
 * Exported for the tests: this rule is only ever wrong in ways that are much
 * easier to write down than to click through.
 */
export function supersededUuids(
  catalog: readonly Identified[],
  added: readonly Identified[],
): Map<string, string> {
  const byId = new Map<string, string>();
  for (const c of catalog) if (c.id) byId.set(c.id, c.uuid);

  const alias = new Map<string, string>();
  for (const a of added) {
    const winner = a.id ? byId.get(a.id) : undefined;
    if (winner && winner !== a.uuid) alias.set(a.uuid, winner);
  }
  return alias;
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
 * Banner dimensions and JPEG quality. Deliberately modest: like the avatar this
 * lives in the CRDT, so it rides along in every sync payload to every device.
 * 1024×341 at 0.78 lands around 60-90 KB — wide enough to look sharp on a
 * laptop, small enough not to dominate the gist.
 */
const BANNER_W = 1024;
const BANNER_H = 341;
const BANNER_QUALITY = 0.78;

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
 * Shape of a catch-up: consecutive watches this close together belong to one
 * burst, a burst this long is worth judging, and it is a catch-up once it claims
 * more viewing than the clock it spans could have delivered.
 *
 * The grace is what keeps honest habits in. Ticking three episodes off at the
 * end of an evening writes three records seconds apart, and that is real
 * viewing — so a burst has to be both long AND impossible before it is dropped.
 */
const BURST_GAP_MS = 10 * 60_000;
const BURST_MIN_WATCHES = 9;
const BURST_GRACE_MINUTES = 60;

/**
 * Order a watch log newest first — the comparator behind `recentEpisodeWatches`.
 *
 * ISO timestamps sort chronologically as plain strings, so the primary key is a
 * string compare. Ties are the common case rather than an edge one: marking a
 * season watched stamps every episode with the same instant, so a whole season
 * lands as one block. Falling back to season/episode puts the finale at the
 * newest end of that block instead of whichever entry the map happened to hold
 * first — without it a season you watched to the end reads as S1E1…E5. Show
 * name settles ties between different series, only so that the order cannot
 * shift from one read to the next.
 */
export function byWatchRecency(
  a: { watchedAt: string; season: number; episode: number; show: { name: string } },
  b: { watchedAt: string; season: number; episode: number; show: { name: string } },
): number {
  return (
    b.watchedAt.localeCompare(a.watchedAt) ||
    b.season - a.season ||
    b.episode - a.episode ||
    a.show.name.localeCompare(b.show.name)
  );
}

/**
 * Drop catch-up bookkeeping from a watch log, keeping viewing.
 *
 * The test is physical rather than statistical: a run of watches logged faster
 * than the episodes could have been played did not happen when it says it did.
 * Marking a season — or importing a backup, which stamps every dateless row with
 * the moment it ran — writes tens to hundreds of records inside a few seconds,
 * claiming days of viewing in an instant. Real viewing can't outrun its own
 * playback, however hard someone binges.
 *
 * Bursts are dropped whole. The timestamps are the untrustworthy part, so
 * keeping eight of a season's twenty-two would just invent a smaller session out
 * of the same bad data.
 */
export function dropBulkTicks(points: WatchPoint[]): WatchPoint[] {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const kept: WatchPoint[] = [];
  let burst: WatchPoint[] = [];

  const flush = () => {
    if (!burst.length) return;
    const claimed = burst.reduce((total, p) => total + p.minutes, 0);
    const elapsed = (burst[burst.length - 1].at - burst[0].at) / 60_000;
    const impossible = burst.length >= BURST_MIN_WATCHES && claimed > elapsed + BURST_GRACE_MINUTES;
    if (!impossible) kept.push(...burst);
    burst = [];
  };

  for (const p of sorted) {
    if (burst.length && p.at - burst[burst.length - 1].at > BURST_GAP_MS) flush();
    burst.push(p);
  }
  flush();
  return kept;
}

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

/** Longest handle we keep. Matches GitHub's own cap; well past anything typed. */
const MAX_LOGIN = 39;

/**
 * Fold whatever was typed into a handle: no leading `@`, lower case, spaces and
 * punctuation collapsed to hyphens.
 *
 * Strict because it is rendered by *other* people's browsers on the public page
 * — an arbitrary string there is one more thing to have to trust — and because
 * `@Jo Smith!` reading back as `@jo-smith` is what people expect a username to
 * do. Returns '' when nothing usable survives, which callers treat as "clear it".
 */
export function normalizeLogin(raw: string): string {
  return (
    (raw ?? '')
      .trim()
      .replace(/^@+/, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      // Hyphens introduced by the sweep above can leave the handle topped and
      // tailed with them ("@ hi " -> "-hi-"); trim those rather than keep them.
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, MAX_LOGIN)
  );
}

export function safeImageSrc(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' && value.startsWith('data:image/') ? value : null;
}

/**
 * A gist id as GitHub issues them: hex, nothing else.
 *
 * Lives here beside the other field validators because it guards a *synced*
 * field. `publicGistId` travels in the CRDT rather than device-local config, so
 * it arrives from the sync gist, a paired device or an imported state file — and
 * from there it is interpolated into authenticated `PATCH`/`DELETE /gists/…`
 * calls. Every one of those writers already holds the gist token, so this is not
 * a privilege boundary; it is the check that keeps a malformed or
 * segment-injecting value (`id/star`, `../user/…`) from being spliced into an
 * API path at all.
 */
export function isGistId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{6,64}$/i.test(value);
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
 * Center-crop an image file to `width`×`height` and re-encode it as a JPEG data
 * URI. Runs entirely in-browser (no upload target exists — the app has no
 * backend).
 *
 * The crop takes the largest region of the source matching the target aspect,
 * so a portrait photo used as a banner keeps its middle band rather than being
 * squashed.
 */
async function downscaleToDataUri(
  file: File,
  width: number,
  height: number,
  quality: number,
): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not an image.');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not process the image on this device.');

    const targetAspect = width / height;
    const srcAspect = bitmap.width / bitmap.height;
    // Too wide for the target → trim the sides; too tall → trim top and bottom.
    const cropW = srcAspect > targetAspect ? bitmap.height * targetAspect : bitmap.width;
    const cropH = srcAspect > targetAspect ? bitmap.height : bitmap.width / targetAspect;
    ctx.drawImage(
      bitmap,
      (bitmap.width - cropW) / 2,
      (bitmap.height - cropH) / 2,
      cropW,
      cropH,
      0,
      0,
      width,
      height,
    );
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    bitmap.close();
  }
}
