import { addedKey } from './doc.service';
import { DocService } from './doc.service';

describe('addedKey', () => {
  it('derives a stable id from the TMDB id, so devices converge', () => {
    expect(addedKey('show', 1396)).toBe('tmdb:show:1396');
    expect(addedKey('show', 1396)).toBe(addedKey('show', 1396));
  });

  it('keeps shows and movies in separate id spaces', () => {
    expect(addedKey('show', 1396)).not.toBe(addedKey('movie', 1396));
  });
});

describe('added titles in export/import', () => {
  it('round-trips added titles so a backup restores them', () => {
    const source = new DocService();
    source.addedShows.set('tmdb:show:1396', {
      uuid: 'tmdb:show:1396',
      name: 'Breaking Bad',
      tmdbId: 1396,
      tvdbId: '81189',
      imdbId: null,
      posterPath: '/poster.jpg',
      firstReleaseDate: '2008-01-20',
      overview: 'A chemistry teacher.',
      genres: ['Drama'],
      addedAt: '2026-01-01T00:00:00.000Z',
    });

    const restored = new DocService();
    restored.importJson(source.exportJson());

    expect(restored.addedShows.get('tmdb:show:1396')).toEqual(
      jasmine.objectContaining({ name: 'Breaking Bad', tvdbId: '81189' }),
    );
  });

  it('never carries the synced settings map, which holds the API key', () => {
    const docs = new DocService();
    docs.settings.set('tmdbKey', 'super-secret');
    const exported = JSON.parse(docs.exportJson());

    expect(exported.settings).toBeUndefined();
    expect(docs.exportJson()).not.toContain('super-secret');
  });
});
