import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';

/**
 * A row that opens on tap/click and fires a confirmable action when swiped
 * (touch) or when its button is clicked (desktop hover). Emits `open` for a tap
 * and `confirm` for a swipe-past-threshold or button click.
 *
 * The action is configurable because two very different gestures share this
 * shell: swipe *left* on a red backdrop to remove a list item, swipe *right* on
 * a green one to mark an episode watched. Direction is not cosmetic — a
 * destructive action and an additive one should not feel like the same motion.
 *
 * Tap vs. swipe is disambiguated by horizontal travel: a real drag suppresses
 * the synthesized click so a swipe never accidentally opens the item.
 *
 * The row is also a keyboard target (Enter/Space open it) — swiping is the
 * touch affordance, not the only way in — and `touchcancel` snaps it back so a
 * gesture the browser steals for scrolling can't strand the row half-open.
 */
@Component({
  selector: 'app-swipe-row',
  template: `
    <div class="swipe">
      <!--
        Purely the backdrop revealed behind a swipe. It is not focusable and has
        no handler of its own: the row is dragged over it, so a tap here can only
        land once the gesture already ended. The .swipe-btn button is the real
        control, and it is reachable by keyboard.
      -->
      <div class="swipe-action" [class.right]="direction() === 'right'" [class.good]="tone() === 'good'"
           aria-hidden="true">
        <span class="ic">{{ icon() }}</span> {{ label() }}
      </div>
      <div
        class="swipe-fg"
        role="button"
        tabindex="0"
        [class.snap]="snap()"
        [style.transform]="'translateX(' + dx() + 'px)'"
        (touchstart)="onStart($event)"
        (touchmove)="onMove($event)"
        (touchend)="onEnd()"
        (touchcancel)="onCancel()"
        (click)="onClick()"
        (keydown.enter)="open.emit()"
        (keydown.space)="open.emit()"
      >
        <ng-content />
        @if (!disabled()) {
          <button class="swipe-btn" [class.good]="tone() === 'good'" (click)="onAction($event)"
                  [attr.aria-label]="buttonLabel() || label()">{{ icon() }}</button>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .swipe {
        position: relative;
        overflow: hidden;
        border-radius: 10px;
      }
      .swipe-action {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        padding: 0 20px;
        background: var(--bad);
        color: #2a0a0a;
        font-size: 13px;
        font-weight: 800;
        cursor: pointer;
      }
      /* A right swipe drags the row rightward, so its backdrop is revealed on
         the left — the label has to follow the reveal, not sit off-screen. */
      .swipe-action.right {
        justify-content: flex-start;
      }
      .swipe-action.good {
        background: var(--good);
        color: #06281d;
      }
      .swipe-action .ic {
        font-size: 14px;
      }
      .swipe-fg {
        position: relative;
        background: var(--bg-elev);
        cursor: pointer;
        will-change: transform;
      }
      .swipe-fg.snap {
        transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .swipe-btn {
        position: absolute;
        top: 50%;
        right: 10px;
        transform: translateY(-50%);
        width: 30px;
        height: 30px;
        border-radius: 8px;
        border: none;
        background: transparent;
        color: var(--text-faint);
        font-size: 14px;
        opacity: 0;
        transition: all 0.14s ease;
      }
      /*
       * Keyboard focus must reveal the button too — it lives outside the
       * hover-only block, or tabbing to it would focus something invisible.
       */
      .swipe-btn:focus-visible {
        opacity: 1;
        outline: 2px solid var(--bad);
        outline-offset: 1px;
      }
      .swipe-btn.good:focus-visible {
        outline-color: var(--good);
      }
      .swipe-fg:focus-visible {
        outline: 2px solid var(--gold);
        outline-offset: -2px;
        border-radius: 10px;
      }
      /* desktop affordance: reveal the button on hover (pointer devices only) */
      @media (hover: hover) {
        .swipe-fg:hover .swipe-btn {
          opacity: 1;
        }
        .swipe-btn:hover {
          background: var(--bad);
          color: #2a0a0a;
        }
        .swipe-btn.good:hover {
          background: var(--good);
          color: #06281d;
        }
      }
    `,
  ],
  // State is all signals/inputs, and touchmove fires at frame rate — OnPush
  // keeps a drag from change-detecting every other row in the list.
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SwipeRow {
  /** Which way the row travels. 'left' reads as destructive, 'right' as additive. */
  readonly direction = input<'left' | 'right'>('left');
  readonly tone = input<'bad' | 'good'>('bad');
  readonly label = input('Remove');
  readonly icon = input('✕');
  /** Accessible name for the button; falls back to `label`. */
  readonly buttonLabel = input('');
  /** Inert: the row still opens on tap, but the action can't be triggered. */
  readonly disabled = input(false);

  readonly open = output<void>();
  readonly confirm = output<void>();

  readonly dx = signal(0);
  readonly snap = signal(false);

  private startX = 0;
  private startY = 0;
  private dragging = false;
  private moved = false;
  private readonly MAX = 96; // px of reveal
  private readonly THRESHOLD = 64; // swipe past this → confirm

  /** +1 when the row travels right, -1 when it travels left. */
  private readonly sign = computed(() => (this.direction() === 'right' ? 1 : -1));

  onStart(e: TouchEvent): void {
    if (this.disabled()) return;
    this.startX = e.touches[0].clientX;
    this.startY = e.touches[0].clientY;
    this.dragging = true;
    this.moved = false;
    this.snap.set(false);
  }

  onMove(e: TouchEvent): void {
    if (!this.dragging) return;
    const dx = e.touches[0].clientX - this.startX;
    const dy = e.touches[0].clientY - this.startY;
    // ignore mostly-vertical gestures (let the page scroll)
    if (!this.moved && Math.abs(dy) > Math.abs(dx)) {
      this.dragging = false;
      return;
    }
    if (Math.abs(dx) > 6) this.moved = true;
    // Travel only in the configured direction; the opposite way is pinned to 0.
    const travel = Math.min(this.MAX, Math.max(0, dx * this.sign()));
    this.dx.set(travel * this.sign());
  }

  onEnd(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.snap.set(true);
    if (this.dx() * this.sign() >= this.THRESHOLD) {
      this.dx.set(this.MAX * this.sign());
      this.confirm.emit();
    } else {
      this.dx.set(0);
    }
  }

  /**
   * The browser took the gesture over (usually to scroll). Snap back rather
   * than reusing onEnd — a cancelled swipe must never count as a confirmation.
   */
  onCancel(): void {
    this.dragging = false;
    this.snap.set(true);
    this.dx.set(0);
  }

  onClick(): void {
    if (this.moved) {
      this.moved = false; // swallow the tap that ended a swipe
      return;
    }
    this.open.emit();
  }

  onAction(e: Event): void {
    e.stopPropagation();
    if (this.disabled()) return;
    this.confirm.emit();
  }

  /** Snap the row back to rest — for a caller whose row survives the action. */
  reset(): void {
    this.snap.set(true);
    this.dx.set(0);
  }
}
