import { Injectable, inject } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';

/**
 * "Back" for detail pages.
 *
 * A show or movie can be opened from its own index, from Up Next, or from a
 * custom list — so a hard-coded `/movies` link drops the user somewhere they
 * were never coming from. Popping history returns them to wherever they were.
 *
 * The router stamps an incrementing `navigationId` into `history.state`, so a
 * value of 1 means this page *is* the first entry of the session (deep link,
 * refresh, shared URL) and there is nothing of ours to pop — go to `fallback`
 * instead of walking out of the app.
 */
@Injectable({ providedIn: 'root' })
export class BackNav {
  private location = inject(Location);
  private router = inject(Router);

  back(fallback: string): void {
    const state = this.location.getState() as { navigationId?: number } | null;
    if ((state?.navigationId ?? 1) > 1) this.location.back();
    else this.router.navigateByUrl(fallback);
  }
}
