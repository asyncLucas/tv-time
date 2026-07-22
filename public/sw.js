/**
 * The app's service worker: Angular's, plus offline write delivery.
 *
 * `ngsw-worker.js` (precaching, versioned updates, the poster-art cache) is
 * imported wholesale — this file is that worker with one capability added:
 * flushing a gist push that failed while the device was offline. Background
 * Sync fires when connectivity returns even if every tab is closed, which is
 * the case the app itself cannot cover.
 *
 * Plain dependency-free JavaScript on purpose. It is copied verbatim out of
 * public/ by the build, so there is no separate bundling step to forget and no
 * way to ship a stale compiled worker. It imports nothing from the app; the
 * contract between them is the record shape in src/app/core/gist-outbox.ts and
 * the four constants below, which must match that file.
 *
 * Registered in place of ngsw-worker.js by src/app/app.config.ts.
 */

/**
 * Cache-buster for the import below. **Bump this when Angular is upgraded.**
 *
 * Registering this file demotes ngsw-worker.js from the main service worker
 * script to an imported one, and the two are fetched under different rules: the
 * main script always bypasses the HTTP cache on an update check, imported
 * scripts do not (the default `updateViaCache: 'imports'`, which Angular's
 * `provideServiceWorker` gives no way to change). ngsw-worker.js ships under an
 * unhashed filename, so a host that sets any `Cache-Control` on it — GitHub
 * Pages sends `max-age=600` — can hand back the previous Angular version's
 * worker after a deploy.
 *
 * The revision only has to change when ngsw-worker.js itself does, which is on
 * an Angular upgrade and at no other time: this file's own bytes are stable
 * across app deploys, and app content updates travel through ngsw.json, which
 * the running worker re-checks on its own.
 */
const NGSW_REV = '20-3-0';
importScripts(`./ngsw-worker.js?rev=${NGSW_REV}`);

/** Written by the page, read (and cleared) here. Must match gist-outbox.ts. */
const OUTBOX_DB = 'tvtime-outbox';
const OUTBOX_STORE = 'kv';
const PUSH_KEY = 'push';
const VERSION_KEY = 'version';
const SYNC_TAG = 'gist-push';

/** Read-only from here: the token lives with the rest of the device config. */
const CONFIG_DB = 'tvtime-config';
const CONFIG_STORE = 'kv';
const TOKEN_KEY = 'gistToken';

const API = 'https://api.github.com';
const FILENAME = 'tvtime-revival-state.json';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(flushOutbox());
});

/**
 * Deliver the queued payload — if, and only if, the gist has not moved since it
 * was built.
 *
 * A gist push replaces the *whole* CRDT state, so it is safe only when it is a
 * superset of what is already there. The app guarantees that by pulling and
 * merging before every push. This worker cannot merge — shipping a CRDT engine
 * into the service worker to cover an offline edge case is not a trade worth
 * making — so it does the one thing that is provably safe without merging:
 * push only while the remote still sits on the exact version the payload was
 * merged onto. If another device wrote in the meantime, the record is left for
 * the app to merge properly at next launch, which is exactly the behaviour
 * without this worker — never worse.
 *
 * Throwing asks the browser to retry the sync later; returning ends it.
 */
async function flushOutbox() {
  const record = await idbGet(OUTBOX_DB, OUTBOX_STORE, PUSH_KEY);
  if (!record || !record.gistId || !record.content) return;

  if (expired(record)) {
    await idbDelete(OUTBOX_DB, OUTBOX_STORE, PUSH_KEY);
    return;
  }

  const token = await idbGet(CONFIG_DB, CONFIG_STORE, TOKEN_KEY);
  if (!token) return; // sync was disconnected here; the app owns that decision

  const head = await gh('GET', `/gists/${record.gistId}`, token);
  // The token was revoked or the gist deleted: this payload can never land, and
  // retrying forever would just burn the user's rate limit.
  if (head.status === 401 || head.status === 404) {
    await idbDelete(OUTBOX_DB, OUTBOX_STORE, PUSH_KEY);
    return;
  }
  if (!head.ok) throw new Error(`gist read failed (${head.status})`);

  const remote = await head.json().catch(() => null);
  if (!canFastForward(record, versionOf(remote))) return; // let the app merge

  const res = await gh('PATCH', `/gists/${record.gistId}`, token, {
    files: { [FILENAME]: { content: record.content } },
  });
  // 403 is a rate limit or a missing scope — both are the app's to report, and
  // both resolve on their own timescale, so leave the record and stop trying.
  if (res.status === 401 || res.status === 403 || res.status === 404) return;
  if (!res.ok) throw new Error(`gist write failed (${res.status})`);

  await idbDelete(OUTBOX_DB, OUTBOX_STORE, PUSH_KEY);
  const version = versionOf(await res.json().catch(() => null));
  if (version) await idbPut(OUTBOX_DB, OUTBOX_STORE, VERSION_KEY, version);
}

/** Mirrors canFastForward in src/app/core/gist-outbox.ts. */
function canFastForward(record, remoteVersion) {
  return !!record.baseVersion && !!remoteVersion && remoteVersion === record.baseVersion;
}

function expired(record) {
  const queued = Date.parse(record.queuedAt);
  return !Number.isFinite(queued) || Date.now() - queued > MAX_AGE_MS;
}

function versionOf(gist) {
  const version = gist && gist.history && gist.history[0] && gist.history[0].version;
  return typeof version === 'string' && version ? version : null;
}

function gh(method, path, token, body) {
  return fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// IndexedDB
//
// Databases are opened WITHOUT a version and only when they already exist:
// opening a missing database creates it empty at version 1, which would then
// stop the app's own `open(name, 1)` from ever running its upgrade and creating
// the object store. A worker must not be able to break the page that way.
// ---------------------------------------------------------------------------
async function openExisting(name, store) {
  if (!self.indexedDB || !indexedDB.databases) return null;
  const existing = await indexedDB.databases().catch(() => []);
  if (!existing.some((d) => d.name === name)) return null;

  const db = await new Promise((resolve) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => resolve(null);
  });
  if (!db) return null;
  if (!db.objectStoreNames.contains(store)) {
    db.close();
    return null;
  }
  return db;
}

async function idbGet(name, store, key) {
  const db = await openExisting(name, store);
  if (!db) return null;
  try {
    return await new Promise((resolve) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

function idbWrite(name, store, run) {
  return openExisting(name, store).then((db) => {
    if (!db) return;
    return new Promise((resolve) => {
      const t = db.transaction(store, 'readwrite');
      run(t.objectStore(store));
      t.oncomplete = t.onerror = t.onabort = () => resolve();
    }).finally(() => db.close());
  });
}

function idbPut(name, store, key, value) {
  return idbWrite(name, store, (s) => s.put(value, key));
}

function idbDelete(name, store, key) {
  return idbWrite(name, store, (s) => s.delete(key));
}
