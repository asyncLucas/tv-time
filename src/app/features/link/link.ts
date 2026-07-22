import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { DeviceService } from '../../core/device.service';
import { GistSyncService } from '../../core/gist-sync.service';
import { PairingService, decodeLink } from '../../core/pairing.service';
import { SyncService } from '../../core/sync.service';

/**
 * The landing page a linking QR code points at — this is the *new* device's
 * side of the handshake.
 *
 * The payload rides in the URL fragment, which never reaches a server, and is
 * never redeemed automatically: opening a link is not consent to hand a browser
 * your library, so the page explains exactly what is about to be turned on and
 * waits for a tap. The same screen doubles as the manual path — paste a code
 * when there's no camera in the picture.
 */
@Component({
  selector: 'app-link',
  imports: [RouterLink],
  template: `
    <div class="page">
      <div class="sheet">
        <div class="brand">
          <span class="mark">tv</span>
          <div>
            <strong>Link this device</strong>
            <small>Join a library you're already tracking somewhere else</small>
          </div>
        </div>

        @switch (pair.state()) {
          @case ('linked') {
            <h1>You're all set</h1>
            <p class="lede">
              @if (pair.peerName()) {
                This device is now part of your fleet, linked from
                <strong>{{ pair.peerName() }}</strong>.
              } @else {
                This device is now part of your fleet.
              }
            </p>
            <ul class="applied">
              <li [class.on]="pair.applied()?.p2p">Peer-to-peer sync connected</li>
              <li [class.on]="pair.applied()?.gist">GitHub&nbsp;Gist cloud sync enabled</li>
              <li [class.on]="pair.applied()?.tmdb">TMDB key copied over</li>
            </ul>
            <a class="btn primary big" routerLink="/">Open your library</a>
          }
          @case ('linking') {
            <h1>Linking…</h1>
            <p class="lede">Pulling your library down and turning sync on. This can take a moment.</p>
            <div class="bar"><span></span></div>
          }
          @case ('connecting') {
            <h1>Connecting…</h1>
            <p class="lede">Reaching the device that showed the code.</p>
            <div class="bar"><span></span></div>
          }
          @default {
            <h1>{{ code() ? 'Ready to link' : 'Enter your link code' }}</h1>
            @if (code()) {
              <p class="lede">
                Linking will connect this device to your other devices' sync room and copy the
                credentials it needs — the GitHub&nbsp;Gist token, the sync passphrase and your TMDB
                key. Nothing is sent to a server we run.
              </p>
            } @else {
              <p class="lede">
                On a device that already has your library, open <strong>Settings → Link a
                device</strong>, then scan the QR code with this device's camera — or paste the
                copied link below.
              </p>
              <input
                class="in"
                placeholder="Paste link or code"
                autocapitalize="off"
                autocomplete="off"
                spellcheck="false"
                [value]="typed()"
                (input)="typed.set($any($event.target).value)"
              />
            }

            <label class="field">
              <span>This device will appear as</span>
              <input class="in" maxlength="40" [value]="name()" (input)="name.set($any($event.target).value)" />
            </label>

            @if (alreadySyncing()) {
              <p class="warn">
                This device already syncs with a library. Linking points it at the one behind the
                code instead — local data stays, but it will merge with the new library.
              </p>
            }
            @if (pair.error()) { <p class="warn err">{{ pair.error() }}</p> }

            <button class="btn primary big" [disabled]="!ready()" (click)="link()">
              Link this device
            </button>
            <a class="quiet" routerLink="/">Not now</a>
          }
        }
      </div>
    </div>
  `,
  styles: [
    `
      .page {
        min-height: 100%;
        display: grid;
        place-items: center;
        padding: calc(32px + var(--safe-top)) 20px calc(48px + var(--safe-bottom));
      }
      .sheet {
        width: min(520px, 100%);
        background: var(--bg-elev);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 28px 28px 24px;
        box-shadow: var(--shadow-lg);
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
        padding-bottom: 20px;
        margin-bottom: 20px;
        border-bottom: 1px solid var(--line-soft);
      }
      .mark {
        display: grid;
        place-items: center;
        width: 38px;
        height: 38px;
        border-radius: 10px;
        background: var(--gold);
        color: #1a1600;
        font-weight: 800;
        font-size: 15px;
      }
      .brand strong {
        display: block;
        font-size: 14.5px;
      }
      .brand small {
        color: var(--text-dim);
        font-size: 12.5px;
      }
      h1 {
        font-size: 22px;
        letter-spacing: -0.02em;
        margin: 0 0 10px;
      }
      .lede {
        color: var(--text-dim);
        font-size: 13.5px;
        line-height: 1.6;
        margin: 0 0 18px;
      }
      .in {
        width: 100%;
        background: var(--bg-elev-2);
        border: 1px solid var(--line);
        color: var(--text);
        padding: 11px 14px;
        border-radius: var(--radius-sm);
        font-size: 14px;
        outline: none;
      }
      .in:focus {
        border-color: #3a3f4a;
      }
      .field {
        display: block;
        margin: 16px 0 20px;
      }
      .field span {
        display: block;
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-faint);
        margin-bottom: 7px;
      }
      .warn {
        background: var(--bg-elev-2);
        border-left: 3px solid var(--gold);
        border-radius: var(--radius-sm);
        color: var(--text-dim);
        font-size: 12.5px;
        line-height: 1.55;
        padding: 11px 13px;
        margin: 0 0 18px;
      }
      .warn.err {
        border-left-color: var(--bad);
        color: var(--bad);
      }
      .btn.big {
        width: 100%;
        padding: 13px 18px;
        font-size: 14px;
        display: block;
        text-align: center;
      }
      .btn[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .quiet {
        display: block;
        text-align: center;
        color: var(--text-faint);
        font-size: 12.5px;
        margin-top: 14px;
      }
      .applied {
        list-style: none;
        padding: 0;
        margin: 0 0 22px;
      }
      .applied li {
        color: var(--text-faint);
        font-size: 13px;
        padding: 6px 0 6px 26px;
        position: relative;
      }
      .applied li::before {
        content: '·';
        position: absolute;
        left: 8px;
      }
      .applied li.on {
        color: var(--text);
      }
      .applied li.on::before {
        content: '✓';
        color: var(--good);
        left: 4px;
      }
      .bar {
        height: 4px;
        border-radius: 4px;
        background: var(--bg-elev-2);
        overflow: hidden;
      }
      .bar span {
        display: block;
        height: 100%;
        width: 40%;
        border-radius: 4px;
        background: var(--gold);
        animation: slide 1.2s ease-in-out infinite;
      }
      @keyframes slide {
        0% {
          transform: translateX(-100%);
        }
        100% {
          transform: translateX(320%);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .bar span {
          animation: none;
          width: 100%;
          opacity: 0.5;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Link {
  protected pair = inject(PairingService);
  private devices = inject(DeviceService);
  private gist = inject(GistSyncService);
  private sync = inject(SyncService);

  /**
   * Payload from the scanned URL's fragment, if we arrived that way. Read
   * through the router rather than `location.hash` so scanning a *second* code
   * is picked up — a fragment-only change never reloads the page.
   */
  private readonly fragment = toSignal(inject(ActivatedRoute).fragment, { initialValue: null });
  /** A code is single-use; once redeemed the one in the URL is dead to us. */
  private readonly spent = signal(false);
  protected readonly typed = signal('');
  protected readonly name = signal(this.devices.name());

  protected readonly code = computed(() => (this.spent() ? null : this.fragment()));
  protected readonly ready = computed(() => !!decodeLink(this.code() ?? this.typed()));
  protected readonly alreadySyncing = computed(() => this.gist.enabled() || !!this.sync.room());

  protected async link(): Promise<void> {
    const raw = this.code() ?? this.typed();
    if (!decodeLink(raw)) return;
    await this.devices.rename(this.name());
    await this.pair.claim(raw);
    // A redeemed code is spent — drop it from the URL so a reload can't retry it.
    if (this.pair.state() === 'linked') {
      this.spent.set(true);
      history.replaceState(null, '', location.pathname + location.search);
    }
  }
}
