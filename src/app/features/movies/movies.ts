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
import { TrendingStore } from '../../core/trending.store';
import { TmdbService } from '../../core/tmdb.service';
import { Poster } from '../../shared/poster';
import { InitialsPipe } from '../../shared/initials';
import { TitleSearch } from '../../shared/title-search';
import { YearPipe } from '../../shared/year';
import { scrollToCard } from '../../shared/scroll-to-card';
import type { MovieView } from '../../core/models';

type Filter = 'all' | 'watched' | 'watchlist' | 'favorites' | 'trending';

/** Stash key for the tab/search/scroll position remembered across a detail visit. */
const STASH = 'movies';

/** How many cards the grid reveals at a time. */
const PAGE = 60;

@Component({
  selector: 'app-movies',
  imports: [InitialsPipe, Poster, RouterLink, TitleSearch, YearPipe],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Movies</h1>
          @if (filter() === 'trending') {
            <div class="sub">Trending on TMDB this week</div>
          } @else {
            <div class="sub">{{ filtered().length }} of {{ store.movies().length }} tracked films</div>
          }
        </div>
        <input class="search" placeholder="Search movies…" [value]="q()" (input)="q.set($any($event.target).value)" />
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
          <div class="empty">Loading trending films…</div>
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
          @for (m of visibleMovies(); track m.uuid) {
            <div class="card" [attr.data-card]="m.uuid">
              <div class="pw">
                <a [routerLink]="['/movies', m.uuid]" (click)="remember(m.uuid)">
                  <app-poster
                    [title]="m.name"
                    [imdbId]="m.imdbId"
                    [cachedPoster]="m.cachedPoster ?? null"
                  />
                </a>
              </div>
              <a class="name" [routerLink]="['/movies', m.uuid]" (click)="remember(m.uuid)">{{
                m.name
              }}</a>
              <div class="yr">{{ m.firstReleaseDate | year }}</div>
            </div>
          }
        </div>
        @if (filtered().length > visibleMovies().length) {
          <button class="more" (click)="showMore()">
            Show more ({{ filtered().length - visibleMovies().length }} remaining)
          </button>
        }
      } @else {
        <div class="empty">
          @if (q().trim()) {
            No films in your library match — search TMDB below to add one.
          } @else {
            No films in your library match.
          }
        </div>
      }

      @if (filter() !== 'trending') {
        <app-title-search kind="movie" [query]="q()" />
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
      .empty a {
        color: var(--gold);
        text-decoration: underline;
      }
      .name {
        font-size: 13.5px;
        font-weight: 600;
        margin-top: 10px;
        line-height: 1.3;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .yr {
        font-size: 12px;
        color: var(--text-faint);
        margin-top: 2px;
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
export class Movies {
  store = inject(LibraryStore);
  tmdb = inject(TmdbService);
  private listState = inject(ListStateStore);

  /**
   * Where the grid was when the user last opened a film from it, if that's
   * where they just came back from. Read once, at construction, so the signals
   * below can start from it rather than resetting and then being corrected.
   */
  private readonly restored = this.listState.take(STASH);

  q = signal(this.restored?.query ?? '');
  filter = signal<Filter>((this.restored?.filter as Filter) ?? 'all');

  /** This week's trending films — fetched once, app-wide (see TrendingStore). */
  private readonly feed = inject(TrendingStore).movies;
  readonly trending = this.feed.results;
  readonly loadingTrending = this.feed.loading;
  readonly trendingError = this.feed.error;

  readonly addedKey = addedKey;

  tabs: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'watched', label: 'Watched' },
    { key: 'watchlist', label: 'Watchlist' },
    { key: 'favorites', label: 'Favorites' },
    { key: 'trending', label: 'Trending' },
  ];

  constructor() {
    // Coming back from a movie page: put the card they opened back under their
    // eyes. The tab and search are already restored above.
    if (this.restored) scrollToCard(this.restored.anchor);

    // Nothing is fetched until the Trending tab is actually opened. The store
    // ignores a repeat call, so this needs no guard of its own.
    effect(() => {
      if (this.filter() === 'trending') this.feed.load();
    });
  }

  filtered = computed<MovieView[]>(() => {
    const q = this.q().trim().toLowerCase();
    const f = this.filter();
    return this.store
      .movies()
      .filter((m) => {
        if (f === 'watched' && !m.state.watched) return false;
        if (f === 'watchlist' && (!m.state.watchlist || m.state.watched)) return false;
        if (f === 'favorites' && !m.state.favorite) return false;
        if (q && !m.name.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) =>
        // The Watched tab reads as a history: most recently seen first, films
        // with no recorded date at the end. Everything else stays alphabetical.
        f === 'watched'
          ? (b.state.watchedAt ?? '').localeCompare(a.state.watchedAt ?? '')
          : a.name.localeCompare(b.name),
      );
  });

  /**
   * How many cards are actually in the DOM. The full catalog is ~565 posters,
   * each with its own IntersectionObserver — far more than anyone scrolls — so
   * the grid grows on demand. Resets whenever the filter or query changes —
   * except on the very first pass, where a restored grid has to re-reveal
   * enough cards for the one they opened to exist again.
   */
  private readonly limit = linkedSignal<string, number>({
    source: () => `${this.filter()}|${this.q()}`,
    computation: (_source, previous) => (previous ? PAGE : (this.restored?.limit ?? PAGE)),
  });
  readonly visibleMovies = computed(() => this.filtered().slice(0, this.limit()));

  showMore(): void {
    this.limit.update((n) => n + PAGE);
  }

  /** Stash the grid's state on the way into a film, for the trip back. */
  remember(anchor: string): void {
    this.listState.save(STASH, {
      filter: this.filter(),
      query: this.q(),
      limit: this.limit(),
      anchor,
    });
  }

  /**
   * All four tab counts in one pass. Each was previously its own template call
   * doing its own full scan of the library, four times per change detection.
   */
  readonly counts = computed(() => {
    const ms = this.store.movies();
    const n: Record<Filter, number> = {
      all: ms.length,
      watched: 0,
      watchlist: 0,
      favorites: 0,
      trending: 0, // not a slice of the library, so it has no count
    };
    for (const m of ms) {
      if (m.state.watched) n.watched++;
      else if (m.state.watchlist) n.watchlist++;
      if (m.state.favorite) n.favorites++;
    }
    return n;
  });

  /** Trending rows with their link, poster URL and library flag precomputed. */
  readonly trendingCards = computed(() =>
    this.trending().map((t) => {
      const key = addedKey('movie', t.tmdbId);
      return {
        ...t,
        key,
        link: ['/movies', key],
        poster: this.tmdb.poster(t.posterPath, 'w342'),
        inLibrary: this.store.isInLibrary('movie', t.tmdbId),
      };
    }),
  );
}
