import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { TmdbService, TmdbShow, TmdbEpisode } from '../../core/tmdb.service';
import type { ShowStatus } from '../../core/models';

@Component({
  selector: 'app-show-detail',
  imports: [RouterLink],
  template: `
    @if (show(); as s) {
      <div class="detail">
        <div class="hero" [style.background-image]="backdrop()">
          <div class="scrim"></div>
          <a class="back" routerLink="/shows">← Shows</a>
          <div class="hero-inner">
            <img class="poster" [src]="posterUrl() || s.cachedPoster || ''" [alt]="s.name" />
            <div class="info">
              <h1>{{ s.name }}</h1>
              <div class="facts">
                @if (tmdbShow()?.firstAirDate) { <span>{{ tmdbShow()!.firstAirDate!.slice(0, 4) }}</span> }
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
                <div class="rating">
                  @for (n of [1,2,3,4,5,6,7,8,9,10]; track n) {
                    <span class="pip" [class.on]="(s.state.rating || 0) >= n" (click)="rate(n)">{{ n }}</span>
                  }
                </div>
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
                  @if (!seasonComplete(s.tvdbId, season)) {
                    <button class="btn ghost sm" (click)="markSeason($event, season.seasonNumber)">Mark all</button>
                  }
                </header>
                @if (isOpen(season.seasonNumber)) {
                  <div class="eps">
                    @for (ep of episodes()[season.seasonNumber] || []; track ep.episodeNumber) {
                      <div class="ep" [class.watched]="isWatched(s.tvdbId, ep)">
                        <button class="tick" (click)="toggle(s.tvdbId, ep)">
                          {{ isWatched(s.tvdbId, ep) ? '✓' : '' }}
                        </button>
                        <div class="ep-num">{{ ep.episodeNumber }}</div>
                        <div class="ep-main">
                          <div class="ep-name">{{ ep.name || 'Episode ' + ep.episodeNumber }}</div>
                          @if (ep.airDate) { <div class="ep-air">{{ ep.airDate }}</div> }
                        </div>
                        <button class="upto" title="Mark everything up to here" (click)="markUpTo(s.tvdbId, ep)">
                          ⤓
                        </button>
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
    } @else {
      <div class="page"><div class="empty">Show not found.</div></div>
    }
  `,
  styleUrl: './show-detail.scss',
})
export class ShowDetail {
  store = inject(LibraryStore);
  tmdb = inject(TmdbService);

  readonly uuid = input.required<string>();
  readonly show = computed(() => this.store.show(this.uuid()));

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
    // load TMDB show whenever the route show (with a tvdb id) changes
    effect(() => {
      const s = this.show();
      this.tmdbShow.set(null);
      this.episodes.set({});
      if (s?.tvdbId && this.tmdb.hasKey()) this.loadShow(s.tvdbId);
    });
  }

  private async loadShow(tvdbId: string): Promise<void> {
    this.loadingSeasons.set(true);
    const info = await this.tmdb.showByTvdb(tvdbId);
    this.tmdbShow.set(info);
    this.loadingSeasons.set(false);
    // auto-open the first season with unwatched episodes (or season 1)
    if (info?.seasons.length) {
      const first = info.seasons[0].seasonNumber;
      this.open.set(new Set([first]));
      this.loadSeason(info.id, first);
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
    if (!tvdbId) return;
    this.store.setEpisodeWatched(tvdbId, ep.seasonNumber, ep.episodeNumber, !this.isWatched(tvdbId, ep));
  }
  /** Watched count for a season — 0 until that season's episode list has loaded. */
  /** True once every episode of a season is watched (hides its "Mark all"). */
  seasonComplete(tvdbId: string | null, season: { seasonNumber: number; episodeCount: number }): boolean {
    return (
      !!tvdbId &&
      season.episodeCount > 0 &&
      this.store.watchedInSeason(tvdbId, season.seasonNumber) >= season.episodeCount
    );
  }

  async markSeason(evt: Event, seasonNumber: number): Promise<void> {
    evt.stopPropagation();
    const s = this.show();
    if (!s?.tvdbId || !this.tmdbShow()) return;
    await this.loadSeason(this.tmdbShow()!.id, seasonNumber);
    const numbers = (this.episodes()[seasonNumber] ?? []).map((e) => e.episodeNumber);
    if (!numbers.length) return; // season failed to load — nothing to mark
    this.store.markWatchedUpTo(s.tvdbId, seasonNumber, Math.max(...numbers), [
      { season: seasonNumber, episodes: numbers },
    ]);
  }

  async markUpTo(tvdbId: string | null, ep: TmdbEpisode): Promise<void> {
    if (!tvdbId || !this.tmdbShow()) return;
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
      const lastEp = lastEps.length ? Math.max(...lastEps.map((e) => e.episodeNumber)) : Number.MAX_SAFE_INTEGER;
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
