import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { TmdbService } from '../core/tmdb.service';
import { PosterCacheService } from '../core/poster-cache.service';
import { initialsOf } from './initials';

/**
 * A poster image that resolves lazily and gracefully degrades:
 *   TMDB poster (if a key is set)  →  a poster path some device with a key
 *   already resolved and wrote to the synced cache  →  cached TheTVDB poster
 *   from the backup  →  a generated gradient tile with the title's initials.
 *
 * That middle step is what makes films work at all: TV Time backups ship a
 * cached poster for every show and none for any movie, so before the cache a
 * key-less device had nothing but initials across the whole movie library.
 *
 * Uses IntersectionObserver so only on-screen cards ever touch the network.
 */
@Component({
  selector: 'app-poster',
  template: `
    <div class="poster">
      @if (src()) {
        <img
          [src]="src()!"
          [alt]="title()"
          [attr.loading]="eager() ? 'eager' : 'lazy'"
          decoding="async"
          (error)="onError()"
        />
      } @else {
        <div class="ph" [style.background]="gradient()">
          <span>{{ initials() }}</span>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .poster {
        position: relative;
        aspect-ratio: 2 / 3;
        border-radius: 10px;
        overflow: hidden;
        background: var(--bg-elev-2);
        box-shadow: var(--shadow);
      }
      img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        /* The image is always fully opaque and simply appears when it paints.
           An earlier design faded it in from opacity 0 via a loaded-gated
           transition/animation — but on Continue watching, returning to the
           freshly re-rendered grid after marking an episode, that reveal could
           stall in Chromium (the CSS transition/animation stuck "running" with
           currentTime frozen at 0), pinning covers at opacity 0 forever. Any
           opacity-0 entry state carries that risk, so we don't hide the image
           at all — a blank cover is far worse than a missing fade. */
      }
      .ph {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        color: #ffffffcc;
        font-weight: 800;
        font-size: 26px;
        letter-spacing: 0.04em;
      }
    `,
  ],
  // Grids instantiate hundreds of these (565 on the Movies page), and every
  // binding reads a signal — so OnPush takes them all out of the default
  // check-everything-on-every-tick path.
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Poster {
  private tmdb = inject(TmdbService);
  private posters = inject(PosterCacheService);
  private el = inject(ElementRef<HTMLElement>);

  /** Small always-visible thumbnails (e.g. list rows) should load eagerly. */
  readonly eager = input(false);
  readonly title = input('');
  readonly tvdbId = input<string | null>(null);
  readonly imdbId = input<string | null>(null);
  readonly cachedPoster = input<string | null>(null);

  readonly src = signal<string | null>(null);
  /** resolve() has run (successfully or not) — the observer fires once. */
  private fetched = false;
  /** A live TMDB lookup produced a URL, so fallbacks must stop overwriting it. */
  private hasRemote = false;

  /**
   * Best artwork available without touching the network: the backup's own
   * cached poster, else whatever a key-holding device recorded for this title.
   */
  readonly fallback = computed(
    () => this.cachedPoster() ?? this.posters.url({ tvdbId: this.tvdbId(), imdbId: this.imdbId() }),
  );

  readonly initials = computed(() => initialsOf(this.title()));
  readonly gradient = computed(() => {
    let h = 0;
    for (const c of this.title()) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `linear-gradient(140deg, hsl(${h} 40% 24%), hsl(${(h + 40) % 360} 45% 14%))`;
  });

  constructor() {
    // Seed an immediate fallback, and keep tracking it: the synced poster cache
    // can fill in after this card has already painted (a sync landing, another
    // card resolving the same title), and that's exactly when a movie tile gets
    // to stop being initials.
    effect(() => {
      const f = this.fallback();
      if (!this.hasRemote && f) this.src.set(f);
    });

    // Only resolve posters that actually scroll into view. Grids render hundreds
    // of these, so the observer is also torn down on destroy — otherwise every
    // card the user scrolls past keeps an observer alive for the whole session.
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        this.resolve();
      }
    });
    queueMicrotask(() => io.observe(this.el.nativeElement));
    inject(DestroyRef).onDestroy(() => io.disconnect());
  }

  private async resolve(): Promise<void> {
    if (this.fetched) return;
    this.fetched = true;
    if (!this.tmdb.hasKey()) return; // keep cached/placeholder
    try {
      let posterPath: string | null = null;
      // IMDb first: only films are given one, and a film's TheTVDB id belongs to
      // a different id space entirely — resolving it as a show (list rows pass
      // both ids) would hand back some unrelated series' artwork.
      if (this.imdbId()) {
        const m = await this.tmdb.findMovieByImdb(this.imdbId()!);
        posterPath = m?.poster_path ?? null;
      } else if (this.tvdbId()) {
        const show = await this.tmdb.showByTvdb(this.tvdbId()!);
        posterPath = show?.posterPath ?? null;
      }
      const url = this.tmdb.poster(posterPath, 'w342');
      if (url) {
        this.hasRemote = true;
        this.src.set(url);
        // Hand the path to the fleet: every device without a key, and every
        // visitor to the published profile, renders this cover from here on.
        this.posters.remember({ tvdbId: this.tvdbId(), imdbId: this.imdbId() }, posterPath);
      }
    } catch {
      /* keep fallback */
    }
  }

  onError(): void {
    // The URL we tried didn't load. Drop back to the offline fallback if it's
    // something different, otherwise to the initials placeholder.
    const f = this.fallback();
    this.hasRemote = false;
    this.src.set(f && f !== this.src() ? f : null);
  }
}
