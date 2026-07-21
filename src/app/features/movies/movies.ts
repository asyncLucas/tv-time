import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { addedKey } from '../../core/doc.service';
import { TrendingStore } from '../../core/trending.store';
import { TmdbService } from '../../core/tmdb.service';
import { Poster } from '../../shared/poster';
import { InitialsPipe } from '../../shared/initials';
import { TitleSearch } from '../../shared/title-search';
import { YearPipe } from '../../shared/year';
import type { MovieView } from '../../core/models';

type Filter = 'all' | 'watched' | 'watchlist' | 'favorites' | 'trending';

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
            @if (t.key !== 'trending') { <span class="n">{{ count(t.key) }}</span> }
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
            @for (t of trending(); track t.tmdbId) {
              <div class="card">
                <a class="pw" [routerLink]="['/movies', addedKey('movie', t.tmdbId)]">
                  <div class="tp">
                    @if (tmdb.poster(t.posterPath, 'w342'); as src) {
                      <img [src]="src" [alt]="t.name" loading="lazy" />
                    } @else {
                      <span class="tph">{{ t.name | initials }}</span>
                    }
                  </div>
                  @if (store.isInLibrary('movie', t.tmdbId)) {
                    <span class="in">✓ In library</span>
                  }
                </a>
                <a class="name" [routerLink]="['/movies', addedKey('movie', t.tmdbId)]">{{ t.name }}</a>
                <div class="yr">{{ t.year || '—' }}</div>
              </div>
            }
          </div>
        }
      } @else if (filtered().length) {
        <div class="poster-grid">
          @for (m of filtered(); track m.uuid) {
            <div class="card">
              <div class="pw">
                <a [routerLink]="['/movies', m.uuid]">
                  <app-poster
                    [title]="m.name"
                    [imdbId]="m.imdbId"
                    [cachedPoster]="m.cachedPoster ?? null"
                  />
                </a>
                <div class="actions">
                  <button
                    class="act"
                    [class.on]="m.state.watched"
                    title="Watched"
                    (click)="store.setMovieWatched(m.uuid, !m.state.watched)"
                  >
                    ✓
                  </button>
                  <button
                    class="act"
                    [class.on]="m.state.favorite"
                    title="Favorite"
                    (click)="store.toggleMovieFavorite(m.uuid)"
                  >
                    ★
                  </button>
                </div>
              </div>
              <a class="name" [routerLink]="['/movies', m.uuid]">{{ m.name }}</a>
              <div class="yr">{{ m.firstReleaseDate | year }}</div>
            </div>
          }
        </div>
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
      .pw:hover .actions {
        opacity: 1;
      }
      .actions {
        position: absolute;
        top: 8px;
        right: 8px;
        display: flex;
        gap: 6px;
        opacity: 0;
        transition: opacity 0.14s ease;
      }
      .act {
        width: 30px;
        height: 30px;
        border-radius: 8px;
        border: none;
        background: rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(4px);
        color: #fff;
        font-size: 13px;
      }
      .act.on {
        background: var(--gold);
        color: #1a1600;
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
    `,
  ],
})
export class Movies {
  store = inject(LibraryStore);
  tmdb = inject(TmdbService);
  q = signal('');
  filter = signal<Filter>('all');

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
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  count(f: Filter): number {
    const ms = this.store.movies();
    if (f === 'all') return ms.length;
    if (f === 'watched') return ms.filter((m) => m.state.watched).length;
    if (f === 'watchlist') return ms.filter((m) => m.state.watchlist && !m.state.watched).length;
    if (f === 'favorites') return ms.filter((m) => m.state.favorite).length;
    return 0; // trending isn't a slice of the library, so it has no count
  }
}
