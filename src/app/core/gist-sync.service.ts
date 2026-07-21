import { Injectable, computed, inject, signal } from '@angular/core';
import * as Y from 'yjs';
import { DocService } from './doc.service';
import { LocalConfigService } from './local-config.service';

export type GistStatus = 'off' | 'syncing' | 'synced' | 'error';

const API = 'https://api.github.com';
const FILENAME = 'tvtime-revival-state.json';
const MARKER = 'tv-time-revival · sync state (do not delete)';
/** Tags CRDT updates that came FROM the gist, so we don't echo them back. */
const GIST_ORIGIN = 'gist-sync';
const POLL_MS = 45_000;
const PUSH_DEBOUNCE_MS = 2_500;
/** Safety stop for gist discovery paging (100 per page = 10k gists). */
const MAX_GIST_PAGES = 100;
/**
 * Minimum gap between any two GitHub API calls. GitHub's *primary* limit is a
 * generous 5k/hour, but a *secondary* "too many requests too quickly" heuristic
 * trips on bursts (rapid PATCH pushes, or paging every gist on connect). Spacing
 * calls keeps us clear of it without noticeably slowing normal use.
 */
const MIN_REQUEST_GAP_MS = 1_000;
/** How long to wait when GitHub 403/429s without telling us when to retry. */
const DEFAULT_BACKOFF_MS = 60_000;

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

  readonly status = signal<GistStatus>('off');
  readonly lastSync = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly enabled = computed(() => this.status() !== 'off');

  private pushTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private busy = false;
  private rerun = false;
  private wired = false;

  /** Epoch ms of the last request start — enforces MIN_REQUEST_GAP_MS spacing. */
  private lastRequestAt = 0;
  /** Epoch ms before which we must not send anything (set from 403/429 backoff). */
  private cooldownUntil = 0;
  /** Tail of the request queue — serializes api() so throttle spacing holds. */
  private chain: Promise<unknown> = Promise.resolve();

  private token(): string | undefined {
    return this.config.get<string>('gistToken')?.trim() || undefined;
  }
  private gistId(): string | undefined {
    return this.config.get<string>('gistId');
  }

  /** Reconnect on launch if a token was saved on this device. */
  autoStart(): void {
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
  }

  private async pull(): Promise<void> {
    const id = this.gistId();
    if (!id) return;
    const gist = await this.api('GET', `/gists/${id}`);
    const file = (gist as any).files?.[FILENAME];
    if (!file) return;
    // Large gists get truncated inline; fall back to raw_url. That response is
    // status-checked — an error page's HTML would otherwise flow on as if it
    // were state content.
    let content: string | undefined = file.content;
    if (file.truncated && file.raw_url) {
      const raw = await fetch(file.raw_url);
      if (!raw.ok) throw new Error(`Could not read synced state (HTTP ${raw.status})`);
      content = await raw.text();
    }
    if (!content) return;
    let update: Uint8Array | null = null;
    try {
      const parsed = JSON.parse(content);
      if (parsed?.update) update = b64ToBytes(parsed.update);
    } catch {
      return; // malformed remote file — ignore rather than corrupt local state
    }
    if (update) Y.applyUpdate(this.docs.doc, update, GIST_ORIGIN);
  }

  private async push(): Promise<void> {
    const id = this.gistId();
    if (!id) return;
    await this.api('PATCH', `/gists/${id}`, { files: { [FILENAME]: { content: this.pack() } } });
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
    clearTimeout(this.pushTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  // -------------------------------------------------------------------------
  /**
   * Single choke point for every GitHub call, so rate-limit protection lives in
   * one place. Before sending it (a) waits out any active cooldown from a prior
   * 403/429 and (b) spaces requests at least MIN_REQUEST_GAP_MS apart to dodge
   * the "too many requests too quickly" secondary limit. On a rate-limit
   * response it reads GitHub's own `Retry-After` / `x-ratelimit-reset` headers to
   * set the next cooldown and retries the call once.
   *
   * Calls are serialized through `chain`: a poll `pull()` can overlap a `sync()`,
   * and without serialization both would read the same `lastRequestAt`, sleep the
   * same amount and fire together — defeating the spacing. Queuing them makes the
   * gap (and the shared cooldown) actually hold between concurrent callers.
   */
  private api(method: string, path: string, body?: unknown): Promise<unknown> {
    const result = this.chain.then(() => this.dispatch(method, path, body));
    // Keep the queue moving even if this call rejects — a failure must not wedge
    // every later request behind a permanently-rejected tail.
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async dispatch(method: string, path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.ok) return res.status === 204 ? null : res.json();
      if (res.status === 401) throw new Error('Invalid or expired token');
      if (res.status === 404) throw new Error('Gist not found (was it deleted?)');

      // 403 (with rate-limit signal) and 429 mean we've been throttled. Back off
      // for the window GitHub gives us, then retry once before surfacing an error.
      const limited = res.status === 429 || (res.status === 403 && this.isRateLimited(res));
      if (limited && attempt === 0) {
        this.cooldownUntil = Date.now() + this.backoffMs(res);
        continue;
      }
      if (limited) throw new Error('Rate-limited by GitHub — will retry shortly');
      if (res.status === 403) throw new Error('Token lacks the "gist" scope');
      throw new Error(`GitHub API ${res.status}`);
    }
  }

  /** Wait out any cooldown, then honour the minimum gap between requests. */
  private async throttle(): Promise<void> {
    const waitCooldown = this.cooldownUntil - Date.now();
    if (waitCooldown > 0) await sleep(waitCooldown);
    const waitGap = this.lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
    if (waitGap > 0) await sleep(waitGap);
    this.lastRequestAt = Date.now();
  }

  /** A 403 is a rate limit (not a scope problem) when the limit is exhausted. */
  private isRateLimited(res: Response): boolean {
    return (
      res.headers.get('retry-after') !== null ||
      res.headers.get('x-ratelimit-remaining') === '0'
    );
  }

  /** How long to back off, from GitHub's headers, falling back to a fixed wait. */
  private backoffMs(res: Response): number {
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) return Math.max(0, Number(retryAfter) * 1000);
    const reset = res.headers.get('x-ratelimit-reset');
    if (reset) return Math.max(0, Number(reset) * 1000 - Date.now());
    return DEFAULT_BACKOFF_MS;
  }

  private fail(e: any): void {
    this.error.set(String(e?.message ?? e));
    this.status.set('error');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
