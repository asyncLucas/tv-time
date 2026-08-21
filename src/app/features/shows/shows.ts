import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { addedKey } from '../../core/doc.service';
import { ListStateStore } from '../../core/list-state.service';
import { TmdbService, TmdbSearchResult, TmdbShow } from '../../core/tmdb.service';
import { TvmazeService } from '../../core/tvmaze.service';
import { Poster } from '../../shared/poster';
import { InitialsPipe } from '../../shared/initials';
import { TitleSearch } from '../../shared/title-search';
import { TimeLeftPipe } from '../../shared/time-left';
import { RecentSearches } from '../../shared/recent-searches';
import { RecentSearchesService } from '../../core/recent-searches.service';
import { scrollToCard } from '../../shared/scroll-to-card';
import { MAX_SHOWS_PROBED, TMDB_CONCURRENCY, mapPool } from '../../shared/map-pool';
import type { ShowView, ShowStatus } from '../../core/models';

type Filter =
  | 'airing'
  | 'all'
  | 'watching'
  | 'paused'
  | 'completed'
  | 'watchlist'
  | 'favorites'
  | 'trending';

/** One card in the Airing soon section: a show you follow and its next episode. */
interface UpNext {
  show: ShowView;
  ep: NonNullable<TmdbShow['nextEpisode']>;
  /**
   * Local clock time the episode airs, for an episode airing today — the one
   * case where "when" is a question of hours rather than days. Null whenever
   * TVmaze has no time for it (see `TvmazeService`), which leaves the card
   * showing the day alone.
   */
  airTime: string | null;
}

/** Stash key for the tab/search/scroll position remembered across a detail visit. */
const STASH = 'shows';

/** How many cards the grid reveals at a time. */
const PAGE = 60;

/** Cards in the Airing soon section. */
const MAX_UP_NEXT = 12;

function label(s: ShowStatus): string {
  return s === 'none' ? 'Following' : s[0].toUpperCase() + s.slice(1);
}

@Component({
  selector: 'app-shows',
  imports: [InitialsPipe, RouterLink, Poster, TitleSearch, TimeLeftPipe, RecentSearches],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Shows</h1>
          @if (filter() === 'airing') {
            <div class="sub">Next episodes for the shows you're watching</div>
          } @else if (filter() === 'trending') {
            <div class="sub">Trending on TMDB this week</div>
          } @else {
            <div class="sub">{{ filtered().length }} of {{ store.shows().length }} series in the catalog</div>
          }
        </div>
        <input
          class="search"
          placeholder="Search shows…"
          [value]="q()"
          (input)="q.set($any($event.target).value)"
          (blur)="rememberQuery()"
        />
      </div>

      @if (!q().trim()) {
        <app-recent-searches kind="show" (pick)="q.set($event)" />
      }

      <div class="tabs">
        @for (t of tabs; track t.key) {
          <button class="tab" [class.on]="filter() === t.key" (click)="filter.set(t.key)">
            {{ t.label }}
            @if (t.key === 'airing') {
              @if (upNext().length) { <span class="n">{{ upNext().length }}</span> }
            } @else if (t.key !== 'trending') {
              <span class="n">{{ counts()[t.key] }}</span>
            }
          </button>
        }
      </div>

      @if (filter() === 'airing') {
        @if (!tmdb.hasKey()) {
          <div class="empty">
            Airing dates need a free <a routerLink="/settings">TMDB key</a> — add one to see
            what's coming next.
          </div>
        } @else if (loadingUpNext()) {
          <div class="empty">Checking what's coming next…</div>
        } @else if (!upNext().length) {
          <div class="empty">
            Nothing scheduled for the shows you're watching. Check back after the next renewal.
          </div>
        } @else {
          <div class="upnext">
            @for (u of upNext(); track u.show.uuid) {
              <a class="un-card" [routerLink]="['/shows', u.show.uuid]" (click)="remember(u.show.uuid)">
                <app-poster
                  [title]="u.show.name"
                  [tvdbId]="u.show.tvdbId"
                  [cachedPoster]="u.show.cachedPoster"
                />
                <div class="un-meta">
                  <div class="un-name">{{ u.show.name }}</div>
                  <div class="un-ep">
                    S{{ u.ep.seasonNumber }}·E{{ u.ep.episodeNumber }} — {{ u.ep.name }}
                  </div>
                  <div class="un-air" [title]="u.ep.airDate">
                    {{ u.ep.airDate | timeLeft }}@if (u.airTime) {<span class="un-at"> · {{ u.airTime }}</span>}
                  </div>
                </div>
              </a>
            }
          </div>
        }
      } @else if (filter() === 'trending') {
        @if (!tmdb.hasKey()) {
          <div class="empty">
            Trending needs a free <a routerLink="/settings">TMDB key</a> — add one to see what
            people are watching.
          </div>
        } @else if (trendingError()) {
          <div class="empty">{{ trendingError() }}</div>
        } @else if (loadingTrending()) {
          <div class="empty">Loading trending series…</div>
        } @else if (!trending().length) {
          <div class="empty">TMDB returned nothing trending right now.</div>
        } @else {
          <div class="poster-grid">
            @for (t of trendingCards(); track t.tmdbId) {
              <div class="card" [attr.data-card]="t.key">
                <a class="pw" [routerLink]="t.link" (click)="remember(t.key)">
                  <div class="tp">
                    @if (t.poster; as src) {
                      <img [src]="src" [alt]="t.name" loading="lazy" decoding="async" />
                    } @else {
                      <span class="tph">{{ t.name | initials }}</span>
                    }
                  </div>
                  @if (t.inLibrary) {
                    <span class="in">✓ In library</span>
                  }
                </a>
                <a class="name" [routerLink]="t.link" (click)="remember(t.key)">{{ t.name }}</a>
                <div class="yr">{{ t.year || '—' }}</div>
              </div>
            }
          </div>
        }
      } @else if (filtered().length) {
        <div class="poster-grid">
          @for (s of visibleShows(); track s.uuid) {
            <a
              class="card"
              [attr.data-card]="s.uuid"
              [routerLink]="['/shows', s.uuid]"
              (click)="remember(s.uuid)"
            >
              <app-poster [title]="s.name" [tvdbId]="s.tvdbId" [cachedPoster]="s.cachedPoster" />
              <div class="meta">
                <div class="name">{{ s.name }}</div>
                <div class="row">
                  @if (s.state.favorite) { <span class="star">★</span> }
                  @if (s.state.status !== 'none') {
                    <span class="status s-{{ s.state.status }}">{{ s.statusLabel }}</span>
                  }
                </div>
              </div>
            </a>
          }
        </div>
        @if (filtered().length > visibleShows().length) {
          <button class="more" (click)="showMore()">
            Show more ({{ filtered().length - visibleShows().length }} remaining)
          </button>
        }
      } @else {
        <div class="empty">
          @if (q().trim()) {
            No shows in your library match — search TMDB below to add one.
          } @else {
            No shows in your library match.
          }
        </div>
      }

      @if (filter() !== 'trending' && filter() !== 'airing') {
        <app-title-search kind="show" [query]="q()" />
      }
    </div>
  `,
  styles: [
    `
      .search {
        background: var(--bg-elev);
        border: 1px solid var(--line);
        color: var(--text);
        padding: 10px 14px;
        border-radius: 10px;
        font-size: 14px;
        min-width: 240px;
        outline: none;
        transition: border-color var(--dur-2) var(--ease-out);
      }
      .search:focus {
        border-color: #3a3f4a;
      }
      /* On phones the search wraps under the title — let it fill the row. */
      @media (max-width: 720px) {
        .search {
          flex: 1 1 100%;
          width: 100%;
          min-width: 0;
        }
      }
      .tabs {
        display: flex;
        gap: 8px;
        margin-bottom: 24px;
        flex-wrap: wrap;
      }
      .tab {
        background: transparent;
        border: 1px solid var(--line);
        color: var(--text-dim);
        padding: 7px 14px;
        border-radius: 999px;
        font-size: 13px;
        font-weight: 600;
        transition:
          background var(--dur-2) var(--ease-out),
          border-color var(--dur-2) var(--ease-out),
          color var(--dur-2) var(--ease-out),
          transform var(--dur-1) var(--ease-out);
      }
      .tab:active {
        transform: scale(0.96);
      }
      .tab.on {
        background: var(--gold-soft);
        color: var(--gold);
        border-color: transparent;
      }
      .tab .n {
        opacity: 0.6;
        margin-left: 4px;
      }
      /* Airing soon — wide cards, since an episode title needs the room a
         poster tile doesn't give it. */
      .upnext {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
        gap: 14px;
      }
      .un-card {
        display: flex;
        gap: 12px;
        background: var(--bg-elev);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 10px;
        transition:
          border-color var(--dur-2) var(--ease-out),
          background var(--dur-2) var(--ease-out),
          transform var(--dur-2) var(--ease-out),
          box-shadow var(--dur-2) var(--ease-out);
      }
      .un-card:hover {
        border-color: #3a3f4a;
        background: var(--bg-elev-2);
        transform: translateY(-2px);
        box-shadow: var(--shadow);
      }
      .un-card:active {
        transform: translateY(0);
        box-shadow: none;
      }
      .un-card app-poster {
        width: 56px;
        flex-shrink: 0;
      }
      .un-meta {
        min-width: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
      }
      .un-name {
        font-size: 13.5px;
        font-weight: 700;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .un-ep {
        font-size: 12px;
        color: var(--text-dim);
        margin-top: 3px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .un-air {
        font-size: 11.5px;
        color: var(--gold);
        font-weight: 600;
        margin-top: 4px;
      }
      /* The clock time rides along with "Today" but isn't the headline — the
         same gold, one step back, so the day still reads first. */
      .un-at {
        opacity: 0.8;
        font-variant-numeric: tabular-nums;
      }
      /* Trending cards render TMDB posters directly, without app-poster. */
      .pw {
        position: relative;
        display: block;
      }
      .tp {
        aspect-ratio: 2 / 3;
        border-radius: 10px;
        overflow: hidden;
        background: var(--bg-elev-2);
        display: grid;
        place-items: center;
      }
      .tp img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .tph {
        color: var(--text-faint);
        font-weight: 800;
        font-size: 20px;
      }
      .in {
        position: absolute;
        top: 8px;
        left: 8px;
        background: rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(4px);
        color: var(--good);
        border-radius: 8px;
        padding: 3px 8px;
        font-size: 11px;
        font-weight: 700;
      }
      .yr {
        font-size: 12px;
        color: var(--text-faint);
        margin-top: 2px;
      }
      .empty a {
        color: var(--gold);
        text-decoration: underline;
      }
      .card {
        display: block;
      }
      .card:hover app-poster,
      .card:hover .tp {
        transform: translateY(-5px) scale(1.015);
      }
      .card:active app-poster,
      .card:active .tp {
        transform: translateY(-2px) scale(0.99);
      }
      .card app-poster {
        display: block;
      }
      /* .tp keeps its own display:grid — it centres the initials placeholder. */
      .card app-poster,
      .card .tp {
        transition: transform var(--dur-2) var(--ease-spring);
      }
      .card .name {
        transition: color var(--dur-2) var(--ease-out);
      }
      .card:hover .name {
        color: var(--gold);
      }
      .meta {
        margin-top: 10px;
      }
      .name {
        font-size: 13.5px;
        font-weight: 600;
        line-height: 1.3;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      /* Library cards get this spacing from .meta; trending names sit bare. */
      .card > .name {
        margin-top: 10px;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 5px;
      }
      .star {
        color: var(--gold);
        font-size: 12px;
      }
      .status {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-faint);
      }
      .status.s-watching {
        color: var(--accent);
      }
      .status.s-completed {
        color: var(--good);
      }
      .more {
        display: block;
        margin: 24px auto 0;
        padding: 10px 20px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: transparent;
        color: var(--text-dim);
        font-size: 13px;
        font-weight: 600;
        transition: all var(--dur-2) var(--ease-out);
      }
      .more:hover {
        background: var(--bg-elev-2);
        color: var(--text);
      }
    `,
  ],
  // All bindings read signals or computeds; the per-card work that used to run
  // inline in the template now lives in `filtered()`/`trendingCards()`.
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Shows {
  store = inject(LibraryStore);
  tmdb = inject(TmdbService);
  private tvmaze = inject(TvmazeService);
  private listState = inject(ListStateStore);
  private recentSearches = inject(RecentSearchesService);

  /**
   * Where the grid was when the user last opened a show from it, if that's
   * where they just came back from. Read once, at construction, so the signals
   * below can start from it rather than resetting and then being corrected.
   */
  private readonly restored = this.listState.take(STASH);

  q = signal(this.restored?.query ?? '');
  /** Opens on what's coming next — the reason to come here — unless the trip
   *  back from a show says otherwise. */
  filter = signal<Filter>((this.restored?.filter as Filter) ?? 'airing');

  /** Next episodes for the shows being watched, soonest first. */
  readonly upNext = signal<UpNext[]>([]);
  readonly loadingUpNext = signal(false);

  readonly trending = signal<TmdbSearchResult[]>([]);
  readonly loadingTrending = signal(false);
  readonly trendingError = signal<string | null>(null);
  /** Guards the one-shot fetch: opening the tab again reuses what we already have. */
  private trendingLoaded = false;

  readonly addedKey = addedKey;

  tabs: { key: Filter; label: string }[] = [
    { key: 'airing', label: 'Airing soon' },
    { key: 'all', label: 'All' },
    { key: 'watching', label: 'Watching' },
    { key: 'paused', label: 'Paused' },
    { key: 'completed', label: 'Completed' },
    { key: 'watchlist', label: 'Watchlist' },
    { key: 'favorites', label: 'Favorites' },
    { key: 'trending', label: 'Trending' },
  ];

  constructor() {
    // Coming back from a show page: put the card they opened back under their
    // eyes. The tab and search are already restored above.
    if (this.restored) scrollToCard(this.restored.anchor);

    // Nothing is fetched until the Trending tab is actually opened.
    effect(() => {
      if (this.filter() !== 'trending' || !this.tmdb.hasKey() || this.trendingLoaded) return;
      this.trendingLoaded = true;
      void this.loadTrending();
    });

    // Airing soon re-resolves whenever the watching list changes, not just once
    // — following a new show should put its next episode here. The show fetches
    // are cache-first, so a re-run after a tick is usually free.
    effect(() => {
      const shows = this.store.watchingShows();
      if (this.filter() !== 'airing' || !this.tmdb.hasKey()) return;
      untracked(() => this.loadUpNext(shows));
    });
  }

  /**
   * Identifies the newest resolve pass. The effect above re-fires on every
   * change to the watching list — including each episode ticked off — so several
   * passes can be in flight at once. Without this, a slow earlier pass could
   * land after a newer one and overwrite it with stale results.
   */
  private runId = 0;

  private async loadUpNext(shows: ShowView[]): Promise<void> {
    const run = ++this.runId;
    const queue = shows.filter((s) => s.tvdbId).slice(0, MAX_SHOWS_PROBED);
    this.loadingUpNext.set(true);

    const results = await mapPool(queue, TMDB_CONCURRENCY, (s) =>
      this.tmdb.showByTvdb(s.tvdbId!).catch(() => null),
    );
    if (run !== this.runId) return; // superseded by a newer pass

    // Air times already resolved, kept across the re-resolve. This pass re-fires
    // on every episode ticked off, and rebuilding the cards from scratch made
    // the time on today's cards blink out and back for each one.
    const known = new Map(
      this.upNext()
        .filter((c) => c.airTime)
        .map((c) => [cardKey(c), c.airTime!]),
    );
    const found: UpNext[] = [];
    results.forEach((info, i) => {
      // A title we can't resolve simply doesn't appear in "airing soon".
      if (info?.nextEpisode?.airDate) {
        const card: UpNext = { show: queue[i], ep: info.nextEpisode, airTime: null };
        // Only while it is still today — a time carried past midnight would sit
        // beside a card that no longer reads "Today".
        if (isToday(card.ep.airDate)) card.airTime = known.get(cardKey(card)) ?? null;
        found.push(card);
      }
    });
    found.sort((a, b) => (a.ep.airDate! < b.ep.airDate! ? -1 : 1));
    const cards = found.slice(0, MAX_UP_NEXT);
    // Show the cards on the day data alone, then fill in air times behind them:
    // the clock time is a detail on one or two cards, and nobody should wait on
    // a second service for the section to appear.
    this.upNext.set(cards);
    this.loadingUpNext.set(false);
    void this.loadAirTimes(cards, run);
  }

  /**
   * Resolve the clock time for the cards airing today, and republish them.
   *
   * Only today's episodes are asked about: for anything further out the day is
   * the answer, and every lookup is a request to a service we otherwise don't
   * need. Cards whose time we can't get are left exactly as they were.
   */
  private async loadAirTimes(cards: UpNext[], run: number): Promise<void> {
    const today = cards.filter((c) => !c.airTime && c.show.tvdbId && isToday(c.ep.airDate));
    if (!today.length) return;

    const stamps = await mapPool(today, TMDB_CONCURRENCY, (c) =>
      this.tvmaze.airstamp(c.show.tvdbId!, c.ep.seasonNumber, c.ep.episodeNumber),
    );
    if (run !== this.runId) return; // superseded by a newer pass

    const times = new Map<string, string>();
    stamps.forEach((stamp, i) => {
      const time = localTimeToday(stamp);
      if (time) times.set(cardKey(today[i]), time);
    });
    if (!times.size) return;
    this.upNext.update((list) =>
      list.map((c) => {
        const time = times.get(cardKey(c));
        return time ? { ...c, airTime: time } : c;
      }),
    );
  }

  private async loadTrending(): Promise<void> {
    this.loadingTrending.set(true);
    this.trendingError.set(null);
    try {
      this.trending.set(await this.tmdb.trendingShows());
    } catch {
      this.trendingLoaded = false; // let a re-open retry
      this.trendingError.set('Could not reach TMDB. Check your connection and try again.');
    } finally {
      this.loadingTrending.set(false);
    }
  }

  /**
   * The filtered grid, with each card's status label baked in.
   *
   * `label()` used to be called from the template, so it rebuilt a string per
   * card on every change detection cycle. Computing it here ties it to the data
   * it actually depends on.
   */
  filtered = computed<(ShowView & { statusLabel: string })[]>(() => {
    const q = this.q().trim().toLowerCase();
    const f = this.filter();
    // Watching and Completed read as a history: most recently seen first, by
    // last episode watch — falling back to the backup's show-level watch date,
    // then to the end of the list. Ties (and the other tabs) stay alphabetical.
    const lastWatched = this.store.lastWatchedByTvdb();
    const watchedAt = (s: ShowView): string =>
      (s.tvdbId ? lastWatched[s.tvdbId] : undefined) ?? s.showWatchedAt ?? '';
    const byRecency = f === 'watching' || f === 'completed';
    return this.store
      .shows()
      .filter((s) => {
        if (f === 'favorites' && !s.state.favorite) return false;
        if (f === 'watching' && s.state.status !== 'watching') return false;
        if (f === 'paused' && s.state.status !== 'paused') return false;
        if (f === 'completed' && s.state.status !== 'completed') return false;
        if (f === 'watchlist' && s.state.status !== 'watchlist') return false;
        if (q && !s.name.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort(
        (a, b) =>
          (byRecency ? watchedAt(b).localeCompare(watchedAt(a)) : 0) ||
          a.name.localeCompare(b.name),
      )
      .map((s) => ({ ...s, statusLabel: label(s.state.status) }));
  });

  /**
   * How many cards are actually in the DOM. A full catalog is hundreds of
   * posters, each with its own IntersectionObserver, and mounting them all on
   * first paint costs far more than anyone scrolls through — so the grid grows
   * on demand instead. Resets whenever the filter or query changes, so a new
   * search never opens already scrolled deep into the previous one — except on
   * the very first pass, where a restored grid has to re-reveal enough cards
   * for the one they opened to exist again.
   */
  private readonly limit = linkedSignal<string, number>({
    source: () => `${this.filter()}|${this.q()}`,
    computation: (_source, previous) => (previous ? PAGE : (this.restored?.limit ?? PAGE)),
  });
  readonly visibleShows = computed(() => this.filtered().slice(0, this.limit()));

  showMore(): void {
    this.limit.update((n) => n + PAGE);
  }

  /** Keep the query the user settled on, once they leave the search box. */
  rememberQuery(): void {
    void this.recentSearches.remember('show', this.q());
  }

  /** Stash the grid's state on the way into a show, for the trip back. */
  remember(anchor: string): void {
    this.listState.save(STASH, {
      filter: this.filter(),
      query: this.q(),
      limit: this.limit(),
      anchor,
    });
  }

  /**
   * All five tab counts in one pass. Each was previously its own template call
   * doing its own full scan of the library, five times per change detection.
   */
  readonly counts = computed(() => {
    const shows = this.store.shows();
    const n: Record<Filter, number> = {
      all: shows.length,
      airing: 0, // resolved from TMDB, not from the library — see upNext()
      watching: 0,
      paused: 0,
      completed: 0,
      watchlist: 0,
      favorites: 0,
      trending: 0, // not a slice of the library, so it has no count
    };
    for (const s of shows) {
      if (s.state.favorite) n.favorites++;
      if (s.state.status === 'watching') n.watching++;
      else if (s.state.status === 'paused') n.paused++;
      else if (s.state.status === 'completed') n.completed++;
      else if (s.state.status === 'watchlist') n.watchlist++;
    }
    return n;
  });

  /** Trending rows with their link, poster URL and library flag precomputed. */
  readonly trendingCards = computed(() =>
    this.trending().map((t) => {
      const key = addedKey('show', t.tmdbId);
      return {
        ...t,
        key,
        // Link straight at the entry that holds the show when this TMDB uuid was
        // deduped into a catalog one, so the card does not route through a detail
        // page that has to redirect itself.
        link: ['/shows', this.store.canonicalUuid(key) ?? key],
        poster: this.tmdb.poster(t.posterPath, 'w342'),
        inLibrary: this.store.isInLibrary('show', t.tmdbId),
      };
    }),
  );
}

/** Identifies a card by the episode it is about, not just by its show. */
function cardKey(c: UpNext): string {
  return `${c.show.uuid}:${c.ep.seasonNumber}:${c.ep.episodeNumber}`;
}

/** Whether a bare `YYYY-MM-DD` air date falls on today's local calendar day. */
export function isToday(airDate: string | null): boolean {
  if (!airDate) return false;
  const [y, m, d] = airDate.split('-').map(Number);
  if (!y || !m || !d) return false;
  const now = new Date();
  return now.getFullYear() === y && now.getMonth() + 1 === m && now.getDate() === d;
}

/** Reused across cards rather than rebuilt per format call. */
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/**
 * An ISO instant as a local clock time — but only if it lands on today. A
 * broadcast late in a distant timezone can be "today" there and tomorrow here;
 * a time beside a card that reads "Today" would then be wrong twice over, so
 * such a stamp is dropped and the card keeps the day it had.
 */
export function localTimeToday(airstamp: string | null): string | null {
  if (!airstamp) return null;
  const t = Date.parse(airstamp);
  if (!Number.isFinite(t)) return null;
  const when = new Date(t);
  const now = new Date();
  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();
  return sameDay ? TIME_FORMAT.format(when) : null;
}
