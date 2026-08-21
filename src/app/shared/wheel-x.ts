import { Directive, ElementRef, NgZone, DestroyRef, inject } from '@angular/core';

/**
 * How much of the remaining distance to close each frame. 0.16 lands a normal
 * wheel tick in ~10 frames (about 160ms) — long enough to read as travel, short
 * enough that a fast flick still feels answered immediately.
 */
const CLOSE_PER_FRAME = 0.16;

/** Stop the loop once we're within half a pixel; anything less can't be seen. */
const SETTLED_PX = 0.5;

/**
 * Routes the mouse wheel into horizontal travel while the cursor is over a
 * horizontally scrollable rail: the rail consumes vertical wheel ticks until it
 * reaches its start/end, and only then does the page resume scrolling. Trackpad
 * horizontal pans (deltaX-dominant) are left to the browser, which already
 * scrolls the rail natively, and a rail with no overflow never intercepts.
 *
 * The travel is eased rather than applied outright. Assigning `scrollLeft`
 * per event teleports the rail one wheel notch at a time, which on a notched
 * mouse wheel is a visible stutter; instead each tick pushes a *target* and a
 * rAF loop decelerates into it, so a run of ticks reads as one continuous glide.
 * Deltas accumulate while the loop is mid-flight, so scrolling faster gets you
 * there faster instead of queueing.
 *
 * Any real scroll the directive didn't ask for — a touch drag, a trackpad pan,
 * a scrollbar grab — abandons the animation on the spot, so the rail never
 * fights the user's finger for control.
 */
@Directive({
  selector: '[appWheelX]',
  host: { '(wheel)': 'onWheel($event)' },
})
export class WheelX {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly zone = inject(NgZone);

  /** Where we're gliding to, or null when nothing is in flight. */
  private target: number | null = null;
  private frame = 0;
  /**
   * Our own sub-pixel position within the glide, and the value we last asked the
   * element for.
   *
   * The animation can't read `scrollLeft` back as its state: the element rounds
   * what it's given to whole device pixels, so once the remaining distance is
   * small enough that a frame's step rounds away to nothing, the read-back stops
   * changing — the glide freezes a few pixels short and the rAF loop runs
   * forever asking for a position it will never be told it reached. Tracking the
   * position here makes the loop authoritative and guarantees it terminates.
   */
  private pos = 0;
  private lastWritten = 0;

  constructor() {
    // Not an Angular-relevant event: a glide is 10 frames of scrollLeft writes
    // and none of them can change a binding.
    this.zone.runOutsideAngular(() => {
      this.el.addEventListener('scroll', this.onScroll, { passive: true });
    });
    inject(DestroyRef).onDestroy(() => {
      this.el.removeEventListener('scroll', this.onScroll);
      this.stop();
    });
  }

  onWheel(e: WheelEvent): void {
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const el = this.el;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 0) return;
    // Firefox reports line-based deltas (deltaMode 1); normalise to pixels.
    const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    // Measure the edges against where we're *heading*, not where we are, so a
    // second tick during a glide doesn't hand the page a scroll the rail still
    // has room for.
    const from = this.target ?? el.scrollLeft;
    if ((dy > 0 && from >= max - 1) || (dy < 0 && from <= 0)) return; // edge — page scrolls
    e.preventDefault();

    const next = Math.max(0, Math.min(max, from + dy));
    // Honour a reduced-motion preference: land immediately, no glide.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.stop();
      this.write(next);
      return;
    }
    this.target = next;
    if (!this.frame) {
      this.pos = el.scrollLeft; // fresh glide — start from wherever the rail is
      this.zone.runOutsideAngular(() => this.tick());
    }
  }

  /**
   * Rails declare `scroll-behavior: smooth` so that `scrollIntoView` and anchor
   * jumps animate. That would apply to our own per-frame writes too — the
   * browser easing into a position we're already easing into, which reads as
   * drag and never quite converges. Each frame is therefore written as an
   * explicit instant scroll, which overrides the declaration.
   */
  private write(left: number): void {
    this.lastWritten = left;
    this.el.scrollTo({ left, behavior: 'instant' });
  }

  /**
   * A scroll we didn't write means something else is driving — a finger, a
   * trackpad pan, a scrollbar drag — so give it the rail. The slack absorbs the
   * element rounding our sub-pixel writes to whole device pixels; a gesture
   * smaller than that isn't one worth yielding to.
   */
  private readonly onScroll = (): void => {
    if (this.target === null) return;
    if (Math.abs(this.el.scrollLeft - this.lastWritten) > 4) this.stop();
  };

  private tick(): void {
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const target = this.target;
      if (target === null) return;
      const gap = target - this.pos;
      if (Math.abs(gap) <= SETTLED_PX) {
        this.pos = target;
        this.write(target);
        this.target = null;
        return;
      }
      this.pos += gap * CLOSE_PER_FRAME;
      this.write(this.pos);
      this.tick();
    });
  }

  private stop(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.target = null;
  }
}
