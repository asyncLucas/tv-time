import { Injectable } from '@angular/core';

const BASE = 'https://api.tvmaze.com';

/**
 * The one thing TMDB can't tell us: what time an episode actually airs.
 *
 * TMDB's `air_date` is a bare calendar date, so "Today" is the finest an
 * airing-soon card can honestly get from it. TVmaze publishes an `airstamp` —
 * the exact instant, with offset — which is enough to say "Today · 21:00" in
 * the viewer's own timezone. It needs no key and no account, so it costs the
 * user nothing to have this.
 *
 * It is strictly an enhancement: every lookup can fail (unknown show, 404,
 * offline) and every caller treats null as "just show the day", which is what
 * the card said before this existed.
 */
@Injectable({ providedIn: 'root' })
export class TvmazeService {
  /**
   * Resolved ids and airstamps, kept for the life of the tab.
   *
   * A session-scoped memo rather than the Cache API used for TMDB: this is only
   * ever asked about episodes airing *today*, so there are a handful of entries
   * at most, and a schedule that shifts during the day is better re-read on the
   * next load than served from a week-old disk copy.
   */
  private showIdByTvdb = new Map<string, number | null>();
  private stampByEpisode = new Map<string, string | null>();
  /** In-flight requests by URL, so concurrent callers share one round-trip. */
  private inflight = new Map<string, Promise<{ answered: boolean; data: any | null }>>();

  /**
   * The exact air time of one episode as an ISO instant, or null when TVmaze
   * doesn't know the show, the episode, or is simply unreachable.
   */
  async airstamp(tvdbId: string, season: number, episode: number): Promise<string | null> {
    const key = `${tvdbId}:${season}:${episode}`;
    const memo = this.stampByEpisode.get(key);
    if (memo !== undefined) return memo;

    const showId = await this.showId(tvdbId);
    if (showId === null) return null;

    const ep = await this.get(
      `${BASE}/shows/${showId}/episodebynumber?season=${season}&number=${episode}`,
    );
    if (!ep.answered) return null;
    const stamp = typeof ep.data?.airstamp === 'string' ? ep.data.airstamp : null;
    this.stampByEpisode.set(key, stamp);
    return stamp;
  }

  /** TVmaze's own show id for a TheTVDB series id (null if it has none). */
  private async showId(tvdbId: string): Promise<number | null> {
    const memo = this.showIdByTvdb.get(tvdbId);
    if (memo !== undefined) return memo;
    const show = await this.get(`${BASE}/lookup/shows?thetvdb=${encodeURIComponent(tvdbId)}`);
    if (!show.answered) return null;
    const id = typeof show.data?.id === 'number' ? show.data.id : null;
    this.showIdByTvdb.set(tvdbId, id);
    return id;
  }

  /**
   * A plain GET, reporting whether TVmaze actually answered.
   *
   * The distinction is what the memos above are keyed on: "TVmaze has no time
   * for this episode" is settled and worth remembering for the session, while
   * "we were offline for a moment" is not — caching that would leave the time
   * missing for the rest of the tab's life, long after the network came back.
   */
  private get(url: string): Promise<{ answered: boolean; data: any | null }> {
    const pending = this.inflight.get(url);
    if (pending) return pending;
    const run = fetch(url)
      .then((res) => {
        if (res.ok) return res.json().then((data: any) => ({ answered: true, data }));
        // A 404 is TVmaze answering "no such show/episode"; a 5xx or a rate
        // limit is not an answer at all.
        return { answered: res.status === 404, data: null };
      })
      .catch(() => ({ answered: false, data: null }))
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, run);
    return run;
  }
}
