import { Injectable } from '@angular/core';

/** A poster grid's UI state at the moment one of its cards was opened. */
export interface ListState {
  /** The selected tab. */
  filter: string;
  /** The search box contents. */
  query: string;
  /** How far "Show more" had grown the grid. */
  limit: number;
  /** Route id of the card that was opened, so the grid can scroll back to it. */
  anchor: string;
}

/**
 * Remembers where a poster grid was when the user opened a title, so coming
 * back from the detail page lands on the same tab, the same search and the same
 * card — instead of a grid reset to "All" and scrolled to the top.
 *
 * The stash is in-memory and one-shot: it is written on the way *into* a detail
 * page and consumed by the next `take()`. Reaching a list any other way (side
 * nav, deep link, reload) finds nothing stashed and starts clean, which is why
 * this isn't in the URL or in storage — it's a trip-back hint, not state worth
 * sharing or persisting.
 */
@Injectable({ providedIn: 'root' })
export class ListStateStore {
  private readonly stash = new Map<string, ListState>();

  save(key: string, state: ListState): void {
    this.stash.set(key, state);
  }

  /** Reads and clears the stash for `key` — a restore only ever happens once. */
  take(key: string): ListState | null {
    const state = this.stash.get(key) ?? null;
    this.stash.delete(key);
    return state;
  }
}
