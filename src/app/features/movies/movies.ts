import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { Poster } from '../../shared/poster';
import { TitleSearch } from '../../shared/title-search';
import type { MovieView } from '../../core/models';

type Filter = 'all' | 'watched' | 'watchlist' | 'favorites';

@Component({
  selector: 'app-movies',
  imports: [Poster, RouterLink, TitleSearch],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Movies</h1>
          <div class="sub">{{ filtered().length }} of {{ store.movies().length }} tracked films</div>
        </div>
        <input class="search" placeholder="Search movies…" [value]="q()" (input)="q.set($any($event.target).value)" />
      </div>

      <div class="tabs">
        @for (t of tabs; track t.key) {
          <button class="tab" [class.on]="filter() === t.key" (click)="filter.set(t.key)">
            {{ t.label }} <span class="n">{{ count(t.key) }}</span>
          </button>
        }
      </div>

      @if (filtered().length) {
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
              <div class="yr">{{ year(m) }}</div>
            </div>
          }
        </div>
      } @else {
        <div class="empty">
          No films in your library match
          @if (q().trim()) { — search TMDB below to add one. } @else { .}
        </div>
      }

      <app-title-search kind="movie" [query]="q()" />
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
  q = signal('');
  filter = signal<Filter>('all');

  tabs: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'watched', label: 'Watched' },
    { key: 'watchlist', label: 'Watchlist' },
    { key: 'favorites', label: 'Favorites' },
  ];

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
    return ms.filter((m) => m.state.favorite).length;
  }
  year(m: MovieView): string {
    return m.firstReleaseDate?.slice(0, 4) ?? '';
  }
}
