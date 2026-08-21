import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { LibraryStore } from '../core/library.store';

/**
 * The "save this somewhere" control on a detail page: one button that reads
 * back everywhere a title is saved, and opens a menu to change it.
 *
 * The films and shows pages ran identical copies of this — the same panel
 * markup, the same list plumbing, the same summarising label — differing only
 * in what "watchlist" means to each (a flag on a film, one of a show's
 * statuses). That difference stays with the pages: this renders the row and
 * reports the click, while the custom lists, which work the same for both, are
 * handled here.
 */
@Component({
  selector: 'app-save-menu',
  template: `
    @if (variant() === 'caret') {
      <button
        class="btn primary split-caret"
        type="button"
        [attr.aria-expanded]="open()"
        aria-label="Add to a list"
        (click)="open.set(!open())"
      >
        ▾
      </button>
    } @else {
      <button
        class="btn"
        type="button"
        [class.saved]="isSaved()"
        [attr.aria-expanded]="open()"
        (click)="open.set(!open())"
      >
        {{ savedLabel() }} ▾
      </button>
    }

    @if (open()) {
      <div class="lm-backdrop" (click)="open.set(false)"></div>
      <div class="lm-panel" role="menu">
        <!-- Absent (null) when the title is somewhere that contradicts being
             on the watchlist — watched, or a show already under way. -->
        @if (watchlist() !== null) {
          <button
            class="lm-row"
            type="button"
            role="menuitemcheckbox"
            [attr.aria-checked]="watchlist()"
            (click)="watchlistToggled.emit()"
          >
            <span class="lm-check">{{ watchlist() ? '✓' : '' }}</span>
            <span class="lm-name">Watchlist</span>
          </button>
          <div class="lm-sep"></div>
        }
        @if (listRows().length) {
          @for (l of listRows(); track l.id) {
            <button
              class="lm-row"
              type="button"
              role="menuitemcheckbox"
              [attr.aria-checked]="l.member"
              (click)="toggleList(l.id)"
            >
              <span class="lm-check">{{ l.member ? '✓' : '' }}</span>
              <span class="lm-name">{{ l.name }}</span>
            </button>
          }
          <div class="lm-sep"></div>
        } @else {
          <div class="lm-empty">No lists yet — make one:</div>
        }
        <form class="lm-new" (submit)="$event.preventDefault(); createListWithTitle()">
          <input
            class="lm-input"
            placeholder="New list…"
            [value]="newListName()"
            (input)="newListName.set($any($event.target).value)"
          />
          <button class="btn sm" type="submit" [disabled]="!newListName().trim()">Add</button>
        </form>
        @if (removeLabel(); as label) {
          <div class="lm-sep"></div>
          <button
            class="lm-row danger"
            type="button"
            role="menuitem"
            (click)="open.set(false); removeRequested.emit()"
          >
            <span class="lm-check">✕</span>
            <span class="lm-name">{{ label }}</span>
          </button>
        }
      </div>
    }
  `,
  // The panel positions itself against the .list-menu wrapper the page puts
  // around this control, so the host element must not become a box of its own.
  styles: `
    :host {
      display: contents;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SaveMenu {
  private readonly store = inject(LibraryStore);

  readonly uuid = input.required<string>();
  readonly title = input.required<string>();
  readonly entityType = input.required<'movie' | 'show'>();

  /** Watchlist state, or null to leave the row out entirely. */
  readonly watchlist = input<boolean | null>(null);
  /** Text for the danger row at the foot; null leaves it out. */
  readonly removeLabel = input<string | null>(null);
  /**
   * `caret` is the half of a split button that sits against "+ Add to library"
   * while a title is only being previewed; `button` is the standalone control.
   */
  readonly variant = input<'button' | 'caret'>('button');
  /**
   * Called before any write, so a page previewing a title it hasn't added can
   * bring it into the library first — a list item needs something real to
   * resolve to. The uuid is deterministic, so it is the same before and after.
   */
  readonly ensureSaveable = input<() => Promise<void>>(() => Promise.resolve());

  readonly watchlistToggled = output<void>();
  readonly removeRequested = output<void>();

  readonly open = signal(false);
  readonly newListName = signal('');

  /**
   * The custom lists, each flagged with whether this title is on it. Resolved
   * once here rather than calling `isInList` twice per row from the template.
   */
  readonly listRows = computed(() =>
    this.store.lists().map((l) => ({ ...l, member: this.store.isInList(l.id, this.uuid()) })),
  );

  /** How many custom lists this title currently belongs to. */
  private readonly listCount = computed(() => this.listRows().filter((l) => l.member).length);

  /** Whether the title is on the watchlist or in any list — deliberately saved. */
  readonly isSaved = computed(() => this.watchlist() === true || this.listCount() > 0);

  /**
   * One label summarising everywhere this title is saved, so the control reads
   * back its own state. Being in the library is not itself "saved" — once the
   * last membership is dropped the control invites saving again rather than
   * claiming a state the title no longer has.
   */
  readonly savedLabel = computed(() => {
    const lists = this.listCount();
    if (this.watchlist() && lists) return `✓ Watchlist +${lists}`;
    if (this.watchlist()) return '✓ Watchlist';
    if (lists) return `✓ In ${lists} list${lists > 1 ? 's' : ''}`;
    return '+ Save';
  });

  /** Toggle this title's membership in a custom list. */
  async toggleList(listId: string): Promise<void> {
    await this.ensureSaveable()();
    const uuid = this.uuid();
    if (this.store.isInList(listId, uuid)) {
      this.store.removeListItem(listId, { uuid });
      return;
    }
    this.store.addListItem(listId, { uuid, title: this.title(), entityType: this.entityType() });
  }

  /** Create a new list from the draft name and drop this title straight into it. */
  async createListWithTitle(): Promise<void> {
    const name = this.newListName().trim();
    if (!name) return;
    await this.ensureSaveable()();
    const id = this.store.createList(name);
    this.store.addListItem(id, {
      uuid: this.uuid(),
      title: this.title(),
      entityType: this.entityType(),
    });
    this.newListName.set('');
  }
}
