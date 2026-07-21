import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { parseAddedKey } from '../../core/doc.service';
import { TmdbService, TmdbMovie, tmdbPosterUrl } from '../../core/tmdb.service';
import type { MovieView } from '../../core/models';
import { Poster } from '../../shared/poster';
import { BackNav } from '../../shared/back-nav';

@Component({
  selector: 'app-movie-detail',
  imports: [RouterLink, Poster],
  template: `
    @if (movie(); as m) {
      <div class="detail">
        <div class="hero" [style.background-image]="backdrop()">
          <div class="scrim"></div>
          <button class="back" type="button" (click)="nav.back('/movies')">← Back</button>
          <div class="hero-inner">
            <app-poster class="poster" [title]="m.name" [imdbId]="m.imdbId" [cachedPoster]="m.cachedPoster ?? null" />
            <div class="info">
              <h1>{{ m.name }}</h1>
              @if (tmdbMovie()?.tagline) {
                <p class="tagline">{{ tmdbMovie()!.tagline }}</p>
              }
              <div class="facts">
                @if (year()) { <span>{{ year() }}</span> }
                @if (runtime()) { <span>{{ runtime() }}</span> }
                @if (tmdbMovie()?.voteAverage) { <span>★ {{ tmdbMovie()!.voteAverage!.toFixed(1) }}</span> }
                @if (tmdbMovie()?.directors?.length) { <span>{{ tmdbMovie()!.directors.join(', ') }}</span> }
              </div>
              @if (genres().length) {
                <div class="genres">
                  @for (g of genres(); track g) {
                    <span class="chip">{{ g }}</span>
                  }
                </div>
              }
              <p class="overview">{{ tmdbMovie()?.overview || m.overview || 'No synopsis available.' }}</p>

              @if (isPreview()) {
                <div class="controls">
                  <button class="btn primary add" [disabled]="adding()" (click)="addToLibrary()">
                    {{ adding() ? 'Adding…' : '+ Add to library' }}
                  </button>
                </div>
              } @else {
                <div class="controls">
                  <button
                    class="btn"
                    [class.primary]="m.state.watched"
                    (click)="store.setMovieWatched(m.uuid, !m.state.watched)"
                  >
                    ✓ {{ m.state.watched ? 'Watched' : 'Mark watched' }}
                  </button>
                  <button
                    class="btn"
                    [class.primary]="m.state.watchlist"
                    (click)="store.toggleMovieWatchlist(m.uuid)"
                  >
                    + {{ m.state.watchlist ? 'On watchlist' : 'Watchlist' }}
                  </button>
                  <button
                    class="btn"
                    [class.primary]="m.state.favorite"
                    (click)="store.toggleMovieFavorite(m.uuid)"
                  >
                    ★ {{ m.state.favorite ? 'Favorited' : 'Favorite' }}
                  </button>
                  <div class="rating" role="radiogroup" aria-label="Your rating out of 10">
                    @for (n of [1,2,3,4,5,6,7,8,9,10]; track n) {
                      <button
                        type="button"
                        class="pip"
                        role="radio"
                        [class.on]="(m.state.rating || 0) >= n"
                        [attr.aria-checked]="m.state.rating === n"
                        [attr.aria-label]="'Rate ' + n + ' out of 10'"
                        (click)="rate(n)"
                      >
                        {{ n }}
                      </button>
                    }
                  </div>
                </div>

                @if (m.state.watchedAt) {
                  <div class="watched-at">Watched {{ m.state.watchedAt.slice(0, 10) }}</div>
                }
              }
            </div>
          </div>
        </div>

        <div class="body">
          @if (!tmdb.hasKey()) {
            <div class="notice">
              Add a free <a routerLink="/settings">TMDB API key</a> to load cast, artwork and details.
            </div>
          } @else if (loading()) {
            <div class="empty">Loading details…</div>
          } @else if (tmdbMovie()?.cast?.length) {
            <h2 class="sec">Cast</h2>
            <div class="cast">
              @for (c of tmdbMovie()!.cast; track c.name) {
                <div class="person">
                  @if (tmdb.profileImg(c.profilePath); as img) {
                    <img [src]="img" [alt]="c.name" loading="lazy" />
                  } @else {
                    <div class="ph">{{ c.name.slice(0, 1) }}</div>
                  }
                  <div class="p-name">{{ c.name }}</div>
                  <div class="p-char">{{ c.character }}</div>
                </div>
              }
            </div>
          } @else {
            <div class="empty">No extra details found on TMDB for this film.</div>
          }
        </div>
      </div>
    } @else if (loading()) {
      <div class="page"><div class="empty">Loading details…</div></div>
    } @else {
      <div class="page"><div class="empty">Movie not found.</div></div>
    }
  `,
  styleUrl: './movie-detail.scss',
})
export class MovieDetail {
  store = inject(LibraryStore);
  nav = inject(BackNav);
  tmdb = inject(TmdbService);

  readonly uuid = input.required<string>();

  /** The library entry for this uuid, if the film is actually in the library. */
  private readonly stored = computed(() => this.store.movie(this.uuid()));

  /** TMDB id to preview from, when the route points at a film not yet added. */
  private readonly previewId = computed(() => {
    const p = parseAddedKey(this.uuid());
    return p?.kind === 'movie' ? p.tmdbId : null;
  });

  /** Read-only mode: showing a TMDB title the user hasn't added to the library. */
  readonly isPreview = computed(() => !this.stored() && this.previewId() !== null);
  readonly adding = signal(false);

  /**
   * The film to render: the real library entry, or — in preview — one
   * synthesized from the fetched TMDB data so the template works unchanged.
   */
  readonly movie = computed<MovieView | undefined>(() => {
    const m = this.stored();
    if (m) return m;
    const info = this.tmdbMovie();
    return this.isPreview() && info ? previewMovieView(this.uuid(), info) : undefined;
  });

  readonly tmdbMovie = signal<TmdbMovie | null>(null);
  readonly loading = signal(false);

  readonly backdrop = computed(() => {
    const b = this.tmdb.poster(this.tmdbMovie()?.backdropPath ?? null, 'original');
    return b ? `url(${b})` : 'none';
  });
  readonly year = computed(
    () => (this.tmdbMovie()?.releaseDate || this.movie()?.firstReleaseDate)?.slice(0, 4) ?? '',
  );
  readonly runtime = computed(() => {
    const r = this.tmdbMovie()?.runtime;
    if (!r) return '';
    const h = Math.floor(r / 60);
    const min = r % 60;
    return h ? `${h}h ${min}m` : `${min}m`;
  });
  readonly genres = computed(() => {
    const fromTmdb = this.tmdbMovie()?.genres ?? [];
    return fromTmdb.length ? fromTmdb : this.movie()?.genres ?? [];
  });

  constructor() {
    // Load TMDB detail whenever the route changes. A library film resolves by
    // its IMDb id; a preview (not yet added) resolves straight from the TMDB id
    // in the uuid. Keyed off `stored`/`previewId`, NOT `movie()` — `movie()`
    // derives from `tmdbMovie`, so depending on it here would loop.
    effect(() => {
      const m = this.stored();
      const previewId = this.previewId();
      // Adding a previewed film flips `stored` from undefined to the new entry
      // for the SAME tmdb id we already loaded — keep the fetched detail rather
      // than nulling it and refetching the identical data. (untracked so the
      // effect never re-fires on its own tmdbMovie writes.)
      if (m && previewId !== null && untracked(this.tmdbMovie)?.id === previewId) return;
      this.tmdbMovie.set(null);
      if (!this.tmdb.hasKey()) return;
      if (m?.imdbId) this.load(this.tmdb.movieByImdb(m.imdbId));
      else if (!m && previewId !== null) this.load(this.tmdb.movie(previewId));
    });
  }

  private async load(fetch: Promise<TmdbMovie | null>): Promise<void> {
    this.loading.set(true);
    this.tmdbMovie.set(await fetch);
    this.loading.set(false);
  }

  /**
   * Commit a previewed film to the library. The uuid is deterministic, so once
   * `addMovie` writes the entry `stored()` flips to it and the page swaps from
   * preview to the full interactive detail in place — no navigation needed.
   */
  async addToLibrary(): Promise<void> {
    const id = this.previewId();
    const info = this.tmdbMovie();
    if (id === null || !info || this.adding()) return;
    this.adding.set(true);
    try {
      // Hand the already-fetched detail to the store so it doesn't re-request it.
      await this.store.addMovie(
        {
          tmdbId: id,
          name: info.title,
          overview: info.overview,
          posterPath: info.posterPath,
          year: info.releaseDate?.slice(0, 4) ?? null,
        },
        info,
      );
    } finally {
      this.adding.set(false);
    }
  }

  rate(n: number): void {
    const cur = this.movie()?.state.rating;
    this.store.rateMovie(this.uuid(), cur === n ? null : n);
  }
}

/**
 * A throwaway `MovieView` built from TMDB data so the detail template can render
 * a film that isn't in the library yet. State is neutral (unwatched, unrated);
 * the page shows an "Add to library" button instead of the tracking controls,
 * and none of this is ever written to the CRDT.
 */
function previewMovieView(uuid: string, t: TmdbMovie): MovieView {
  return {
    uuid,
    name: t.title,
    imdbId: t.imdbId,
    tvdbId: null,
    genres: t.genres,
    firstReleaseDate: t.releaseDate,
    overview: t.overview,
    followedAt: null,
    watchedAt: null,
    favorite: false,
    cachedPoster: tmdbPosterUrl(t.posterPath),
    state: {
      watched: false,
      watchedAt: null,
      watchlist: false,
      favorite: false,
      rating: null,
      updatedAt: null,
    },
  };
}
