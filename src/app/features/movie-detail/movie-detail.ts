import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { parseAddedKey } from '../../core/doc.service';
import { TmdbService, TmdbMovie, WatchProvider, tmdbPosterUrl } from '../../core/tmdb.service';
import type { MovieView } from '../../core/models';
import { Poster } from '../../shared/poster';
import { BackNav } from '../../shared/back-nav';
import { ConfirmDialog } from '../../shared/confirm-dialog';
import { stremioUrl, openStremio } from '../../shared/stremio';
import { SaveMenu } from '../../shared/save-menu';

@Component({
  selector: 'app-movie-detail',
  imports: [NgTemplateOutlet, RouterLink, Poster, ConfirmDialog, SaveMenu],
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
                @if (tmdbMovie()?.trailerUrl; as trailer) {
                  <a class="trailer-badge" [href]="trailer" target="_blank" rel="noopener" title="Watch the trailer on YouTube">▶ Trailer</a>
                }
                @if (stremioUrl(); as stremio) {
                  <a class="stremio-badge" [href]="stremio" (click)="onStremioClick($event)" target="_blank" rel="noopener" title="Open in Stremio">Stremio</a>
                }
              </div>
              @if (tmdbMovie()?.watchProviders; as wp) {
                @if (wp.streaming.length || wp.rent.length || wp.buy.length) {
                  <div class="providers">
                    @if (streamingLogos().length) {
                      <span class="prov-label">Streaming</span>
                      @for (p of streamingLogos(); track p.name) {
                        <img class="prov" [src]="p.logo" [alt]="p.name" [title]="p.title" loading="lazy" decoding="async" />
                      }
                    }
                    @if (rentOrBuyLogos().length) {
                      <span class="prov-label">Rent / Buy</span>
                      @for (p of rentOrBuyLogos(); track p.name) {
                        <img class="prov" [src]="p.logo" [alt]="p.name" [title]="p.title" loading="lazy" decoding="async" />
                      }
                    }
                    @if (wp.link) {
                      <a class="prov-more" [href]="wp.link" target="_blank" rel="noopener">All options ↗</a>
                    }
                  </div>
                }
              }
              @if (genres().length) {
                <div class="genres">
                  @for (g of genres(); track g) {
                    <span class="chip">{{ g }}</span>
                  }
                </div>
              }
              <p class="overview">{{ tmdbMovie()?.overview || m.overview || 'No synopsis available.' }}</p>

              <div class="controls">
                @if (isPreview()) {
                  <div class="list-menu split">
                    <button class="btn primary add" [disabled]="adding()" (click)="addToLibrary()">
                      {{ adding() ? 'Adding…' : '+ Add to library' }}
                    </button>
                    <ng-container [ngTemplateOutlet]="saveMenu" />
                  </div>
                } @else {
                  <button
                    class="btn"
                    [class.primary]="m.state.watched"
                    (click)="store.setMovieWatched(m.uuid, !m.state.watched)"
                  >
                    ✓ {{ m.state.watched ? 'Watched' : 'Mark watched' }}
                  </button>
                  <button
                    class="btn"
                    [class.primary]="m.state.favorite"
                    (click)="store.toggleMovieFavorite(m.uuid)"
                  >
                    ★ {{ m.state.favorite ? 'Favorited' : 'Favorite' }}
                  </button>
                  <div class="list-menu">
                    <ng-container [ngTemplateOutlet]="saveMenu" />
                  </div>
                  <!-- You can only rate a film you've seen, so the pips appear
                       once it's marked watched. After a score is given the row
                       collapses to the score itself, which reopens the pips. -->
                  @if (m.state.watched) {
                    @if (ratingOpen()) {
                      <div class="rating" role="radiogroup" aria-label="Your rating out of 10">
                        @for (n of RATING_PIPS; track n) {
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
                    } @else {
                      <button
                        class="btn rated"
                        type="button"
                        [attr.aria-label]="'Your rating: ' + m.state.rating + ' out of 10 — change it'"
                        (click)="changingRating.set(true)"
                      >
                        ★ {{ m.state.rating }}/10
                      </button>
                    }
                  }
                }
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
          } @else if (castRows().length) {
            <h2 class="sec">Cast</h2>
            <div class="cast">
              @for (c of castRows(); track c.name) {
                <a class="person" [href]="c.url" target="_blank" rel="noopener" [title]="'View ' + c.name + ' on TMDB'">
                  @if (c.img) {
                    <img [src]="c.img" [alt]="c.name" loading="lazy" decoding="async" />
                  } @else {
                    <div class="ph">{{ c.initial }}</div>
                  }
                  <div class="p-name">{{ c.name }}</div>
                  <div class="p-char">{{ c.character }}</div>
                </a>
              }
            </div>
          } @else {
            <div class="empty">No extra details found on TMDB for this film.</div>
          }
        </div>
      </div>
    } @else if (loading() || redirecting()) {
      <div class="page"><div class="empty">Loading details…</div></div>
    } @else {
      <div class="page"><div class="empty">Movie not found.</div></div>
    }

    @if (removing()) {
      <app-confirm-dialog
        [open]="true"
        [danger]="true"
        heading="Remove from library?"
        message="This deletes the film from your library along with its rating and watch status. You can add it again anytime."
        confirmLabel="Remove"
        (confirmed)="confirmRemove()"
        (dismissed)="removing.set(false)"
      />
    }

    <ng-template #saveMenu>
      <app-save-menu
        [uuid]="uuid()"
        [title]="movie()?.name ?? ''"
        entityType="movie"
        [watchlist]="watchlistRow()"
        [variant]="isPreview() ? 'caret' : 'button'"
        [removeLabel]="isAdded() ? 'Remove from library' : null"
        [ensureSaveable]="ensureInLibrary"
        (watchlistToggled)="toggleWatchlist()"
        (removeRequested)="removing.set(true)"
      />
    </ng-template>
  `,
  styleUrl: './movie-detail.scss',
  // Every binding reads a signal or computed; per-row list membership, cast and
  // provider URLs are resolved in computeds rather than inline.
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MovieDetail {
  store = inject(LibraryStore);
  nav = inject(BackNav);
  tmdb = inject(TmdbService);
  private readonly router = inject(Router);

  readonly uuid = input.required<string>();

  /** The library entry for this uuid, if the film is actually in the library. */
  private readonly stored = computed(() => this.store.movie(this.uuid()));

  /** TMDB id to preview from, when the route points at a film not yet added. */
  private readonly previewId = computed(() => {
    const p = parseAddedKey(this.uuid());
    return p?.kind === 'movie' ? p.tmdbId : null;
  });

  /**
   * Where this film really lives, when the route addresses it by a TMDB uuid the
   * library deduped away (see `LibraryStore.canonicalUuid`). Non-null means this
   * page is standing in front of the user's actual entry.
   */
  private readonly canonical = computed(() => this.store.canonicalUuid(this.uuid()));

  /**
   * A redirect to the canonical uuid is on its way. The template treats this as
   * loading: neither the preview nor the library view can render a title this
   * uuid doesn't resolve to, and "Movie not found." is the wrong thing to flash
   * at someone on their way to a film they own.
   */
  readonly redirecting = computed(() => this.canonical() !== null);

  /**
   * Read-only mode: showing a TMDB title the user hasn't added to the library.
   *
   * A superseded uuid is explicitly *not* a preview — the film is in the
   * library, just under another uuid — otherwise the page would offer to add a
   * film the user already has while the redirect below is still in flight.
   */
  readonly isPreview = computed(
    () => !this.stored() && this.previewId() !== null && !this.canonical(),
  );
  /** In-library, and added from TMDB — so the "In library" toggle can remove it. */
  readonly isAdded = computed(() => !!this.stored() && this.previewId() !== null);
  readonly adding = signal(false);
  /** Whether the "remove from library?" confirmation is showing. */
  readonly removing = signal(false);

  /**
   * Whether the user asked to change an existing score. A transient intent, so
   * it resets when the route moves to another film or the watched flag flips —
   * re-marking a film watched shouldn't leave its pips hanging open.
   */
  readonly changingRating = linkedSignal<string, boolean>({
    source: () => `${this.uuid()}|${this.stored()?.state.watched ?? false}`,
    computation: () => false,
  });

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

  /** A Stremio Web link for this film, once its IMDb id is known. */
  readonly stremioUrl = computed(() =>
    stremioUrl('movie', this.tmdbMovie()?.imdbId ?? this.movie()?.imdbId ?? null),
  );

  /** Rent and buy providers merged (deduped) for the paid-options badge row. */
  readonly rentOrBuy = computed<WatchProvider[]>(() => {
    const wp = this.tmdbMovie()?.watchProviders;
    if (!wp) return [];
    const byName = new Map<string, WatchProvider>();
    for (const p of [...wp.rent, ...wp.buy]) if (!byName.has(p.name)) byName.set(p.name, p);
    return [...byName.values()];
  });

  readonly RATING_PIPS = RATING_PIPS;

  /** Provider badges with their logo URL and tooltip resolved once. */
  readonly streamingLogos = computed(() =>
    (this.tmdbMovie()?.watchProviders?.streaming ?? []).map((p) => ({
      name: p.name,
      logo: this.tmdb.providerLogo(p.logoPath),
      title: `Stream on ${p.name}`,
    })),
  );
  readonly rentOrBuyLogos = computed(() =>
    this.rentOrBuy().map((p) => ({
      name: p.name,
      logo: this.tmdb.providerLogo(p.logoPath),
      title: `Rent or buy on ${p.name}`,
    })),
  );

  /** Cast with headshot URLs and placeholder initials resolved once. */
  readonly castRows = computed(() =>
    (this.tmdbMovie()?.cast ?? []).map((c) => ({
      name: c.name,
      character: c.character,
      img: this.tmdb.profileImg(c.profilePath),
      initial: c.name.slice(0, 1),
      url: `https://www.themoviedb.org/person/${c.id}`,
    })),
  );

  /** Plain clicks try the Stremio app first; see `openStremio`. */
  onStremioClick(event: MouseEvent): void {
    const web = this.stremioUrl();
    if (web) openStremio(event, web);
  }

  constructor() {
    // A Trending card (or a link from another device) can address a film by its
    // TMDB uuid even though the library already holds it under the catalog's own
    // uuid. Send the user to the entry that carries their rating and lists,
    // rather than to a page offering to add what they already have. `replaceUrl`
    // keeps the dead uuid out of history so Back still leaves the detail page.
    effect(() => {
      const canonical = this.canonical();
      if (canonical) this.router.navigate(['/movies', canonical], { replaceUrl: true });
    });

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
    // A second caller joins the add already running rather than returning
    // straight away: the list menu adds the film before writing its watchlist
    // flag or a list item, and a caller that didn't wait would have its write
    // overwritten by the add's own `movieState` entry landing after it.
    if (this.inflightAdd) return this.inflightAdd;
    const id = this.previewId();
    const info = this.tmdbMovie();
    if (id === null || !info) return;
    this.adding.set(true);
    // Hand the already-fetched detail to the store so it doesn't re-request it.
    this.inflightAdd = this.store
      .addMovie(
        {
          tmdbId: id,
          name: info.title,
          overview: info.overview,
          posterPath: info.posterPath,
          year: info.releaseDate?.slice(0, 4) ?? null,
        },
        info,
      )
      .then(() => undefined)
      .finally(() => {
        this.inflightAdd = null;
        this.adding.set(false);
      });
    return this.inflightAdd;
  }

  /** The add in progress, if any — see `addToLibrary`. */
  private inflightAdd: Promise<void> | null = null;

  /**
   * What the menu's watchlist row should show, or null to leave it out.
   * Marking a film watched clears its watchlist flag in the store, so while
   * watched the row could only ever read "off" — better absent than offering a
   * toggle that contradicts the state.
   */
  readonly watchlistRow = computed<boolean | null>(() =>
    this.movie()?.state.watched ? null : this.movie()?.state.watchlist ?? false,
  );

  /**
   * Toggle the watchlist flag, adding a previewed film to the library first.
   *
   * Which way it goes is decided from the state the user clicked, not from the
   * state after the add: `addMovie` files a film onto the watchlist already, so
   * a blind toggle read that as a request to take it straight back off — the
   * one click that says "watchlist this" was the one click that didn't.
   */
  async toggleWatchlist(): Promise<void> {
    const wanted = !(this.movie()?.state.watchlist ?? false);
    await this.ensureInLibrary();
    if ((this.movie()?.state.watchlist ?? false) !== wanted) {
      this.store.toggleMovieWatchlist(this.uuid());
    }
  }

  /**
   * Whether the pips are showing rather than the collapsed score. An unrated
   * film has nothing to collapse to, so the pips are the resting state until a
   * score exists; after that they only come back when asked for.
   */
  readonly ratingOpen = computed(() => this.changingRating() || !this.movie()?.state.rating);

  /**
   * Rate the film. Only reachable while it's marked watched — the pips are
   * hidden otherwise — and guarded here so the rule doesn't live in the
   * template alone. Committing a score collapses the row back to that score;
   * clearing one leaves the pips up, since there's nothing to collapse to.
   */
  rate(n: number): void {
    const state = this.movie()?.state;
    if (!state?.watched) return;
    this.store.rateMovie(this.uuid(), state.rating === n ? null : n);
    this.changingRating.set(false);
  }

  /**
   * Remove this film from the library. Its uuid is the deterministic TMDB
   * added-key, so once the entry is gone `stored()` flips back to undefined and
   * the page reactively returns to its "+ Add to library" preview — the button
   * toggles in place rather than navigating away.
   */
  confirmRemove(): void {
    this.removing.set(false);
    if (!this.isAdded()) return;
    this.store.removeAdded('movie', this.uuid());
  }

  /**
   * Bring a previewed film into the library so a list item has something real
   * to resolve to. The uuid is deterministic, so it's the same before and after.
   *
   * Bound as a field, not a method: it is handed to `app-save-menu` as an
   * input, and a method reference would arrive with no `this`.
   */
  readonly ensureInLibrary = async (): Promise<void> => {
    if (this.isPreview()) await this.addToLibrary();
  };
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

/** The 1-10 rating pips. Hoisted so the template doesn't rebuild it per cycle. */
const RATING_PIPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
