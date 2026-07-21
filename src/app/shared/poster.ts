import {
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
import { initialsOf } from './initials';

/**
 * A poster image that resolves lazily and gracefully degrades:
 *   TMDB poster (if a key is set)  →  cached TheTVDB poster from the backup
 *   →  a generated gradient tile with the title's initials.
 *
 * Uses IntersectionObserver so only on-screen cards ever touch the network.
 */
@Component({
  selector: 'app-poster',
  template: `
    <div class="poster" [class.loaded]="loaded()">
      @if (src()) {
        <img [src]="src()!" [alt]="title()" [attr.loading]="eager() ? 'eager' : 'lazy'" (load)="loaded.set(true)" (error)="onError()" />
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
        opacity: 0;
        transition: opacity 0.3s ease;
      }
      .poster.loaded img {
        opacity: 1;
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
})
export class Poster {
  private tmdb = inject(TmdbService);
  private el = inject(ElementRef<HTMLElement>);

  /** Small always-visible thumbnails (e.g. list rows) should load eagerly. */
  readonly eager = input(false);
  readonly title = input('');
  readonly tvdbId = input<string | null>(null);
  readonly imdbId = input<string | null>(null);
  readonly cachedPoster = input<string | null>(null);

  readonly src = signal<string | null>(null);
  readonly loaded = signal(false);
  private resolved = false;

  readonly initials = computed(() => initialsOf(this.title()));
  readonly gradient = computed(() => {
    let h = 0;
    for (const c of this.title()) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `linear-gradient(140deg, hsl(${h} 40% 24%), hsl(${(h + 40) % 360} 45% 14%))`;
  });

  constructor() {
    // seed immediate fallback from the cached backup poster
    effect(() => {
      if (!this.resolved && this.cachedPoster()) this.src.set(this.cachedPoster());
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
    if (this.resolved) return;
    this.resolved = true;
    if (!this.tmdb.hasKey()) return; // keep cached/placeholder
    try {
      let posterPath: string | null = null;
      if (this.tvdbId()) {
        const show = await this.tmdb.showByTvdb(this.tvdbId()!);
        posterPath = show?.posterPath ?? null;
      } else if (this.imdbId()) {
        const m = await this.tmdb.findMovieByImdb(this.imdbId()!);
        posterPath = m?.poster_path ?? null;
      }
      const url = this.tmdb.poster(posterPath, 'w342');
      if (url) {
        this.loaded.set(false);
        this.src.set(url);
      }
    } catch {
      /* keep fallback */
    }
  }

  onError(): void {
    // TMDB/tvdb url failed → fall back to placeholder
    this.src.set(null);
  }
}
