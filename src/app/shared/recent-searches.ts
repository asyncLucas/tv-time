import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { RecentSearchesService, SearchKind } from '../core/recent-searches.service';

/**
 * The queries this device searched last, as one-tap chips.
 *
 * Shown by the Shows/Movies pages while their search box is empty, so it fills
 * dead space rather than competing with an active search. Picking one refills
 * the box; the page takes it from there exactly as if it had been typed.
 */
@Component({
  selector: 'app-recent-searches',
  template: `
    @if (items().length) {
      <div class="rs">
        <span class="rs-lbl">Recent</span>
        @for (q of items(); track q) {
          <button class="rs-chip" type="button" (click)="pick.emit(q)">{{ q }}</button>
        }
        <button class="rs-clear" type="button" (click)="store.clear(kind())">Clear</button>
      </div>
    }
  `,
  styles: [
    `
      .rs {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 18px;
      }
      .rs-lbl {
        font-size: 11.5px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--text-faint);
      }
      .rs-chip {
        background: var(--bg-elev);
        border: 1px solid var(--line);
        color: var(--text-dim);
        padding: 5px 12px;
        border-radius: 999px;
        font-size: 12.5px;
        font-weight: 600;
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .rs-chip:hover {
        background: var(--gold-soft);
        color: var(--gold);
        border-color: transparent;
      }
      .rs-clear {
        background: transparent;
        border: none;
        color: var(--text-faint);
        font-size: 12px;
        font-weight: 600;
        text-decoration: underline;
      }
      .rs-clear:hover {
        color: var(--text-dim);
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecentSearches {
  store = inject(RecentSearchesService);

  readonly kind = input.required<SearchKind>();
  /** The query the user picked, for the page to put back in its search box. */
  readonly pick = output<string>();

  readonly items = computed(() => this.store.recent(this.kind()));
}
