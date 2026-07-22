import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { addedKey } from '../../core/doc.service';
import { ListStateStore } from '../../core/list-state.service';
import { TmdbService, TmdbSearchResult } from '../../core/tmdb.service';
import { Poster } from '../../shared/poster';
import { InitialsPipe } from '../../shared/initials';
import { TitleSearch } from '../../shared/title-search';
import { scrollToCard } from '../../shared/scroll-to-card';
import type { ShowView, ShowStatus } from '../../core/models';

type Filter = 'all' | 'watching' | 'completed' | 'watchlist' | 'favorites' | 'trending';

/** Stash key for the tab/search/scroll position remembered across a detail visit. */
const STASH = 'shows';

/** How many cards the grid reveals at a time. */
const PAGE = 60;

function label(s: ShowStatus): string {
  return s === 'none' ? 'Following' : s[0].toUpperCase() + s.slice(1);
}

@Component({
  selector: 'app-shows',
  imports: [InitialsPipe, RouterLink, Poster, TitleSearch],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Shows</h1>
          @if (filter() === 'trending') {
            <div class="sub">Trending on TMDB this week</div>
          } @else {
            <div class="sub">{{ filtered().length }} of {{ store.shows().length }} series in the catalog</div>
          }
        </div>
        <input class="search" placeholder="Search shows…" [value]="q()" (input)="q.set($any($event.target).value)" />
      </div>

      <div class="tabs">
        @for (t of tabs; track t.key) {
          <button class="tab" [class.on]="filter() === t.key" (click)="filter.set(t.key)">
            {{ t.label }}
            @if (t.key !== 'trending') { <span class="n">{{ counts()[t.key] }}</span> }
          </button>
        }
      </div>

      @if (filter() === 'trending') {
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

      @if (filter() !== 'trending') {
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
      .card:hover app-poster {
        transform: translateY(-4px);
      }
      .card app-poster {
        display: block;
        transition: transform 0.16s ease;
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
        transition: all 0.14s ease;
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
  private listState = inject(ListStateStore);

  /**
   * Where the grid was when the user last opened a show from it, if that's
   * where they just came back from. Read once, at construction, so the signals
   * below can start from it rather than resetting and then being corrected.
   */
  private readonly restored = this.listState.take(STASH);

  q = signal(this.restored?.query ?? '');
  filter = signal<Filter>((this.restored?.filter as Filter) ?? 'all');

  readonly trending = signal<TmdbSearchResult[]>([]);
  readonly loadingTrending = signal(false);
  readonly trendingError = signal<string | null>(null);
  /** Guards the one-shot fetch: opening the tab again reuses what we already have. */
  private trendingLoaded = false;

  readonly addedKey = addedKey;

  tabs: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'watching', label: 'Watching' },
    { key: 'completed', label: 'Completed' },
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
    return this.store
      .shows()
      .filter((s) => {
        if (f === 'favorites' && !s.state.favorite) return false;
        if (f === 'watching' && s.state.status !== 'watching') return false;
        if (f === 'completed' && s.state.status !== 'completed') return false;
        if (q && !s.name.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name))
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
      watching: 0,
      completed: 0,
      watchlist: 0,
      favorites: 0,
      trending: 0, // not a slice of the library, so it has no count
    };
    for (const s of shows) {
      if (s.state.favorite) n.favorites++;
      if (s.state.status === 'watching') n.watching++;
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
        link: ['/shows', key],
        poster: this.tmdb.poster(t.posterPath, 'w342'),
        inLibrary: this.store.isInLibrary('show', t.tmdbId),
      };
    }),
  );
}
