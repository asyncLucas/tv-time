import { DOCUMENT, DestroyRef, NgZone, inject } from '@angular/core';
import { Router, Scroll } from '@angular/router';

/**
 * How long to keep looking for the card, and how often. Library grids are
 * already in the DOM when the router settles, but Trending renders from a
 * fetch, so its cards can show up a beat later.
 */
const RETRY_MS = 100;
const BUDGET_MS = 2500;

/** Any of these means the user took over — stop trying to move the page. */
const USER_INPUT = ['wheel', 'touchstart', 'keydown'] as const;

/**
 * Makes sure the card marked `data-card="<anchor>"` is on screen once it exists,
 * and leaves the page alone if it already is. Call it from a list component's
 * constructor (it injects).
 *
 * On a normal trip back this does nothing: the router's own scroll restoration
 * (see `withInMemoryScrolling` in app.config) has already put the grid back
 * where it was, card included. It earns its keep when that restore can't work —
 * a Trending grid that is still fetching when the router scrolls, or a library
 * grid that changed height because the title was updated on the detail page.
 *
 * Timing matters. The router restores the scroll while handling its own `Scroll`
 * event, and that handler runs *after* this one (`Router.events` is a separate
 * subject the router feeds first), so measuring the viewport here would read the
 * position from before the restore. Hence the deferral to a macrotask.
 */
export function scrollToCard(anchor: string): void {
  const router = inject(Router);
  const doc = inject(DOCUMENT);
  const zone = inject(NgZone);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const finish = () => {
    done = true;
    clearTimeout(timer);
    for (const ev of USER_INPUT) doc.removeEventListener(ev, finish);
    sub.unsubscribe();
  };

  /** @returns whether the card has been dealt with (found, or already in view). */
  const attempt = () => {
    if (done) return true;
    const el = doc.querySelector(`[data-card="${CSS.escape(anchor)}"]`);
    if (!el) return false;
    const box = el.getBoundingClientRect();
    const middle = box.top + box.height / 2;
    // Only move the page if the card isn't already looking at the user.
    if (middle < 0 || middle > window.innerHeight) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    finish();
    return true;
  };

  for (const ev of USER_INPUT) doc.addEventListener(ev, finish, { passive: true });
  inject(DestroyRef).onDestroy(finish);

  const sub = router.events.subscribe((e) => {
    if (done || !(e instanceof Scroll)) return;
    // Outside Angular: a poll that finds nothing 25 times shouldn't tick change
    // detection 25 times.
    zone.runOutsideAngular(() => {
      const deadline = Date.now() + BUDGET_MS;
      const tick = () => {
        if (attempt() || Date.now() > deadline) finish();
        else timer = setTimeout(tick, RETRY_MS);
      };
      timer = setTimeout(tick);
    });
  });
}
