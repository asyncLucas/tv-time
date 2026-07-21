import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { parseAddedKey } from '../../core/doc.service';
import { TmdbService, TmdbShow, TmdbEpisode, tmdbPosterUrl } from '../../core/tmdb.service';
import type { ShowStatus, ShowView } from '../../core/models';
import { BackNav } from '../../shared/back-nav';
import { ConfirmDialog } from '../../shared/confirm-dialog';
import { YearPipe } from '../../shared/year';

@Component({
  selector: 'app-show-detail',
  imports: [RouterLink, ConfirmDialog, YearPipe],
  template: `
    @if (show(); as s) {
      <div class="detail">
        <div class="hero" [style.background-image]="backdrop()">
          <div class="scrim"></div>
          <button class="back" type="button" (click)="nav.back('/shows')">← Back</button>
          <div class="hero-inner">
            <img class="poster" [src]="posterUrl() || s.cachedPoster || ''" [alt]="s.name" />
            <div class="info">
              <h1>{{ s.name }}</h1>
              <div class="facts">
                @if (tmdbShow()?.firstAirDate) { <span>{{ tmdbShow()!.firstAirDate | year }}</span> }
                @if (tmdbShow()?.status) { <span>{{ tmdbShow()!.status }}</span> }
                @if (s.network || tmdbShow()?.networks?.length) { <span>{{ s.network || tmdbShow()!.networks[0] }}</span> }
                @if (totalEpisodes()) { <span>{{ totalEpisodes() }} episodes</span> }
              </div>
              @if (s.genres.length || tmdbShow()?.genres?.length) {
                <div class="genres">
                  @for (g of (tmdbShow()?.genres?.length ? tmdbShow()!.genres : s.genres); track g) {
                    <span class="chip">{{ g }}</span>
                  }
                </div>
              }
              <p class="overview">{{ tmdbShow()?.overview || s.overview || 'No synopsis available.' }}</p>

              @if (isPreview()) {
                <div class="controls">
                  <button class="btn primary add" [disabled]="adding()" (click)="addToLibrary()">
                    {{ adding() ? 'Adding…' : '+ Add to library' }}
                  </button>
                </div>
              } @else {
                <div class="controls">
                  <select class="status-sel" [value]="s.state.status" (change)="setStatus($any($event.target).value)">
                    <option value="none">Not in my library</option>
                    <option value="watching">Watching</option>
                    <option value="completed">Completed</option>
                    <option value="watchlist">Watchlist</option>
                    <option value="dropped">Dropped</option>
                  </select>
                  <button class="btn" [class.primary]="s.state.favorite" (click)="store.toggleShowFavorite(s.uuid)">
                    ★ {{ s.state.favorite ? 'Favorited' : 'Favorite' }}
                  </button>
                  <div class="rating" role="radiogroup" aria-label="Your rating out of 10">
                    @for (n of [1,2,3,4,5,6,7,8,9,10]; track n) {
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
                </div>
              }

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
          @if (!tmdb.hasKey()) {
            <div class="notice">
              Add a free <a routerLink="/settings">TMDB API key</a> to load seasons, episodes and posters.
            </div>
          } @else if (loadingSeasons()) {
            <div class="empty">Loading episodes…</div>
          } @else if (tmdbShow()?.seasons?.length) {
            @for (season of tmdbShow()!.seasons; track season.seasonNumber) {
              <section class="season">
                <header (click)="toggleSeason(season.seasonNumber)">
                  <div class="s-title">
                    <span class="caret" [class.open]="isOpen(season.seasonNumber)">▸</span>
                    Season {{ season.seasonNumber }}
                    <span class="s-count">{{ store.watchedInSeason(s.tvdbId!, season.seasonNumber) }}/{{ season.episodeCount }}</span>
                  </div>
                  @if (!isPreview()) {
                  <button
                    class="s-mark"
                    [class.done]="seasonComplete(s.tvdbId, season)"
                    [disabled]="!canToggleSeason(s.tvdbId, season)"
                    (click)="askSeason($event, season)"
                    [title]="
                      seasonComplete(s.tvdbId, season)
                        ? 'Unmark season ' + season.seasonNumber
                        : 'Mark season ' + season.seasonNumber + ' watched'
                    "
                    [attr.aria-pressed]="seasonComplete(s.tvdbId, season)"
                    [attr.aria-label]="'Season ' + season.seasonNumber + ' watched'"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
                  </button>
                  }
                </header>
                @if (isOpen(season.seasonNumber)) {
                  <div class="eps">
                    @for (ep of episodes()[season.seasonNumber] || []; track ep.episodeNumber) {
                      <div class="ep" [class.watched]="isWatched(s.tvdbId, ep)">
                        @if (!isPreview()) {
                          <button class="tick" (click)="toggle(s.tvdbId, ep)">
                            {{ isWatched(s.tvdbId, ep) ? '✓' : '' }}
                          </button>
                        }
                        <div class="ep-num">{{ ep.episodeNumber }}</div>
                        <div class="ep-main">
                          <div class="ep-name">{{ ep.name || 'Episode ' + ep.episodeNumber }}</div>
                          @if (ep.airDate) { <div class="ep-air">{{ ep.airDate }}</div> }
                        </div>
                        @if (!isPreview()) {
                          <button class="upto" title="Mark everything up to here" (click)="markUpTo(s.tvdbId, ep)">
                            ⤓
                          </button>
                        }
                      </div>
                    }
                    @if (!(episodes()[season.seasonNumber])) {
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
    } @else if (loadingSeasons()) {
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
  `,
  styleUrl: './show-detail.scss',
})
export class ShowDetail {
  store = inject(LibraryStore);
  nav = inject(BackNav);
  tmdb = inject(TmdbService);

  readonly uuid = input.required<string>();

  /** The library entry for this uuid, if the show is actually in the library. */
  private readonly stored = computed(() => this.store.show(this.uuid()));

  /** TMDB id to preview from, when the route points at a show not yet added. */
  private readonly previewId = computed(() => {
    const p = parseAddedKey(this.uuid());
    return p?.kind === 'show' ? p.tmdbId : null;
  });

  /** Read-only mode: showing a TMDB title the user hasn't added to the library. */
  readonly isPreview = computed(() => !this.stored() && this.previewId() !== null);
  readonly adding = signal(false);

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
  readonly progress = computed(() => {
    const total = this.totalEpisodes();
    if (!total) return 0;
    return Math.min(100, Math.round(((this.show()?.watchedEpisodeCount ?? 0) / total) * 100));
  });

  constructor() {
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
    const id = this.previewId();
    const info = this.tmdbShow();
    if (id === null || !info || this.adding()) return;
    this.adding.set(true);
    try {
      // Hand the already-fetched detail to the store so it doesn't re-request it.
      await this.store.addShow(
        {
          tmdbId: id,
          name: info.name,
          overview: info.overview,
          posterPath: info.posterPath,
          year: info.firstAirDate?.slice(0, 4) ?? null,
        },
        info,
      );
    } finally {
      this.adding.set(false);
    }
  }

  private async loadSeason(tmdbId: number, seasonNumber: number): Promise<void> {
    if (this.episodes()[seasonNumber]) return;
    const eps = await this.tmdb.season(tmdbId, seasonNumber);
    this.episodes.update((m) => ({ ...m, [seasonNumber]: eps }));
  }

  isOpen(n: number): boolean {
    return this.open().has(n);
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

  /** False when the ring has nothing to do: no episodes behind it, none in it. */
  canToggleSeason(
    tvdbId: string | null,
    season: { seasonNumber: number; episodeCount: number },
  ): boolean {
    if (!tvdbId || this.isPreview()) return false;
    if (this.seasonComplete(tvdbId, season)) return true; // unmarkable
    return this.spanUpTo(season.seasonNumber).some((x) => !this.seasonComplete(tvdbId, x));
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
    for (const x of seasons) await this.loadSeason(this.tmdbShow()!.id, x.seasonNumber);
    const payload = seasons.map((x) => ({
      season: x.seasonNumber,
      episodes: (this.episodes()[x.seasonNumber] ?? []).map((e) => e.episodeNumber),
    }));
    const last = payload.find((x) => x.season === p.through)?.episodes ?? [];
    if (!last.length) return; // target season failed to load — nothing to mark
    this.store.markWatchedUpTo(s.tvdbId, p.through, Math.max(...last), payload);
  }

  async markUpTo(tvdbId: string | null, ep: TmdbEpisode): Promise<void> {
    if (!tvdbId || this.isPreview() || !this.tmdbShow()) return;
    // ensure all seasons up to this one are loaded
    const seasons = this.tmdbShow()!.seasons.filter((s) => s.seasonNumber <= ep.seasonNumber);
    for (const s of seasons) await this.loadSeason(this.tmdbShow()!.id, s.seasonNumber);
    const payload = seasons.map((s) => ({
      season: s.seasonNumber,
      episodes: (this.episodes()[s.seasonNumber] ?? []).map((e) => e.episodeNumber),
    }));
    this.store.markWatchedUpTo(tvdbId, ep.seasonNumber, ep.episodeNumber, payload);
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
      for (const season of info.seasons) await this.loadSeason(info.id, season.seasonNumber);
      const payload = info.seasons.map((season) => ({
        season: season.seasonNumber,
        episodes: (this.episodes()[season.seasonNumber] ?? []).map((e) => e.episodeNumber),
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
}

/**
 * A throwaway `ShowView` built from TMDB data so the detail template can render
 * a show that isn't in the library yet. State is neutral ("not in my library",
 * nothing watched); the page shows an "Add to library" button instead of the
 * tracking controls, and none of this is ever written to the CRDT.
 */
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
