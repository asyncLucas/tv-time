import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { TmdbService, TmdbMovie } from '../../core/tmdb.service';
import { Poster } from '../../shared/poster';

@Component({
  selector: 'app-movie-detail',
  imports: [RouterLink, Poster],
  template: `
    @if (movie(); as m) {
      <div class="detail">
        <div class="hero" [style.background-image]="backdrop()">
          <div class="scrim"></div>
          <a class="back" routerLink="/movies">← Movies</a>
          <div class="hero-inner">
            <app-poster class="poster" [title]="m.name" [imdbId]="m.imdbId" />
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
    } @else {
      <div class="page"><div class="empty">Movie not found.</div></div>
    }
  `,
  styleUrl: './movie-detail.scss',
})
export class MovieDetail {
  store = inject(LibraryStore);
  tmdb = inject(TmdbService);

  readonly uuid = input.required<string>();
  readonly movie = computed(() => this.store.movie(this.uuid()));

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
    // load TMDB detail whenever the route movie (with an imdb id) changes
    effect(() => {
      const m = this.movie();
      this.tmdbMovie.set(null);
      if (m?.imdbId && this.tmdb.hasKey()) this.load(m.imdbId);
    });
  }

  private async load(imdbId: string): Promise<void> {
    this.loading.set(true);
    this.tmdbMovie.set(await this.tmdb.movieByImdb(imdbId));
    this.loading.set(false);
  }

  rate(n: number): void {
    const cur = this.movie()?.state.rating;
    this.store.rateMovie(this.uuid(), cur === n ? null : n);
  }
}
