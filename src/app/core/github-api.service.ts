import { Injectable, computed, inject } from '@angular/core';
import { LocalConfigService } from './local-config.service';

const API = 'https://api.github.com';
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
 * A failed GitHub call, carrying the status alongside the message.
 *
 * Callers branch on *what went wrong* — "the gist is gone, re-create it" is a
 * different recovery from "the token expired" — and the status is the only
 * stable way to ask. Matching the message text instead would make a copy edit
 * to a user-facing string silently break a recovery path.
 */
export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubApiError';
  }

  /** The gist (or whatever was addressed) is not there — 404, or a 401 on a read. */
  static isMissing(e: unknown): boolean {
    return e instanceof GithubApiError && e.status === 404;
  }
}

/**
 * The app's single pipe to the GitHub API.
 *
 * Two features talk to GitHub — cloud sync through a private gist
 * (GistSyncService) and the public profile page (PublicProfileService) — and
 * both use the same device-local `gist`-scoped token. They therefore also share
 * one rate-limit budget, so the throttle, the cooldown and the request queue
 * live here rather than in either caller: publishing a profile while sync is
 * pushing must not put two requests on the wire in the same instant, which is
 * exactly what the secondary limit punishes.
 *
 * The token never leaves the device — it stays in LocalConfigService (IndexedDB)
 * and is deliberately absent from the synced document.
 */
@Injectable({ providedIn: 'root' })
export class GithubApiService {
  private config = inject(LocalConfigService);

  /**
   * Reactive because `LocalConfigService.get` reads a signal: a UI that offers
   * "publish" only when GitHub is reachable updates the moment a token is saved.
   */
  readonly hasToken = computed(() => !!this.token());

  token(): string | undefined {
    return this.config.get<string>('gistToken')?.trim() || undefined;
  }

  /** Epoch ms of the last request start — enforces MIN_REQUEST_GAP_MS spacing. */
  private lastRequestAt = 0;
  /** Epoch ms before which we must not send anything (set from 403/429 backoff). */
  private cooldownUntil = 0;
  /** Tail of the request queue — serializes calls so throttle spacing holds. */
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * Send one authenticated request, queued behind every other in-flight call.
   *
   * Before sending it (a) waits out any active cooldown from a prior 403/429 and
   * (b) spaces requests at least MIN_REQUEST_GAP_MS apart. On a rate-limit
   * response it reads GitHub's own `Retry-After` / `x-ratelimit-reset` headers to
   * set the next cooldown and retries the call once.
   *
   * Serialization matters: a sync poll can overlap a push, and without a queue
   * both would read the same `lastRequestAt`, sleep the same amount and fire
   * together — defeating the spacing.
   */
  request(method: string, path: string, body?: unknown): Promise<unknown> {
    const result = this.chain.then(() => this.dispatch(method, path, body));
    // Keep the queue moving even if this call rejects — a failure must not wedge
    // every later request behind a permanently-rejected tail.
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async dispatch(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = this.token();
    if (!token) throw new Error('No GitHub token on this device');

    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.ok) return res.status === 204 ? null : res.json();
      if (res.status === 401) throw new GithubApiError(401, 'Invalid or expired token');
      if (res.status === 404) throw new GithubApiError(404, 'Gist not found (was it deleted?)');

      // 403 (with rate-limit signal) and 429 mean we've been throttled. Back off
      // for the window GitHub gives us, then retry once before surfacing an error.
      const limited = res.status === 429 || (res.status === 403 && isRateLimited(res));
      if (limited && attempt === 0) {
        this.cooldownUntil = Date.now() + backoffMs(res);
        continue;
      }
      if (limited) {
        throw new GithubApiError(res.status, 'Rate-limited by GitHub — will retry shortly');
      }
      if (res.status === 403) throw new GithubApiError(403, 'Token lacks the "gist" scope');
      throw new GithubApiError(res.status, `GitHub API ${res.status}`);
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
}

/** A 403 is a rate limit (not a scope problem) when the limit is exhausted. */
function isRateLimited(res: Response): boolean {
  return (
    res.headers.get('retry-after') !== null || res.headers.get('x-ratelimit-remaining') === '0'
  );
}

/** How long to back off, from GitHub's headers, falling back to a fixed wait. */
function backoffMs(res: Response): number {
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) return Math.max(0, Number(retryAfter) * 1000);
  const reset = res.headers.get('x-ratelimit-reset');
  if (reset) return Math.max(0, Number(reset) * 1000 - Date.now());
  return DEFAULT_BACKOFF_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read a *public* gist with no credentials at all.
 *
 * Separate from `request` on purpose: this is the path a visitor takes when they
 * open somebody else's shared profile, and that visitor has no token, no gist of
 * their own and nothing to rate-limit against but their own IP. It also means an
 * anonymous read can never accidentally ride on the owner's token.
 *
 * Returns null when the gist is gone or was never public — GitHub answers 404 to
 * an unauthenticated read of a private gist, which is exactly the answer we want
 * to give a visitor whose link was revoked.
 */
export async function fetchPublicGistFile(gistId: string, filename: string): Promise<string | null> {
  const res = await fetch(`${API}/gists/${encodeURIComponent(gistId)}`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new GithubApiError(res.status, `GitHub API ${res.status}`);
  const gist: any = await res.json();
  // A private gist is unreachable anonymously, so this is belt-and-braces: it
  // also covers the owner's own browser, where a cache could hold a stale copy.
  if (gist?.public === false) return null;
  const file = gist?.files?.[filename];
  if (!file) return null;
  // Large files come back truncated inline; fall back to the raw blob. That
  // response is status-checked so an error page's HTML can't flow on as content.
  if (file.truncated && file.raw_url) {
    const raw = await fetch(file.raw_url);
    if (!raw.ok) {
      throw new GithubApiError(raw.status, `Could not read the profile (HTTP ${raw.status})`);
    }
    return raw.text();
  }
  return typeof file.content === 'string' ? file.content : null;
}
