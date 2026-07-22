import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { Poster } from '../../shared/poster';
import { SwipeRow } from '../../shared/swipe-row';
import { InitialsPipe } from '../../shared/initials';

/** How many rows a list card shows before it collapses behind "Show all". */
const PREVIEW = 6;

interface ListItem {
  uuid?: string | null;
  title?: string | null;
}

@Component({
  selector: 'app-lists',
  imports: [Poster, SwipeRow, InitialsPipe],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Custom lists</h1>
          <div class="sub">
            @if (cards().length) {
              {{ cards().length }} {{ cards().length === 1 ? 'list' : 'lists' }} ·
              {{ totalItems() }} {{ totalItems() === 1 ? 'item' : 'items' }}
            } @else {
              Group titles however you like
            }
          </div>
        </div>
        <button class="btn primary" (click)="newList()">+ New list</button>
      </div>

      @if (cards().length) {
        <div class="lists">
          @for (list of cards(); track list.id) {
            <section class="list">
              <header>
                <div class="l-head">
                  <h2>{{ list.name }}</h2>
                  <span class="count">{{ list.total }}</span>
                </div>
                <div class="l-actions">
                  <button class="icon" (click)="rename(list)" title="Rename list" aria-label="Rename list">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" />
                      <path d="M14.5 6.5 17.5 9.5" />
                    </svg>
                  </button>
                  <button
                    class="icon danger"
                    (click)="confirmDelete(list)"
                    title="Delete list"
                    aria-label="Delete list"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
                    </svg>
                  </button>
                </div>
              </header>

              @if (list.description) {
                <p class="desc">{{ list.description }}</p>
              }

              @if (list.total) {
                <div class="items">
                  @for (row of list.rows; track row.key) {
                    <app-swipe-row
                      buttonLabel="Remove from list"
                      (open)="openItem(row.item)"
                      (confirm)="store.removeListItem(list.id, row.item)"
                    >
                      @if (row.resolved; as r) {
                        <div class="item">
                          <app-poster
                            class="thumb"
                            [title]="r.name"
                            [tvdbId]="r.tvdbId"
                            [imdbId]="r.imdbId"
                            [cachedPoster]="r.cachedPoster"
                            [eager]="true"
                          />
                          <div class="it-main">
                            <div class="it-name">{{ r.name }}</div>
                            <div class="it-type">{{ r.type === 'movie' ? 'Movie' : 'Show' }}</div>
                          </div>
                          <span class="chev" aria-hidden="true">›</span>
                        </div>
                      } @else {
                        <div class="item unmatched">
                          <div class="thumb ph"><span>{{ row.item.title | initials }}</span></div>
                          <div class="it-main">
                            <div class="it-name">{{ row.item.title }}</div>
                            <div class="it-type muted">Not in your library</div>
                          </div>
                        </div>
                      }
                    </app-swipe-row>
                  }
                </div>

                @if (list.total > PREVIEW) {
                  <button class="more" (click)="toggle(list.id)">
                    {{ list.isExpanded ? 'Show less' : 'Show all ' + list.total }}
                  </button>
                }
              } @else {
                <p class="empty sm">Nothing here yet — add titles from a show or movie page.</p>
              }
            </section>
          }
        </div>
      } @else {
        <div class="empty">
          <p>No custom lists yet.</p>
          <p class="hint">
            Create one above, or import a TV Time backup (Settings → Import backup) to bring yours in.
          </p>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .lists {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr));
        gap: 16px;
        align-items: start;
      }
      .list {
        background: var(--bg-elev);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 16px 14px 14px;
        transition: border-color 0.15s ease;
      }
      .list:hover {
        border-color: #333844;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 0 4px;
        margin-bottom: 12px;
      }
      .l-head {
        display: flex;
        align-items: baseline;
        gap: 9px;
        min-width: 0;
      }
      .l-head h2 {
        font-size: 15px;
        font-weight: 700;
        letter-spacing: -0.01em;
        margin: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .count {
        flex-shrink: 0;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-faint);
        font-variant-numeric: tabular-nums;
      }
      .desc {
        color: var(--text-dim);
        font-size: 12.5px;
        margin: -6px 4px 12px;
      }

      /* Actions stay out of the way until the card is hovered, but keyboard
         focus must still be able to reach them. */
      .l-actions {
        display: flex;
        align-items: center;
        gap: 2px;
        flex-shrink: 0;
      }
      .icon {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 7px;
        background: transparent;
        color: var(--text-faint);
        opacity: 0;
        transition: all 0.14s ease;
      }
      .icon svg {
        width: 15px;
        height: 15px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .list:hover .icon,
      .icon:focus-visible {
        opacity: 1;
      }
      .icon:hover {
        background: var(--bg-elev-2);
        color: var(--text);
      }
      .icon.danger:hover {
        background: rgba(248, 113, 113, 0.14);
        color: var(--bad);
      }
      @media (hover: none) {
        .icon {
          opacity: 1;
        }
      }

      .items {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .item {
        display: flex;
        align-items: center;
        gap: 12px;
        /* right lane reserved for the chevron / swipe delete so neither ever
           collides with a long title */
        padding: 7px 40px 7px 8px;
        border-radius: 10px;
        transition: background 0.14s ease;
      }
      app-swipe-row:hover .item {
        background: var(--bg-elev-2);
      }
      .thumb {
        width: 34px;
        flex-shrink: 0;
      }
      .thumb.ph {
        aspect-ratio: 2/3;
        border-radius: 6px;
        background: var(--bg-elev-2);
        border: 1px dashed var(--line);
        display: grid;
        place-items: center;
        color: var(--text-faint);
        font-weight: 700;
        font-size: 11px;
      }
      .item.unmatched .it-name {
        color: var(--text-dim);
      }
      .it-main {
        flex: 1;
        min-width: 0;
      }
      .it-name {
        font-size: 13.5px;
        font-weight: 600;
        line-height: 1.3;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .it-type {
        font-size: 11px;
        font-weight: 500;
        color: var(--text-faint);
        margin-top: 1px;
      }
      .chev {
        position: absolute;
        right: 14px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--text-faint);
        font-size: 18px;
        line-height: 1;
        transition: all 0.14s ease;
      }
      /* On hover the swipe row reveals its own ✕ in this lane — retire the
         chevron so the two never stack on top of each other. */
      app-swipe-row:hover .chev {
        opacity: 0;
      }

      .more {
        width: 100%;
        margin-top: 8px;
        padding: 8px;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: var(--text-dim);
        font-size: 12.5px;
        font-weight: 600;
        transition: all 0.14s ease;
      }
      .more:hover {
        background: var(--bg-elev-2);
        color: var(--text);
      }

      .empty.sm {
        padding: 10px 4px 6px;
        margin: 0;
        text-align: left;
        font-size: 13px;
      }
      .empty p {
        margin: 0;
      }
      .empty .hint {
        margin-top: 6px;
        font-size: 13px;
      }
    `,
  ],
  // Every binding reads `cards()` or a signal, and the expensive per-row
  // resolution now happens there rather than in the template.
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Lists {
  store = inject(LibraryStore);
  private router = inject(Router);

  readonly PREVIEW = PREVIEW;
  readonly expanded = signal(new Set<string>());

  readonly totalItems = computed(() =>
    this.store.lists().reduce((n, l) => n + (l.items?.length || 0), 0),
  );

  /**
   * Everything the template renders, resolved once per state change.
   *
   * The rows used to call `store.resolveListItem(item)` inline, which meant a
   * library lookup per row on every change detection cycle. Resolving here ties
   * the work to the signals it actually depends on — the lists themselves and
   * which cards are expanded — so scrolling or typing elsewhere costs nothing.
   */
  readonly cards = computed(() =>
    this.store.lists().map((list) => {
      const items: ListItem[] = list.items ?? [];
      const isExpanded = this.expanded().has(list.id);
      const shown = isExpanded ? items : items.slice(0, PREVIEW);
      return {
        ...list,
        total: items.length,
        isExpanded,
        rows: shown.map((item, i) => ({
          // Index disambiguates rows whose uuid and title are both absent —
          // those would otherwise all track as `undefined` and collide.
          key: item.uuid || item.title || `#${i}`,
          item,
          resolved: this.store.resolveListItem(item),
        })),
      };
    }),
  );

  toggle(id: string): void {
    const next = new Set(this.expanded());
    next.has(id) ? next.delete(id) : next.add(id);
    this.expanded.set(next);
  }

  openItem(item: { uuid?: string | null; title?: string | null }): void {
    const r = this.store.resolveListItem(item);
    if (r) this.router.navigate(['/', r.type === 'movie' ? 'movies' : 'shows', r.uuid]);
  }

  newList(): void {
    const name = prompt('Name your list')?.trim();
    if (name) this.store.createList(name);
  }

  rename(list: { id: string; name: string }): void {
    const name = prompt('Rename list', list.name)?.trim();
    if (name && name !== list.name) this.store.renameList(list.id, name);
  }

  confirmDelete(list: { id: string; name: string }): void {
    if (confirm(`Delete the list "${list.name}"? This can't be undone.`)) this.store.deleteList(list.id);
  }
}
