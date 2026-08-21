import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  NgZone,
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
import { MAX_SHOWS_PROBED, TMDB_CONCURRENCY, mapPool } from '../../shared/map-pool';
import type { ShowView } from '../../core/models';

/** One row of the Recently watched feed — an episode you already ticked off. */
interface WatchedEpisode {
  key: string;
  show: ShowView;
  tvdbId: string;
  season: number;
  episode: number;
  code: string;
  actionLabel: string;
  /** Resolved lazily from the season fetch; the row renders without it. */
  title: string | null;
  /** "Today" / "3 days ago" — precomputed, like the strings in `nextUp`. */
  when: string;
}

/** A season/episode coordinate — enough to order two episodes of one show. */
export interface EpisodeRef {
  season: number;
  episode: number;
}

/** TMDB's last-episode-to-air for a show, with the date it went out. */
export interface AiredRef extends EpisodeRef {
  airDate: string | null;
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
  /** "12 left" — aired episodes still ahead, or '' while the count is unknown. */
  leftLabel: string;
  /** When this episode went out, if anything on hand knows — see `airedOn`. */
  airDate: string | null;
  /** Part of a just-released batch — it takes the rail's top rows. See `nextUp`. */
  fresh: boolean;
  /** Resolved lazily from the season fetch; the row renders without it. */
  title: string | null;
}

/** A rail row before the rail has decided whether it leads — see `nextUp`. */
type Candidate = Omit<NextEpisode, 'fresh'>;

/** The bit of a rail row the episode modal is opened from — either rail's. */
type EpisodeRow = Pick<NextEpisode, 'show' | 'tvdbId' | 'season' | 'episode' | 'code' | 'title'>;

/**
 * The episode the modal is showing, as a copy rather than a pointer into a rail:
 * ticking an episode off advances Continue watching past it, so the row behind
 * the modal is already gone by the time it is on screen.
 */
interface DialogEpisode {
  showName: string;
  tvdbId: string;
  season: number;
  episode: number;
  code: string;
  title: string | null;
  stillUrl: string | null;
  overview: string | null;
  airDate: string | null;
  runtime: number | null;
  communityScore: number | null;
  /** Null while the dialog follows a tick — see `EpisodeRatingDialog`. */
  watched: boolean | null;
}

@Component({
  selector: 'app-home',
  imports: [RouterLink, Poster, SwipeRow, EpisodeRatingDialog],
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

      @if (recentlyWatched().length) {
        <section>
          <div class="sec-head">
            <h2>Recently watched</h2>
            <a class="more" routerLink="/profile">Your history →</a>
          </div>
          <div class="nextup-rail">
            @for (w of recentlyWatched(); track w.key) {
              <app-swipe-row
                direction="right"
                tone="bad"
                label="Unwatched"
                icon="↩"
                [buttonLabel]="w.actionLabel"
                (open)="openShow(w.show.uuid)"
                (confirm)="markUnwatched(w)"
              >
                <div class="nu-row">
                  <app-poster
                    class="nu-thumb"
                    [title]="w.show.name"
                    [tvdbId]="w.tvdbId"
                    [cachedPoster]="w.show.cachedPoster"
                    [eager]="true"
                  />
                  <div class="nu-main">
                    <div class="nu-name">{{ w.show.name }}</div>
                    <!-- The episode line opens the episode, the rest of the row
                         opens the show — the same split the show page makes. -->
                    <button
                      class="nu-ep"
                      type="button"
                      [attr.aria-label]="'About ' + w.code + ' of ' + w.show.name"
                      (click)="openEpisode(w, $event)"
                    >
                      <span class="nu-code">{{ w.code }}</span>
                      @if (w.title) { — {{ w.title }} }
                    </button>
                  </div>
                  <span class="nu-left one">{{ w.when }}</span>
                </div>
              </app-swipe-row>
            }
          </div>
        </section>
      }

      <section id="continue-watching">
        <div class="sec-head">
          <h2>Continue watching</h2>
          <a class="more" routerLink="/shows">All shows →</a>
        </div>
        @if (nextUp().length) {
          <div class="nextup-rail">
            @for (n of nextUp(); track n.key) {
              <app-swipe-row
                direction="left"
                tone="good"
                label="Watched"
                icon="✓"
                [buttonLabel]="n.actionLabel"
                label2="Pause"
                icon2="⏸"
                tone2="warn"
                [buttonLabel2]="'Pause ' + n.show.name"
                (open)="openShow(n.show.uuid)"
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
                    <button
                      class="nu-ep"
                      type="button"
                      [attr.aria-label]="'About ' + n.code + ' of ' + n.show.name"
                      (click)="openEpisode(n, $event)"
                    >
                      <span class="nu-code">{{ n.code }}</span>
                      @if (n.title) { — {{ n.title }} }
                    </button>
                  </div>
                  @if (n.leftLabel) {
                    <span class="nu-left">{{ n.leftLabel }}</span>
                  }
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

        @if (!nextUp().length) {
          <div class="empty">Nothing in progress. Browse your <a routerLink="/shows">shows</a>.</div>
        }
      </section>

      @if (paused().length) {
        <section>
          <div class="sec-head">
            <h2>Paused</h2>
            <a class="more" routerLink="/shows">All shows →</a>
          </div>
          <div class="nextup-rail">
            @for (s of paused(); track s.uuid) {
              <a class="nu-row plain" [routerLink]="['/shows', s.uuid]">
                <app-poster
                  class="nu-thumb"
                  [title]="s.name"
                  [tvdbId]="s.tvdbId"
                  [cachedPoster]="s.cachedPoster"
                />
                <div class="nu-main">
                  <div class="nu-name">{{ s.name }}</div>
                  <div class="nu-ep">{{ s.watchedEpisodeCount }} episodes watched</div>
                </div>
              </a>
            }
          </div>
        </section>
      }
    </div>

    @if (ratingFor(); as n) {
      <app-episode-rating-dialog
        [open]="true"
        [showName]="n.showName"
        [code]="n.code"
        [episodeTitle]="n.title"
        [still]="n.stillUrl"
        [overview]="n.overview"
        [airDate]="n.airDate"
        [runtime]="n.runtime"
        [communityScore]="n.communityScore"
        [watched]="n.watched"
        [current]="currentRating()"
        [destination]="ratingDestination()"
        (watchedToggled)="toggleWatchedFromDialog()"
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
  private readonly doc = inject(DOCUMENT);
  private readonly zone = inject(NgZone);

  /** Shelved shows, most recently active first — a way back into what you put down. */
  readonly paused = computed(() => this.store.pausedShows().slice(0, MAX_PAUSED));

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
  private readonly lastAired = signal<Record<string, AiredRef | null>>({});

  /**
   * Everything the season fetch said about an episode, keyed
   * `${tvdbId}:${season}:${episode}`. The rails only render the title, but the
   * rest of it is what the episode modal reads — held here so opening one is
   * free rather than another round-trip.
   */
  private readonly epMeta = signal<
    Record<
      string,
      {
        title: string;
        airDate: string | null;
        stillPath: string | null;
        overview: string;
        runtime: number | null;
        voteAverage: number | null;
      }
    >
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
   * Shows whose current release has claimed a place at the front of the rail.
   *
   * Freshness is *claimed*, not recomputed, for the same reason `pinned` is:
   * the air dates it rests on arrive from TMDB a moment after the rows do, and
   * a row promoted to the top mid-swipe is a row that moved under your finger.
   * Claims are made while the page is settling and held for its life — so the
   * order can gain a row early on, but never rearranges once you're using it,
   * and never shifts on its own at midnight either.
   */
  private readonly released = signal<ReadonlySet<string>>(new Set());

  /**
   * Every in-progress show's next watchable episode — the rail before its cap.
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
  private readonly candidates = computed<Candidate[]>(() => {
    const furthest = this.store.furthestWatchedByTvdb();
    const seasons = this.seasons();
    const lastAired = this.lastAired();
    const meta = this.epMeta();
    const now = today();

    const rows: Candidate[] = [];
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
      const left = episodesLeft(next, lastAired[tvdbId], list);
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
        leftLabel: left ? `${left} left` : '',
        airDate: airedOn(next, lastAired[tvdbId], m?.airDate),
        title: m?.title ?? null,
      });
    }
    return rows;
  });

  /**
   * The rail: rows in `pinned` order, except that a show which has just
   * released takes the front — a release is the reason to open the app, and it
   * would otherwise sit below whatever you happened to watch last, or out of
   * the rail entirely on a long watchlist. The cap is applied after the sort,
   * so a release reaches you from anywhere in the watchlist; several releases
   * keep their usual order among themselves.
   */
  readonly nextUp = computed<NextEpisode[]>(() => {
    const released = this.released();
    // Rank lookup as a map, not indexOf per comparison: sort calls the
    // comparator O(n log n) times and a linear scan inside it would make this
    // quadratic on a large watchlist.
    const rank = new Map(this.pinned().map((id, i) => [id, i]));
    const rankOf = (r: NextEpisode) => rank.get(r.tvdbId) ?? rank.size;

    const rows = this.candidates().map((c) => ({ ...c, fresh: released.has(c.tvdbId) }));
    rows.sort((a, b) => Number(b.fresh) - Number(a.fresh) || rankOf(a) - rankOf(b));
    return rows.slice(0, MAX_NEXT_UP);
  });

  /**
   * Rows the release check can't settle without an exact per-episode date: the
   * show's air line moved within the release window, but the episode on offer
   * isn't the one that moved — a premiere that dropped three episodes at once
   * leaves you two behind the line with all three released today.
   *
   * Only those rows. `epMeta` is otherwise filled from what's on screen, and
   * pulling a season for every show in a long watchlist to date a release that
   * didn't happen would be a request each for nothing.
   */
  private readonly datesWanted = computed<Candidate[]>(() => {
    const lastAired = this.lastAired();
    const now = today();
    return this.candidates().filter((c) => {
      if (c.airDate) return false;
      const aired = lastAired[c.tvdbId]?.airDate;
      return !!aired && justReleased(aired, now);
    });
  });

  /**
   * The last few episodes you actually ticked off, oldest at the top.
   *
   * The newest is picked first and the display order reversed after, so the
   * feed still tracks the latest watches — it just runs forward in time down
   * the page, ending on the most recent episode directly above Continue
   * watching, which is the episode that rail follows on from.
   *
   * Titles come from the same `epMeta` map the rail fills, so a row you just
   * watched already reads with its title; anything older resolves on the next
   * pass and the row renders as "S2·E4" until then.
   */
  readonly recentlyWatched = computed<WatchedEpisode[]>(() => {
    const meta = this.epMeta();
    const now = Date.now();
    return this.store
      .recentEpisodeWatches()
      .slice(0, MAX_RECENT)
      .reverse()
      .map((w) => {
        const code = `S${w.season}·E${w.episode}`;
        return {
          key: w.key,
          show: w.show,
          tvdbId: w.show.tvdbId!,
          season: w.season,
          episode: w.episode,
          code,
          actionLabel: `Mark ${code} of ${w.show.name} unwatched`,
          title: meta[w.key]?.title ?? null,
          when: ago(w.watchedAt, now),
        };
      });
  });

  constructor() {
    // Coming back from a detail page, the router restores the scroll position
    // this page had when it was left (`scrollPositionRestoration`, app.config).
    // That restore is the right answer and it lands before the rail resolves,
    // so the opening scroll below would arrive late and undo it — leave the
    // page where the user had it.
    if (this.router.getCurrentNavigation()?.trigger === 'popstate') this.positioned = true;

    // Any of these means the user is already reading the page on their own
    // terms — the opening scroll below must not fire behind them.
    const takeOver = () => {
      this.positioned = true;
      this.takenOver.set(true);
      for (const ev of USER_INPUT) this.doc.removeEventListener(ev, takeOver);
    };
    for (const ev of USER_INPUT) this.doc.addEventListener(ev, takeOver, { passive: true });
    inject(DestroyRef).onDestroy(takeOver);

    // Season structure for the Continue watching rail, from a cache-first show
    // fetch — usually free after the first pass.
    //
    // Only the watching list is a tracked dependency. Both resolvers write to
    // signals their own results feed into (seasons → nextUp → epMeta → nextUp),
    // so they read that state through `untracked` and dedupe against a plain
    // Set — otherwise each write would re-enter the effect that produced it.
    effect(() => {
      const shows = this.store.watchingShows();
      if (this.tmdb.hasKey()) untracked(() => this.resolveSeasons(shows));
    });

    // Episode titles for the rows actually on screen — the rail plus the
    // Recently watched feed, one fetch per (show, season) not already pulled.
    // `datesWanted` rides along: those rows aren't on screen (that is the
    // point — the date decides whether they belong there), and they need the
    // same season fetch.
    effect(() => {
      const rows = [...this.nextUp(), ...this.recentlyWatched(), ...this.datesWanted()];
      untracked(() => this.resolveEpisodeMeta(rows));
    });

    // Which shows have just released. Claimed once per show and only while the
    // page is settling — see `released` for why it is not simply recomputed.
    effect(() => {
      const rows = this.candidates();
      if (this.takenOver()) return;
      const now = untracked(() => today());
      const fresh = rows.filter((r) => r.airDate && justReleased(r.airDate, now));
      untracked(() => {
        const held = this.released();
        const added = fresh.filter((r) => !held.has(r.tvdbId));
        if (added.length) {
          this.released.set(new Set([...held, ...added.map((r) => r.tvdbId)]));
        }
      });
    });

    // Open on Continue watching rather than at the top: the history above it is
    // context, and what to watch next is the reason to be here. It waits for
    // the rail's first rows — they arrive from TMDB, and scrolling to a section
    // that is still empty would just land the page somewhere arbitrary.
    effect(() => {
      if (this.positioned || !this.nextUp().length) return;
      this.positioned = true;
      // Outside Angular, and deferred a macrotask: the rows this effect just
      // saw are not in the DOM until after this change-detection pass.
      this.zone.runOutsideAngular(() =>
        setTimeout(() =>
          this.doc
            .getElementById('continue-watching')
            ?.scrollIntoView({ block: 'start', behavior: 'instant' }),
        ),
      );
    });
  }

  /**
   * True once the page has been put where it should open — or once the user
   * has taken it over, whichever comes first. Scrolling someone's page out from
   * under them because a fetch landed late is worse than not scrolling at all.
   */
  private positioned = false;

  /**
   * The reader is on the page — the same first touch/wheel/key `positioned`
   * watches for, as a signal, because the rail's order settles on it too.
   */
  private readonly takenOver = signal(false);

  openShow(uuid: string): void {
    this.router.navigate(['/shows', uuid]);
  }

  /**
   * Take back a watch from the Recently watched feed.
   *
   * The row leaves the feed, and the Continue watching rail rewinds to offer
   * the episode again — the two read off the same watch log, so undoing a
   * mistake in one place corrects the other with no extra bookkeeping. The
   * episode's rating is deliberately left alone (see LibraryStore).
   */
  markUnwatched(w: WatchedEpisode): void {
    this.store.setEpisodeWatched(w.tvdbId, w.season, w.episode, false);
    this.ratingNote.set(null);
  }

  /** The episode the modal is on — see `DialogEpisode` for why it's a copy. */
  readonly ratingFor = signal<DialogEpisode | null>(null);
  /** What became of the last rating, reported inline under the rail. */
  readonly ratingNote = signal<string | null>(null);

  markWatched(n: NextEpisode): void {
    this.store.setEpisodeWatched(n.tvdbId, n.season, n.episode, true);
    this.ratingNote.set(null);
    // No watch toggle on this way in: it is the tick that raised the dialog.
    this.ratingFor.set(this.dialogFor(n, null));
  }

  /**
   * Open an episode to read about it, from either rail — the same modal the
   * show page opens, and the same one "How was it?" arrives in after a tick.
   * Everything it shows is already in `epMeta` from the season fetch the rows
   * needed for their titles, so reading about an episode costs no request.
   *
   * The click is stopped here: the row around it opens the *show*, and tapping
   * the episode should not do both.
   */
  openEpisode(row: EpisodeRow, event: Event): void {
    event.stopPropagation();
    this.ratingNote.set(null);
    this.ratingFor.set(
      this.dialogFor(row, this.store.isEpisodeWatched(row.tvdbId, row.season, row.episode)),
    );
  }

  /** Tick the open episode off (or back on) without leaving the dialog. */
  toggleWatchedFromDialog(): void {
    const n = this.ratingFor();
    if (!n) return;
    this.store.setEpisodeWatched(n.tvdbId, n.season, n.episode, !n.watched);
    this.ratingFor.set({ ...n, watched: !n.watched });
  }

  /** A rail row plus whatever the season fetch knows about that episode. */
  private dialogFor(row: EpisodeRow, watched: boolean | null): DialogEpisode {
    const m = this.epMeta()[epKey(row.tvdbId, row.season, row.episode)];
    return {
      showName: row.show.name,
      tvdbId: row.tvdbId,
      season: row.season,
      episode: row.episode,
      code: row.code,
      title: row.title ?? m?.title ?? null,
      stillUrl: this.tmdb.poster(m?.stillPath ?? null, 'w500'),
      overview: m?.overview || null,
      airDate: m?.airDate ?? null,
      runtime: m?.runtime ?? null,
      communityScore: m?.voteAverage ?? null,
      watched,
    };
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
   * Store the score and push it to TMDB. The dialog stays up — it closes when
   * the user says so — and the write runs in the background behind it, so the
   * round-trip never holds up a decision they have already made.
   */
  async submitRating(value: number): Promise<void> {
    const n = this.ratingFor();
    if (!n) return;
    const outcome = await this.store.rateEpisodeAndPush(n.tvdbId, n.season, n.episode, value);
    // A later rating may have finished first; only the newest note is useful.
    this.ratingNote.set(`${n.showName} ${n.code} rated ${value}/10 — ${outcome}`);
  }

  async clearRating(): Promise<void> {
    const n = this.ratingFor();
    if (!n) return;
    const outcome = await this.store.rateEpisodeAndPush(n.tvdbId, n.season, n.episode, null);
    this.ratingNote.set(`${n.showName} ${n.code} rating cleared — ${outcome}`);
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
          ? { season: last.seasonNumber, episode: last.episodeNumber, airDate: last.airDate }
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

  private async resolveEpisodeMeta(rows: { tvdbId: string; season: number }[]): Promise<void> {
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
            overview: e.overview,
            runtime: e.runtime ?? null,
            voteAverage: e.voteAverage ?? null,
          };
        }
      }
      return next;
    });
  }
}

/** Rows in the Continue watching rail — one episode each, from distinct shows. */
const MAX_NEXT_UP = 5;
/** Episodes in the Recently watched feed. */
const MAX_RECENT = 5;
/**
 * Any of these means the user took over — see the constructor. `mousedown`
 * is in the list for the scrollbar: dragging it produces no wheel or key
 * event, so without it the page could still be scrolled out from under a
 * mouse-only reader.
 */
const USER_INPUT = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
/** Shelved shows offered a way back on the home page. */
const MAX_PAUSED = 5;

/**
 * Day-granular "how long ago", for a watch timestamp. Unlike an air date these
 * carry a clock time, so this compares whole local days rather than elapsed
 * hours — watching something at 11pm and looking at it at 1am should read
 * "Yesterday", not "2 hours ago".
 */
export function ago(watchedAt: string, now: number): string {
  const then = Date.parse(watchedAt);
  if (Number.isNaN(then)) return '';
  const startOfDay = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = Math.round(days / 365);
  return years === 1 ? 'a year ago' : `${years} years ago`;
}

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
 * The date this episode went out, as far as anything on hand knows — `null` if
 * nothing does.
 *
 * The season fetch is exact but only covers rows already on screen, and the
 * rail now sorts on this *before* it takes its top five, so a show sitting
 * outside that window would never be measured. TMDB's last-episode-to-air
 * carries its own date and rides along on the show fetch every row needs, so it
 * covers the rest — but only for the episode it actually describes: a show two
 * episodes behind the air line released nothing today, whatever its
 * last-aired date says.
 */
export function airedOn(
  ep: EpisodeRef,
  lastAired: AiredRef | null | undefined,
  airDate: string | null | undefined,
): string | null {
  if (airDate) return airDate;
  if (lastAired && lastAired.season === ep.season && lastAired.episode === ep.episode) {
    return lastAired.airDate;
  }
  return null;
}

/**
 * Is this a release the rail should lead with?
 *
 * TMDB air dates are the *network's* local date, and the reader's date is their
 * device's, so the two disagree by a day for a good part of the world: a show
 * that goes out Tuesday night in New York is a Wednesday-morning release in
 * Tokyo. Comparing them exactly would give most viewers east of the network a
 * release window of a few hours, or none at all. The window is a day wide so
 * that "it's out" means the same thing everywhere.
 */
export function justReleased(airDate: string, today: string): boolean {
  return airDate === today || airDate === dayBefore(today);
}

/** The `YYYY-MM-DD` before this one, over UTC so no zone can skip a day. */
function dayBefore(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * How many aired episodes are still ahead, counting the one the rail is
 * offering — "12 left" on a row means twelve you could watch today.
 *
 * Counted forward from `next` through the season structure rather than as
 * total-minus-watched: the rail's position is already "one past the furthest
 * you've reached" (see `advance`), so an episode skipped months ago is behind
 * you, not owed to you. Deriving it the other way would also let a backup's
 * specials or renumbered episodes push the count negative.
 *
 * Episodes merely scheduled don't count — `episodeCount` includes them, so the
 * tail is trimmed at `lastAired`. Returns 0 when nothing can be counted (the
 * show isn't resolved, or TMDB's last-aired episode sits behind `next`), which
 * the caller renders as no label at all rather than a confident "0 left".
 */
export function episodesLeft(
  next: EpisodeRef,
  lastAired: EpisodeRef | null | undefined,
  seasons: TmdbShow['seasons'],
): number {
  if (!lastAired) return 0; // unresolved, or nothing has aired
  let left = 0;
  for (const s of seasons) {
    if (s.seasonNumber < next.season || s.seasonNumber > lastAired.season) continue;
    // Trim each end to the window [next, lastAired] within this season.
    const from = s.seasonNumber === next.season ? next.episode : 1;
    const to =
      s.seasonNumber === lastAired.season ? Math.min(lastAired.episode, s.episodeCount) : s.episodeCount;
    left += Math.max(0, to - from + 1);
  }
  return left;
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
