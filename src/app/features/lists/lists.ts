import { Component, inject } from '@angular/core';
import { LibraryStore } from '../../core/library.store';

@Component({
  selector: 'app-lists',
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Custom lists</h1>
          <div class="sub">{{ store.lists().length }} lists from your backup</div>
        </div>
      </div>

      @if (store.lists().length) {
        <div class="lists">
          @for (list of store.lists(); track list.id) {
            <section class="list">
              <header>
                <h2>{{ list.name }}</h2>
                <span class="chip">{{ list.items?.length || 0 }} items</span>
              </header>
              @if (list.description) { <p class="desc">{{ list.description }}</p> }
              <ul>
                @for (item of list.items; track item.uuid || item.title) {
                  <li>
                    <span class="dot"></span>
                    {{ item.title }}
                  </li>
                } @empty {
                  <li class="muted">Empty list</li>
                }
              </ul>
            </section>
          }
        </div>
      } @else {
        <div class="empty">No custom lists.</div>
      }
    </div>
  `,
  styles: [
    `
      .lists {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 18px;
      }
      .list {
        background: var(--bg-elev);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 20px 22px;
      }
      .list header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
      }
      .list h2 {
        font-size: 16px;
        font-weight: 700;
        margin: 0;
      }
      .desc {
        color: var(--text-dim);
        font-size: 13px;
        margin: 4px 0 12px;
      }
      ul {
        list-style: none;
        margin: 10px 0 0;
        padding: 0;
      }
      li {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 7px 0;
        font-size: 14px;
        border-top: 1px solid var(--line-soft);
      }
      li.muted {
        color: var(--text-faint);
      }
      .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--gold);
        flex-shrink: 0;
      }
    `,
  ],
})
export class Lists {
  store = inject(LibraryStore);
}
