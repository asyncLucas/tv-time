import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { parseAddedKey } from '../../core/doc.service';
import { TmdbService, TmdbMovie, WatchProvider, tmdbPosterUrl } from '../../core/tmdb.service';
import type { MovieView } from '../../core/models';
import { Poster } from '../../shared/poster';
import { BackNav } from '../../shared/back-nav';
import { ConfirmDialog } from '../../shared/confirm-dialog';
import { stremioUrl, openStremio } from '../../shared/stremio';

@Component({
  selector: 'app-movie-detail',
  imports: [NgTemplateOutlet, RouterLink, Poster, ConfirmDialog],
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
                    <button
                      class="btn primary split-caret"
                      [attr.aria-expanded]="listMenuOpen()"
                      aria-label="Add to a list"
                      (click)="listMenuOpen.set(!listMenuOpen())"
                    >
                      ▾
                    </button>
                    <ng-container [ngTemplateOutlet]="listPanel" />
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
                  <ng-container [ngTemplateOutlet]="listControl" />
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
    } @else if (loading()) {
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

    <ng-template #listControl>
      <div class="list-menu">
        <button
          class="btn"
          [class.saved]="isSaved()"
          [attr.aria-expanded]="listMenuOpen()"
          (click)="listMenuOpen.set(!listMenuOpen())"
        >
          {{ savedLabel() }} ▾
        </button>
        <ng-container [ngTemplateOutlet]="listPanel" />
      </div>
    </ng-template>

    <ng-template #listPanel>
      @if (listMenuOpen()) {
          <div class="lm-backdrop" (click)="listMenuOpen.set(false)"></div>
          <div class="lm-panel" role="menu">
            <!-- Marking a film watched clears its watchlist flag in the store, so
                 the row would only ever read "off" here — hide it while watched
                 rather than offering a toggle that contradicts the state. -->
            @if (!movie()?.state?.watched) {
              <button
                class="lm-row"
                type="button"
                role="menuitemcheckbox"
                [attr.aria-checked]="movie()?.state?.watchlist ?? false"
                (click)="toggleWatchlist()"
              >
                <span class="lm-check">{{ movie()?.state?.watchlist ? '✓' : '' }}</span>
                <span class="lm-name">Watchlist</span>
              </button>
              <div class="lm-sep"></div>
            }
            @if (listRows().length) {
              @for (l of listRows(); track l.id) {
                <button
                  class="lm-row"
                  type="button"
                  role="menuitemcheckbox"
                  [attr.aria-checked]="l.member"
                  (click)="toggleList(l.id)"
                >
                  <span class="lm-check">{{ l.member ? '✓' : '' }}</span>
                  <span class="lm-name">{{ l.name }}</span>
                </button>
              }
              <div class="lm-sep"></div>
            } @else {
              <div class="lm-empty">No lists yet — make one:</div>
            }
            <form class="lm-new" (submit)="$event.preventDefault(); createListWithMovie()">
              <input
                class="lm-input"
                placeholder="New list…"
                [value]="newListName()"
                (input)="newListName.set($any($event.target).value)"
              />
              <button class="btn sm" type="submit" [disabled]="!newListName().trim()">Add</button>
            </form>
            @if (isAdded()) {
              <div class="lm-sep"></div>
              <button
                class="lm-row danger"
                type="button"
                role="menuitem"
                (click)="listMenuOpen.set(false); removing.set(true)"
              >
                <span class="lm-check">✕</span>
                <span class="lm-name">Remove from library</span>
              </button>
            }
          </div>
      }
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
  /** In-library, and added from TMDB — so the "In library" toggle can remove it. */
  readonly isAdded = computed(() => !!this.stored() && this.previewId() !== null);
  readonly adding = signal(false);
  /** Whether the "remove from library?" confirmation is showing. */
  readonly removing = signal(false);

  /** Whether the "add to list" dropdown is open, and the new-list draft name. */
  readonly listMenuOpen = signal(false);
  readonly newListName = signal('');

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

  /**
   * The custom lists, each flagged with whether this film is on it. Resolved
   * once here rather than calling `isInList` twice per row from the template.
   */
  readonly listRows = computed(() =>
    this.store.lists().map((l) => ({ ...l, member: this.store.isInList(l.id, this.uuid()) })),
  );

  /** How many custom lists this film currently belongs to. */
  private readonly listCount = computed(() => this.listRows().filter((l) => l.member).length);

  /** Whether the film sits on the watchlist or in any list — i.e. deliberately saved. */
  readonly isSaved = computed(
    () => (this.movie()?.state.watchlist ?? false) || this.listCount() > 0,
  );

  /**
   * One label summarising everywhere this film is saved, so the single control
   * reads back its own state. Being in the library is not itself "saved" — once
   * the last watchlist/list membership is dropped the control invites saving
   * again rather than claiming a state the film no longer has.
   */
  readonly savedLabel = computed(() => {
    const onWatchlist = this.movie()?.state.watchlist ?? false;
    const lists = this.listCount();
    if (onWatchlist && lists) return `✓ Watchlist +${lists}`;
    if (onWatchlist) return '✓ Watchlist';
    if (lists) return `✓ In ${lists} list${lists > 1 ? 's' : ''}`;
    return '+ Save';
  });

  /** Toggle the watchlist flag, adding a previewed film to the library first. */
  async toggleWatchlist(): Promise<void> {
    await this.ensureInLibrary();
    this.store.toggleMovieWatchlist(this.uuid());
  }

  rate(n: number): void {
    const cur = this.movie()?.state.rating;
    this.store.rateMovie(this.uuid(), cur === n ? null : n);
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
   * Toggle this film's membership in a custom list. If we're still previewing a
   * TMDB title, add it to the library first so the list item has something real
   * to resolve to — the uuid is deterministic, so it's the same before and after.
   */
  async toggleList(listId: string): Promise<void> {
    await this.ensureInLibrary();
    const uuid = this.uuid();
    if (this.store.isInList(listId, uuid)) {
      this.store.removeListItem(listId, { uuid });
    } else {
      this.store.addListItem(listId, { uuid, title: this.movie()!.name, entityType: 'movie' });
    }
  }

  /** Create a new list from the draft name and drop this film straight into it. */
  async createListWithMovie(): Promise<void> {
    const name = this.newListName().trim();
    if (!name) return;
    await this.ensureInLibrary();
    const id = this.store.createList(name);
    this.store.addListItem(id, { uuid: this.uuid(), title: this.movie()!.name, entityType: 'movie' });
    this.newListName.set('');
  }

  private async ensureInLibrary(): Promise<void> {
    if (this.isPreview()) await this.addToLibrary();
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

/** The 1-10 rating pips. Hoisted so the template doesn't rebuild it per cycle. */
const RATING_PIPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
