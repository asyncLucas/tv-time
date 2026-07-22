import { Injectable, computed, inject, signal } from '@angular/core';
import * as Y from 'yjs';
import { DocService } from './doc.service';
import {
  clearQueuedPush,
  gistVersionOf,
  hasQueuedPush,
  queuePush,
  readGistVersion,
  rememberGistVersion,
  requestBackgroundFlush,
} from './gist-outbox';
import { GithubApiService } from './github-api.service';
import { LocalConfigService } from './local-config.service';

export type GistStatus = 'off' | 'syncing' | 'synced' | 'error';

const FILENAME = 'tvtime-revival-state.json';
const MARKER = 'tv-time-revival · sync state (do not delete)';
/** Tags CRDT updates that came FROM the gist, so we don't echo them back. */
const GIST_ORIGIN = 'gist-sync';
const POLL_MS = 45_000;
const PUSH_DEBOUNCE_MS = 2_500;
/** Safety stop for gist discovery paging (100 per page = 10k gists). */
const MAX_GIST_PAGES = 100;

/**
 * Truly-serverless sync through a private GitHub Gist the user owns.
 *
 * There is no backend to run: the app talks straight to the GitHub API from the
 * browser (CORS-enabled) using a device-local `gist`-scoped token. The gist
 * holds the whole Yjs state as one base64 blob; because that state is a CRDT,
 * every device does pull → merge → push and they all converge — last-writer
 * conflicts are impossible at the data level.
 *
 * The token lives only in this device's IndexedDB (LocalConfigService) and never
 * enters the synced document. Devices discover the same gist from the token
 * alone (searched by a description marker), so setup is just "paste token".
 */
@Injectable({ providedIn: 'root' })
export class GistSyncService {
  private docs = inject(DocService);
  private config = inject(LocalConfigService);
  /** Shared with the public-profile publisher — one queue, one rate-limit budget. */
  private gh = inject(GithubApiService);

  readonly status = signal<GistStatus>('off');
  readonly lastSync = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly enabled = computed(() => this.status() !== 'off');
  /**
   * An edit is written but not yet in the gist — the offline case. It clears
   * itself once the payload lands, whether that happens here, on the next
   * `online` event, or in the service worker with every tab closed.
   */
  readonly pendingPush = signal(false);

  private pushTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private busy = false;
  private rerun = false;
  private wired = false;

  /**
   * Gist commit sha of the remote state this device has merged with. Mirrored
   * into the outbox so a queued push carries the version it was built on, which
   * is the only thing that lets the service worker deliver it safely.
   */
  private baseVersion: string | null = null;
  /** Retry the moment the network comes back, rather than at the next poll. */
  private readonly onOnline = (): void => void this.sync();

  private token(): string | undefined {
    return this.gh.token();
  }
  private gistId(): string | undefined {
    return this.config.get<string>('gistId');
  }

  /** Reconnect on launch if a token was saved on this device. */
  autoStart(): void {
    // Signed-out devices (see DeviceService) stay off until re-linked.
    if (this.config.get<boolean>('signedOut')) return;
    if (this.token()) this.start();
  }

  /** Enable sync with a fresh token: store it, find/create the gist, sync, wire. */
  async connect(token: string): Promise<void> {
    await this.config.set('gistToken', token.trim());
    await this.start(true);
  }

  private async start(justConnected = false): Promise<void> {
    this.status.set('syncing');
    this.error.set(null);
    // Anything left over from a previous session: the version we were merged
    // with, and whether an edit is still waiting to go out.
    const [version, pending] = await Promise.all([readGistVersion(), hasQueuedPush()]);
    this.baseVersion = version;
    this.pendingPush.set(pending);
    try {
      await this.ensureGist();
      await this.sync();
      this.wire();
      if (justConnected) await this.push(); // seed the gist with local state
    } catch (e: any) {
      this.fail(e);
    }
  }

  /**
   * Pull remote, merge, push the merged result back — the only routine that
   * writes to the gist.
   *
   * Always pulling first is what makes concurrent devices safe: a push sends
   * the *whole* doc state, so pushing without merging would overwrite edits
   * another device made since our last poll. Pull-then-push means the payload
   * we write is a superset of both sides.
   *
   * Runs serialized. A request arriving mid-flight sets `rerun` instead of
   * overlapping, so the newest local state is never left unpushed.
   */
  async sync(): Promise<void> {
    if (!this.token()) return;
    if (this.busy) {
      this.rerun = true;
      return;
    }
    this.busy = true;
    this.status.set('syncing');
    try {
      do {
        this.rerun = false;
        await this.pull();
        await this.push();
      } while (this.rerun);
      this.status.set('synced');
      this.lastSync.set(new Date().toISOString());
      this.error.set(null);
    } catch (e: any) {
      this.fail(e);
    } finally {
      this.busy = false;
      this.rerun = false;
    }
  }

  disconnect(): void {
    this.teardown();
    this.status.set('off');
    this.lastSync.set(null);
  }

  /** Fully forget: stop syncing and drop the token + gist id from this device. */
  forget(): void {
    this.disconnect();
    this.config.delete('gistToken');
    this.config.delete('gistId');
    // An undelivered payload outlives the connection it belonged to, and the
    // service worker would keep trying to push it with a token that is gone.
    void clearQueuedPush();
    this.pendingPush.set(false);
  }

  // -------------------------------------------------------------------------
  // Gist plumbing
  // -------------------------------------------------------------------------
  /**
   * Point this device at the user's state gist, creating it on first connect.
   *
   * Discovery walks every page of the user's gists rather than just the first
   * hundred — stopping early would silently create a *second* state gist for
   * anyone with a busy account, splitting their devices across two of them.
   * The description marker is preferred over a filename match so an unrelated
   * gist that happens to carry the same filename can't hijack sync.
   */
  private async ensureGist(): Promise<void> {
    if (this.gistId()) return;

    let byFilename: any = null;
    for (let page = 1; page <= MAX_GIST_PAGES; page++) {
      const batch = (await this.api('GET', `/gists?per_page=100&page=${page}`)) as any[];
      if (!Array.isArray(batch) || !batch.length) break;

      const marked = batch.find((g) => g.description === MARKER);
      if (marked) {
        await this.config.set('gistId', marked.id);
        return;
      }
      byFilename ??= batch.find((g) => g.files?.[FILENAME]);
      if (batch.length < 100) break; // last page
    }
    if (byFilename) {
      await this.config.set('gistId', byFilename.id);
      return;
    }
    const created = await this.api('POST', '/gists', {
      description: MARKER,
      public: false,
      files: { [FILENAME]: { content: this.pack() } },
    });
    await this.config.set('gistId', (created as any).id);
    await this.rememberVersion(created);
  }

  private async pull(): Promise<void> {
    const id = this.gistId();
    if (!id) return;
    const gist = await this.api('GET', `/gists/${id}`);
    const update = await this.readRemoteUpdate(gist);
    // `undefined` is "we could not read what is up there". Claiming that version
    // anyway is the one mistake with teeth: `baseVersion` is the whole basis on
    // which the service worker decides a queued payload is a safe superset of
    // the remote, so advancing it without merging would license a push that
    // silently drops another device's edits. Leave it where it is and let the
    // next cycle try again.
    if (update === undefined) return;
    if (update) Y.applyUpdate(this.docs.doc, update, GIST_ORIGIN);
    // Merged (or confirmed there was nothing to merge): everything we push from
    // here on really is built on top of this exact remote state.
    await this.rememberVersion(gist);
  }

  /**
   * The CRDT update sitting in the gist.
   *
   * Three outcomes, and the caller must tell them apart: a `Uint8Array` to
   * merge, `null` for a remote that holds no state yet (nothing to merge, but we
   * are in sync with it), and `undefined` for a payload we could not read —
   * truncated and unfetchable, empty, or not the JSON we wrote.
   */
  private async readRemoteUpdate(gist: unknown): Promise<Uint8Array | null | undefined> {
    const file = (gist as any).files?.[FILENAME];
    if (!file) return undefined;
    // Large gists get truncated inline; fall back to raw_url. That response is
    // status-checked — an error page's HTML would otherwise flow on as if it
    // were state content.
    let content: string | undefined = file.content;
    if (file.truncated && file.raw_url) {
      const raw = await fetch(file.raw_url);
      if (!raw.ok) throw new Error(`Could not read synced state (HTTP ${raw.status})`);
      content = await raw.text();
    }
    if (!content) return undefined;
    try {
      const parsed = JSON.parse(content);
      return parsed?.update ? b64ToBytes(parsed.update) : null;
    } catch {
      return undefined; // malformed remote file — ignore rather than corrupt local state
    }
  }

  /**
   * Write the merged state back, parking the payload in the outbox if it can't
   * be delivered.
   *
   * The queue is a *failure* path, not a precaution taken on every push. The
   * payload is the entire CRDT state — megabytes on a real library — so writing
   * it to IndexedDB before each PATCH would spend tens of megabytes of storage
   * traffic per binge on pushes that were always going to succeed.
   *
   * That leaves one case uncovered: a tab closed mid-PATCH never reaches the
   * catch. It doesn't need to. The edit is already durable in the local Yjs
   * database, so the next launch pulls, merges and pushes it exactly as if the
   * tab had never been open. What the app genuinely *cannot* recover on its own
   * is an edit made offline with every tab then closed, and that is precisely
   * the case the catch below queues for.
   */
  private async push(): Promise<void> {
    const id = this.gistId();
    if (!id) return;
    const content = this.pack();
    // Captured together with `content`, in the same tick: the record must
    // describe the state it carries, never a version merged after the pack.
    const baseVersion = this.baseVersion;
    try {
      const gist = await this.api('PATCH', `/gists/${id}`, { files: { [FILENAME]: { content } } });
      await this.rememberVersion(gist);
      if (this.pendingPush()) {
        await clearQueuedPush();
        this.pendingPush.set(false);
      }
    } catch (e) {
      await queuePush({
        gistId: id,
        content,
        baseVersion,
        queuedAt: new Date().toISOString(),
      });
      this.pendingPush.set(true);
      throw e; // fail() arms the retry
    }
  }

  /** Note the gist's new commit sha, in memory and in the outbox database. */
  private async rememberVersion(gist: unknown): Promise<void> {
    const version = gistVersionOf(gist);
    if (!version || version === this.baseVersion) return;
    this.baseVersion = version;
    await rememberGistVersion(version);
  }

  /** Serialize the full CRDT state into the gist file payload. */
  private pack(): string {
    const update = Y.encodeStateAsUpdate(this.docs.doc);
    return JSON.stringify({
      app: 'tv-time-revival',
      schema: 1,
      updatedAt: new Date().toISOString(),
      update: bytesToB64(update),
    });
  }

  // -------------------------------------------------------------------------
  // Live wiring: push local edits (debounced), poll for remote edits
  // -------------------------------------------------------------------------
  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    this.docs.doc.on('update', this.onDocUpdate);
    this.pollTimer = setInterval(() => this.pull().catch(() => {}), POLL_MS);
    // The poll only pulls, so without this a push that failed offline would sit
    // untried until the next local edit or app launch. This is also the whole
    // retry story on browsers with no Background Sync (Safari, Firefox).
    window.addEventListener('online', this.onOnline);
  }

  /**
   * A local edit landed. Debounce, then run a full merge cycle — not a bare
   * push, which would clobber anything a sibling device wrote since the last
   * poll (see sync()).
   */
  private onDocUpdate = (_u: Uint8Array, origin: unknown): void => {
    if (origin === GIST_ORIGIN) return; // remote change — don't echo it back
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.sync(), PUSH_DEBOUNCE_MS);
  };

  private teardown(): void {
    if (this.wired) this.docs.doc.off('update', this.onDocUpdate);
    this.wired = false;
    window.removeEventListener('online', this.onOnline);
    clearTimeout(this.pushTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  // -------------------------------------------------------------------------
  /** Every GitHub call goes through the shared, throttled request queue. */
  private api(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.gh.request(method, path, body);
  }

  private fail(e: any): void {
    this.error.set(String(e?.message ?? e));
    this.status.set('error');
    void this.armRetry();
  }

  /**
   * A cycle failed. If a payload is still parked in the outbox, hand it to the
   * browser: Background Sync delivers it when connectivity returns, even with
   * every tab closed — the one case the app itself can't cover. Where that
   * isn't supported the registration quietly fails and the `online` listener
   * (or the next launch) does the job instead.
   */
  private async armRetry(): Promise<void> {
    const pending = await hasQueuedPush();
    this.pendingPush.set(pending);
    if (pending) await requestBackgroundFlush();
  }
}

// --- base64 <-> bytes (binary-safe, no data: URI overhead) ---
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
