import { TestBed } from '@angular/core/testing';
import { LibraryStore } from './library.store';
import { TmdbService, type TmdbListItemRef } from './tmdb.service';

/**
 * Mirroring custom lists to TMDB, against the real `LibraryStore` and a
 * recording stand-in for TMDB.
 *
 * A list is the one thing the mirror has to *create* before it can write to it,
 * which is where the interesting failure modes are: adding an item to a brand
 * new list is two calls that must land in order, and the id the first one
 * returns has to be remembered or every later edit makes another list. The
 * store is inert here — nothing calls `whenReady()`, so each spec gets an empty
 * in-memory CRDT.
 */
describe('mirroring lists to TMDB', () => {
  /** Every list call made, in the order it was made. */
  let calls: string[];
  let store: LibraryStore;
  let linked: boolean;
  let nextListId: number;
  /** Ids `createList` should fail on, to exercise the unhappy path. */
  let refuseCreate: boolean;

  /**
   * Let the fire-and-forget mirror finish. Every stubbed call resolves
   * immediately and nothing here uses a timer, so draining the microtask queue
   * is enough — and unlike a timeout it can't race.
   */
  async function flush(): Promise<void> {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }

  /** The store's own record of where a list lives on TMDB. */
  function remoteIdOf(listId: string): number | undefined {
    return store.lists().find((l) => l.id === listId)?.tmdbListId;
  }

  const ok = { ok: true, as: 'account' as const, error: null };

  beforeEach(async () => {
    calls = [];
    linked = true;
    nextListId = 900;
    refuseCreate = false;

    const tmdb = {
      hasKey: () => true,
      hasAccount: () => true,
      hasListAccess: () => linked,
      // The title-level mirror is not what these specs are about, but the same
      // mutations trigger it, so it has to exist and stay quiet.
      setWatchlist: async () => ok,
      setFavorite: async () => ok,
      rateTitle: async () => ok,
      clearTitleRating: async () => ok,
      movie: async () => null,
      show: async () => null,
      createList: async (name: string) => {
        calls.push(`create:${name}`);
        if (refuseCreate) return { ok: false, as: null, error: 'nope', listId: null };
        return { ...ok, listId: nextListId++ };
      },
      updateList: async (id: number, name: string) => {
        calls.push(`update:${id}:${name}`);
        return ok;
      },
      deleteList: async (id: number) => {
        calls.push(`delete:${id}`);
        return ok;
      },
      addListItems: async (id: number, items: TmdbListItemRef[]) => {
        calls.push(`add:${id}:${items.map((i) => `${i.media_type}/${i.media_id}`).join(',')}`);
        return ok;
      },
      removeListItems: async (id: number, items: TmdbListItemRef[]) => {
        calls.push(`remove:${id}:${items.map((i) => `${i.media_type}/${i.media_id}`).join(',')}`);
        return ok;
      },
    };

    await TestBed.configureTestingModule({
      providers: [{ provide: TmdbService, useValue: tmdb }],
    }).compileComponents();
    store = TestBed.inject(LibraryStore);
  });

  /**
   * Put a title in the library so a list entry can resolve to it. Added titles
   * carry their TMDB id in their own uuid, so this needs no network.
   */
  async function addTitle(kind: 'show' | 'movie', tmdbId: number, name: string): Promise<string> {
    const result = { tmdbId, name, posterPath: null, year: null, overview: '' } as any;
    return kind === 'show' ? store.addShow(result, null) : store.addMovie(result, null);
  }

  it('creates the list on TMDB before putting anything on it, and remembers its id', async () => {
    const uuid = await addTitle('movie', 550, 'Fight Club');
    const listId = store.createList('filmes');
    await flush();
    // An empty list is nothing to mirror — the create waits for a reason to.
    expect(calls).toEqual([]);

    store.addListItem(listId, { uuid, title: 'Fight Club', entityType: 'movie' });
    await flush();

    expect(calls).toEqual(['create:filmes', 'add:900:movie/550']);
    expect(remoteIdOf(listId)).toBe(900);
  });

  it('reuses the remote list for later items instead of making another', async () => {
    const a = await addTitle('movie', 550, 'Fight Club');
    const b = await addTitle('movie', 27205, 'Inception');
    const listId = store.createList('filmes');
    store.addListItem(listId, { uuid: a, title: 'Fight Club', entityType: 'movie' });
    store.addListItem(listId, { uuid: b, title: 'Inception', entityType: 'movie' });
    await flush();

    expect(calls).toEqual(['create:filmes', 'add:900:movie/550', 'add:900:movie/27205']);
    expect(calls.filter((c) => c.startsWith('create:')).length).toBe(1);
  });

  /**
   * The whole reason lists go through v4: a show on a list is the case the
   * older API cannot express at all.
   */
  it('sends a show as tv, not as a movie', async () => {
    const uuid = await addTitle('show', 1396, 'Breaking Bad');
    const listId = store.createList('para assistir');
    store.addListItem(listId, { uuid, title: 'Breaking Bad', entityType: 'show' });
    await flush();

    expect(calls).toContain('add:900:tv/1396');
  });

  it('takes an item off the remote list when it comes off here', async () => {
    const uuid = await addTitle('movie', 550, 'Fight Club');
    const listId = store.createList('filmes');
    store.addListItem(listId, { uuid, title: 'Fight Club', entityType: 'movie' });
    await flush();
    calls = [];

    store.removeListItem(listId, { uuid, title: 'Fight Club' });
    await flush();
    expect(calls).toEqual(['remove:900:movie/550']);
  });

  it('deletes the remote list, and sends nothing for one that was never mirrored', async () => {
    const uuid = await addTitle('movie', 550, 'Fight Club');
    const mirrored = store.createList('filmes');
    store.addListItem(mirrored, { uuid, title: 'Fight Club', entityType: 'movie' });
    const untouched = store.createList('nunca');
    await flush();
    calls = [];

    store.deleteList(untouched);
    store.deleteList(mirrored);
    await flush();
    expect(calls).toEqual(['delete:900']);
  });

  it('renames a mirrored list but never creates one just to rename it', async () => {
    const uuid = await addTitle('movie', 550, 'Fight Club');
    const mirrored = store.createList('filmes');
    store.addListItem(mirrored, { uuid, title: 'Fight Club', entityType: 'movie' });
    const untouched = store.createList('nunca');
    await flush();
    calls = [];

    store.renameList(untouched, 'ainda nunca');
    store.renameList(mirrored, 'filmes bons');
    await flush();
    expect(calls).toEqual(['update:900:filmes bons']);
  });

  /** Lists sit behind their own opt-in, so an unlinked app is silent. */
  it('does nothing at all when lists are not linked', async () => {
    linked = false;
    const uuid = await addTitle('movie', 550, 'Fight Club');
    const listId = store.createList('filmes');
    store.addListItem(listId, { uuid, title: 'Fight Club', entityType: 'movie' });
    store.renameList(listId, 'outro');
    store.deleteList(listId);
    await flush();

    expect(calls).toEqual([]);
  });

  /**
   * A refused create must not be papered over by later writes behaving as if
   * the list existed — nothing should reach a list id we never got.
   */
  it('never creates a remote list for a title TMDB cannot name', async () => {
    const listId = store.createList('filmes');
    store.addListItem(listId, { uuid: 'ghost-uuid', title: 'Unknown Number', entityType: 'movie' });
    await flush();

    expect(calls).toEqual([]);
    expect(remoteIdOf(listId)).toBeUndefined();
  });

  it('gives up on the list when TMDB refuses to create it', async () => {
    refuseCreate = true;
    const uuid = await addTitle('movie', 550, 'Fight Club');
    const listId = store.createList('filmes');
    store.addListItem(listId, { uuid, title: 'Fight Club', entityType: 'movie' });
    await flush();

    expect(calls).toEqual(['create:filmes']);
    expect(remoteIdOf(listId)).toBeUndefined();
    expect(store.tmdbNote()?.text).toContain('nope');
  });

  describe('the one-off catch-up', () => {
    it('sends every list in one pass and counts what it could not match', async () => {
      const a = await addTitle('movie', 550, 'Fight Club');
      const show = await addTitle('show', 1396, 'Breaking Bad');
      const first = store.createList('filmes');
      const second = store.createList('séries');
      store.addListItem(first, { uuid: a, title: 'Fight Club', entityType: 'movie' });
      store.addListItem(second, { uuid: show, title: 'Breaking Bad', entityType: 'show' });
      // A list entry pointing at nothing in the library — the shape the old
      // backup leaves behind for titles the catalog has no id for.
      store.addListItem(second, { uuid: 'ghost-uuid', title: 'Unknown Number', entityType: 'movie' });
      await flush();
      calls = [];

      const summary = await store.syncAllLists();

      expect(summary.lists).toBe(2);
      expect(summary.items).toBe(2);
      expect(summary.unresolved).toBe(1);
      expect(calls).toEqual(['add:900:movie/550', 'add:901:tv/1396']);
    });

    it('is safe to run twice — the second pass re-sends against the same lists', async () => {
      const uuid = await addTitle('movie', 550, 'Fight Club');
      const listId = store.createList('filmes');
      store.addListItem(listId, { uuid, title: 'Fight Club', entityType: 'movie' });
      await flush();

      await store.syncAllLists();
      await store.syncAllLists();
      expect(calls.filter((c) => c.startsWith('create:')).length).toBe(1);
    });
  });
});
