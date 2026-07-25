import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, QrCode as QrCodeIcon } from 'lucide-angular';
import { QrCode } from '../../shared/qr-code';
import { PairingService } from '../../core/pairing.service';
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
  imports: [QrCode, RouterLink, LucideAngularModule],
  template: `
    <section class="card">
      <h2>Link a device <span class="tag">new</span></h2>
      <p class="hint">
        Start a session on another device the way you'd expect: show a code here, scan it there.
        The new device joins your peer-to-peer sync room and receives your GitHub&nbsp;Gist token, so
        it's syncing the moment it opens — nothing to type twice.
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
                <button class="btn" (click)="copy()">{{ copied() ? '✓ Copied' : 'Copy link' }}</button>
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
          <button class="btn" (click)="pair.host()">Link another device</button>
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
          <button class="btn primary" (click)="pair.host()">Try again</button>
        }
        @default {
          <div class="row">
            <button class="btn primary icon" (click)="pair.host()">
              <lucide-icon [img]="QrIcon" [size]="16" /> Show QR code
            </button>
            <a class="btn ghost" routerLink="/link">This device is the new one…</a>
          </div>
          @if (!gist.enabled()) {
            <p class="fine">
              Cloud sync isn't set up on this device, so the linked device gets peer-to-peer sync
              only. Connect a GitHub token above first to pass that along too.
            </p>
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
      .fine code {
        background: var(--bg-elev-2);
        padding: 1px 5px;
        border-radius: 4px;
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
  protected readonly QrIcon = QrCodeIcon;
  protected readonly copied = signal(false);

  protected readonly clock = computed(() => {
    const s = this.pair.secondsLeft();
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

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
