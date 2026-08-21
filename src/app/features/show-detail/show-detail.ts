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
import { Router, RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { parseAddedKey } from '../../core/doc.service';
import { TmdbService, TmdbShow, TmdbEpisode, WatchProvider, tmdbPosterUrl } from '../../core/tmdb.service';
import type { ShowStatus, ShowView } from '../../core/models';
import { BackNav } from '../../shared/back-nav';
import { ConfirmDialog } from '../../shared/confirm-dialog';
import { EpisodeRatingDialog } from '../../shared/episode-rating-dialog';
import { YearPipe } from '../../shared/year';
import { stremioUrl, openStremio } from '../../shared/stremio';
import { WheelX } from '../../shared/wheel-x';
import { SaveMenu } from '../../shared/save-menu';

@Component({
  selector: 'app-show-detail',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    ConfirmDialog,
    EpisodeRatingDialog,
    YearPipe,
    WheelX,
    SaveMenu,
  ],
  template: `
    @if (show(); as s) {
      <div class="detail">
        <div class="hero" [style.background-image]="backdrop()">
          <div class="scrim"></div>
          <button class="back" type="button" (click)="nav.back('/shows')">← Back</button>
          <div class="hero-inner">
            <img
              class="poster"
              [src]="posterUrl() || s.cachedPoster || ''"
              [alt]="s.name"
              decoding="async"
            />
            <div class="info">
              <h1>{{ s.name }}</h1>
              <div class="facts">
                @if (tmdbShow()?.firstAirDate) { <span>{{ tmdbShow()!.firstAirDate | year }}</span> }
                @if (tmdbShow()?.status) { <span>{{ tmdbShow()!.status }}</span> }
                @if (s.network || tmdbShow()?.networks?.length) { <span>{{ s.network || tmdbShow()!.networks[0] }}</span> }
                @if (totalEpisodes()) { <span>{{ totalEpisodes() }} episodes</span> }
                @if (stremioUrl(); as stremio) {
                  <a class="stremio-badge" [href]="stremio" (click)="onStremioClick($event)" target="_blank" rel="noopener" title="Open in Stremio">Stremio</a>
                }
              </div>
              @if (tmdbShow()?.watchProviders; as wp) {
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
              <p class="overview">{{ tmdbShow()?.overview || s.overview || 'No synopsis available.' }}</p>

              <div class="controls">
                @if (isPreview()) {
                  <div class="list-menu split">
                    <button class="btn primary add" [disabled]="adding()" (click)="addToLibrary()">
                      {{ adding() ? 'Adding…' : '+ Add to library' }}
                    </button>
                    <ng-container [ngTemplateOutlet]="saveMenu" />
                  </div>
                } @else {
                  @if (isAdded()) {
                    <button class="btn in-lib" (click)="removing.set(true)" title="Remove from library">
                      <span class="lbl-in">✓ In library</span><span class="lbl-out">✕ Remove</span>
                    </button>
                  }
                  <select class="status-sel" [value]="s.state.status" (change)="setStatus($any($event.target).value)">
                    <option value="none">Not in my library</option>
                    <option value="watching">Watching</option>
                    <option value="paused">Paused</option>
                    <option value="completed">Completed</option>
                    <option value="watchlist">Watchlist</option>
                    <option value="dropped">Dropped</option>
                  </select>
                  <button class="btn" [class.primary]="s.state.favorite" (click)="store.toggleShowFavorite(s.uuid)">
                    ★ {{ s.state.favorite ? 'Favorited' : 'Favorite' }}
                  </button>
                  <div class="list-menu">
                    <ng-container [ngTemplateOutlet]="saveMenu" />
                  </div>
                  <div class="rating" role="radiogroup" aria-label="Your rating out of 10">
                    @for (n of RATING_PIPS; track n) {
                      <button
                        type="button"
                        class="pip"
                        role="radio"
                        [class.on]="(s.state.rating || 0) >= n"
                        [attr.aria-checked]="s.state.rating === n"
                        [attr.aria-label]="'Rate ' + n + ' out of 10'"
                        (click)="rate(n)"
                      >
                        {{ n }}
                      </button>
                    }
                  </div>
                }
              </div>

              @if (markingAll()) {
                <div class="marking">Marking all episodes as watched…</div>
              } @else if (progress() > 0) {
                <div class="progress">
                  <div class="bar"><div class="fill" [style.width.%]="progress()"></div></div>
                  <span>{{ s.watchedEpisodeCount }} / {{ totalEpisodes() }} watched</span>
                </div>
              }
            </div>
          </div>
        </div>

        <div class="body">
          @if (ratingNote(); as note) {
            <p class="rate-note" role="status">
              {{ note }}
              <button type="button" class="rate-dismiss" aria-label="Dismiss" (click)="ratingNote.set(null)">
                ✕
              </button>
            </p>
          }
          @if (castRows().length) {
            <h2 class="sec">Cast</h2>
            <div class="cast-rail" appWheelX>
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
          }
          @if (!tmdb.hasKey()) {
            <div class="notice">
              Add a free <a routerLink="/settings">TMDB API key</a> to load seasons, episodes and posters.
            </div>
          } @else if (loadingSeasons()) {
            <div class="empty">Loading episodes…</div>
          } @else if (seasonRows().length) {
            @for (season of seasonRows(); track season.seasonNumber) {
              <section class="season">
                <header (click)="toggleSeason(season.seasonNumber)">
                  <div class="s-title">
                    <span class="caret" [class.open]="season.isOpen">▸</span>
                    Season {{ season.seasonNumber }}
                    <span class="s-count">{{ season.watchedCount }}/{{ season.episodeCount }}</span>
                  </div>
                  @if (!isPreview()) {
                  <button
                    class="s-mark"
                    [class.done]="season.complete"
                    [disabled]="!season.canToggle"
                    (click)="askSeason($event, season)"
                    [title]="season.markTitle"
                    [attr.aria-pressed]="season.complete"
                    [attr.aria-label]="season.ariaLabel"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
                  </button>
                  }
                </header>
                @if (season.isOpen) {
                  <div class="eps">
                    @for (row of season.episodes; track row.ep.episodeNumber) {
                      <div class="ep" [class.watched]="row.watched">
                        @if (!isPreview()) {
                          <button class="tick" (click)="toggle(s.tvdbId, row.ep)">
                            {{ row.watched ? '✓' : '' }}
                          </button>
                        }
                        <div class="ep-num">{{ row.ep.episodeNumber }}</div>
                        <!-- The row itself opens the episode: everything TMDB
                             sent with the season is already here, so reading
                             about one costs no request. -->
                        <button class="ep-main" type="button" (click)="openEpisode(row.ep)">
                          <div class="ep-name">{{ row.label }}</div>
                          <div class="ep-sub">
                            @if (row.ep.airDate) { <span>{{ row.ep.airDate }}</span> }
                            @if (row.watchedOn) {
                              <span class="ep-seen">✓ Watched {{ row.watchedOn }}</span>
                            }
                          </div>
                        </button>
                        @if (row.score) {
                          <span class="ep-score" [title]="'TMDB community rating: ' + row.score + '/10'">
                            {{ row.score }}
                          </span>
                        }
                        @if (!isPreview()) {
                          <button
                            class="ep-rate"
                            [class.rated]="row.rating"
                            [title]="row.rateLabel"
                            [attr.aria-label]="row.rateLabel"
                            (click)="askRating(row.ep, row.rating)"
                          >
                            ★<span class="val">{{ row.rating }}</span>
                          </button>
                        }
                      </div>
                    }
                    @if (!season.loaded) {
                      <div class="empty sm">Loading…</div>
                    }
                  </div>
                }
              </section>
            }
          } @else {
            <div class="empty">No episode data found on TMDB for this show.</div>
          }
        </div>
      </div>
    } @else if (loadingSeasons() || redirecting()) {
      <div class="page"><div class="empty">Loading show…</div></div>
    } @else {
      <div class="page"><div class="empty">Show not found.</div></div>
    }

    @if (pending(); as p) {
      <app-confirm-dialog
        [open]="true"
        [danger]="p.watched"
        [heading]="
          p.watched
            ? 'Unmark season ' + p.season + '?'
            : p.from === p.through
              ? 'Mark season ' + p.through + ' as watched?'
              : 'Mark seasons ' + p.from + '–' + p.through + ' as watched?'
        "
        [message]="
          p.watched
            ? 'This clears your watch history for all ' + p.count + ' episodes of season ' + p.season + '. Later seasons are left alone.'
            : (p.through !== p.season ? 'Season ' + p.season + ' hasn’t aired yet. ' : '') +
              (p.from === p.through
                ? 'This marks all ' + p.count + ' episodes of season ' + p.through + ' as watched.'
                : 'This marks all ' + p.count + ' episodes up to the end of season ' + p.through + ' as watched, including earlier seasons you haven’t finished.')
        "
        [confirmLabel]="p.watched ? 'Unmark all' : 'Mark all watched'"
        (confirmed)="applySeason()"
        (dismissed)="pending.set(null)"
      />
    }

    @if (ratingFor(); as r) {
      <app-episode-rating-dialog
        [open]="true"
        [showName]="show()?.name ?? ''"
        [code]="'S' + r.ep.seasonNumber + '·E' + r.ep.episodeNumber"
        [episodeTitle]="r.ep.name"
        [still]="r.stillUrl"
        [overview]="r.ep.overview"
        [airDate]="r.ep.airDate"
        [runtime]="r.ep.runtime"
        [communityScore]="r.ep.voteAverage"
        [watched]="r.watched"
        [current]="r.current"
        [destination]="ratingDestination()"
        (watchedToggled)="toggleWatchedFromDialog()"
        (rated)="submitRating($event)"
        (cleared)="submitRating(null)"
        (dismissed)="ratingFor.set(null)"
      />
    }

    @if (removing()) {
      <app-confirm-dialog
        [open]="true"
        [danger]="true"
        heading="Remove from library?"
        message="This deletes the show from your library along with its rating and watch history. You can add it again anytime."
        confirmLabel="Remove"
        (confirmed)="confirmRemove()"
        (dismissed)="removing.set(false)"
      />
    }

    <ng-template #saveMenu>
      <app-save-menu
        [uuid]="uuid()"
        [title]="show()?.name ?? ''"
        entityType="show"
        [watchlist]="watchlistRow()"
        [variant]="isPreview() ? 'caret' : 'button'"
        [ensureSaveable]="ensureInLibrary"
        (watchlistToggled)="toggleWatchlist()"
      />
    </ng-template>
  `,
  styleUrl: './show-detail.scss',
  // Every binding reads a signal or computed; the per-season and per-episode
  // work now happens in `seasonRows()` rather than inline in the template.
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShowDetail {
  store = inject(LibraryStore);
  nav = inject(BackNav);
  tmdb = inject(TmdbService);
  private readonly router = inject(Router);

  readonly uuid = input.required<string>();

  /** The library entry for this uuid, if the show is actually in the library. */
  private readonly stored = computed(() => this.store.show(this.uuid()));

  /** TMDB id to preview from, when the route points at a show not yet added. */
  private readonly previewId = computed(() => {
    const p = parseAddedKey(this.uuid());
    return p?.kind === 'show' ? p.tmdbId : null;
  });

  /**
   * Where this show really lives, when the route addresses it by a TMDB uuid the
   * library deduped away (see `LibraryStore.canonicalUuid`). Non-null means this
   * page is standing in front of the user's actual entry.
   */
  private readonly canonical = computed(() => this.store.canonicalUuid(this.uuid()));

  /**
   * A redirect to the canonical uuid is on its way. The template treats this as
   * loading: neither the preview nor the library view can render a title this
   * uuid doesn't resolve to, and "Show not found." is the wrong thing to flash at
   * someone on their way to a show they follow.
   */
  readonly redirecting = computed(() => this.canonical() !== null);

  /**
   * Read-only mode: showing a TMDB title the user hasn't added to the library.
   *
   * A superseded uuid is explicitly *not* a preview — the show is in the
   * library, just under another uuid — otherwise the page would offer to add a
   * show the user already has while the redirect below is still in flight.
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
   * The show to render: the real library entry, or — in preview — one
   * synthesized from the fetched TMDB data so the whole detail template works
   * unchanged. Undefined while a preview is still loading (or genuinely missing).
   */
  readonly show = computed<ShowView | undefined>(() => {
    const s = this.stored();
    if (s) return s;
    const info = this.tmdbShow();
    return this.isPreview() && info ? previewShowView(this.uuid(), info) : undefined;
  });

  /**
   * The season toggle awaiting confirmation, if any. `from`..`season` is the
   * span the action covers — marking cascades back to season 1, unmarking
   * doesn't, so `from` equals `season` in that direction.
   */
  readonly pending = signal<{
    /** The season whose ring was clicked. */
    season: number;
    from: number;
    /** Last season in range with episodes — may trail `season` if it's unaired. */
    through: number;
    count: number;
    watched: boolean;
  } | null>(null);

  readonly tmdbShow = signal<TmdbShow | null>(null);
  readonly episodes = signal<Record<number, TmdbEpisode[]>>({});
  readonly loadingSeasons = signal(false);
  readonly markingAll = signal(false);
  private open = signal<Set<number>>(new Set());

  readonly posterUrl = computed(() => this.tmdb.poster(this.tmdbShow()?.posterPath ?? null, 'w342'));
  readonly backdrop = computed(() => {
    const b = this.tmdb.poster(this.tmdbShow()?.backdropPath ?? null, 'original');
    return b ? `url(${b})` : 'none';
  });
  readonly totalEpisodes = computed(() =>
    (this.tmdbShow()?.seasons ?? []).reduce((n, s) => n + s.episodeCount, 0),
  );

  /** A Stremio Web link for this show, once its IMDb id is known. */
  readonly stremioUrl = computed(() => stremioUrl('series', this.tmdbShow()?.imdbId ?? null));

  /** Cast with headshot URLs and placeholder initials resolved once. */
  readonly castRows = computed(() =>
    (this.tmdbShow()?.cast ?? []).map((c) => ({
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

  /** Rent and buy providers merged (deduped) for the paid-options badge row. */
  readonly rentOrBuy = computed<WatchProvider[]>(() => {
    const wp = this.tmdbShow()?.watchProviders;
    if (!wp) return [];
    const byName = new Map<string, WatchProvider>();
    for (const p of [...wp.rent, ...wp.buy]) if (!byName.has(p.name)) byName.set(p.name, p);
    return [...byName.values()];
  });
  readonly progress = computed(() => {
    const total = this.totalEpisodes();
    if (!total) return 0;
    return Math.min(100, Math.round(((this.show()?.watchedEpisodeCount ?? 0) / total) * 100));
  });

  readonly RATING_PIPS = RATING_PIPS;

  /** TMDB's genre list when it has one, else whatever the backup recorded. */
  readonly genres = computed(() => {
    const fromTmdb = this.tmdbShow()?.genres ?? [];
    return fromTmdb.length ? fromTmdb : this.show()?.genres ?? [];
  });

  /** Provider badges with their logo URL and tooltip resolved once. */
  readonly streamingLogos = computed(() =>
    (this.tmdbShow()?.watchProviders?.streaming ?? []).map((p) => ({
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

  /**
   * Everything the season list renders, derived in a single pass.
   *
   * The template previously called `seasonComplete` three times per header plus
   * `canToggleSeason` — which itself allocated a filtered array and re-ran
   * `seasonComplete` across it — making the season list O(seasons²) on every
   * change detection cycle. Completion is computed once per season here and the
   * "can toggle" check reads that map, so the whole thing is linear and only
   * re-runs when the watch data, the open set or the episode lists actually
   * change.
   */
  readonly seasonRows = computed(() => {
    const seasons = this.tmdbShow()?.seasons ?? [];
    const tvdbId = this.show()?.tvdbId ?? null;
    const open = this.open();
    const loaded = this.episodes();
    const preview = this.isPreview();

    const watchedCount = (n: number) => (tvdbId ? this.store.watchedInSeason(tvdbId, n) : 0);
    const complete = new Map<number, boolean>();
    for (const x of seasons) {
      complete.set(
        x.seasonNumber,
        !!tvdbId && x.episodeCount > 0 && watchedCount(x.seasonNumber) >= x.episodeCount,
      );
    }
    // Seasons that have actually aired — the only ones a cascade can cover.
    const aired = seasons.filter((x) => x.episodeCount > 0);

    return seasons.map((season) => {
      const n = season.seasonNumber;
      const done = complete.get(n)!;
      const eps = loaded[n];
      return {
        ...season,
        isOpen: open.has(n),
        complete: done,
        watchedCount: watchedCount(n),
        // Unmarking is always available on a complete season; marking needs at
        // least one unfinished season at or below this one.
        canToggle:
          !!tvdbId &&
          !preview &&
          (done || aired.some((x) => x.seasonNumber <= n && !complete.get(x.seasonNumber))),
        markTitle: done ? `Unmark season ${n}` : `Mark season ${n} watched`,
        ariaLabel: `Season ${n} watched`,
        loaded: !!eps,
        episodes: (eps ?? []).map((ep) => {
          const rating = tvdbId
            ? this.store.episodeRating(tvdbId, ep.seasonNumber, ep.episodeNumber)
            : null;
          const watchedAt = tvdbId
            ? this.store.episodeWatchedAt(tvdbId, ep.seasonNumber, ep.episodeNumber)
            : null;
          return {
            ep,
            watched: !!watchedAt,
            label: ep.name || `Episode ${ep.episodeNumber}`,
            // Formatted here, not in the template: a date pipe would re-run for
            // every episode of every open season on each change-detection pass.
            watchedOn: formatDay(watchedAt),
            rating,
            rateLabel: rating
              ? `Your rating: ${rating} out of 10 — change it`
              : `Rate episode ${ep.episodeNumber}`,
            // TMDB's community score, to one decimal like TMDB shows it.
            score: ep.voteAverage ? ep.voteAverage.toFixed(1) : null,
          };
        }),
      };
    });
  });

  constructor() {
    // A Trending card (or a link from another device) can address a show by its
    // TMDB uuid even though the library already holds it under the catalog's own
    // uuid. Send the user to the entry that carries their watch history rather than to a
    // page offering to add what they already have. `replaceUrl` keeps the dead
    // uuid out of history so Back still leaves the detail page.
    effect(() => {
      const canonical = this.canonical();
      if (canonical) this.router.navigate(['/shows', canonical], { replaceUrl: true });
    });

    // Load the TMDB show whenever the route changes. A library show resolves by
    // its TheTVDB id; a preview (not yet added) resolves straight from the TMDB
    // id in the uuid. Keyed off `stored`/`previewId`, NOT `show()` — `show()`
    // derives from `tmdbShow`, so depending on it here would loop.
    effect(() => {
      const s = this.stored();
      const previewId = this.previewId();
      // Adding a previewed show flips `stored` from undefined to the new entry
      // for the SAME tmdb id we already loaded — keep the fetched detail rather
      // than nulling it and refetching the identical data. (untracked so the
      // effect never re-fires on its own tmdbShow writes.)
      if (s && previewId !== null && untracked(this.tmdbShow)?.id === previewId) return;
      this.tmdbShow.set(null);
      this.episodes.set({});
      if (!this.tmdb.hasKey()) return;
      if (s?.tvdbId) this.loadShow(this.tmdb.showByTvdb(s.tvdbId));
      else if (!s && previewId !== null) this.loadShow(this.tmdb.show(previewId));
    });
  }

  private async loadShow(fetch: Promise<TmdbShow | null>): Promise<void> {
    this.loadingSeasons.set(true);
    const info = await fetch;
    this.tmdbShow.set(info);
    this.loadingSeasons.set(false);
    // Auto-open the season you're mid-way through: the first aired season that
    // isn't fully watched. Finished seasons stay collapsed, and a fully-watched
    // show opens nothing. (A preview show has no watch data, so this falls to
    // its first aired season.)
    if (info?.seasons.length) {
      const tvdbId = this.stored()?.tvdbId ?? null;
      const ongoing = info.seasons.find(
        (s) => s.episodeCount > 0 && !this.seasonComplete(tvdbId, s),
      );
      if (ongoing) {
        this.open.set(new Set([ongoing.seasonNumber]));
        this.loadSeason(info.id, ongoing.seasonNumber);
      } else {
        this.open.set(new Set());
      }
    }
  }

  /**
   * Commit a previewed show to the library. The uuid is deterministic, so once
   * `addShow` writes the entry `stored()` flips to it and the page swaps from
   * preview to the full interactive detail in place — no navigation needed.
   */
  async addToLibrary(): Promise<void> {
    // A second caller joins the add already running rather than returning
    // straight away: the list menu adds the show before writing a status or a
    // list item, and a caller that didn't wait would have its write overwritten
    // by the add's own `showState` entry landing after it.
    if (this.inflightAdd) return this.inflightAdd;
    const id = this.previewId();
    const info = this.tmdbShow();
    if (id === null || !info) return;
    this.adding.set(true);
    // Hand the already-fetched detail to the store so it doesn't re-request it.
    this.inflightAdd = this.store
      .addShow(
        {
          tmdbId: id,
          name: info.name,
          overview: info.overview,
          posterPath: info.posterPath,
          year: info.firstAirDate?.slice(0, 4) ?? null,
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
   * Remove this show from the library. Its uuid is the deterministic TMDB
   * added-key, so once the entry is gone `stored()` flips back to undefined and
   * the page reactively returns to its "+ Add to library" preview — the button
   * toggles in place rather than navigating away.
   */
  confirmRemove(): void {
    this.removing.set(false);
    if (!this.isAdded()) return;
    this.store.removeAdded('show', this.uuid());
  }

  private async loadSeason(tmdbId: number, seasonNumber: number): Promise<void> {
    if (this.episodes()[seasonNumber]) return;
    const eps = await this.tmdb.season(tmdbId, seasonNumber);
    this.episodes.update((m) => ({ ...m, [seasonNumber]: eps }));
  }

  /**
   * Load several seasons at once. These requests are independent, so awaiting
   * them one at a time — as "mark all watched" used to — serialized a full
   * round-trip per season; a 15-season show meant 15 sequential fetches before
   * the UI unblocked. Already-loaded seasons short-circuit inside loadSeason.
   */
  private async loadSeasons(tmdbId: number, seasonNumbers: number[]): Promise<void> {
    await Promise.all(seasonNumbers.map((n) => this.loadSeason(tmdbId, n)));
  }

  toggleSeason(n: number): void {
    const set = new Set(this.open());
    if (set.has(n)) set.delete(n);
    else {
      set.add(n);
      const id = this.tmdbShow()?.id;
      if (id) this.loadSeason(id, n);
    }
    this.open.set(set);
  }

  isWatched(tvdbId: string | null, ep: TmdbEpisode): boolean {
    return !!tvdbId && this.store.isEpisodeWatched(tvdbId, ep.seasonNumber, ep.episodeNumber);
  }
  toggle(tvdbId: string | null, ep: TmdbEpisode): void {
    if (!tvdbId || this.isPreview()) return;
    this.store.setEpisodeWatched(tvdbId, ep.seasonNumber, ep.episodeNumber, !this.isWatched(tvdbId, ep));
  }

  /** True once every episode of a season is watched (hides its "Mark all"). */
  seasonComplete(
    tvdbId: string | null,
    season: { seasonNumber: number; episodeCount: number },
  ): boolean {
    return (
      !!tvdbId &&
      season.episodeCount > 0 &&
      this.store.watchedInSeason(tvdbId, season.seasonNumber) >= season.episodeCount
    );
  }

  /**
   * The seasons a "mark watched" on `n` covers: everything up to and including
   * it that actually has episodes.
   *
   * The `episodeCount > 0` filter matters for the season the user clicked, not
   * just the ones before it — a show's newest season is often listed by TMDB
   * before anything airs, and clicking that must still mark the seasons behind
   * it rather than doing nothing.
   */
  private spanUpTo(n: number): { seasonNumber: number; episodeCount: number }[] {
    return (this.tmdbShow()?.seasons ?? []).filter((x) => x.seasonNumber <= n && x.episodeCount > 0);
  }

  /**
   * Toggling a whole season is destructive in both directions — it either
   * writes or erases a season's worth of history — so it always goes through a
   * confirmation rather than firing on the click.
   */
  askSeason(evt: Event, season: { seasonNumber: number; episodeCount: number }): void {
    evt.stopPropagation(); // the header row toggles the season open
    const tvdbId = this.show()?.tvdbId;
    if (!tvdbId) return;

    // Unmarking never cascades — clearing season 3 shouldn't erase seasons you
    // did watch — so it stands alone.
    if (this.seasonComplete(tvdbId, season)) {
      this.pending.set({
        season: season.seasonNumber,
        from: season.seasonNumber,
        through: season.seasonNumber,
        count: season.episodeCount,
        watched: true,
      });
      return;
    }

    const span = this.spanUpTo(season.seasonNumber);
    if (!span.length) return; // nothing has aired yet anywhere in range
    this.pending.set({
      season: season.seasonNumber,
      from: span[0].seasonNumber,
      through: span[span.length - 1].seasonNumber,
      count: span.reduce((n, x) => n + x.episodeCount, 0),
      watched: false,
    });
  }

  async applySeason(): Promise<void> {
    const p = this.pending();
    this.pending.set(null);
    const s = this.show();
    if (!p || !s?.tvdbId || !this.tmdbShow()) return;

    if (p.watched) {
      await this.loadSeason(this.tmdbShow()!.id, p.season);
      const numbers = (this.episodes()[p.season] ?? []).map((e) => e.episodeNumber);
      if (!numbers.length) return; // season failed to load — nothing to change
      this.store.setSeasonWatched(s.tvdbId, p.season, numbers, false);
      return;
    }

    // `through` is the last season in range that has episodes — which is not
    // necessarily the one clicked, since an unaired season contributes none.
    const seasons = this.spanUpTo(p.through);
    await this.loadSeasons(
      this.tmdbShow()!.id,
      seasons.map((x) => x.seasonNumber),
    );
    const payload = seasons.map((x) => ({
      season: x.seasonNumber,
      episodes: (this.episodes()[x.seasonNumber] ?? []).map((e) => ({
        number: e.episodeNumber,
        airDate: e.airDate,
      })),
    }));
    const last = payload.find((x) => x.season === p.through)?.episodes ?? [];
    if (!last.length) return; // target season failed to load — nothing to mark
    this.store.markWatchedUpTo(
      s.tvdbId,
      p.through,
      Math.max(...last.map((e) => e.number)),
      payload,
    );
  }

  async setStatus(v: string): Promise<void> {
    this.store.setShowStatus(this.uuid(), v as ShowStatus);
    // Completing a show marks its whole run watched.
    if (v === 'completed') await this.markAllWatched();
  }

  /** Mark every episode of every season as watched (used when completing). */
  private async markAllWatched(): Promise<void> {
    const s = this.show();
    const info = this.tmdbShow();
    if (!s?.tvdbId || !info?.seasons.length) return; // no episode data (e.g. no TMDB key)
    this.markingAll.set(true);
    try {
      await this.loadSeasons(
        info.id,
        info.seasons.map((season) => season.seasonNumber),
      );
      const payload = info.seasons.map((season) => ({
        season: season.seasonNumber,
        episodes: (this.episodes()[season.seasonNumber] ?? []).map((e) => ({
          number: e.episodeNumber,
          airDate: e.airDate,
        })),
      }));
      const last = info.seasons[info.seasons.length - 1];
      const lastEps = this.episodes()[last.seasonNumber] ?? [];
      // If the final season's list failed to load, an unbounded ceiling still
      // marks everything `payload` did contain — it never invents episodes.
      const lastEp = lastEps.length
        ? Math.max(...lastEps.map((e) => e.episodeNumber))
        : Number.MAX_SAFE_INTEGER;
      this.store.markWatchedUpTo(s.tvdbId, last.seasonNumber, lastEp, payload);
    } finally {
      this.markingAll.set(false);
    }
  }

  rate(n: number): void {
    const cur = this.show()?.state.rating;
    this.store.rateShow(this.uuid(), cur === n ? null : n);
  }

  // -------------------------------------------------------------------------
  // Watchlist and custom lists
  // -------------------------------------------------------------------------
  readonly onWatchlist = computed(() => this.show()?.state.status === 'watchlist');

  /**
   * What the menu's watchlist row should show, or null to leave it out.
   *
   * A show's watchlist state is one of its statuses rather than a flag beside
   * them, so the row is only meaningful while the show is unstarted: offering
   * "Watchlist" next to "Watching" would be a toggle that silently throws away
   * where the user is in the show.
   */
  readonly watchlistRow = computed<boolean | null>(() => {
    const status = this.show()?.state.status ?? 'none';
    if (status !== 'none' && status !== 'watchlist') return null;
    return status === 'watchlist';
  });

  /**
   * Put the show on the watchlist, or take it off again. Off means back to
   * "not in my library" — the status it held before, since the row only shows
   * while the show is unstarted.
   *
   * Which way the toggle goes is decided from the state the user clicked, not
   * from the state after the add: bringing a previewed show into the library
   * already lands it on the watchlist, and re-reading it here would take the
   * click as a request to undo that.
   */
  async toggleWatchlist(): Promise<void> {
    const wanted = !this.onWatchlist();
    await this.ensureInLibrary();
    this.store.setShowStatus(this.uuid(), wanted ? 'watchlist' : 'none');
  }

  /**
   * Bring a previewed show into the library so a list item has something real
   * to resolve to. The uuid is deterministic, so it's the same before and after.
   *
   * `addShow` files a show as *Watching*, which is right when the user pressed
   * "+ Add to library" and wrong here: filing something into a list says you
   * mean to watch it, not that you have started. So an add triggered this way
   * lands on the watchlist instead — the same place `addMovie` puts a film, and
   * the only status that leaves the menu's Watchlist row meaningful.
   *
   * Bound as a field, not a method: it is handed to `app-save-menu` as an
   * input, and a method reference would arrive with no `this`.
   */
  readonly ensureInLibrary = async (): Promise<void> => {
    if (!this.isPreview()) return;
    await this.addToLibrary();
    if (this.stored()) this.store.setShowStatus(this.uuid(), 'watchlist');
  };

  // -------------------------------------------------------------------------
  // Per-episode ratings
  // -------------------------------------------------------------------------
  /** The episode whose rating modal is open, with the score it starts from. */
  readonly ratingFor = signal<{
    ep: TmdbEpisode;
    current: number | null;
    stillUrl: string | null;
    /** Null while the dialog follows a tick — see `EpisodeRatingDialog`. */
    watched: boolean | null;
  } | null>(null);
  /** What became of the last rating — mainly, whether TMDB accepted it. */
  readonly ratingNote = signal<string | null>(null);

  /** Where a rating goes, so the modal can say so before it's given. */
  readonly ratingDestination = computed(() =>
    this.tmdb.hasAccount() ? 'Also sent to your TMDB account' : 'Also sent to TMDB',
  );

  askRating(ep: TmdbEpisode, current: number | null): void {
    this.openDialog(ep, current, null);
  }

  /**
   * Open an episode to read about it. Same dialog as rating one — an episode is
   * one thing, and having tapped it you can just as well say what you thought —
   * but this way in also offers the watch toggle, since you may be reading to
   * decide rather than reporting back.
   */
  openEpisode(ep: TmdbEpisode): void {
    const tvdbId = this.show()?.tvdbId ?? null;
    const rating = tvdbId
      ? this.store.episodeRating(tvdbId, ep.seasonNumber, ep.episodeNumber)
      : null;
    this.openDialog(ep, rating, this.isWatched(tvdbId, ep));
  }

  private openDialog(ep: TmdbEpisode, current: number | null, watched: boolean | null): void {
    if (this.isPreview() || !this.show()?.tvdbId) return;
    this.ratingNote.set(null);
    this.ratingFor.set({
      ep,
      current,
      watched,
      stillUrl: this.tmdb.poster(ep.stillPath, 'w500'),
    });
  }

  /** Tick the open episode off (or back on) without leaving the dialog. */
  toggleWatchedFromDialog(): void {
    const target = this.ratingFor();
    const tvdbId = this.show()?.tvdbId;
    if (!target || !tvdbId) return;
    this.toggle(tvdbId, target.ep);
    this.ratingFor.set({ ...target, watched: this.isWatched(tvdbId, target.ep) });
  }

  /**
   * Store the score — or withdraw it, with `null` — and mirror it to TMDB. The
   * dialog stays up until the user closes it; the local write is instant, and
   * the badge in the list updates from it immediately behind the modal.
   */
  async submitRating(value: number | null): Promise<void> {
    const target = this.ratingFor();
    const tvdbId = this.show()?.tvdbId;
    if (!target || !tvdbId) return;

    const { seasonNumber, episodeNumber } = target.ep;
    const outcome = await this.store.rateEpisodeAndPush(
      tvdbId,
      seasonNumber,
      episodeNumber,
      value,
    );
    const code = `S${seasonNumber}·E${episodeNumber}`;
    this.ratingNote.set(
      value == null ? `${code} rating cleared — ${outcome}` : `${code} rated ${value}/10 — ${outcome}`,
    );
  }
}

/** Reused across every episode row, rather than rebuilt per format call. */
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/**
 * A watch timestamp as a short local date. Returns null for anything that
 * doesn't parse — an imported backup can carry stamps we've never seen, and a
 * row is better off showing no date than "Invalid Date".
 */
function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DAY_FORMAT.format(t) : null;
}

/**
 * A throwaway `ShowView` built from TMDB data so the detail template can render
 * a show that isn't in the library yet. State is neutral ("not in my library",
 * nothing watched); the page shows an "Add to library" button instead of the
 * tracking controls, and none of this is ever written to the CRDT.
 */
/** The 1-10 rating pips. Hoisted so the template doesn't rebuild it per cycle. */
const RATING_PIPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function previewShowView(uuid: string, t: TmdbShow): ShowView {
  return {
    uuid,
    name: t.name,
    tvdbId: t.tvdbId,
    genres: t.genres,
    firstReleaseDate: t.firstAirDate,
    overview: t.overview,
    followedAt: null,
    showWatchedAt: null,
    isEnded: null,
    dayOfWeek: null,
    network: t.networks[0] ?? null,
    country: null,
    hashtag: null,
    cachedPoster: tmdbPosterUrl(t.posterPath),
    favorite: false,
    state: { status: 'none', favorite: false, rating: null, addedAt: null, updatedAt: null },
    watchedEpisodeCount: 0,
  };
}
