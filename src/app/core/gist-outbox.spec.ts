import {
  canFastForward,
  clearQueuedPush,
  destroyOutbox,
  gistVersionOf,
  hasQueuedPush,
  isExpired,
  queuePush,
  readGistVersion,
  readQueuedPush,
  rememberGistVersion,
  type OutboxRecord,
} from './gist-outbox';

function record(over: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    gistId: 'abc123',
    content: '{"app":"tv-time-revival"}',
    baseVersion: 'sha-1',
    queuedAt: new Date().toISOString(),
    ...over,
  };
}

/**
 * `canFastForward` is the whole safety argument for pushing from a service
 * worker that cannot merge CRDTs. A gist push replaces the entire state, so a
 * wrong `true` here silently destroys whatever another device wrote.
 */
describe('canFastForward', () => {
  it('allows a push while the gist still sits on the merged-from version', () => {
    expect(canFastForward(record({ baseVersion: 'sha-1' }), 'sha-1')).toBe(true);
  });

  it('refuses once another device has written', () => {
    expect(canFastForward(record({ baseVersion: 'sha-1' }), 'sha-2')).toBe(false);
  });

  it('refuses when this device has never completed a pull', () => {
    expect(canFastForward(record({ baseVersion: null }), 'sha-1')).toBe(false);
  });

  it('refuses when the remote version is unreadable', () => {
    expect(canFastForward(record(), null)).toBe(false);
    expect(canFastForward(record(), undefined)).toBe(false);
  });

  it('refuses an empty or absent record', () => {
    expect(canFastForward(null, 'sha-1')).toBe(false);
    expect(canFastForward(record({ content: '' }), 'sha-1')).toBe(false);
    expect(canFastForward(record({ gistId: '' }), 'sha-1')).toBe(false);
  });
});

describe('isExpired', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-07-22T12:00:00.000Z');

  it('keeps a recently queued push', () => {
    expect(isExpired(record({ queuedAt: new Date(now - 29 * DAY).toISOString() }), now)).toBe(false);
  });

  it('drops one older than the retention window', () => {
    expect(isExpired(record({ queuedAt: new Date(now - 31 * DAY).toISOString() }), now)).toBe(true);
  });

  it('drops a record with an unreadable timestamp rather than retrying forever', () => {
    expect(isExpired(record({ queuedAt: 'not a date' }), now)).toBe(true);
  });
});

describe('gistVersionOf', () => {
  it('reads the newest commit sha', () => {
    expect(gistVersionOf({ history: [{ version: 'sha-a' }, { version: 'sha-b' }] })).toBe('sha-a');
  });

  it('returns null for a response with no usable history', () => {
    expect(gistVersionOf({})).toBeNull();
    expect(gistVersionOf({ history: [] })).toBeNull();
    expect(gistVersionOf({ history: [{ version: '' }] })).toBeNull();
    expect(gistVersionOf(null)).toBeNull();
  });
});

/**
 * The store itself. These run against the browser's real IndexedDB — the same
 * database the service worker reads, so a shape change that would strand a
 * queued push shows up here.
 */
describe('outbox storage', () => {
  afterEach(async () => {
    await destroyOutbox();
  });

  it('round-trips a queued push', async () => {
    const queued = record({ gistId: 'gist-42' });
    await queuePush(queued);
    expect(await readQueuedPush()).toEqual(queued);
  });

  it('replaces the previous payload rather than accumulating', async () => {
    await queuePush(record({ content: 'first' }));
    await queuePush(record({ content: 'second' }));
    expect((await readQueuedPush())?.content).toBe('second');
  });

  it('reads back nothing once cleared', async () => {
    await queuePush(record());
    await clearQueuedPush();
    expect(await readQueuedPush()).toBeNull();
  });

  it('keeps the base version independent of the queued push', async () => {
    await rememberGistVersion('sha-9');
    await queuePush(record());
    await clearQueuedPush();
    expect(await readGistVersion()).toBe('sha-9');
  });

  it('reports an empty outbox on a device that has never synced', async () => {
    expect(await readQueuedPush()).toBeNull();
    expect(await readGistVersion()).toBeNull();
    expect(await hasQueuedPush()).toBe(false);
  });

  /**
   * The UI only ever asks "is anything waiting?", and the record it would
   * otherwise read back is the whole CRDT state. This has to agree with
   * `readQueuedPush` exactly, or the pending note lies in one direction or the
   * other.
   */
  it('answers the pending question without reading the payload back', async () => {
    expect(await hasQueuedPush()).toBe(false);
    await queuePush(record());
    expect(await hasQueuedPush()).toBe(true);
    await clearQueuedPush();
    expect(await hasQueuedPush()).toBe(false);
  });

  it('does not count a stored version as a queued push', async () => {
    await rememberGistVersion('sha-9');
    expect(await hasQueuedPush()).toBe(false);
  });
});
