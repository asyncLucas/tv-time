import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { TmdbService, TmdbShow } from '../../core/tmdb.service';
import { Poster } from '../../shared/poster';
import { TimeLeftPipe } from '../../shared/time-left';
import { formatDuration } from '../../shared/duration';
import type { ShowView } from '../../core/models';

interface UpNext {
  show: ShowView;
  ep: NonNullable<TmdbShow['nextEpisode']>;
}

@Component({
  selector: 'app-home',
  imports: [RouterLink, Poster, TimeLeftPipe],
  template: `
    <div class="page">
      <div class="hello">
        <h1>{{ store.profile()?.name ? 'Welcome back, ' + store.profile()?.name : 'Welcome to TV Time Revival' }}</h1>
        <div class="sub">
          @if (store.stats().showsFollowed || store.stats().moviesTracked) {
            Your library — local-first, and yours to keep.
          } @else {
            Import a TV Time backup or add titles to start tracking.
          }
        </div>
      </div>

      <div class="stats">
        <a class="stat" routerLink="/shows">
          <div class="n">{{ store.stats().showsFollowed }}</div>
          <div class="l">Shows</div>
        </a>
        <a class="stat" routerLink="/movies">
          <div class="n">{{ store.stats().moviesWatched }}</div>
          <div class="l">Movies watched</div>
        </a>
        <div class="stat">
          <div class="n">{{ store.stats().episodesWatched }}</div>
          <div class="l">Episodes logged</div>
        </div>
        <div class="stat gold">
          <div class="n">{{ lifetime() }}</div>
          <div class="l">Lifetime watched</div>
        </div>
      </div>

      @if (!tmdb.hasKey()) {
        <div class="cta">
          <div>
            <strong>Turn on posters & "what's airing"</strong>
            <p>Add a free TMDB key to enrich all {{ store.shows().length }} shows with artwork and episode schedules.</p>
          </div>
          <a class="btn primary" routerLink="/settings">Add TMDB key</a>
        </div>
      }

      @if (upNext().length) {
        <section>
          <h2>Airing soon</h2>
          <div class="upnext">
            @for (u of upNext(); track u.show.uuid) {
              <a class="un-card" [routerLink]="['/shows', u.show.uuid]">
                <app-poster [title]="u.show.name" [tvdbId]="u.show.tvdbId" [cachedPoster]="u.show.cachedPoster" />
                <div class="un-meta">
                  <div class="un-name">{{ u.show.name }}</div>
                  <div class="un-ep">
                    S{{ u.ep.seasonNumber }}·E{{ u.ep.episodeNumber }} — {{ u.ep.name }}
                  </div>
                  <div class="un-air" [title]="u.ep.airDate">{{ u.ep.airDate | timeLeft }}</div>
                </div>
              </a>
            }
          </div>
        </section>
      }

      <section>
        <div class="sec-head">
          <h2>Continue watching</h2>
          <a class="more" routerLink="/shows">All shows →</a>
        </div>
        @if (watching().length) {
          <div class="poster-grid">
            @for (s of watching(); track s.uuid) {
              <a class="card" [routerLink]="['/shows', s.uuid]">
                <app-poster [title]="s.name" [tvdbId]="s.tvdbId" [cachedPoster]="s.cachedPoster" />
                <div class="name">{{ s.name }}</div>
              </a>
            }
          </div>
        } @else {
          <div class="empty">Nothing in progress. Browse your <a routerLink="/shows">shows</a>.</div>
        }
      </section>
    </div>
  `,
  styleUrl: './home.scss',
})
export class Home {
  store = inject(LibraryStore);
  tmdb = inject(TmdbService);

  readonly watching = computed(() => this.store.watchingShows().slice(0, 18));
  readonly upNext = signal<UpNext[]>([]);

  readonly lifetime = computed(() => formatDuration(this.store.stats().lifetimeMinutes));

  /**
   * Identifies the newest resolve pass. The effect below re-fires on every
   * change to the watching list — including each episode you tick off — so
   * several passes can be in flight at once. Without this, a slow earlier pass
   * could land after a newer one and overwrite it with stale results.
   */
  private runId = 0;

  constructor() {
    effect(() => {
      // resolve airing-soon episodes for currently-watching shows (cache-first)
      if (this.tmdb.hasKey()) this.resolveUpNext(this.store.watchingShows());
    });
  }

  private async resolveUpNext(shows: ShowView[]): Promise<void> {
    const run = ++this.runId;
    const queue = shows.filter((s) => s.tvdbId).slice(0, MAX_SHOWS_PROBED);
    const found: UpNext[] = [];

    // small concurrency to be gentle on the API
    const workers = Array.from({ length: 5 }, async () => {
      while (queue.length) {
        const s = queue.shift()!;
        try {
          const info = await this.tmdb.showByTvdb(s.tvdbId!);
          if (info?.nextEpisode?.airDate) found.push({ show: s, ep: info.nextEpisode });
        } catch {
          /* a title we can't resolve simply doesn't appear in "airing soon" */
        }
      }
    });
    await Promise.all(workers);
    if (run !== this.runId) return; // superseded by a newer pass

    found.sort((a, b) => (a.ep.airDate! < b.ep.airDate! ? -1 : 1));
    this.upNext.set(found.slice(0, MAX_UP_NEXT));
  }
}

/** Cap the fan-out at TMDB so a large library can't melt the rate limit. */
const MAX_SHOWS_PROBED = 40;
const MAX_UP_NEXT = 12;
