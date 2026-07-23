import { Directive, ElementRef, inject } from '@angular/core';

/**
 * Routes the mouse wheel into horizontal travel while the cursor is over a
 * horizontally scrollable rail: the rail consumes vertical wheel ticks until it
 * reaches its start/end, and only then does the page resume scrolling. Trackpad
 * horizontal pans (deltaX-dominant) are left to the browser, which already
 * scrolls the rail natively, and a rail with no overflow never intercepts.
 */
@Directive({
  selector: '[appWheelX]',
  host: { '(wheel)': 'onWheel($event)' },
})
export class WheelX {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  onWheel(e: WheelEvent): void {
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const el = this.el;
    if (el.scrollWidth <= el.clientWidth) return;
    // Firefox reports line-based deltas (deltaMode 1); normalise to pixels.
    const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    const atStart = el.scrollLeft <= 0;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    if ((dy > 0 && atEnd) || (dy < 0 && atStart)) return; // edge reached — page scrolls
    e.preventDefault();
    el.scrollLeft += dy;
  }
}
