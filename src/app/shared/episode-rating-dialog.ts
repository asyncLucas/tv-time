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

/** Reused across dialogs rather than rebuilt per format call. */
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/**
 * A bare `YYYY-MM-DD` air date as a short local date.
 *
 * Built as a local date rather than parsed: `Date.parse('2017-08-06')` is UTC
 * midnight, which formats as the 5th anywhere west of Greenwich — an episode
 * would appear to have aired a day early for half the world. The shape is
 * checked rather than left to `Date.parse`, which accepts almost anything and
 * would quietly turn a string it doesn't understand into the 1st of January.
 */
function formatAirDate(airDate: string | null): string | null {
  if (!airDate) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(airDate);
  if (!parts) return airDate; // unexpected format — show it verbatim
  const [, year, month, day] = parts;
  return DAY_FORMAT.format(new Date(+year, +month - 1, +day));
}

/** The 1-10 pips, hoisted so the template doesn't rebuild the array per cycle. */
const RATING_PIPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * One episode, in a modal: its still, synopsis and facts, whether you have
 * watched it, and what you made of it.
 *
 * It is reached two ways — opened on an episode you tapped to read about, and
 * raised automatically after you tick one off ("How was it?"). Both want the
 * same things on screen, so they are one dialog rather than two: the watch
 * toggle is left out (`watched` null) on the path that just set it.
 *
 * Picking a number commits it immediately — the score is written and pushed on
 * the tap — but the dialog stays up so the choice is visible and can be changed
 * or cleared before the user dismisses it themselves. Skipping is always one tap
 * away, and Escape/backdrop close it just like Done.
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
        <h3>{{ episodeTitle() || code() }}</h3>
        <p class="ep">
          <span class="code">{{ code() }}</span>
          @for (f of facts(); track f) { <span class="fact">{{ f }}</span> }
        </p>
        @if (showName()) { <p class="show">{{ showName() }}</p> }

        @if (overview()) {
          <p class="synopsis">{{ overview() }}</p>
        }

        @if (watched() !== null) {
          <button
            class="seen"
            type="button"
            [class.on]="watched()"
            [attr.aria-pressed]="watched()"
            (click)="watchedToggled.emit()"
          >
            <span class="tick">{{ watched() ? '✓' : '' }}</span>
            {{ watched() ? 'Watched' : 'Mark watched' }}
          </button>
        }

        <h4 class="rate-label">How was it?</h4>
        <div class="pips" role="radiogroup" aria-label="Rate this episode out of 10">
          @for (n of PIPS; track n) {
            <button
              type="button"
              class="pip"
              role="radio"
              [class.on]="preview() === n"
              [class.under]="picked() !== null && n < picked()!"
              [attr.aria-checked]="picked() === n"
              [attr.aria-label]="'Rate ' + n + ' out of 10'"
              (mouseenter)="hover.set(n)"
              (mouseleave)="hover.set(null)"
              (focus)="hover.set(n)"
              (blur)="hover.set(null)"
              (click)="pick(n)"
            >
              {{ n }}
            </button>
          }
        </div>
        <div class="scale">
          <span>{{ preview() ? preview() + ' / 10' : 'Not rated' }}</span>
          <span class="note">{{ destination() }}</span>
        </div>

        <div class="actions">
          @if (picked() !== null) {
            <button class="btn ghost clear" (click)="clear()">Clear rating</button>
            <button class="btn primary" (click)="dismiss()">Done</button>
          } @else {
            <button class="btn ghost" (click)="dismiss()">Skip</button>
          }
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
      /* Air date, runtime and TMDB's score, separated the way the detail pages
         separate their facts. */
      .ep .fact::before {
        content: '·';
        margin: 0 6px;
        opacity: 0.5;
      }
      .synopsis {
        margin: 12px 0 0;
        font-size: 13px;
        line-height: 1.55;
        color: var(--text-dim);
        /* Long synopses would push the pips off a short screen; the dialog is
           for deciding and rating, not for reading an essay. */
        max-height: 7.75em;
        overflow-y: auto;
      }
      /* Watch toggle: the same green the episode rows use for a ticked box. */
      .seen {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        margin-top: 14px;
        padding: 7px 13px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: transparent;
        color: var(--text-dim);
        font-size: 12.5px;
        font-weight: 700;
        transition:
          background var(--dur-2) var(--ease-out),
          border-color var(--dur-2) var(--ease-out),
          color var(--dur-2) var(--ease-out);
      }
      .seen .tick {
        width: 9px;
        font-weight: 800;
      }
      .seen.on {
        background: rgba(46, 196, 141, 0.14);
        border-color: transparent;
        color: var(--good);
      }
      .seen:hover {
        border-color: #3a3f4a;
      }
      .rate-label {
        margin: 18px 0 0;
        font-size: 12px;
        font-weight: 700;
        color: var(--text-faint);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .pips {
        display: flex;
        gap: 4px;
        margin-top: 8px;
      }
      .pip {
        flex: 1;
        min-width: 0;
        padding: 9px 0;
        border: 1px solid var(--line);
        background: transparent;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        line-height: 1;
        color: var(--text-faint);
        transition:
          color 0.12s ease,
          background 0.12s ease,
          border-color 0.12s ease,
          transform 0.12s ease;
      }
      /* Everything below the score is tinted, so the row still reads as a scale
         even though only the chosen number is filled. */
      .pip.under {
        color: var(--gold);
        border-color: transparent;
        background: var(--gold-soft);
      }
      .pip.on {
        color: #1a1600;
        background: var(--gold);
        border-color: var(--gold);
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
  /** TMDB's synopsis for the episode, when it has one. */
  readonly overview = input<string | null>(null);
  /** `YYYY-MM-DD`, as TMDB gives it. */
  readonly airDate = input<string | null>(null);
  /** Episode length in minutes. */
  readonly runtime = input<number | null>(null);
  /** TMDB's community score out of 10 — not the user's own. */
  readonly communityScore = input<number | null>(null);
  /**
   * Whether the episode is watched, or null to leave the toggle out — the
   * dialog that *follows* ticking an episode has nothing to offer here.
   */
  readonly watched = input<boolean | null>(null);
  /** The score already on record, so re-rating starts from it. */
  readonly current = input<number | null>(null);
  /** Where the rating will be filed, e.g. "Also sent to TMDB". */
  readonly destination = input('Also sent to TMDB');

  readonly watchedToggled = output<void>();
  readonly rated = output<number>();
  readonly cleared = output<void>();
  readonly dismissed = output<void>();

  readonly PIPS = RATING_PIPS;

  /** Air date, runtime and community score — whichever of them TMDB knows. */
  readonly facts = computed(() => {
    const out: string[] = [];
    const date = formatAirDate(this.airDate());
    if (date) out.push(date);
    const mins = this.runtime();
    if (mins) out.push(`${mins} min`);
    const score = this.communityScore();
    if (score) out.push(`★ ${score.toFixed(1)}`);
    return out;
  });
  /** The pip under the pointer/focus, previewed before it's committed. */
  readonly hover = signal<number | null>(null);
  /**
   * The still failed to load. It is decoration, so it is dropped entirely
   * rather than left as a broken-image block taking up half the dialog.
   */
  readonly stillBroken = signal(false);

  /**
   * What the user chose while this dialog has been up, if anything. `undefined`
   * means untouched, so the score on record still stands; `null` means they
   * cleared it — which `current()` can't report, since the parent keeps feeding
   * the value it had when the dialog opened.
   */
  private readonly chosen = signal<number | null | undefined>(undefined);

  /** The score currently on the episode: this session's choice, else the record. */
  readonly picked = computed(() => {
    const c = this.chosen();
    return c === undefined ? this.current() : c;
  });

  /** The number shown as chosen: what you're pointing at, else what's picked. */
  readonly preview = computed(() => this.hover() ?? this.picked() ?? 0);

  private dlg = viewChild<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    effect(() => {
      const el = this.dlg()?.nativeElement;
      if (!el) return;
      if (this.open() && !el.open) {
        // A stale hover from the last episode would light a number this one
        // hasn't earned — the pointer never left the button, the dialog did.
        this.hover.set(null);
        this.chosen.set(undefined);
        this.stillBroken.set(false);
        el.showModal();
      } else if (!this.open() && el.open) {
        el.close();
      }
    });
  }

  /**
   * Commit the score without closing: the write happens now, but leaving the
   * dialog up lets the user see what they gave, change it, or clear it before
   * dismissing on their own terms.
   */
  pick(n: number): void {
    if (this.picked() === n) return;
    this.chosen.set(n);
    this.rated.emit(n);
  }

  clear(): void {
    this.chosen.set(null);
    this.hover.set(null);
    this.cleared.emit();
  }

  dismiss(): void {
    this.dlg()?.nativeElement.close();
  }

  onClose(): void {
    this.dismissed.emit();
  }

  /** A click landing on the dialog element itself is a click on the backdrop. */
  onBackdrop(e: MouseEvent): void {
    if (e.target === this.dlg()?.nativeElement) this.dismiss();
  }
}
