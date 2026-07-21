import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { Poster } from '../../shared/poster';
import { SwipeRow } from '../../shared/swipe-row';

@Component({
  selector: 'app-lists',
  imports: [Poster, SwipeRow],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Custom lists</h1>
          <div class="sub">{{ store.lists().length }} lists · tap an item to open, swipe left to remove</div>
        </div>
      </div>

      @if (store.lists().length) {
        <div class="lists">
          @for (list of store.lists(); track list.id) {
            <section class="list">
              <header>
                <div class="l-head">
                  <h2>{{ list.name }}</h2>
                  @if (list.description) { <p class="desc">{{ list.description }}</p> }
                </div>
                <div class="l-actions">
                  <span class="chip">{{ list.items?.length || 0 }}</span>
                  <button class="del-list" (click)="confirmDelete(list)" title="Delete list">🗑</button>
                </div>
              </header>

              @if (list.items?.length) {
                <div class="items">
                  @for (item of list.items; track item.uuid || item.title) {
                    <app-swipe-row (open)="openItem(item)" (remove)="store.removeListItem(list.id, item)">
                      @if (store.resolveListItem(item); as r) {
                        <div class="item">
                          <app-poster
                            class="thumb"
                            [title]="r.name"
                            [tvdbId]="r.tvdbId"
                            [imdbId]="r.imdbId"
                            [cachedPoster]="r.cachedPoster"
                          />
                          <div class="it-main">
                            <div class="it-name">{{ r.name }}</div>
                            <div class="it-type">{{ r.type }}</div>
                          </div>
                          <span class="chev">›</span>
                        </div>
                      } @else {
                        <div class="item">
                          <div class="thumb ph"><span>{{ initials(item.title) }}</span></div>
                          <div class="it-main">
                            <div class="it-name">{{ item.title }}</div>
                            <div class="it-type muted">not in your catalog</div>
                          </div>
                        </div>
                      }
                    </app-swipe-row>
                  }
                </div>
              } @else {
                <div class="empty sm">This list is empty.</div>
              }
            </section>
          }
        </div>
      } @else {
        <div class="empty">
          No custom lists yet.<br />
          Import a TV Time backup (Settings → Import backup) to bring yours in.
        </div>
      }
    </div>
  `,
  styles: [
    `
      .lists {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
        gap: 18px;
        align-items: start;
      }
      .list {
        background: var(--bg-elev);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 18px 18px 12px;
      }
      header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
      }
      .l-head h2 {
        font-size: 16px;
        font-weight: 700;
        margin: 0;
      }
      .desc {
        color: var(--text-dim);
        font-size: 12.5px;
        margin: 3px 0 0;
      }
      .l-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }
      .del-list {
        border: none;
        background: transparent;
        color: var(--text-faint);
        font-size: 13px;
        width: 28px;
        height: 28px;
        border-radius: 7px;
      }
      .del-list:hover {
        background: rgba(248, 113, 113, 0.12);
      }
      .items {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 10px 8px 8px;
      }
      .thumb {
        width: 40px;
        flex-shrink: 0;
      }
      .thumb.ph {
        aspect-ratio: 2/3;
        border-radius: 6px;
        background: var(--bg-elev-2);
        display: grid;
        place-items: center;
        color: var(--text-faint);
        font-weight: 800;
        font-size: 13px;
      }
      .it-main {
        flex: 1;
        min-width: 0;
      }
      .it-name {
        font-size: 14px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .it-type {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--gold);
        margin-top: 2px;
      }
      .it-type.muted {
        color: var(--text-faint);
      }
      .chev {
        color: var(--text-faint);
        font-size: 20px;
        padding-right: 4px;
      }
      .empty.sm {
        padding: 16px 0;
        text-align: left;
      }
    `,
  ],
})
export class Lists {
  store = inject(LibraryStore);
  private router = inject(Router);

  openItem(item: { uuid?: string | null; title?: string | null }): void {
    const r = this.store.resolveListItem(item);
    if (r) this.router.navigate(['/', r.type === 'movie' ? 'movies' : 'shows', r.uuid]);
  }

  confirmDelete(list: { id: string; name: string }): void {
    if (confirm(`Delete the list "${list.name}"? This can't be undone.`)) this.store.deleteList(list.id);
  }

  initials(title?: string | null): string {
    return (title ?? '?')
      .replace(/^(the|a|an|o|as|os)\s+/i, '')
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  }
}
