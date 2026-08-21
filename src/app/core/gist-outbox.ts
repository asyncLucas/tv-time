/**
 * The pending-push outbox: the payload a gist sync could not deliver, parked
 * where a service worker can finish the job later.
 *
 * A push is the last step of an edit. Tick an episode with no connection and
 * the PATCH simply fails, leaving that change on this device alone — until the
 * app is next opened *and* online. The outbox holds the exact payload that
 * failed, so `public/sw.js` can deliver it through Background Sync when
 * connectivity returns, even with every tab closed.
 *
 * It gets its own IndexedDB database for two reasons. LocalConfigService
 * mirrors every key it holds into an in-memory signal, and a payload is the
 * whole CRDT state — megabytes on a large library. And this database is the one
 * place two contexts write (page and worker), so keeping it apart leaves
 * `tvtime-config` single-writer and makes the worker's blast radius obvious.
 *
 * Every function here swallows storage errors: a device with IndexedDB blocked
 * (private mode, locked-down browser) loses the retry, not the app.
 */

const DB = 'tvtime-outbox';
const STORE = 'kv';
/** The queued payload. */
const PUSH_KEY = 'push';
/** The gist version the local state was last merged with — see canFastForward. */
const VERSION_KEY = 'version';

/**
 * Background Sync tag. Shared verbatim with public/sw.js; changing it here
 * without changing it there silently orphans queued pushes.
 */
export const OUTBOX_SYNC_TAG = 'gist-push';

/** How long a queued push stays worth delivering before it is dropped. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** One undelivered gist push. The shape is a contract with public/sw.js. */
export interface OutboxRecord {
  /** The gist to PATCH. */
  gistId: string;
  /** Full file content — an already-merged CRDT state (GistSyncService.pack). */
  content: string;
  /**
   * The gist commit sha this payload was merged on top of, or null if this
   * device has never completed a pull. The worker refuses to push without it.
   */
  baseVersion: string | null;
  /** When it was queued, ISO — drives expiry and the "pending" note in the UI. */
  queuedAt: string;
}

/**
 * Is it safe to PATCH this payload without merging first?
 *
 * Only when the gist still sits on the exact version the payload was built on.
 * The gist holds the *whole* state as one blob, so a push that isn't a superset
 * of what's there destroys the difference; the app guarantees that by pulling
 * and merging before every push, and this is the one check that gives the same
 * guarantee to a caller that cannot merge.
 */
export function canFastForward(
  record: OutboxRecord | null | undefined,
  remoteVersion: string | null | undefined,
): boolean {
  if (!record?.gistId || !record.content || !record.baseVersion) return false;
  return !!remoteVersion && remoteVersion === record.baseVersion;
}

/** True once a queued push is too old to be worth delivering. */
export function isExpired(record: OutboxRecord, now = Date.now()): boolean {
  const queued = Date.parse(record.queuedAt);
  return !Number.isFinite(queued) || now - queued > MAX_AGE_MS;
}

/** The current commit sha of a gist, from any GitHub gist response. */
export function gistVersionOf(gist: unknown): string | null {
  const version = (gist as any)?.history?.[0]?.version;
  return typeof version === 'string' && version ? version : null;
}

/** Park a payload for delivery. Replaces any earlier one — it's a superset. */
export function queuePush(record: OutboxRecord): Promise<void> {
  return write(PUSH_KEY, record);
}

export function readQueuedPush(): Promise<OutboxRecord | null> {
  return read<OutboxRecord>(PUSH_KEY);
}

/**
 * Is anything queued? Asked on launch and after every failed cycle, purely to
 * drive a boolean in the UI.
 *
 * Uses `getKey` rather than `get` on purpose: the record holds the entire CRDT
 * state, which is megabytes on a real library, and reading it back would
 * structured-clone all of it out of the database to answer yes or no.
 */
export async function hasQueuedPush(): Promise<boolean> {
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    return await new Promise<boolean>((resolve, reject) => {
      const req = db!.transaction(STORE, 'readonly').objectStore(STORE).getKey(PUSH_KEY);
      req.onsuccess = () => resolve(req.result !== undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

export function clearQueuedPush(): Promise<void> {
  return write(PUSH_KEY, undefined);
}

export function rememberGistVersion(version: string): Promise<void> {
  return write(VERSION_KEY, version);
}

export function readGistVersion(): Promise<string | null> {
  return read<string>(VERSION_KEY);
}

/**
 * Ask the browser to deliver the outbox in the background. Chromium-only; the
 * `false` return is the signal that this device falls back to flushing when the
 * app is next online with a tab open (see GistSyncService.wire).
 */
export async function requestBackgroundFlush(): Promise<boolean> {
  // `ready` never settles when nothing is registered (dev, or a browser with
  // service workers off), so gate on an actual controller first.
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return false;
  try {
    const reg: any = await navigator.serviceWorker.ready;
    if (!reg?.sync) return false;
    await reg.sync.register(OUTBOX_SYNC_TAG);
    return true;
  } catch {
    return false; // permission denied, or the registration went away
  }
}

/** Drop the whole outbox database (used by "Reset local data"). */
export function destroyOutbox(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

// ---------------------------------------------------------------------------
// storage
//
// A connection is opened per operation and closed after. These run once per
// push at most, and holding one open would block the delete above.
// ---------------------------------------------------------------------------
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function read<T>(key: string): Promise<T | null> {
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    return await new Promise<T | null>((resolve, reject) => {
      const req = db!.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** `undefined` deletes the key — one path for both, so both close the db. */
async function write(key: string, value: unknown): Promise<void> {
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    await new Promise<void>((resolve, reject) => {
      const t = db!.transaction(STORE, 'readwrite');
      const store = t.objectStore(STORE);
      if (value === undefined) store.delete(key);
      else store.put(value, key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {
    /* storage blocked — the retry is lost, the app is not */
  } finally {
    db?.close();
  }
}
