import { DocService, epKey } from './doc.service';
import { parseTmdbExpiry } from './tmdb.service';
import type { EpisodeRating } from './models';

/**
 * Per-episode ratings live in their own CRDT map rather than inside the
 * matching EpisodeWatch. These pin down why: a rating is an opinion, and
 * clearing a watch must not take it down with the watch history.
 */
describe('episode ratings in the doc', () => {
  let docs: DocService;
  const key = epKey('323168', 1, 6);

  const rating = (): EpisodeRating => ({
    tvdbId: '323168',
    season: 1,
    episode: 6,
    rating: 8,
    ratedAt: '2026-01-18T22:20:16Z',
    syncedToTmdb: true,
  });

  beforeEach(() => {
    docs = new DocService();
    docs.episodeWatches.set(key, {
      tvdbId: '323168',
      season: 1,
      episode: 6,
      watchedAt: '2026-01-18T22:20:16Z',
      nbTimes: 1,
    });
    docs.episodeRatings.set(key, rating());
  });

  it('keeps the rating when the watch is cleared', () => {
    docs.episodeWatches.delete(key);
    expect(docs.episodeRatings.get(key)?.rating).toBe(8);
  });

  it('keys ratings exactly like the watch they belong to', () => {
    expect(docs.episodeRatings.has(key)).toBeTrue();
    expect(key).toBe('323168:1:6');
  });

  it('travels in the state export and merges back on import', () => {
    const exported = JSON.parse(docs.exportJson());
    expect(exported.episodeRatings[key].rating).toBe(8);

    const fresh = new DocService();
    fresh.importJson(JSON.stringify(exported));
    expect(fresh.episodeRatings.get(key)).toEqual(jasmine.objectContaining({ rating: 8 }));
  });
});

/**
 * TMDB stamps guest-session expiry in its own format. Getting this wrong in the
 * lenient direction is the expensive one — believing a lapsed session is live
 * makes every rating fail — so anything unreadable falls back to one hour.
 */
describe('parseTmdbExpiry', () => {
  it("reads TMDB's space-separated UTC stamp", () => {
    expect(parseTmdbExpiry('2016-08-27 16:26:40 UTC')).toBe(Date.parse('2016-08-27T16:26:40Z'));
  });

  it('falls back to an hour out when the stamp is missing or unreadable', () => {
    const hour = 60 * 60 * 1000;
    for (const bad of [undefined, null, '', 'soon', 42]) {
      const drift = Math.abs(parseTmdbExpiry(bad) - (Date.now() + hour));
      expect(drift).toBeLessThan(1000);
    }
  });
});
