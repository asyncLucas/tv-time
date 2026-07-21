import { Injectable, computed, inject, signal } from '@angular/core';
import { TMDB_UNREACHABLE, TmdbService, type TmdbSearchResult } from './tmdb.service';

/** What a page needs to render one trending tab. */
export interface TrendingFeed {
  readonly results: () => TmdbSearchResult[];
  readonly loading: () => boolean;
  readonly error: () => string | null;
  /** Idempotent: safe to call on every render of the tab. */
  readonly load: () => void;
}

/**
 * This week's trending shows and films, fetched once per kind and shared.
 *
 * The Shows and Movies pages each held their own copy of this — the same four
 * signals, the same one-shot guard, the same error string. Beyond the
 * duplication, two copies meant two fetches for a user who opened both tabs,
 * and neither page could see what the other had already loaded.
 *
 * Lives at app scope rather than per-component, so the results survive
 * navigating away and back. That's deliberate: "trending this week" doesn't
 * change between two clicks, and the alternative is a visible reload of
 * identical content every time you return to the tab.
 */
@Injectable({ providedIn: 'root' })
export class TrendingStore {
  private tmdb = inject(TmdbService);

  private readonly state = {
    tv: this.emptyState(),
    movie: this.emptyState(),
  };

  readonly shows = this.feed('tv');
  readonly movies = this.feed('movie');

  private emptyState() {
    return {
      results: signal<TmdbSearchResult[]>([]),
      loading: signal(false),
      error: signal<string | null>(null),
      /** Guards the one-shot fetch; cleared on failure so a re-open retries. */
      loaded: false,
    };
  }

  private feed(kind: 'tv' | 'movie'): TrendingFeed {
    const s = this.state[kind];
    return {
      results: computed(() => s.results()),
      loading: computed(() => s.loading()),
      error: computed(() => s.error()),
      load: () => void this.load(kind),
    };
  }

  private async load(kind: 'tv' | 'movie'): Promise<void> {
    const s = this.state[kind];
    // No key means no request to make — the caller renders its own "add a
    // TMDB key" notice, and we must not latch `loaded` before one exists.
    if (s.loaded || !this.tmdb.hasKey()) return;
    s.loaded = true;
    s.loading.set(true);
    s.error.set(null);
    try {
      s.results.set(kind === 'tv' ? await this.tmdb.trendingShows() : await this.tmdb.trendingMovies());
    } catch {
      s.loaded = false; // let a re-open retry
      s.error.set(TMDB_UNREACHABLE);
    } finally {
      s.loading.set(false);
    }
  }
}
