import { advance, hasAired } from './home';

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
