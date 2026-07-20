import { Component, inject, signal } from '@angular/core';
import { LibraryStore } from '../../core/library.store';
import { TmdbService } from '../../core/tmdb.service';
import { SyncService } from '../../core/sync.service';
import { DocService } from '../../core/doc.service';

@Component({
  selector: 'app-settings',
  template: `
    <div class="page">
      <div class="page-head"><h1>Settings</h1></div>

      <!-- TMDB -->
      <section class="card">
        <h2>TMDB metadata</h2>
        <p class="hint">
          A free key from
          <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org</a>
          unlocks posters, seasons, episodes and airing schedules. Stored only on this device.
        </p>
        <div class="row">
          <input
            class="in"
            type="password"
            placeholder="TMDB API key (v3)"
            [value]="key()"
            (input)="key.set($any($event.target).value)"
          />
          <button class="btn primary" (click)="saveKey()">Save</button>
        </div>
        <div class="status" [class.ok]="tmdb.hasKey()">
          {{ tmdb.hasKey() ? '✓ Key active' : 'No key set — posters use cached artwork only' }}
        </div>
      </section>

      <!-- Sync -->
      <section class="card">
        <h2>Decentralized sync</h2>
        <p class="hint">
          Peer-to-peer sync across your own devices. Pick a room name and a passphrase; open the same
          pair on another device to converge. End-to-end encrypted — no server stores your data.
        </p>
        @if (sync.room()) {
          <div class="synced">
            <div>
              <strong>Room: {{ sync.room() }}</strong>
              <div class="hint">
                {{ sync.connected() ? 'Connected' : 'Connecting…' }} · {{ sync.peers() }} peer(s) online
              </div>
            </div>
            <button class="btn" (click)="sync.forget()">Disconnect</button>
          </div>
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
          <button class="btn ghost" (click)="clearCache()">Clear TMDB cache</button>
        </div>
        @if (msg()) { <div class="status ok">{{ msg() }}</div> }
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
    `,
  ],
})
export class Settings {
  store = inject(LibraryStore);
  tmdb = inject(TmdbService);
  sync = inject(SyncService);
  private docs = inject(DocService);

  key = signal(this.tmdb.apiKey() ?? '');
  room = signal('');
  pass = signal('');
  msg = signal('');

  saveKey(): void {
    this.tmdb.setKey(this.key());
    this.flash('TMDB key saved.');
  }

  connect(): void {
    this.sync.connect(this.room().trim(), this.pass());
  }

  exportState(): void {
    const blob = new Blob([this.docs.exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tvtime-state-${new Date().toISOString().slice(0, 10)}.json`;
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

  async clearCache(): Promise<void> {
    await this.tmdb.clearCache();
    this.flash('TMDB cache cleared.');
  }

  reset(): void {
    if (!confirm('Delete all local data on this device? Your export file and synced devices are unaffected.'))
      return;
    indexedDB.deleteDatabase('tvtime-revival');
    location.reload();
  }

  private flash(m: string): void {
    this.msg.set(m);
    setTimeout(() => this.msg.set(''), 2500);
  }
}
