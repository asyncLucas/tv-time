import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { Poster } from '../../shared/poster';
import type { ShowView, ShowStatus } from '../../core/models';

type Filter = 'all' | 'watching' | 'completed' | 'watchlist' | 'favorites';

@Component({
  selector: 'app-shows',
  imports: [RouterLink, Poster],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Shows</h1>
          <div class="sub">{{ filtered().length }} of {{ store.shows().length }} tracked series</div>
        </div>
        <input class="search" placeholder="Search shows…" [value]="q()" (input)="q.set($any($event.target).value)" />
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
          @for (s of filtered(); track s.uuid) {
            <a class="card" [routerLink]="['/shows', s.uuid]">
              <app-poster [title]="s.name" [tvdbId]="s.tvdbId" [cachedPoster]="s.cachedPoster" />
              <div class="meta">
                <div class="name">{{ s.name }}</div>
                <div class="row">
                  @if (s.state.favorite) { <span class="star">★</span> }
                  <span class="status s-{{ s.state.status }}">{{ label(s.state.status) }}</span>
                </div>
              </div>
            </a>
          }
        </div>
      } @else {
        <div class="empty">No shows match.</div>
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
    `,
  ],
})
export class Shows {
  store = inject(LibraryStore);
  q = signal('');
  filter = signal<Filter>('all');

  tabs: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'watching', label: 'Watching' },
    { key: 'completed', label: 'Completed' },
    { key: 'favorites', label: 'Favorites' },
  ];

  filtered = computed<ShowView[]>(() => {
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
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  count(f: Filter): number {
    const shows = this.store.shows();
    if (f === 'all') return shows.length;
    if (f === 'favorites') return shows.filter((s) => s.state.favorite).length;
    return shows.filter((s) => s.state.status === f).length;
  }
  label(s: ShowStatus): string {
    return s === 'none' ? 'Following' : s[0].toUpperCase() + s.slice(1);
  }
}
