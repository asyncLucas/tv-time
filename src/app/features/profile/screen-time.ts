import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LibraryStore } from '../../core/library.store';
import type { WatchPoint } from '../../core/models';
import { formatDuration } from '../../shared/duration';

/**
 * "Screen time" — a rolling seven-day read of the watch log: how much per day,
 * what time of day, and how the week compares with the one before it.
 *
 * Trailing seven days, not a calendar week: the window always ends on the day
 * you are looking at, so the last column is today and the comparison is
 * "the seven days before these seven" rather than a Monday-to-Sunday stub that
 * means less the earlier in the week you look.
 *
 * The week is navigable. A restored backup's history stops when TV Time did, so
 * a fixed "this week" panel would be permanently empty for exactly the people
 * with the most to look at; the arrows (and the jump link on an empty week) turn
 * the panel into a way to walk back through it.
 */

/** Waking hours assumed in a day — the denominator behind the % figure. */
const WAKING_MINUTES = 16 * 60;
const WINDOW_DAYS = 7;

/**
 * Day boundaries for the time-of-day split, in local hours. Night wraps midnight
 * and so is everything the other three don't claim.
 */
const BANDS = [
  { label: 'Morning', from: 5, to: 12 },
  { label: 'Afternoon', from: 12, to: 17 },
  { label: 'Evening', from: 17, to: 22 },
  { label: 'Night', from: 22, to: 5 },
] as const;

export interface ScreenTimeDay {
  /** `YYYY-M-D` in local time — the bucket key, never displayed. */
  key: string;
  /** Column label: the weekday, or `Today` for the current day. */
  label: string;
  /** Long form for the tooltip, e.g. `Thu, Jul 16`. */
  full: string;
  minutes: number;
}

export interface ScreenTimeBand {
  label: string;
  minutes: number;
}

export interface ScreenTimeWeek {
  from: Date;
  /** Inclusive last day of the window. */
  to: Date;
  rangeLabel: string;
  days: ScreenTimeDay[];
  /** The busiest day's minutes — the bar chart's scale. */
  peak: number;
  bands: ScreenTimeBand[];
  total: number;
  average: number;
  /** Distinct shows and films watched in the window. */
  titles: number;
  /** Share of assumed waking time spent watching, 0–100+. */
  wakingPct: number;
}

/** Local midnight of the day `date` falls in. */
export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * `n` days on from `date`, via the calendar rather than by adding 24h of
 * milliseconds: on a DST boundary a day is 23 or 25 hours long, and epoch
 * arithmetic would silently walk the window off local midnight.
 */
export function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function bandIndex(hour: number): number {
  // Night is tested first because it is the band that wraps: the small hours are
  // numerically below every other band's start and would otherwise fall into the
  // first one whose upper bound they clear.
  if (hour < BANDS[0].from || hour >= BANDS[3].from) return 3;
  if (hour < BANDS[1].from) return 0;
  if (hour < BANDS[2].from) return 1;
  return 2;
}

/**
 * Bucket the watch log into the seven days ending on `lastDay` (a local
 * midnight). Points outside the window are ignored, so callers can pass the
 * whole timeline; `today` only decides which column gets called "Today".
 */
export function buildWeek(points: WatchPoint[], lastDay: Date, today: Date): ScreenTimeWeek {
  const from = addDays(lastDay, -(WINDOW_DAYS - 1));
  const toExclusive = addDays(lastDay, 1);
  const todayKey = dayKey(today);

  const slots = new Map<string, number>();
  const days: ScreenTimeDay[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = addDays(from, i);
    const key = dayKey(d);
    slots.set(key, i);
    days.push({
      key,
      label:
        key === todayKey ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' }),
      full: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
      minutes: 0,
    });
  }

  const bands: ScreenTimeBand[] = BANDS.map((b) => ({ label: b.label, minutes: 0 }));
  const titles = new Set<string>();
  let total = 0;

  const start = from.getTime();
  const end = toExclusive.getTime();
  for (const p of points) {
    if (p.at < start || p.at >= end) continue;
    const at = new Date(p.at);
    const slot = slots.get(dayKey(at));
    if (slot === undefined) continue; // unreachable, but the map lookup is optional
    days[slot].minutes += p.minutes;
    bands[bandIndex(at.getHours())].minutes += p.minutes;
    titles.add(p.titleKey);
    total += p.minutes;
  }

  return {
    from,
    to: lastDay,
    rangeLabel: `${formatDay(from)} – ${formatDay(lastDay)}`,
    days,
    peak: days.reduce((max, d) => Math.max(max, d.minutes), 0),
    bands,
    total,
    average: total / WINDOW_DAYS,
    titles: titles.size,
    wakingPct: (total / (WAKING_MINUTES * WINDOW_DAYS)) * 100,
  };
}

function formatDay(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface ScreenTimeDelta {
  glyph: string;
  label: string;
  dir: 'up' | 'down' | 'flat';
}

/**
 * A period-over-period change, phrased in words as well as an arrow.
 *
 * Deliberately unjudged — no green-good / red-bad. More screen time isn't a win
 * or a failure, and colouring it as one would put an opinion in a panel that is
 * only supposed to report.
 */
export function compareWeek(current: number, previous: number): ScreenTimeDelta {
  if (current === previous) return { glyph: '', label: 'No change', dir: 'flat' };
  if (previous <= 0) return { glyph: '▲', label: 'New activity', dir: 'up' };
  if (current <= 0) return { glyph: '▼', label: 'Nothing this week', dir: 'down' };
  const pct = Math.round(((current - previous) / previous) * 100);
  const up = current > previous;
  // A change too small to round to a whole percent is still a change; reporting
  // it as "0%" would read as no change, which the branch above already owns.
  const label = pct === 0 ? (up ? 'Up <1%' : 'Down <1%') : `${up ? 'Up' : 'Down'} ${Math.abs(pct)}%`;
  return { glyph: up ? '▲' : '▼', label, dir: up ? 'up' : 'down' };
}

@Component({
  selector: 'app-screen-time',
  template: `
    @if (hasHistory()) {
      <section class="st">
        <header class="st-head">
          <div>
            <h2>Screen time</h2>
            <p class="range">{{ week().rangeLabel }}</p>
          </div>
          <div class="nav">
            <button type="button" (click)="shift(-1)" aria-label="Previous seven days">‹</button>
            <button
              type="button"
              (click)="shift(1)"
              [disabled]="offset() === 0"
              aria-label="Next seven days"
            >
              ›
            </button>
          </div>
        </header>

        <div class="panel">
          <div class="p-l">Daily breakdown</div>
          <!-- Each column is focusable and carries its own value as a label, so
               the figures are reachable without reading the bars. -->
          <div class="chart">
            @for (d of week().days; track d.key) {
              <div class="col" tabindex="0" [attr.aria-label]="d.full + ': ' + fmt(d.minutes)">
                <!-- Only the busiest day is labelled: a number over all seven is
                     noise, and the rest are one hover (or tab stop) away. -->
                <div class="v">{{ d.minutes && d.minutes === week().peak ? fmt(d.minutes) : '' }}</div>
                <div class="track">
                  <div class="fill" [style.height.%]="height(d.minutes)"></div>
                </div>
                <div class="x">{{ d.label }}</div>
                <div class="tip" role="presentation">{{ d.full }} · {{ fmt(d.minutes) }}</div>
              </div>
            }
          </div>
        </div>

        @if (!week().total) {
          <p class="st-empty">
            Nothing logged in these seven days.
            @if (jumpTo() !== null) {
              <button type="button" class="link" (click)="offset.set(jumpTo()!)">
                Jump to your last active week
              </button>
            }
          </p>
        }

        <div class="panel">
          <div class="p-l">Peak hours</div>
          <div class="bands">
            @for (b of week().bands; track b.label) {
              <div class="band">
                <span class="b-l">{{ b.label }}</span>
                <span class="meter"><span class="m-fill" [style.width.%]="share(b.minutes)"></span></span>
                <span class="b-v">{{ fmt(b.minutes) }}</span>
              </div>
            }
          </div>
        </div>

        <div class="tiles">
          <div class="tile">
            <div class="t-l">Daily average</div>
            <div class="t-v">{{ fmt(week().average) }}</div>
            <div class="t-d">
              <span class="arw" aria-hidden="true">{{ deltas().average.glyph }}</span>
              {{ deltas().average.label }}
            </div>
          </div>
          <div class="tile">
            <div class="t-l">Total</div>
            <div class="t-v">{{ fmt(week().total) }}</div>
            <div class="t-d">
              <span class="arw" aria-hidden="true">{{ deltas().total.glyph }}</span>
              {{ deltas().total.label }}
            </div>
          </div>
          <div class="tile">
            <div class="t-l">Waking hours</div>
            <div class="t-v">{{ waking() }}</div>
            <!-- Shares the total's delta: this figure is the total scaled by a
                 constant, so it can never move differently. -->
            <div class="t-d">
              <span class="arw" aria-hidden="true">{{ deltas().total.glyph }}</span>
              {{ deltas().total.label }}
            </div>
          </div>
          <div class="tile">
            <div class="t-l">Titles</div>
            <div class="t-v">{{ week().titles }}</div>
            <div class="t-d">
              <span class="arw" aria-hidden="true">{{ deltas().titles.glyph }}</span>
              {{ deltas().titles.label }}
            </div>
          </div>
        </div>

        <p class="foot">
          Compared with the seven days before, at the same flat per-episode average your lifetime
          total uses. Catching up in bulk — a whole season ticked at once — is bookkeeping rather
          than viewing, so it isn't counted here.
        </p>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .st {
        background: var(--bg-elev);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 22px 24px 20px;
        margin-bottom: 40px;
      }
      .st-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 20px;
      }
      h2 {
        font-size: 18px;
        margin: 0;
      }
      .range {
        color: var(--text-dim);
        font-size: 13px;
        margin: 4px 0 0;
      }
      .nav {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
      }
      .nav button {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 1px solid var(--line);
        background: var(--bg-elev-2);
        color: var(--text);
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }
      .nav button:hover:not(:disabled) {
        border-color: #3a3f4a;
      }
      .nav button:disabled {
        opacity: 0.35;
        cursor: default;
      }
      /* The two plotted blocks sit on the next surface up, so the card reads as
         a panel of readings rather than one flat wall of numbers. */
      .panel {
        background: var(--bg-elev-2);
        border-radius: var(--radius);
        padding: 16px 18px;
        margin-bottom: 14px;
      }
      .p-l {
        color: var(--text-dim);
        font-size: 12.5px;
        font-weight: 600;
        margin-bottom: 14px;
      }
      .chart {
        display: flex;
        align-items: flex-end;
        gap: 8px;
      }
      .col {
        position: relative;
        flex: 1 1 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        border-radius: var(--radius-sm);
        outline-offset: 3px;
      }
      /* Fixed row so a labelled column doesn't stand taller than its neighbours
         and knock the whole baseline out of line. */
      .v {
        height: 16px;
        font-size: 11px;
        font-weight: 700;
        color: var(--text-dim);
        white-space: nowrap;
      }
      /* Bars are capped rather than filling their slot — the leftover width is
         the air between them. */
      .track {
        width: 100%;
        max-width: 24px;
        height: 110px;
        background: var(--bg-elev);
        border-radius: var(--radius-sm);
        display: flex;
        align-items: flex-end;
        overflow: hidden;
      }
      .fill {
        width: 100%;
        background: var(--gold);
        /* Rounded where the data ends, square where it meets the baseline. */
        border-radius: 4px 4px 0 0;
        transition: height 0.25s ease;
      }
      .x {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-dim);
        margin-top: 8px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
      }
      .tip {
        position: absolute;
        bottom: calc(100% - 14px);
        left: 50%;
        transform: translateX(-50%);
        background: #000;
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        padding: 5px 9px;
        font-size: 12px;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.12s;
        z-index: 2;
      }
      /* Edge columns anchor to their own edge instead of centring, so the
         tooltip can't hang outside the card. */
      .col:first-child .tip {
        left: 0;
        transform: none;
      }
      .col:last-child .tip {
        left: auto;
        right: 0;
        transform: none;
      }
      .col:hover .tip,
      .col:focus-visible .tip {
        opacity: 1;
      }
      .bands {
        display: grid;
        gap: 10px;
      }
      .band {
        display: grid;
        grid-template-columns: 88px 1fr auto;
        align-items: center;
        gap: 12px;
        font-size: 13px;
      }
      .b-l {
        color: var(--text-dim);
        font-weight: 600;
      }
      .meter {
        height: 8px;
        background: var(--bg-elev);
        border-radius: 999px;
        overflow: hidden;
      }
      .m-fill {
        display: block;
        height: 100%;
        background: var(--gold);
        border-radius: 999px;
        transition: width 0.25s ease;
      }
      .b-v {
        font-variant-numeric: tabular-nums;
        color: var(--text-dim);
        font-size: 12.5px;
        min-width: 56px;
        text-align: right;
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 12px;
      }
      .tile {
        background: var(--bg-elev-2);
        border-radius: var(--radius);
        padding: 14px 16px;
      }
      .t-l {
        color: var(--text-dim);
        font-size: 12.5px;
        font-weight: 600;
      }
      .t-v {
        font-size: 24px;
        font-weight: 800;
        letter-spacing: -0.02em;
        margin: 10px 0 12px;
      }
      .t-d {
        color: var(--text-faint);
        font-size: 12px;
        font-weight: 600;
      }
      .arw {
        color: var(--text-dim);
        margin-right: 2px;
      }
      /* Not the global .empty state: that one is a centred, 48px-padded block
         for a whole page with nothing in it, and this is a note inside a card
         that is otherwise full of readings. */
      .st-empty {
        color: var(--text-dim);
        font-size: 13px;
        margin: -4px 0 14px;
        padding: 0 2px;
      }
      .link {
        background: none;
        border: 0;
        padding: 0;
        color: var(--gold);
        font: inherit;
        cursor: pointer;
        text-decoration: underline;
      }
      .foot {
        color: var(--text-faint);
        font-size: 12px;
        margin: 14px 0 0;
      }

      @media (max-width: 720px) {
        .st {
          padding: 18px 16px 16px;
        }
        .band {
          grid-template-columns: 74px 1fr auto;
          gap: 10px;
        }
        .track {
          height: 92px;
        }
        /* A phone gives each column ~35px. The gap and the label shrink together
           so "Today" still fits inside one — truncating the only labelled day
           would be the worst one to lose. */
        .chart {
          gap: 6px;
        }
        .x {
          font-size: 11px;
        }
        .tiles {
          grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .fill,
        .m-fill,
        .tip {
          transition: none;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScreenTime {
  private store = inject(LibraryStore);

  /**
   * Whole weeks back from today. Read once per render into `lastDay`, so the
   * arrows move a window rather than re-deriving dates in the template.
   */
  readonly offset = signal(0);

  /**
   * Today, captured when the panel is created. A signal so it *could* be
   * refreshed, but not on a timer: a card that silently reshuffles its columns
   * at midnight while you look at it is stranger than one that is a day stale
   * until the next navigation.
   */
  private readonly today = signal(startOfDay(new Date()));

  private readonly lastDay = computed(() => addDays(this.today(), -this.offset() * WINDOW_DAYS));

  readonly hasHistory = computed(() => this.store.watchTimeline().length > 0);

  readonly week = computed(() =>
    buildWeek(this.store.watchTimeline(), this.lastDay(), this.today()),
  );

  /** The seven days immediately before the shown window — the comparison. */
  private readonly previous = computed(() =>
    buildWeek(this.store.watchTimeline(), addDays(this.lastDay(), -WINDOW_DAYS), this.today()),
  );

  /**
   * Period-over-period change per tile.
   *
   * There is no separate entry for the waking-hours tile: `wakingPct` is the
   * week's total scaled by a constant, and `average` is it divided by seven, so
   * all three can only ever produce the same percentage. The waking tile reuses
   * `total` rather than computing a third copy of one number — printing it
   * twice from two call sites just invites them to drift apart and read as a
   * rendering bug.
   */
  readonly deltas = computed(() => {
    const cur = this.week();
    const prev = this.previous();
    return {
      average: compareWeek(cur.average, prev.average),
      total: compareWeek(cur.total, prev.total),
      titles: compareWeek(cur.titles, prev.titles),
    };
  });

  /**
   * The offset of the window holding the most recent watch, or null if that is
   * already the window on screen. Offered only when the current one is empty —
   * it exists so a library whose history ended months ago isn't a dead panel.
   */
  readonly jumpTo = computed(() => {
    const timeline = this.store.watchTimeline();
    const last = timeline[timeline.length - 1];
    if (!last) return null;
    const days = Math.round(
      (this.today().getTime() - startOfDay(new Date(last.at)).getTime()) / 86_400_000,
    );
    const offset = Math.floor(days / WINDOW_DAYS);
    return offset === this.offset() ? null : offset;
  });

  /** Percent of assumed waking time, kept honest at the small end. */
  readonly waking = computed(() => {
    const pct = this.week().wakingPct;
    if (pct <= 0) return '0%';
    if (pct < 1) return '<1%';
    return `${Math.round(pct)}%`;
  });

  shift(direction: number): void {
    // Negative direction walks backwards in time; never past today.
    this.offset.set(Math.max(0, this.offset() - direction));
  }

  fmt(minutes: number): string {
    return formatDuration(Math.round(minutes));
  }

  /** Bar height as a share of the busiest day, with a floor so a short watch still shows. */
  height(minutes: number): number {
    const peak = this.week().peak;
    if (!minutes || !peak) return 0;
    return Math.max(6, (minutes / peak) * 100);
  }

  /** Meter width for a time-of-day band, as a share of the week's busiest band. */
  share(minutes: number): number {
    const peak = this.week().bands.reduce((max, b) => Math.max(max, b.minutes), 0);
    if (!minutes || !peak) return 0;
    return Math.max(2, (minutes / peak) * 100);
  }
}
