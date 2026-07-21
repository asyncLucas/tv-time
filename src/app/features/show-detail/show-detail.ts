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
                @if (tmdb2()?.firstAirDate) { <span>{{ tmdb2()!.firstAirDate!.slice(0, 4) }}</span> }
                @if (tmdb2()?.status) { <span>{{ tmdb2()!.status }}</span> }
                @if (s.network || tmdb2()?.networks?.length) { <span>{{ s.network || tmdb2()!.networks[0] }}</span> }
                @if (totalEpisodes()) { <span>{{ totalEpisodes() }} episodes</span> }
              </div>
              @if (s.genres.length || tmdb2()?.genres?.length) {
                <div class="genres">
                  @for (g of (tmdb2()?.genres?.length ? tmdb2()!.genres : s.genres); track g) {
                    <span class="chip">{{ g }}</span>
                  }
                </div>
              }
              <p class="overview">{{ tmdb2()?.overview || s.overview || 'No synopsis available.' }}</p>

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

              @if (progress() > 0) {
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
          } @else if (tmdb2()?.seasons?.length) {
            @for (season of tmdb2()!.seasons; track season.seasonNumber) {
              <section class="season">
                <header (click)="toggleSeason(season.seasonNumber)">
                  <div class="s-title">
                    <span class="caret" [class.open]="isOpen(season.seasonNumber)">▸</span>
                    Season {{ season.seasonNumber }}
                    <span class="s-count">{{ watchedInSeason(season.seasonNumber) }}/{{ season.episodeCount }}</span>
                  </div>
                  <button class="btn ghost sm" (click)="markSeason($event, season.seasonNumber)">Mark all</button>
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

  readonly tmdb2 = signal<TmdbShow | null>(null);
  readonly episodes = signal<Record<number, TmdbEpisode[]>>({});
  readonly loadingSeasons = signal(false);
  private open = signal<Set<number>>(new Set());

  readonly posterUrl = computed(() => this.tmdb.poster(this.tmdb2()?.posterPath ?? null, 'w342'));
  readonly backdrop = computed(() => {
    const b = this.tmdb.poster(this.tmdb2()?.backdropPath ?? null, 'original');
    return b ? `url(${b})` : 'none';
  });
  readonly totalEpisodes = computed(() =>
    (this.tmdb2()?.seasons ?? []).reduce((n, s) => n + s.episodeCount, 0),
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
      this.tmdb2.set(null);
      this.episodes.set({});
      if (s?.tvdbId && this.tmdb.hasKey()) this.loadShow(s.tvdbId);
    });
  }

  private async loadShow(tvdbId: string): Promise<void> {
    this.loadingSeasons.set(true);
    const info = await this.tmdb.showByTvdb(tvdbId);
    this.tmdb2.set(info);
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
      const id = this.tmdb2()?.id;
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
  watchedInSeason(seasonNumber: number): number {
    const tvdb = this.show()?.tvdbId;
    const eps = this.episodes()[seasonNumber];
    if (!tvdb || !eps) {
      // fall back to counting from the store even before episodes load
      return 0;
    }
    return eps.filter((e) => this.store.isEpisodeWatched(tvdb, seasonNumber, e.episodeNumber)).length;
  }

  async markSeason(evt: Event, seasonNumber: number): Promise<void> {
    evt.stopPropagation();
    const s = this.show();
    if (!s?.tvdbId || !this.tmdb2()) return;
    await this.loadSeason(this.tmdb2()!.id, seasonNumber);
    const eps = this.episodes()[seasonNumber] ?? [];
    this.store.markWatchedUpTo(s.tvdbId, seasonNumber, Math.max(...eps.map((e) => e.episodeNumber)), [
      { season: seasonNumber, episodes: eps.map((e) => e.episodeNumber) },
    ]);
  }

  async markUpTo(tvdbId: string | null, ep: TmdbEpisode): Promise<void> {
    if (!tvdbId || !this.tmdb2()) return;
    // ensure all seasons up to this one are loaded
    const seasons = this.tmdb2()!.seasons.filter((s) => s.seasonNumber <= ep.seasonNumber);
    for (const s of seasons) await this.loadSeason(this.tmdb2()!.id, s.seasonNumber);
    const payload = seasons.map((s) => ({
      season: s.seasonNumber,
      episodes: (this.episodes()[s.seasonNumber] ?? []).map((e) => e.episodeNumber),
    }));
    this.store.markWatchedUpTo(tvdbId, ep.seasonNumber, ep.episodeNumber, payload);
  }

  setStatus(v: string): void {
    this.store.setShowStatus(this.uuid(), v as ShowStatus);
  }
  rate(n: number): void {
    const cur = this.show()?.state.rating;
    this.store.rateShow(this.uuid(), cur === n ? null : n);
  }
}
