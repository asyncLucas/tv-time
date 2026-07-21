import { Component, output, signal } from '@angular/core';

/**
 * A row that opens on tap/click and can be removed by swiping left (touch) or
 * clicking the delete button (desktop hover). Emits `open` for a tap and
 * `remove` for a swipe-past-threshold or delete click.
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
      <div class="swipe-remove" (click)="remove.emit()">
        <span class="ic">✕</span> Remove
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
        <button class="swipe-del" (click)="onDelete($event)" aria-label="Remove from list">✕</button>
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
      .swipe-remove {
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
      .swipe-remove .ic {
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
      .swipe-del {
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
      /* desktop affordance: reveal delete on hover (pointer devices only) */
      @media (hover: hover) {
        .swipe-fg:hover .swipe-del {
          opacity: 1;
        }
        .swipe-del:hover {
          background: var(--bad);
          color: #2a0a0a;
        }
      }
    `,
  ],
})
export class SwipeRow {
  readonly open = output<void>();
  readonly remove = output<void>();

  readonly dx = signal(0);
  readonly snap = signal(false);

  private startX = 0;
  private startY = 0;
  private dragging = false;
  private moved = false;
  private readonly MAX = 96; // px of reveal
  private readonly THRESHOLD = 64; // swipe past this → remove

  onStart(e: TouchEvent): void {
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
    this.dx.set(Math.max(-this.MAX, Math.min(0, dx)));
  }

  onEnd(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.snap.set(true);
    if (this.dx() <= -this.THRESHOLD) {
      this.dx.set(-this.MAX);
      this.remove.emit();
    } else {
      this.dx.set(0);
    }
  }

  /**
   * The browser took the gesture over (usually to scroll). Snap back rather
   * than reusing onEnd — a cancelled swipe must never count as a removal.
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

  onDelete(e: Event): void {
    e.stopPropagation();
    this.remove.emit();
  }
}
