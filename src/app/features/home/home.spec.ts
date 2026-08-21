import { advance, ago, airedOn, episodesLeft, hasAired, justReleased } from './home';

/**
 * `episodesLeft` puts a number on how much of a show is still watchable. The
 * trap is `episodeCount`, which counts scheduled episodes as well as aired
 * ones — the count has to stop at the air line, not at the season finale.
 */
describe('episodesLeft', () => {
  const seasons = [
    { seasonNumber: 1, episodeCount: 10, name: 'Season 1' },
    { seasonNumber: 2, episodeCount: 8, name: 'Season 2' },
  ];

  it('counts the offered episode and everything aired after it', () => {
    // S1E8, S1E9, S1E10, then all eight of season 2.
    expect(episodesLeft({ season: 1, episode: 8 }, { season: 2, episode: 8 }, seasons)).toBe(11);
  });

  it('stops at the last aired episode, not the last scheduled one', () => {
    // Season 2 is only three episodes in, so the other five don't count yet.
    expect(episodesLeft({ season: 1, episode: 8 }, { season: 2, episode: 3 }, seasons)).toBe(6);
  });

  it('counts a single outstanding episode as one, not zero', () => {
    expect(episodesLeft({ season: 2, episode: 8 }, { season: 2, episode: 8 }, seasons)).toBe(1);
  });

  it('gives no count for a show that is unresolved or has not premiered', () => {
    expect(episodesLeft({ season: 1, episode: 1 }, undefined, seasons)).toBe(0);
    expect(episodesLeft({ season: 1, episode: 1 }, null, seasons)).toBe(0);
  });

  it('never goes negative when the air line sits behind the next episode', () => {
    expect(episodesLeft({ season: 2, episode: 5 }, { season: 2, episode: 3 }, seasons)).toBe(0);
    expect(episodesLeft({ season: 2, episode: 1 }, { season: 1, episode: 10 }, seasons)).toBe(0);
  });

  it('ignores a last-aired episode number TMDB no longer backs with a season', () => {
    // A renumbered season can leave lastAired past episodeCount; the count is
    // capped by the season itself rather than trusting the larger number.
    expect(episodesLeft({ season: 2, episode: 1 }, { season: 2, episode: 99 }, seasons)).toBe(8);
  });
});

/**
 * `ago` stamps every row of the Recently watched feed. Watches carry a clock
 * time, but the feed reads in days — so the comparison has to be between local
 * calendar days, not elapsed hours.
 */
describe('ago', () => {
  const at = (iso: string) => new Date(iso).getTime();
  const NOW = at('2026-07-22T09:00:00');

  it('calls anything watched today "Today", however many hours back', () => {
    expect(ago('2026-07-22T08:59:00', NOW)).toBe('Today');
    expect(ago('2026-07-22T00:01:00', NOW)).toBe('Today');
  });

  it('crosses midnight into "Yesterday" rather than counting hours', () => {
    // Ten hours earlier, but the day before — the feed should say so.
    expect(ago('2026-07-21T23:00:00', NOW)).toBe('Yesterday');
  });

  it('scales the unit with the distance', () => {
    expect(ago('2026-07-19T12:00:00', NOW)).toBe('3 days ago');
    expect(ago('2026-06-24T12:00:00', NOW)).toBe('4 weeks ago');
    expect(ago('2026-03-22T12:00:00', NOW)).toBe('4 months ago');
    expect(ago('2025-07-22T12:00:00', NOW)).toBe('a year ago');
    expect(ago('2023-07-22T12:00:00', NOW)).toBe('3 years ago');
  });

  it('reads a timestamp from the future as today, not as negative days', () => {
    expect(ago('2026-07-23T12:00:00', NOW)).toBe('Today');
  });

  it('renders nothing for a timestamp it cannot parse', () => {
    expect(ago('not a date', NOW)).toBe('');
  });
});

/**
 * `hasAired` is what keeps the Continue watching rail to episodes you can
 * actually watch. It has to decide from whatever metadata has arrived: an exact
 * per-episode air date, TMDB's last-episode-to-air for the show, or neither.
 */
describe('hasAired', () => {
  const TODAY = '2026-07-22';

  it('trusts an exact air date over everything else', () => {
    expect(hasAired({ season: 2, episode: 5 }, null, '2026-07-21', TODAY)).toBe(true);
    expect(hasAired({ season: 1, episode: 1 }, { season: 9, episode: 9 }, '2026-07-23', TODAY)).toBe(
      false,
    );
  });

  it('counts an episode airing today as watchable', () => {
    expect(hasAired({ season: 1, episode: 1 }, undefined, TODAY, TODAY)).toBe(true);
  });

  it('falls back to the show’s last aired episode when the date is unknown', () => {
    const last = { season: 3, episode: 4 };
    expect(hasAired({ season: 3, episode: 4 }, last, null, TODAY)).toBe(true);
    expect(hasAired({ season: 2, episode: 9 }, last, null, TODAY)).toBe(true);
    expect(hasAired({ season: 3, episode: 5 }, last, null, TODAY)).toBe(false);
    expect(hasAired({ season: 4, episode: 1 }, last, null, TODAY)).toBe(false);
  });

  it('holds back every episode of a show that has not premiered', () => {
    expect(hasAired({ season: 1, episode: 1 }, null, null, TODAY)).toBe(false);
  });

  it('assumes aired when nothing is known — missing metadata must not hide a row', () => {
    expect(hasAired({ season: 1, episode: 1 }, undefined, null, TODAY)).toBe(true);
  });
});

/**
 * `airedOn` is what lets the rail float today's release to the top. It runs
 * before the rail is capped, so it has to answer for shows the per-episode
 * fetch hasn't reached — and it must not credit a show with a release that
 * isn't the episode being offered.
 */
describe('airedOn', () => {
  const TODAY = '2026-07-22';

  it('prefers the exact per-episode air date', () => {
    const last = { season: 3, episode: 9, airDate: TODAY };
    expect(airedOn({ season: 3, episode: 4 }, last, '2026-07-01')).toBe('2026-07-01');
  });

  it('falls back to the show’s last aired episode when it is the one offered', () => {
    const last = { season: 3, episode: 4, airDate: TODAY };
    expect(airedOn({ season: 3, episode: 4 }, last, null)).toBe(TODAY);
  });

  it('does not lend the show’s release date to an earlier episode', () => {
    // Two behind the air line: today's episode exists, but it isn't this row.
    const last = { season: 3, episode: 6, airDate: TODAY };
    expect(airedOn({ season: 3, episode: 4 }, last, null)).toBeNull();
    expect(airedOn({ season: 2, episode: 6 }, last, null)).toBeNull();
  });

  it('has no date for an unresolved show, or one that has not premiered', () => {
    expect(airedOn({ season: 1, episode: 1 }, undefined, null)).toBeNull();
    expect(airedOn({ season: 1, episode: 1 }, null, null)).toBeNull();
    expect(airedOn({ season: 1, episode: 1 }, { season: 1, episode: 1, airDate: null }, null)).toBeNull();
  });
});

/**
 * `justReleased` decides whether a row leads Continue watching. Its whole job
 * is the day of slack between the network's air date and the viewer's date.
 */
describe('justReleased', () => {
  const TODAY = '2026-07-22';

  it('leads with an episode dated today', () => {
    expect(justReleased(TODAY, TODAY)).toBe(true);
  });

  it('still leads with last night’s air date — the viewer may be a day ahead', () => {
    expect(justReleased('2026-07-21', TODAY)).toBe(true);
  });

  it('stops there: two days back is not a release any more', () => {
    expect(justReleased('2026-07-20', TODAY)).toBe(false);
  });

  it('steps back over a month boundary, and a leap day', () => {
    expect(justReleased('2026-06-30', '2026-07-01')).toBe(true);
    expect(justReleased('2026-06-29', '2026-07-01')).toBe(false);
    expect(justReleased('2024-02-29', '2024-03-01')).toBe(true);
    expect(justReleased('2025-12-31', '2026-01-01')).toBe(true);
  });

  it('does not lead with something scheduled ahead of today', () => {
    expect(justReleased('2026-07-23', TODAY)).toBe(false);
  });
});

/**
 * `advance` decides which episode the Continue watching rail offers next. It
 * runs against TMDB's season list, which is messier than it looks: specials
 * (season 0) are already filtered out upstream, seasons can arrive out of
 * order, and a season can exist with no episodes yet.
 */
describe('advance', () => {
  const seasons = [
    { seasonNumber: 1, episodeCount: 10, name: 'Season 1' },
    { seasonNumber: 2, episodeCount: 8, name: 'Season 2' },
  ];

  it('steps to the next episode within a season', () => {
    expect(advance({ season: 1, episode: 3 }, seasons)).toEqual({ season: 1, episode: 4 });
  });

  it('rolls over to the next season after a finale', () => {
    expect(advance({ season: 1, episode: 10 }, seasons)).toEqual({ season: 2, episode: 1 });
  });

  it('starts a show with nothing watched at the first episode', () => {
    expect(advance(undefined, seasons)).toEqual({ season: 1, episode: 1 });
  });

  it('returns null once the last known episode is watched', () => {
    expect(advance({ season: 2, episode: 8 }, seasons)).toBeNull();
  });

  it('skips a season TMDB lists with no episodes yet', () => {
    const withEmpty = [
      { seasonNumber: 1, episodeCount: 6, name: 'Season 1' },
      { seasonNumber: 2, episodeCount: 0, name: 'Season 2' },
      { seasonNumber: 3, episodeCount: 4, name: 'Season 3' },
    ];
    expect(advance({ season: 1, episode: 6 }, withEmpty)).toEqual({ season: 3, episode: 1 });
  });

  it('orders seasons numerically, not by array position', () => {
    const shuffled = [
      { seasonNumber: 2, episodeCount: 8, name: 'Season 2' },
      { seasonNumber: 1, episodeCount: 10, name: 'Season 1' },
    ];
    expect(advance(undefined, shuffled)).toEqual({ season: 1, episode: 1 });
    expect(advance({ season: 1, episode: 10 }, shuffled)).toEqual({ season: 2, episode: 1 });
  });

  it('moves on when the watched episode is past what TMDB lists for that season', () => {
    // A backup can hold episode numbers TMDB no longer agrees with (renumbered
    // seasons, double episodes). Treat the season as finished rather than
    // offering an episode that doesn't exist.
    expect(advance({ season: 1, episode: 99 }, seasons)).toEqual({ season: 2, episode: 1 });
  });

  it('has no next episode for a show with no seasons', () => {
    expect(advance({ season: 1, episode: 1 }, [])).toBeNull();
  });
});
