import { Injectable, computed, inject } from '@angular/core';
import { LocalConfigService } from './local-config.service';

export type SearchKind = 'show' | 'movie';

/** Where the list lives in the device-local config store. */
const KEY = 'recentSearches';
/** How many queries we keep per kind before the oldest falls off. */
const MAX = 8;
/** Matches TMDB search's own floor — shorter strings never searched anything. */
const MIN_QUERY_LENGTH = 2;

/**
 * The handful of queries this device last searched with, newest first.
 *
 * Device-local rather than synced: what you typed on your phone five minutes
 * ago is not something the fleet needs to agree on, and it would be noise in
 * the gist. Recorded on blur rather than per keystroke — the query is only
 * worth remembering once the user has finished typing it and moved on, which
 * otherwise leaves a trail of every prefix they passed through ("b", "br",
 * "bre", …).
 *
 * Re-picking a recent query costs nothing on the network: TMDB search
 * responses are cached by URL for a week and served stale on failure, so the
 * results come straight back — including offline.
 */
@Injectable({ providedIn: 'root' })
export class RecentSearchesService {
  private config = inject(LocalConfigService);

  /** Reactive: `config.get` reads the store's signal, so this tracks writes. */
  private readonly all = computed<Partial<Record<SearchKind, string[]>>>(
    () => this.config.get<Partial<Record<SearchKind, string[]>>>(KEY) ?? {},
  );

  recent(kind: SearchKind): string[] {
    return this.all()[kind] ?? [];
  }

  /**
   * Record a query as the most recent one for `kind`. A repeat moves to the
   * front rather than being added twice — case-insensitively, so "Severance"
   * and "severance" are the same search.
   */
  async remember(kind: SearchKind, raw: string): Promise<void> {
    const q = raw.trim();
    if (q.length < MIN_QUERY_LENGTH) return;
    const rest = this.recent(kind).filter((x) => x.toLowerCase() !== q.toLowerCase());
    await this.config.set(KEY, { ...this.all(), [kind]: [q, ...rest].slice(0, MAX) });
  }

  /** Drop the whole list for one kind (the "Clear" affordance). */
  async clear(kind: SearchKind): Promise<void> {
    const { [kind]: _dropped, ...rest } = this.all();
    await this.config.set(KEY, rest);
  }
}
