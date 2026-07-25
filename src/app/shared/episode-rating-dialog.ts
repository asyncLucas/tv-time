import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

/** The 1-10 pips, hoisted so the template doesn't rebuild the array per cycle. */
const RATING_PIPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * "How was it?" — the modal that follows marking an episode watched.
 *
 * A single tap commits: picking a pip emits and closes, because this appears
 * unprompted right after a swipe and anything that needs a second confirming
 * tap would be friction on a screen the user didn't ask for. Skipping is always
 * one tap away too, and Escape/backdrop both count as skipping.
 *
 * Built on the native `<dialog>` (like ConfirmDialog) so focus trapping and
 * inert-ing the page behind come from the platform. The parent owns the pending
 * episode; this only reports what the user chose.
 */
@Component({
  selector: 'app-episode-rating-dialog',
  template: `
    <dialog #dlg (close)="onClose()" (click)="onBackdrop($event)">
      @if (still() && !stillBroken()) {
        <img class="still" [src]="still()" alt="" decoding="async" (error)="stillBroken.set(true)" />
      }
      <div class="body">
        <h3>How was it?</h3>
        <p class="ep">
          <span class="code">{{ code() }}</span>
          @if (episodeTitle()) { — {{ episodeTitle() }} }
        </p>
        @if (showName()) { <p class="show">{{ showName() }}</p> }

        <div class="pips" role="radiogroup" aria-label="Rate this episode out of 10">
          @for (n of PIPS; track n) {
            <button
              type="button"
              class="pip"
              role="radio"
              [class.on]="preview() >= n"
              [attr.aria-checked]="current() === n"
              [attr.aria-label]="'Rate ' + n + ' out of 10'"
              (mouseenter)="hover.set(n)"
              (mouseleave)="hover.set(null)"
              (focus)="hover.set(n)"
              (blur)="hover.set(null)"
              (click)="pick(n)"
            >
              ★
            </button>
          }
        </div>
        <div class="scale">
          <span>{{ preview() ? preview() + ' / 10' : 'Not rated' }}</span>
          <span class="note">{{ destination() }}</span>
        </div>

        <div class="actions">
          @if (current()) {
            <button class="btn ghost clear" (click)="clear()">Clear rating</button>
          }
          <button class="btn ghost" (click)="dismiss()">Skip</button>
        </div>
      </div>
    </dialog>
  `,
  styles: [
    `
      dialog {
        width: min(400px, calc(100vw - 32px));
        padding: 0;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--bg-elev);
        color: var(--text);
        box-shadow: var(--shadow-lg);
      }
      dialog::backdrop {
        background: rgba(6, 7, 9, 0.65);
        backdrop-filter: blur(2px);
      }
      .still {
        width: 100%;
        aspect-ratio: 16/9;
        object-fit: cover;
        background: var(--bg-elev-2);
      }
      .body {
        padding: 20px 22px 18px;
      }
      h3 {
        margin: 0;
        font-size: 16px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .ep {
        margin: 8px 0 0;
        font-size: 13.5px;
        color: var(--text-dim);
        line-height: 1.45;
      }
      .ep .code {
        color: var(--text);
        font-weight: 700;
      }
      .show {
        margin: 2px 0 0;
        font-size: 12px;
        color: var(--text-faint);
        font-weight: 600;
      }

      .pips {
        display: flex;
        gap: 2px;
        margin-top: 16px;
      }
      .pip {
        flex: 1;
        padding: 8px 0;
        border: none;
        background: transparent;
        border-radius: 6px;
        font-size: 20px;
        line-height: 1;
        color: var(--text-faint);
        transition:
          color 0.12s ease,
          transform 0.12s ease;
      }
      .pip.on {
        color: var(--gold);
      }
      .pip:hover {
        transform: translateY(-2px);
      }
      .pip:focus-visible {
        outline: 2px solid var(--gold);
        outline-offset: -2px;
      }

      .scale {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-top: 6px;
        font-size: 12px;
        font-weight: 700;
        color: var(--gold);
      }
      .scale .note {
        font-weight: 600;
        color: var(--text-faint);
        text-align: right;
      }

      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 18px;
      }
      .actions .clear {
        margin-right: auto;
        color: var(--bad);
        border-color: transparent;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EpisodeRatingDialog {
  readonly open = input(false);
  readonly showName = input('');
  /** e.g. "S2·E4" — the episode's short code. */
  readonly code = input('');
  readonly episodeTitle = input<string | null>(null);
  /** Episode still, if TMDB has one. Purely decorative. */
  readonly still = input<string | null>(null);
  /** The score already on record, so re-rating starts from it. */
  readonly current = input<number | null>(null);
  /** Where the rating will be filed, e.g. "Also sent to TMDB". */
  readonly destination = input('Also sent to TMDB');

  readonly rated = output<number>();
  readonly cleared = output<void>();
  readonly dismissed = output<void>();

  readonly PIPS = RATING_PIPS;
  /** The pip under the pointer/focus, previewed before it's committed. */
  readonly hover = signal<number | null>(null);
  /**
   * The still failed to load. It is decoration, so it is dropped entirely
   * rather than left as a broken-image block taking up half the dialog.
   */
  readonly stillBroken = signal(false);

  /** How many pips are lit: what you're pointing at, else what's on record. */
  readonly preview = computed(() => this.hover() ?? this.current() ?? 0);

  private dlg = viewChild<ElementRef<HTMLDialogElement>>('dlg');

  /**
   * Set when the user picked or cleared a rating, so the element's own `close`
   * event doesn't report a skip on top of the choice they already made.
   */
  private answered = false;

  constructor() {
    effect(() => {
      const el = this.dlg()?.nativeElement;
      if (!el) return;
      if (this.open() && !el.open) {
        this.answered = false;
        // A stale hover from the last episode would light pips this one hasn't
        // earned — the pointer never left the button, the dialog did.
        this.hover.set(null);
        this.stillBroken.set(false);
        el.showModal();
      } else if (!this.open() && el.open) {
        el.close();
      }
    });
  }

  pick(n: number): void {
    this.answered = true;
    this.dlg()?.nativeElement.close();
    this.rated.emit(n);
  }

  clear(): void {
    this.answered = true;
    this.dlg()?.nativeElement.close();
    this.cleared.emit();
  }

  dismiss(): void {
    this.dlg()?.nativeElement.close();
  }

  onClose(): void {
    if (!this.answered) this.dismissed.emit();
  }

  /** A click landing on the dialog element itself is a click on the backdrop. */
  onBackdrop(e: MouseEvent): void {
    if (e.target === this.dlg()?.nativeElement) this.dismiss();
  }
}
