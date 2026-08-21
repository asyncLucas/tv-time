import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule, Camera as CameraIcon, QrCode as QrCodeIcon } from 'lucide-angular';
import { QrCode } from '../../shared/qr-code';
import { QrScanner } from '../../shared/qr-scanner';
import { PairingService, codePart, decodeLink } from '../../core/pairing.service';
import { GistSyncService } from '../../core/gist-sync.service';

/**
 * "Link a device" — the WhatsApp-style pairing card.
 *
 * Shows a short-lived QR code that the other device opens with its own camera;
 * the credentials themselves never touch the code (see PairingService). The
 * card is a thin view over that service: it owns no protocol state, only the
 * copy-to-clipboard flourish.
 */
@Component({
  selector: 'app-link-device-card',
  imports: [QrCode, QrScanner, RouterLink, LucideAngularModule],
  template: `
    <section class="card">
      <h2>Link a device <span class="tag">new</span></h2>
      <p class="hint">
        Start a session on another device the way you'd expect — with a QR code, pointed whichever
        way suits the devices in front of you. The new one joins your peer-to-peer sync room and
        receives your GitHub&nbsp;Gist token, so it's syncing the moment it opens.
      </p>

      @switch (pair.state()) {
        @case ('waiting') {
          <div class="pairing">
            <div class="qr-frame">
              <app-qr-code [data]="pair.link()!" label="Device linking code" />
            </div>
            <div class="steps">
              <ol>
                <li>On the other device, open the camera and point it at this code.</li>
                <li>Tap the link that appears, then confirm.</li>
              </ol>
              <div class="expiry" [class.soon]="pair.secondsLeft() < 30">
                Code expires in {{ clock() }}
              </div>
              <div class="row">
                <button class="btn" (click)="copy()">
                  {{ copied() ? '✓ Copied' : 'Copy link' }}
                </button>
                <button class="btn ghost" (click)="pair.reset()">Cancel</button>
              </div>
              <p class="fine">
                No camera? Open <code>Settings → Link a device</code> on the other device and paste
                this link there.
              </p>
            </div>
          </div>
          <p class="hint warn">
            Anyone who scans this code within the next two minutes joins your library. Only show it
            to a device you own.
          </p>
        }
        @case ('connecting') {
          <div class="state">
            <span class="spinner"></span>
            <div>
              <strong>Reaching that device…</strong>
              <small>Opening the encrypted channel behind the code you scanned.</small>
            </div>
          </div>
          <button class="btn ghost" (click)="cancel()">Cancel</button>
        }
        @case ('confirming') {
          <div class="state">
            <span class="tick ask">?</span>
            <div>
              <strong>Add {{ pair.peerName() }}?</strong>
              <small>Only link a device you own — this hands it your library.</small>
            </div>
          </div>
          <ul class="grants">
            <li>Joins your peer-to-peer sync room</li>
            @if (pair.sharesGistToken()) {
              <li>Receives your GitHub&nbsp;Gist token, which can read and write your library</li>
            }
          </ul>
          <div class="row">
            <button class="btn primary" (click)="pair.approve()">Link this device</button>
            <button class="btn ghost" (click)="cancel()">Not now</button>
          </div>
        }
        @case ('linking') {
          <div class="state">
            <span class="spinner"></span>
            <div>
              <strong>Linking {{ pair.peerName() ?? 'the new device' }}…</strong>
              <small>Handing over sync credentials over the encrypted channel.</small>
            </div>
          </div>
        }
        @case ('linked') {
          <div class="state ok">
            <span class="tick">✓</span>
            <div>
              <strong>{{ pair.peerName() ?? 'The device' }} is linked</strong>
              <small>It's syncing now and appears in your sessions below.</small>
            </div>
          </div>
          <button class="btn" (click)="retry()">Link another device</button>
        }
        @case ('expired') {
          <div class="state">
            <span class="tick dim">⏱</span>
            <div>
              <strong>Code expired</strong>
              <small>Codes are short-lived on purpose — generate a fresh one.</small>
            </div>
          </div>
          <button class="btn primary" (click)="pair.host()">Show a new code</button>
        }
        @case ('error') {
          <p class="hint err-hint">{{ pair.error() }}</p>
          <button class="btn primary" (click)="retry()">Try again</button>
        }
        @default {
          @if (scanning()) {
            <div class="pairing">
              <app-qr-scanner (scanned)="use($event)" (failed)="noCamera.set(true)" />
              <div class="steps">
                <ol>
                  <li>
                    On the new device, open this app and go to
                    <code>Settings → Link a device → This device is the new one</code>.
                  </li>
                  <li>Point this camera at the code it shows.</li>
                </ol>
                <label class="paste">
                  <span>No camera? Paste the code it shows</span>
                  <input
                    class="in"
                    placeholder="Paste link or code"
                    autocapitalize="off"
                    autocomplete="off"
                    spellcheck="false"
                    [value]="typed()"
                    (input)="typed.set($any($event.target).value)"
                  />
                </label>
                <div class="row">
                  <button class="btn" [disabled]="!typed().trim()" (click)="use(typed())">
                    Use this code
                  </button>
                  <button class="btn ghost" (click)="cancel()">Cancel</button>
                </div>
              </div>
            </div>
          } @else {
            <div class="row">
              <button class="btn primary icon" (click)="scan()">
                <lucide-icon [img]="CameraIcon" [size]="16" /> Scan a code
              </button>
              <button class="btn icon" (click)="show()">
                <lucide-icon [img]="QrIcon" [size]="16" /> Show a code instead
              </button>
              <a class="btn ghost" routerLink="/link">This device is the new one…</a>
            </div>
            <p class="fine">
              <strong>Scan a code</strong> uses this device's camera to read the code on the new
              one. <strong>Show a code</strong> is the other way round — useful when the new device
              is the one holding a camera.
            </p>
            @if (!gist.enabled()) {
              <p class="fine">
                Cloud sync isn't set up on this device, so the linked device gets peer-to-peer sync
                only. Connect a GitHub token above first to pass that along too.
              </p>
            }
          }
        }
      }
    </section>
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
        color: var(--gold);
        background: var(--gold-soft);
        padding: 2px 7px;
        border-radius: 999px;
        margin-left: 6px;
        font-weight: 700;
        vertical-align: middle;
      }
      .hint {
        color: var(--text-dim);
        font-size: 13px;
        line-height: 1.55;
        margin: 0 0 14px;
      }
      .hint.warn {
        margin: 16px 0 0;
        color: var(--text-faint);
      }
      .err-hint {
        color: var(--bad);
      }
      .row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }
      .btn.icon {
        display: inline-flex;
        align-items: center;
        gap: 7px;
      }
      a.btn {
        display: inline-flex;
        align-items: center;
      }
      .pairing {
        display: flex;
        gap: 24px;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .qr-frame {
        background: #fff;
        padding: 10px;
        border-radius: 14px;
        width: 208px;
        flex: none;
        box-shadow: var(--shadow);
      }
      .steps {
        flex: 1;
        min-width: 240px;
      }
      .steps ol {
        margin: 0 0 14px;
        padding-left: 18px;
        color: var(--text-dim);
        font-size: 13px;
        line-height: 1.7;
      }
      .expiry {
        font-size: 12.5px;
        font-weight: 600;
        color: var(--text-faint);
        font-variant-numeric: tabular-nums;
        margin-bottom: 12px;
      }
      .expiry.soon {
        color: var(--gold);
      }
      .fine {
        color: var(--text-faint);
        font-size: 12px;
        line-height: 1.55;
        margin: 12px 0 0;
      }
      .fine code,
      .steps code {
        background: var(--bg-elev-2);
        padding: 1px 5px;
        border-radius: 4px;
      }
      .in {
        width: 100%;
        background: var(--bg-elev-2);
        border: 1px solid var(--line);
        color: var(--text);
        padding: 10px 13px;
        border-radius: var(--radius-sm);
        font-size: 13.5px;
        outline: none;
      }
      .in:focus {
        border-color: #3a3f4a;
      }
      .paste {
        display: block;
        margin-bottom: 12px;
      }
      .paste span {
        display: block;
        font-size: 12px;
        color: var(--text-faint);
        margin-bottom: 6px;
      }
      .grants {
        margin: 0 0 14px;
        padding-left: 18px;
        color: var(--text-dim);
        font-size: 13px;
        line-height: 1.7;
      }
      .tick.ask {
        color: var(--gold);
        font-weight: 800;
      }
      .btn[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }
      app-qr-scanner {
        flex: none;
        width: 228px;
      }
      .state {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: 14px;
      }
      .state strong {
        display: block;
        font-size: 14px;
      }
      .state small {
        color: var(--text-dim);
        font-size: 12.5px;
      }
      .state.ok strong {
        color: var(--good);
      }
      .tick {
        font-size: 20px;
        color: var(--good);
      }
      .tick.dim {
        color: var(--text-faint);
      }
      .spinner {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: 2px solid var(--line);
        border-top-color: var(--gold);
        animation: spin 0.8s linear infinite;
        flex: none;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .spinner {
          animation-duration: 3s;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LinkDeviceCard implements OnDestroy {
  protected pair = inject(PairingService);
  protected gist = inject(GistSyncService);
  private router = inject(Router);
  protected readonly QrIcon = QrCodeIcon;
  protected readonly CameraIcon = CameraIcon;
  protected readonly copied = signal(false);
  /** Viewfinder open — the idle screen's second face. */
  protected readonly scanning = signal(false);
  /** Set when the scanner gave up, so the pasted-code path takes the focus. */
  protected readonly noCamera = signal(false);
  protected readonly typed = signal('');
  /** Which way the last attempt pointed, so "Try again" retries *that*. */
  private readonly mode = signal<'show' | 'scan'>('scan');

  protected readonly clock = computed(() => {
    const s = this.pair.secondsLeft();
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  /** Camera path: read a code off the new device. */
  protected scan(): void {
    this.mode.set('scan');
    this.typed.set('');
    this.noCamera.set(false);
    this.pair.reset();
    this.scanning.set(true);
  }

  /** Screen path: put a code up for the new device to read. */
  protected show(): void {
    this.mode.set('show');
    this.scanning.set(false);
    this.pair.host();
  }

  /**
   * Redeem a code — scanned off the camera or pasted by hand.
   *
   * The code says which side of the exchange it belongs to, so read that rather
   * than assuming the button you pressed was the right one. A code minted by a
   * device that already has the library means *this* one is the newcomer, and
   * refusing it would be pedantry: hand it to the screen that redeems it, which
   * is also where the "this replaces your sync setup" consent lives.
   */
  protected use(code: string): void {
    if (!code.trim()) return;
    this.scanning.set(false);
    const payload = decodeLink(code);
    // Junk falls through to grant(), which is where the "not a valid code"
    // message lives — no second copy of it here.
    if (payload && !payload.o) {
      void this.router.navigate(['/link'], { fragment: codePart(code) });
      return;
    }
    void this.pair.grant(code);
  }

  protected cancel(): void {
    this.scanning.set(false);
    this.pair.reset();
  }

  protected retry(): void {
    if (this.mode() === 'scan') this.scan();
    else this.show();
  }

  protected copy(): void {
    const link = this.pair.link();
    if (!link) return;
    void navigator.clipboard?.writeText(link).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2_000);
    });
  }

  /** Leaving Settings tears the pairing room down — a code shouldn't outlive its screen. */
  ngOnDestroy(): void {
    this.pair.reset();
  }
}
