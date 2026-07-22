import { Injectable, computed, inject, signal } from '@angular/core';
import { DocService } from './doc.service';
import { PosterSize, tmdbPosterUrl } from './tmdb.service';

/** What a poster is keyed by: shows travel with a TheTVDB id, films with IMDb. */
export type PosterKey = { tvdbId?: string | null; imdbId?: string | null };

/**
 * Remembers, in the synced doc, which TMDB poster path belongs to which title.
 *
 * The catalog only half-solves artwork: every show in a TV Time backup carries a
 * cached poster URL, no film does. So a device without a TMDB key renders the
 * whole movie library as initial-tiles, and a published public profile — which
 * has to bake absolute URLs, since a visitor has no key of their own — ships
 * favourite films with no cover at all.
 *
 * The fix is to write down what a key-holding device already resolved. One
 * device with a key, browsing once, fills the map; every other device and every
 * visitor to the public page reads it. Entries are never invalidated: a TMDB
 * poster path is stable, and a slightly dated cover beats a blank one.
 */
@Injectable({ providedIn: 'root' })
export class PosterCacheService {
  private docs = inject(DocService);

  /** Mirror of the Y.Map — templates read this, so it has to be a signal. */
  private paths = signal<Record<string, string>>({});

  /** How many titles we've learned artwork for (settings shows this). */
  readonly size = computed(() => Object.keys(this.paths()).length);

  constructor() {
    const refresh = () => this.paths.set(this.docs.posters.toJSON() as Record<string, string>);
    refresh();
    this.docs.posters.observe(refresh);
  }

  /** The cached artwork URL for a title, or null if nobody has resolved it yet. */
  url(key: PosterKey, size: PosterSize = 'w342'): string | null {
    const k = cacheKey(key);
    return k ? tmdbPosterUrl(this.paths()[k] ?? null, size) : null;
  }

  /**
   * Record the poster path a TMDB lookup produced.
   *
   * Writes are deduped against what's already stored: poster components resolve
   * as they scroll into view, and re-writing an unchanged value would turn every
   * scroll through the grid into CRDT churn the sync layer has to ship.
   */
  remember(key: PosterKey, path: string | null | undefined): void {
    if (!path) return;
    const k = cacheKey(key);
    if (!k || this.docs.posters.get(k) === path) return;
    this.docs.posters.set(k, path);
  }
}

/**
 * Namespaced so a TheTVDB id and an IMDb id can never collide — the two id
 * spaces are unrelated, and films in this catalog carry both.
 *
 * IMDb wins when both are present, matching how Poster resolves: only films
 * carry an IMDb id here, and a film's TheTVDB id would otherwise key (and look
 * up) against the entirely different show that happens to hold that number.
 */
function cacheKey({ tvdbId, imdbId }: PosterKey): string | null {
  if (imdbId) return `mv:${imdbId}`;
  if (tvdbId) return `tv:${tvdbId}`;
  return null;
}
