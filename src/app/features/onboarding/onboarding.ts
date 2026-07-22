import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { LibraryStore } from '../../core/library.store';

/**
 * First-run screen shown when this device has no catalog yet. Keeps the app
 * anonymous by default — nothing personal is bundled; the visitor establishes
 * their own library here, entirely on their own device.
 */
@Component({
  selector: 'app-onboarding',
  template: `
    <div class="wrap">
      <div class="card">
        <div class="brand">
          <span class="mark">tv</span>
          <div>
            <strong>TV&nbsp;Time Revival</strong>
            <small>your private, local-first tracker</small>
          </div>
        </div>

        <h1>Bring your library</h1>
        <p class="lede">
          Nothing is stored on a server and nothing personal ships with this app — set up your own,
          right here on this device.
        </p>

        <div class="actions">
          <label class="opt primary">
            <input type="file" accept="application/json" hidden (change)="onFile($event)" [disabled]="busy()" />
            <span class="ic">↥</span>
            <span class="t">
              <strong>Import a TV Time backup</strong>
              <small>A library JSON exported from your TV Time data</small>
            </span>
          </label>

          <button class="opt" (click)="empty()" [disabled]="busy()">
            <span class="ic">＋</span>
            <span class="t">
              <strong>Start empty</strong>
              <small>Begin with a blank library</small>
            </span>
          </button>
        </div>

        @if (error()) { <div class="err">{{ error() }}</div> }
        @if (busy()) { <div class="busy">Setting up…</div> }

        <p class="foot">
          Everything stays in this browser. You can later sync across your own devices from
          <strong>Settings</strong> — no account required.
        </p>
      </div>
    </div>
  `,
  styleUrl: './onboarding.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Onboarding {
  private store = inject(LibraryStore);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  onFile(evt: Event): void {
    const file = (evt.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.error.set(null);
    this.busy.set(true);
    file
      .text()
      .then((txt) => this.store.importLibrary(txt))
      .catch((e) => this.error.set(String(e?.message ?? e)))
      .finally(() => this.busy.set(false));
  }

  empty(): void {
    this.error.set(null);
    this.busy.set(true);
    this.store
      .startEmpty()
      .catch((e) => this.error.set(String(e?.message ?? e)))
      .finally(() => this.busy.set(false));
  }
}
