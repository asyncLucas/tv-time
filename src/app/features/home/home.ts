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
import { EpisodeRatingDialog } from '../../shared/episode-rating-dialog';
import { Poster } from '../../shared/poster';
import { SwipeRow } from '../../shared/swipe-row';
import { TimeLeftPipe } from '../../shared/time-left';
import type { ShowView } from '../../core/models';

interface UpNext {
  show: ShowView;
  ep: NonNullable<TmdbShow['nextEpisode']>;
}

/** A season/episode coordinate — enough to order two episodes of one show. */
export interface EpisodeRef {
  season: number;
  episode: number;
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
  /** Episode still, for the rating modal. Null until the season resolves. */
  stillUrl: string | null;
}

@Component({
  selector: 'app-home',
  imports: [RouterLink, Poster, SwipeRow, TimeLeftPipe, EpisodeRatingDialog],
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
                label2="Pause"
                icon2="⏸"
                tone2="warn"
                [buttonLabel2]="'Pause ' + n.show.name"
                (open)="openShow(n)"
                (confirm)="markWatched(n)"
                (confirm2)="pauseShow(n)"
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
                  <span class="nu-hint" aria-hidden="true">← Pause · Watched →</span>
                </div>
              </app-swipe-row>
            }
          </div>
        }

        @if (ratingNote(); as note) {
          <p class="rate-note" role="status">
            {{ note }}
            <button type="button" class="rate-dismiss" aria-label="Dismiss" (click)="ratingNote.set(null)">
              ✕
            </button>
          </p>
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

    @if (ratingFor(); as n) {
      <app-episode-rating-dialog
        [open]="true"
        [showName]="n.show.name"
        [code]="n.code"
        [episodeTitle]="n.title"
        [still]="n.stillUrl"
        [current]="currentRating()"
        [destination]="ratingDestination()"
        (rated)="submitRating($event)"
        (cleared)="clearRating()"
        (dismissed)="ratingFor.set(null)"
      />
    }
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

  /**
   * The furthest episode TMDB says has actually aired, per show TVDB id, from
   * the same show fetch as `seasons`. `null` means nothing has aired yet; a
   * show missing from the map hasn't been resolved. See `hasAired`.
   */
  private readonly lastAired = signal<Record<string, EpisodeRef | null>>({});

  /** Episode titles/air dates/stills, keyed `${tvdbId}:${season}:${episode}`. */
  private readonly epMeta = signal<
    Record<string, { title: string; airDate: string | null; stillPath: string | null }>
  >({});

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
   *
   * Only episodes you can actually watch right now appear: a show you're caught
   * up on drops out of the rail rather than offering an episode that hasn't
   * aired. The countdown to that episode is what "Airing soon" above is for.
   */
  readonly nextUp = computed<NextEpisode[]>(() => {
    const furthest = this.store.furthestWatchedByTvdb();
    const seasons = this.seasons();
    const lastAired = this.lastAired();
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
      if (!hasAired(next, lastAired[tvdbId], m?.airDate, now)) continue;

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
        stillUrl: this.tmdb.poster(m?.stillPath ?? null, 'w500'),
      });
    }
    rows.sort((a, b) => (rank.get(a.tvdbId) ?? rank.size) - (rank.get(b.tvdbId) ?? rank.size));
    return rows.slice(0, MAX_NEXT_UP);
  });

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

  /**
   * The episode whose rating modal is up. Holds its own copy of the row rather
   * than an index into `nextUp()` — marking the episode watched immediately
   * advances the rail past it, so the row backing the modal no longer exists
   * by the time the modal is on screen.
   */
  readonly ratingFor = signal<NextEpisode | null>(null);
  /** What became of the last rating, reported inline under the rail. */
  readonly ratingNote = signal<string | null>(null);

  markWatched(n: NextEpisode): void {
    this.store.setEpisodeWatched(n.tvdbId, n.season, n.episode, true);
    this.ratingNote.set(null);
    this.ratingFor.set(n);
  }

  /**
   * Shelve the show: it leaves this rail until an episode is ticked watched,
   * which flips it back to Watching (see LibraryStore.resumeIfPaused).
   */
  pauseShow(n: NextEpisode): void {
    this.store.setShowStatus(n.show.uuid, 'paused');
  }

  /** The score already on record for the episode being rated, if any. */
  readonly currentRating = computed(() => {
    const n = this.ratingFor();
    return n ? this.store.episodeRating(n.tvdbId, n.season, n.episode) : null;
  });

  /** Where a rating goes, so the modal can say so before it's given. */
  readonly ratingDestination = computed(() =>
    this.tmdb.hasAccount() ? 'Also sent to your TMDB account' : 'Also sent to TMDB',
  );

  /**
   * Store the score and push it to TMDB. The modal closes first: the local
   * write is instant and the network round-trip is not, so holding the dialog
   * open would make the app feel like it was thinking about a decision the user
   * has already made.
   */
  async submitRating(value: number): Promise<void> {
    const n = this.ratingFor();
    this.ratingFor.set(null);
    if (!n) return;
    const outcome = await this.store.rateEpisodeAndPush(n.tvdbId, n.season, n.episode, value);
    // A later rating may have finished first; only the newest note is useful.
    this.ratingNote.set(`${n.show.name} ${n.code} rated ${value}/10 — ${outcome}`);
  }

  async clearRating(): Promise<void> {
    const n = this.ratingFor();
    this.ratingFor.set(null);
    if (!n) return;
    const outcome = await this.store.rateEpisodeAndPush(n.tvdbId, n.season, n.episode, null);
    this.ratingNote.set(`${n.show.name} ${n.code} rating cleared — ${outcome}`);
  }

  /** Shows whose season fetch has been attempted, successful or not. */
  private readonly probedShows = new Set<string>();
  /** `${tvdbId}:${season}` fetches already attempted. */
  private readonly probedSeasons = new Set<string>();

  private async resolveSeasons(shows: ShowView[]): Promise<void> {
    const pending = shows
      .filter((s) => s.tvdbId && !this.probedShows.has(s.tvdbId))
      .slice(0, MAX_SHOWS_PROBED);
    if (!pending.length) return;
    for (const s of pending) this.probedShows.add(s.tvdbId!);

    // Fetched concurrently, applied in the original order. The rail's row order
    // is the order shows land in `pinned`, and that has to follow the watching
    // order rather than whichever request happened to return first — ticking an
    // episode re-sorts watchingShows(), and a row that moved mid-swipe would be
    // the row under your finger.
    const results = await mapPool(pending, TMDB_CONCURRENCY, (s) =>
      this.tmdb.showByTvdb(s.tvdbId!).catch(() => null),
    );

    const resolved = results
      .map((info, i) => ({ tvdbId: pending[i].tvdbId!, info }))
      .filter((r) => r.info?.seasons?.length);
    if (!resolved.length) return;

    // One update for the batch rather than one per show.
    this.seasons.update((cur) => {
      const next = { ...cur };
      for (const r of resolved) next[r.tvdbId] = r.info!.seasons;
      return next;
    });
    this.lastAired.update((cur) => {
      const next = { ...cur };
      for (const r of resolved) {
        const last = r.info!.lastEpisode;
        next[r.tvdbId] = last
          ? { season: last.seasonNumber, episode: last.episodeNumber }
          : null;
      }
      return next;
    });
    this.pinned.update((p) => {
      const next = [...p];
      for (const r of resolved) if (!next.includes(r.tvdbId)) next.push(r.tvdbId);
      return next;
    });
  }

  private async resolveEpisodeMeta(rows: NextEpisode[]): Promise<void> {
    // One fetch per (show, season), even when the rail later advances to
    // another episode of a season already pulled.
    const pending = rows.filter((n) => {
      const key = seasonKey(n.tvdbId, n.season);
      if (this.probedSeasons.has(key)) return false;
      this.probedSeasons.add(key);
      return true;
    });
    if (!pending.length) return;

    // The two requests within a row are dependent (id, then season), but the
    // rows are independent — so they run concurrently rather than in series.
    const results = await mapPool(pending, TMDB_CONCURRENCY, async (n) => {
      try {
        const tmdbId = await this.tmdb.tmdbIdForTvdb(n.tvdbId);
        if (tmdbId == null) return null;
        const eps = await this.tmdb.season(tmdbId, n.season);
        return eps.length ? { row: n, eps } : null;
      } catch {
        return null; // the row renders fine as "S2·E4" with no title
      }
    });

    const found = results.filter((r) => r !== null);
    if (!found.length) return;
    this.epMeta.update((cur) => {
      const next = { ...cur };
      for (const { row, eps } of found) {
        for (const e of eps) {
          next[epKey(row.tvdbId, e.seasonNumber, e.episodeNumber)] = {
            title: e.name,
            airDate: e.airDate ?? null,
            stillPath: e.stillPath ?? null,
          };
        }
      }
      return next;
    });
  }

  private async resolveUpNext(shows: ShowView[]): Promise<void> {
    const run = ++this.runId;
    const queue = shows.filter((s) => s.tvdbId).slice(0, MAX_SHOWS_PROBED);

    const results = await mapPool(queue, TMDB_CONCURRENCY, (s) =>
      this.tmdb.showByTvdb(s.tvdbId!).catch(() => null),
    );
    if (run !== this.runId) return; // superseded by a newer pass

    const found: UpNext[] = [];
    results.forEach((info, i) => {
      // A title we can't resolve simply doesn't appear in "airing soon".
      if (info?.nextEpisode?.airDate) found.push({ show: queue[i], ep: info.nextEpisode });
    });
    found.sort((a, b) => (a.ep.airDate! < b.ep.airDate! ? -1 : 1));
    this.upNext.set(found.slice(0, MAX_UP_NEXT));
  }
}

/**
 * Map over `items` with bounded concurrency, preserving input order in the
 * result. TMDB rate-limits, so the fan-out stays small; order is preserved
 * because callers use it to lay out the rail.
 */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Cap the fan-out at TMDB so a large library can't melt the rate limit. */
const MAX_SHOWS_PROBED = 40;
/** How many TMDB requests are in flight at once — gentle on the API. */
const TMDB_CONCURRENCY = 5;
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
 * Can this episode be watched right now?
 *
 * Two independent signals, because neither alone covers the rail. `airDate`
 * comes from the season fetch and is exact, but it only exists for rows already
 * on screen (that is what the fetch is scoped to). `lastAired` — TMDB's
 * last-episode-to-air — rides along on the show fetch every row already needs,
 * so it can rule out an unaired episode before the row is ever shown; without
 * it, a caught-up show would flash into the rail and vanish a moment later.
 *
 * `lastAired` undefined means the show isn't resolved yet, `null` that nothing
 * of it has aired. An episode with neither signal is treated as aired: missing
 * metadata shouldn't quietly hide something you could be watching.
 */
export function hasAired(
  ep: EpisodeRef,
  lastAired: EpisodeRef | null | undefined,
  airDate: string | null | undefined,
  today: string,
): boolean {
  if (airDate) return airDate <= today;
  if (lastAired === undefined) return true;
  if (lastAired === null) return false;
  return (
    ep.season < lastAired.season ||
    (ep.season === lastAired.season && ep.episode <= lastAired.episode)
  );
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
