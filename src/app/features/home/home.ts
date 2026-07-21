import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { epKey, seasonKey } from '../../core/doc.service';
import { LibraryStore } from '../../core/library.store';
import { TmdbService, TmdbShow } from '../../core/tmdb.service';
import { Poster } from '../../shared/poster';
import { SwipeRow } from '../../shared/swipe-row';
import { TimeLeftPipe } from '../../shared/time-left';
import { formatDuration } from '../../shared/duration';
import type { ShowView } from '../../core/models';

interface UpNext {
  show: ShowView;
  ep: NonNullable<TmdbShow['nextEpisode']>;
}

/** The next episode to watch for one show — a row in the Continue watching rail. */
interface NextEpisode {
  /** Identity for @for tracking. Marking it watched changes the key, which
   *  recreates the row — that's what snaps a swiped-away row back to rest. */
  key: string;
  show: ShowView;
  tvdbId: string;
  season: number;
  episode: number;
  /** Precomputed display/accessible strings — see the comment in `nextUp`. */
  code: string;
  actionLabel: string;
  /** Resolved lazily from the season fetch; the row renders without it. */
  title: string | null;
  airDate: string | null;
  /** True once we know it hasn't aired — the row shows a date, not a ✓. */
  unaired: boolean;
}

@Component({
  selector: 'app-home',
  imports: [RouterLink, Poster, SwipeRow, TimeLeftPipe],
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
        @if (nextUp().length) {
          <div class="nextup-rail">
            @for (n of nextUp(); track n.key) {
              <app-swipe-row
                direction="right"
                tone="good"
                label="Watched"
                icon="✓"
                [buttonLabel]="n.actionLabel"
                [disabled]="n.unaired"
                (open)="openShow(n)"
                (confirm)="markWatched(n)"
              >
                <div class="nu-row">
                  <app-poster
                    class="nu-thumb"
                    [title]="n.show.name"
                    [tvdbId]="n.tvdbId"
                    [cachedPoster]="n.show.cachedPoster"
                    [eager]="true"
                  />
                  <div class="nu-main">
                    <div class="nu-name">{{ n.show.name }}</div>
                    <div class="nu-ep">
                      <span class="nu-code">{{ n.code }}</span>
                      @if (n.title) { — {{ n.title }} }
                    </div>
                  </div>
                  @if (n.unaired) {
                    <span class="nu-air">{{ n.airDate | timeLeft }}</span>
                  } @else {
                    <span class="nu-hint" aria-hidden="true">Swipe →</span>
                  }
                </div>
              </app-swipe-row>
            }
          </div>
        }

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
  // Every binding here reads a signal, so OnPush is safe and skips this
  // component on the change-detection passes zone.js runs for unrelated work
  // (poster fetches, sync ticks) — this page renders a lot of cards.
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  store = inject(LibraryStore);
  tmdb = inject(TmdbService);
  private router = inject(Router);

  readonly watching = computed(() => this.store.watchingShows().slice(0, 18));
  readonly upNext = signal<UpNext[]>([]);

  /**
   * Season structure per show TVDB id, from the (cached) show fetch. Holding it
   * here is what makes "what's next" advance synchronously: once a show's
   * seasons are known, ticking an episode recomputes the rail from local state
   * with no network round-trip, so the row swaps to the next episode instantly.
   */
  private readonly seasons = signal<Record<string, TmdbShow['seasons']>>({});

  /** Episode titles/air dates, keyed `${tvdbId}:${season}:${episode}`. */
  private readonly epMeta = signal<Record<string, { title: string; airDate: string | null }>>({});

  /**
   * Show order for the rail, pinned by first appearance.
   *
   * `watchingShows()` re-sorts the moment you tick an episode — which is right
   * for the poster grid, but in a rail you're swiping through it would yank the
   * next row out from under your finger. Positions here are claimed once and
   * held for the life of the page; new shows append.
   */
  private readonly pinned = signal<string[]>([]);

  /**
   * The next unwatched episode for each in-progress show, one row per show.
   *
   * "Next" means one past the furthest episode you've watched — not the first
   * gap. Someone who skipped an episode months ago wants to keep going, not be
   * dragged back; and resolving true first-unwatched would need a season fetch
   * per season rather than the single show fetch this costs.
   */
  readonly nextUp = computed<NextEpisode[]>(() => {
    const furthest = this.store.furthestWatchedByTvdb();
    const seasons = this.seasons();
    const meta = this.epMeta();
    // Rank lookup as a map, not indexOf per comparison: sort calls the
    // comparator O(n log n) times and a linear scan inside it would make this
    // quadratic on a large watchlist.
    const rank = new Map(this.pinned().map((id, i) => [id, i]));
    const now = today();

    const rows: NextEpisode[] = [];
    for (const show of this.store.watchingShows()) {
      const tvdbId = show.tvdbId;
      if (!tvdbId) continue;
      const list = seasons[tvdbId];
      if (!list?.length) continue; // not resolved yet (or a show TMDB doesn't know)

      const next = advance(furthest[tvdbId], list);
      if (!next) continue; // watched through the last aired episode

      const m = meta[epKey(tvdbId, next.season, next.episode)];
      const code = `S${next.season}·E${next.episode}`;
      rows.push({
        key: epKey(tvdbId, next.season, next.episode),
        show,
        tvdbId,
        season: next.season,
        episode: next.episode,
        code,
        // Built here rather than in the template: the binding would otherwise
        // re-concatenate on every change-detection pass, for every row.
        actionLabel: `Mark ${code} of ${show.name} watched`,
        title: m?.title ?? null,
        airDate: m?.airDate ?? null,
        // Unknown air date is treated as aired — the row stays actionable
        // rather than being disabled by missing metadata.
        unaired: !!m?.airDate && m.airDate > now,
      });
    }
    rows.sort((a, b) => (rank.get(a.tvdbId) ?? rank.size) - (rank.get(b.tvdbId) ?? rank.size));
    return rows.slice(0, MAX_NEXT_UP);
  });

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

    // Season structure for the Continue watching rail. Same fetch as above and
    // the same 7-day cache entry, so this is usually free after the first pass.
    //
    // Only the watching list is a tracked dependency. Both resolvers write to
    // signals their own results feed into (seasons → nextUp → epMeta → nextUp),
    // so they read that state through `untracked` and dedupe against a plain
    // Set — otherwise each write would re-enter the effect that produced it.
    effect(() => {
      const shows = this.store.watchingShows();
      if (this.tmdb.hasKey()) untracked(() => this.resolveSeasons(shows));
    });

    // Episode titles for the rows actually on screen — at most MAX_NEXT_UP
    // season fetches, and only for seasons we haven't already pulled.
    effect(() => {
      const rows = this.nextUp();
      untracked(() => this.resolveEpisodeMeta(rows));
    });
  }

  openShow(n: NextEpisode): void {
    this.router.navigate(['/shows', n.show.uuid]);
  }

  markWatched(n: NextEpisode): void {
    if (n.unaired) return;
    this.store.setEpisodeWatched(n.tvdbId, n.season, n.episode, true);
  }

  /** Shows whose season fetch has been attempted, successful or not. */
  private readonly probedShows = new Set<string>();
  /** `${tvdbId}:${season}` fetches already attempted. */
  private readonly probedSeasons = new Set<string>();

  private async resolveSeasons(shows: ShowView[]): Promise<void> {
    const pending = shows
      .filter((s) => s.tvdbId && !this.probedShows.has(s.tvdbId))
      .slice(0, MAX_SHOWS_PROBED);

    for (const s of pending) {
      const tvdbId = s.tvdbId!;
      this.probedShows.add(tvdbId);
      try {
        const info = await this.tmdb.showByTvdb(tvdbId);
        if (!info?.seasons?.length) continue;
        this.seasons.update((cur) => ({ ...cur, [tvdbId]: info.seasons }));
        // Claim this show's rail position as it resolves. Resolution follows
        // the watching order, so the rail lands in that order and then holds
        // it — ticking an episode re-sorts watchingShows(), and without this
        // the row under your finger would move mid-swipe.
        this.pinned.update((p) => (p.includes(tvdbId) ? p : [...p, tvdbId]));
      } catch {
        /* a show we can't resolve simply has no rail row */
      }
    }
  }

  private async resolveEpisodeMeta(rows: NextEpisode[]): Promise<void> {
    for (const n of rows) {
      // One fetch per (show, season), even when the rail later advances to
      // another episode of a season already pulled.
      const key = seasonKey(n.tvdbId, n.season);
      if (this.probedSeasons.has(key)) continue;
      this.probedSeasons.add(key);
      try {
        const tmdbId = await this.tmdb.tmdbIdForTvdb(n.tvdbId);
        if (tmdbId == null) continue;
        const eps = await this.tmdb.season(tmdbId, n.season);
        if (!eps.length) continue;
        this.epMeta.update((cur) => {
          const next = { ...cur };
          for (const e of eps) {
            next[epKey(n.tvdbId, e.seasonNumber, e.episodeNumber)] = {
              title: e.name,
              airDate: e.airDate ?? null,
            };
          }
          return next;
        });
      } catch {
        /* the row renders fine as "S2·E4" with no title */
      }
    }
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
/** Rows in the Continue watching rail — one episode each, from distinct shows. */
const MAX_NEXT_UP = 5;

/** Local calendar date as `YYYY-MM-DD`, to compare against TMDB air dates. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The episode after `from`, given a show's season structure: the next episode
 * in the same season, else episode 1 of the next season with any episodes.
 * `undefined` from (nothing watched yet) starts at the first season.
 *
 * Returns null once you're past the last episode TMDB knows about — a show
 * you're caught up on drops out of the rail rather than showing a dead row.
 */
export function advance(
  from: { season: number; episode: number } | undefined,
  seasons: TmdbShow['seasons'],
): { season: number; episode: number } | null {
  const ordered = [...seasons].filter((s) => s.episodeCount > 0).sort((a, b) => a.seasonNumber - b.seasonNumber);
  if (!ordered.length) return null;
  if (!from) return { season: ordered[0].seasonNumber, episode: 1 };

  const cur = ordered.find((s) => s.seasonNumber === from.season);
  if (cur && from.episode < cur.episodeCount) {
    return { season: from.season, episode: from.episode + 1 };
  }
  const next = ordered.find((s) => s.seasonNumber > from.season);
  return next ? { season: next.seasonNumber, episode: 1 } : null;
}
