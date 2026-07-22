import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { LibraryStore } from '../../core/library.store';
import { TmdbService } from '../../core/tmdb.service';
import { PosterCacheService } from '../../core/poster-cache.service';
import { SyncService, DEFAULT_SIGNALING_URL } from '../../core/sync.service';
import { GistSyncService } from '../../core/gist-sync.service';
import { destroyOutbox } from '../../core/gist-outbox';
import { DocService, DB_NAME } from '../../core/doc.service';
import { TraktExportService } from '../../core/trakt-export.service';
import { LocalConfigService } from '../../core/local-config.service';
import { SeedService } from '../../core/seed.service';
import { LinkDeviceCard } from './link-device-card';
import { DeviceSessionsCard } from './device-sessions-card';

@Component({
  selector: 'app-settings',
  imports: [LinkDeviceCard, DeviceSessionsCard],
  template: `
    <div class="page">
      <div class="page-head"><h1>Settings</h1></div>

      <!-- Cloud sync via GitHub Gist -->
      <section class="card">
        <h2>Cloud sync · GitHub Gist</h2>
        <p class="hint">
          Serverless sync across all your devices through a private gist you own — no backend, works on
          any network. Paste a GitHub token with only the <code>gist</code> scope; it's stored on this
          device and never leaves it.
          <a [href]="gistTokenUrl" target="_blank" rel="noopener">Create a token →</a>
        </p>
        @if (gist.enabled()) {
          <div class="synced">
            <div>
              <strong>Connected</strong>
              <div
                class="sync-state"
                [class.s-connected]="gist.status() === 'synced'"
                [class.s-connecting]="gist.status() === 'syncing'"
                [class.s-error]="gist.status() === 'error'"
              >
                <span class="dot"></span>
                @switch (gist.status()) {
                  @case ('synced') { Synced{{ gistLastSync() ? ' · ' + gistLastSync() : '' }} }
                  @case ('syncing') { Syncing… }
                  @case ('error') { Sync error }
                  @default { Idle }
                }
              </div>
            </div>
            <div style="display:flex; gap:8px">
              <button class="btn" (click)="gist.sync()">Sync now</button>
              <button class="btn" (click)="gist.forget()">Disconnect</button>
            </div>
          </div>
          @if (gist.error()) { <p class="hint err-hint">{{ gist.error() }}</p> }
          @if (gist.pendingPush()) {
            <p class="hint">
              Changes made offline are queued on this device — they upload on their own as soon as
              you have a connection, even if the app is closed.
            </p>
          }
        } @else {
          <div class="row">
            <input
              class="in"
              type="password"
              placeholder="GitHub token (gist scope)"
              [value]="gistToken()"
              (input)="gistToken.set($any($event.target).value)"
            />
            <button class="btn primary" [disabled]="!gistToken()" (click)="connectGist()">Connect</button>
          </div>
          @if (gist.status() === 'error' && gist.error()) {
            <p class="hint err-hint">{{ gist.error() }}</p>
          }
        }
      </section>

      <!-- Device linking (QR) + the sessions it produces -->
      <app-link-device-card />
      <app-device-sessions-card />

      <!-- TMDB -->
      <section class="card">
        <h2>TMDB metadata</h2>
        <p class="hint">
          A free key from
          <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org</a>
          unlocks posters, seasons, episodes and airing schedules. Either credential on that page
          works — the v3 API key or the v4 read access token. Stored in this browser and — with
          Cloud sync on — carried to your other devices, so you only set it once. Film covers, which
          your backup doesn't include, are remembered as they load and then show on every device.
        </p>
        <div class="row">
          <input
            class="in"
            type="password"
            placeholder="TMDB API key or read access token"
            [value]="key()"
            (input)="key.set($any($event.target).value)"
          />
          <button class="btn primary" (click)="saveKey()">Save</button>
        </div>
        <div class="status" [class.ok]="tmdb.hasKey()">
          {{
            tmdb.hasKey()
              ? '✓ Key active' + (posters.size() ? ' — ' + posters.size() + ' covers remembered' : '')
              : 'No key set — posters use cached artwork only'
          }}
        </div>

        <h3 class="sub">Episode ratings</h3>
        <p class="hint">
          Scores you give episodes are sent to TMDB as well as kept here. Without a linked account they
          go anonymously through a temporary guest session — linking one files them under your own
          profile instead, and the link travels with your other synced settings.
        </p>
        @if (tmdb.hasAccount()) {
          <div class="synced">
            <div class="status ok">✓ TMDB account linked</div>
            <button class="btn" (click)="unlinkTmdb()">Unlink</button>
          </div>
        } @else if (tmdbLink(); as link) {
          <div class="row">
            <a class="btn primary" [href]="link.approveUrl" target="_blank" rel="noopener">
              Approve on TMDB ↗
            </a>
            <button class="btn" [disabled]="tmdbBusy()" (click)="finishTmdbLink()">
              {{ tmdbBusy() ? 'Checking…' : "I've approved it — finish" }}
            </button>
            <button class="btn ghost" (click)="tmdbLink.set(null)">Cancel</button>
          </div>
          <p class="hint" style="margin-top:10px">
            Approve the request in the tab that opens, then come back and finish. The token is only
            valid for a few minutes.
          </p>
        } @else {
          <div class="row">
            <button class="btn" [disabled]="!tmdb.hasKey() || tmdbBusy()" (click)="startTmdbLink()">
              {{ tmdbBusy() ? 'Starting…' : 'Link TMDB account' }}
            </button>
          </div>
        }
        @if (tmdbLinkErr()) { <p class="hint err-hint">{{ tmdbLinkErr() }}</p> }
      </section>

      <!-- Sync -->
      <section class="card">
        <h2>Peer-to-peer sync <span class="tag">advanced</span></h2>
        <p class="hint">
          Real-time WebRTC sync directly between your devices. Pick a room name and a passphrase; open the
          same pair on another device to converge. End-to-end encrypted — no server stores your data.
        </p>
        @if (sync.room()) {
          <div class="synced">
            <div>
              <strong>Room: {{ sync.room() }}</strong>
              <div class="sync-state s-{{ sync.status() }}">
                <span class="dot"></span>
                @switch (sync.status()) {
                  @case ('connected') { {{ sync.peers() }} peer(s) connected }
                  @case ('connecting') { Connecting… searching for peers }
                  @case ('error') { Couldn't reach the signaling server }
                  @default { Idle }
                }
              </div>
            </div>
            <button class="btn" (click)="sync.forget()">Disconnect</button>
          </div>
          @if (sync.status() === 'error') {
            <p class="hint err-hint">
              The signaling server (the rendezvous point that introduces your devices) is unreachable.
              Try a different one below, or self-host a relay. Your data never flows through it — it only
              brokers the encrypted peer handshake.
            </p>
          }
        } @else {
          <div class="row">
            <input class="in" placeholder="Room name" [value]="room()" (input)="room.set($any($event.target).value)" />
            <input
              class="in"
              type="password"
              placeholder="Passphrase"
              [value]="pass()"
              (input)="pass.set($any($event.target).value)"
            />
            <button class="btn primary" [disabled]="!room() || !pass()" (click)="connect()">Connect</button>
          </div>
        }

        <details class="fmt">
          <summary>Advanced · signaling server</summary>
          <p class="fmt-note">
            WebRTC needs a reachable rendezvous point to introduce peers. Default:
            <code>{{ defaultSignaling }}</code> — this app's own relay, which sees only the
            encrypted handshake. Paste any other y-webrtc signaling server to use it instead;
            leave blank for the default.
          </p>
          <div class="row">
            <input
              class="in"
              placeholder="wss://your-signaling-server"
              [value]="signaling()"
              (input)="signaling.set($any($event.target).value)"
            />
            <button class="btn" (click)="saveSignaling()">Save</button>
          </div>
        </details>
      </section>

      <!-- Backup -->
      <section class="card">
        <h2>Backup & restore</h2>
        <p class="hint">Your watch state as a portable JSON file — the always-works safety net beneath sync.</p>
        <div class="row">
          <button class="btn" (click)="exportState()">⤓ Export state</button>
          <label class="btn file">
            ⤒ Import state
            <input type="file" accept="application/json" (change)="importState($event)" hidden />
          </label>
          <label class="btn file">
            ↥ Import backup
            <input type="file" accept="application/json" (change)="importBackup($event)" hidden />
          </label>
          <button class="btn ghost" (click)="clearCache()">Clear TMDB cache</button>
        </div>
        <p class="hint" style="margin-top:10px">
          <strong>Import backup</strong> restores a full TV Time library export (your follows, watch
          history, favorites and lists). <strong>Import state</strong> merges just the watch-state file.
        </p>
        @if (msg()) { <div class="status ok">{{ msg() }}</div> }

        <h3 class="sub">Export for Trakt</h3>
        <p class="hint">
          Your watch history, watchlist and ratings as a
          <a href="https://trakt.tv/settings/data" target="_blank" rel="noopener">Trakt import file</a>.
          Episodes are identified by TMDB id, so this needs your TMDB key and one request per season
          you've watched — the first run on a large library takes a minute.
        </p>
        <div class="row">
          <button class="btn" [disabled]="traktBusy()" (click)="exportTrakt()">
            {{ traktBusy() ? 'Preparing…' : '⤓ Export for Trakt' }}
          </button>
        </div>
        @if (traktMsg()) { <div class="status ok">{{ traktMsg() }}</div> }

        <details class="fmt">
          <summary><span class="info-icon" aria-hidden="true">ⓘ</span> Expected JSON structure</summary>
          <p class="fmt-note">
            Only <code>kind</code> is required; every other key is optional and merged in (last-write-wins
            per entry). This is exactly what <strong>Export state</strong> produces — the easiest way to get
            a valid file is to export one first.
          </p>
          <pre>{{ importFormat }}</pre>
        </details>
      </section>

      <div class="danger">
        <button class="btn ghost danger-btn" (click)="reset()">Reset local data…</button>
      </div>
    </div>
  `,
  styles: [
    `
      .card {
        background: var(--bg-elev);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 22px 24px;
        margin-bottom: 18px;
        max-width: 720px;
      }
      h2 {
        font-size: 16px;
        margin: 0 0 8px;
      }
      .tag {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--text-faint);
        background: var(--bg-elev-2);
        padding: 2px 7px;
        border-radius: 999px;
        margin-left: 6px;
        font-weight: 700;
        vertical-align: middle;
      }
      .sub {
        font-size: 13px;
        margin: 22px 0 8px;
        padding-top: 18px;
        border-top: 1px solid var(--line);
      }
      .hint {
        color: var(--text-dim);
        font-size: 13px;
        line-height: 1.55;
        margin: 0 0 14px;
      }
      .hint a {
        color: var(--gold);
        text-decoration: underline;
      }
      .row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .in {
        flex: 1;
        min-width: 160px;
        background: var(--bg-elev-2);
        border: 1px solid var(--line);
        color: var(--text);
        padding: 10px 14px;
        border-radius: 8px;
        font-size: 14px;
        outline: none;
      }
      .in:focus {
        border-color: #3a3f4a;
      }
      .status {
        margin-top: 12px;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--text-faint);
      }
      .status.ok {
        color: var(--good);
      }
      .synced {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }
      .sync-state {
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--text-dim);
        margin-top: 4px;
      }
      .sync-state .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-faint);
      }
      .sync-state.s-connected {
        color: var(--good);
      }
      .sync-state.s-connected .dot {
        background: var(--good);
        box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.15);
      }
      .sync-state.s-connecting .dot {
        background: var(--gold);
        animation: pulse-dot 1s ease-in-out infinite;
      }
      .sync-state.s-error {
        color: var(--bad);
      }
      .sync-state.s-error .dot {
        background: var(--bad);
      }
      @keyframes pulse-dot {
        50% {
          opacity: 0.3;
        }
      }
      .err-hint {
        color: var(--bad) !important;
        margin-top: 12px !important;
      }
      .file {
        position: relative;
        overflow: hidden;
        display: inline-flex;
        align-items: center;
      }
      .danger {
        max-width: 720px;
        margin-top: 8px;
      }
      .danger-btn {
        color: var(--bad);
        border-color: transparent;
      }
      .danger-btn:hover {
        background: rgba(248, 113, 113, 0.1);
      }
      .fmt {
        margin-top: 16px;
        border-top: 1px solid var(--line-soft);
        padding-top: 14px;
      }
      .fmt summary {
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        color: var(--text-dim);
        list-style: none;
      }
      .fmt summary::before {
        content: '▸ ';
        color: var(--text-faint);
      }
      .fmt[open] summary::before {
        content: '▾ ';
      }
      .fmt summary:hover {
        color: var(--text);
      }
      .info-icon {
        color: var(--gold);
        font-size: 14px;
      }
      .fmt-note {
        color: var(--text-dim);
        font-size: 12.5px;
        line-height: 1.55;
        margin: 12px 0 10px;
      }
      .fmt-note code {
        background: var(--bg-elev-2);
        padding: 1px 5px;
        border-radius: 4px;
        font-size: 12px;
      }
      .fmt pre {
        background: #0a0b0e;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 14px 16px;
        overflow-x: auto;
        font-size: 12px;
        line-height: 1.5;
        color: var(--text-dim);
        font-family: 'SF Mono', ui-monospace, 'Cascadia Code', Menlo, monospace;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Settings {
  store = inject(LibraryStore);
  tmdb = inject(TmdbService);
  posters = inject(PosterCacheService);
  sync = inject(SyncService);
  private docs = inject(DocService);
  private trakt = inject(TraktExportService);

  gist = inject(GistSyncService);

  key = signal(this.tmdb.apiKey() ?? '');
  room = signal('');
  pass = signal('');
  msg = signal('');
  signaling = signal((this.docs.settings.get('signalingUrl') as string | undefined) ?? '');
  gistToken = signal('');
  traktMsg = signal('');
  traktBusy = signal(false);
  /** The in-flight TMDB account link (request token + its approval URL). */
  tmdbLink = signal<{ requestToken: string; approveUrl: string } | null>(null);
  tmdbLinkErr = signal('');
  tmdbBusy = signal(false);
  readonly defaultSignaling = DEFAULT_SIGNALING_URL;
  readonly gistTokenUrl =
    'https://github.com/settings/tokens/new?scopes=gist&description=TV+Time+Revival';

  /** Human-readable shape of a valid import file (annotated). */
  readonly importFormat = `{
  "kind": "tvtime-revival-state",   // required — the file is rejected without it
  "schema": 1,
  "showState": {
    "<show-uuid>": {
      "status": "watching",         // watching | completed | watchlist | dropped | none
      "favorite": false,
      "rating": null,               // 1–10 or null
      "addedAt": "2020-01-01T00:00:00Z",
      "updatedAt": "2026-01-01T00:00:00Z"
    }
  },
  "movieState": {
    "<movie-uuid>": {
      "watched": true,
      "watchedAt": "2019-09-03T10:32:47Z",
      "watchlist": false,
      "favorite": false,
      "rating": null
    }
  },
  "episodeWatches": {
    "<tvdbId>:<season>:<episode>": {  // e.g. "323168:1:6"
      "tvdbId": "323168", "season": 1, "episode": 6,
      "watchedAt": "2026-01-18T22:20:16Z", "nbTimes": 1
    }
  },
  "episodeRatings": {
    "<tvdbId>:<season>:<episode>": {  // same key as the watch above
      "tvdbId": "323168", "season": 1, "episode": 6,
      "rating": 8,                    // 1–10
      "ratedAt": "2026-01-18T22:24:03Z",
      "syncedToTmdb": true            // whether TMDB accepted this same score
    }
  },
  "lists": {
    "<list-id>": { "name": "para assistir", "items": [ { "title": "…", "uuid": "…" } ] }
  }
  // note: credentials are intentionally NOT part of this file. Your TMDB key,
  // signaling URL and P2P room + passphrase travel only through your own cloud
  // sync (private gist + encrypted P2P); the gist token stays on this device.
}`;

  saveKey(): void {
    this.tmdb.setKey(this.key());
    this.flash('TMDB key saved.');
  }

  /**
   * Step one of linking a TMDB account: mint a request token and surface the
   * approval link. It is rendered as an anchor the user clicks rather than
   * opened here — a popup from an async continuation is what popup blockers
   * exist to stop, and losing the tab would strand the token.
   */
  async startTmdbLink(): Promise<void> {
    this.tmdbLinkErr.set('');
    this.tmdbBusy.set(true);
    try {
      this.tmdbLink.set(await this.tmdb.startAccountLink());
    } catch (e: any) {
      this.tmdbLinkErr.set(String(e?.message ?? e));
    } finally {
      this.tmdbBusy.set(false);
    }
  }

  /** Step two: exchange the (now approved) token for a session. */
  async finishTmdbLink(): Promise<void> {
    const link = this.tmdbLink();
    if (!link) return;
    this.tmdbLinkErr.set('');
    this.tmdbBusy.set(true);
    try {
      await this.tmdb.finishAccountLink(link.requestToken);
      this.tmdbLink.set(null);
    } catch (e: any) {
      this.tmdbLinkErr.set(String(e?.message ?? e));
    } finally {
      this.tmdbBusy.set(false);
    }
  }

  async unlinkTmdb(): Promise<void> {
    this.tmdbLinkErr.set('');
    await this.tmdb.unlinkAccount();
  }

  connect(): void {
    this.sync.connect(this.room().trim(), this.pass());
  }

  connectGist(): void {
    const t = this.gistToken().trim();
    if (t) this.gist.connect(t);
    this.gistToken.set('');
  }

  gistLastSync(): string {
    const t = this.gist.lastSync();
    return t ? new Date(t).toLocaleTimeString() : '';
  }

  saveSignaling(): void {
    const v = this.signaling().trim();
    // Lives in the synced doc, so a custom signaling server propagates to every
    // device through the gist (and P2P) instead of being re-entered per device.
    if (v) this.docs.settings.set('signalingUrl', v);
    else this.docs.settings.delete('signalingUrl');
    this.flash(v ? 'Signaling server saved — reconnect to apply.' : 'Reverted to default signaling.');
  }

  exportState(): void {
    this.download(this.docs.exportJson(), `tvtime-state-${today()}.json`);
  }

  /**
   * Build and download the Trakt import file. Unlike the backup export this is
   * async and can take a while: every episode watch has to be resolved to a
   * TMDB episode id (see TraktExportService), so the button reports progress
   * instead of appearing to hang.
   */
  async exportTrakt(): Promise<void> {
    if (this.traktBusy()) return;
    this.traktBusy.set(true);
    this.traktMsg.set('Collecting…');
    try {
      const result = await this.trakt.build(({ done, total }) =>
        this.traktMsg.set(`Resolving episodes… ${done}/${total} shows`),
      );
      if (!result.items.length) {
        this.traktMsg.set('Nothing to export yet.');
        return;
      }
      this.download(JSON.stringify(result.items, null, 2), `trakt-import-${today()}.json`);

      const skipped: string[] = [];
      if (result.skippedTitles) skipped.push(`${result.skippedTitles} titles`);
      if (result.skippedEpisodes) skipped.push(`${result.skippedEpisodes} episode watches`);
      this.traktMsg.set(
        `Exported ${result.items.length} items ` +
          `(${result.movies} films, ${result.shows} shows, ${result.episodes} episodes)` +
          (skipped.length ? ` · skipped ${skipped.join(' and ')} with no id Trakt accepts` : ''),
      );
    } catch (e: any) {
      this.traktMsg.set('Export failed: ' + (e?.message ?? e));
    } finally {
      this.traktBusy.set(false);
    }
  }

  private download(text: string, filename: string): void {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  importState(evt: Event): void {
    const file = (evt.target as HTMLInputElement).files?.[0];
    if (!file) return;
    file.text().then((txt) => {
      try {
        this.docs.importJson(txt);
        this.flash('State imported and merged.');
      } catch (e: any) {
        this.flash('Import failed: ' + e.message);
      }
    });
  }

  importBackup(evt: Event): void {
    const file = (evt.target as HTMLInputElement).files?.[0];
    if (!file) return;
    file
      .text()
      .then((txt) => this.store.importLibrary(txt))
      .then(() => this.flash('Library backup imported.'))
      .catch((e: any) => this.flash('Import failed: ' + (e?.message ?? e)));
  }

  async clearCache(): Promise<void> {
    await this.tmdb.clearCache();
    this.flash('TMDB cache cleared.');
  }

  async reset(): Promise<void> {
    if (!confirm('Delete all local data on this device? Your export file and synced devices are unaffected.'))
      return;
    this.sync.forget();
    this.gist.forget();
    await LocalConfigService.destroy(); // device-local API key + sync config
    await destroyOutbox(); // any push still waiting to reach the gist
    await SeedService.destroy(); // imported catalog
    indexedDB.deleteDatabase(DB_NAME); // synced watch-state doc
    location.reload();
  }

  private flash(m: string): void {
    this.msg.set(m);
    setTimeout(() => this.msg.set(''), 2500);
  }
}

/** Date stamp for download filenames. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
