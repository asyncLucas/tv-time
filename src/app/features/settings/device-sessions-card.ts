import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LucideAngularModule, Monitor, Smartphone, Tablet } from 'lucide-angular';
import { ConfirmDialog } from '../../shared/confirm-dialog';
import { DeviceService, DeviceSession } from '../../core/device.service';
import { SyncService } from '../../core/sync.service';

/**
 * "Active sessions" — every device linked to this library.
 *
 * The roster is synced state, so devices that are asleep still appear; the live
 * dot comes from the peer-to-peer room, which is the only thing that can
 * honestly answer "online right now". When P2P is off there's nothing to be
 * live *about*, and the card says so rather than showing everything as offline.
 */
@Component({
  selector: 'app-device-sessions-card',
  imports: [LucideAngularModule, ConfirmDialog],
  template: `
    <section class="card">
      <h2>Active sessions</h2>
      <p class="hint">
        Devices linked to this library. The green dot means the device is in your peer-to-peer room
        right now; everything else is last seen.
      </p>

      @if (devices.signedOut()) {
        <div class="banner">
          <strong>This device is signed out</strong>
          <small>Your data is still here, but it no longer syncs. Link it again to resume.</small>
        </div>
      }

      @if (sessions().length) {
        <ul class="list">
          @for (s of sessions(); track s.id) {
            <li>
              <span class="ic" [class.on]="s.online">
                <lucide-icon [img]="icon(s)" [size]="18" />
              </span>
              @if (s.self && editing()) {
                <input
                  class="in"
                  #nameInput
                  [value]="s.name"
                  maxlength="40"
                  aria-label="Device name"
                  (keydown.enter)="save(nameInput.value)"
                  (keydown.escape)="editing.set(false)"
                />
                <button class="btn sm primary" (click)="save(nameInput.value)">Save</button>
                <button class="btn ghost sm" (click)="editing.set(false)">Cancel</button>
              } @else {
                <div class="who">
                  <strong>
                    <span class="nm">{{ s.name }}</span>
                    @if (s.self) { <span class="chip">this device</span> }
                  </strong>
                  <small [class.live]="s.online && livePresence()">
                    @if (s.self) {
                      {{ devices.signedOut() ? 'Signed out' : 'Active now' }}
                    } @else if (s.online) {
                      Online now
                    } @else {
                      Last seen {{ ago(s.lastSeen) }}
                    }
                    · linked {{ ago(s.linkedAt) }}
                  </small>
                </div>
                <!-- A signed-out device can't sign anyone out: its writes no
                     longer reach the fleet, so the button would be a lie. -->
                @if (!devices.signedOut()) {
                  @if (s.self) {
                    <button class="btn ghost sm" (click)="editing.set(true)">Rename</button>
                  }
                  <button class="btn ghost sm danger" (click)="ask(s)">Sign out</button>
                }
              }
            </li>
          }
        </ul>
      } @else {
        <p class="empty">No devices registered yet.</p>
      }

      @if (!livePresence()) {
        <p class="fine">
          Peer-to-peer sync is off on this device, so live presence is unavailable — the list above
          falls back to each device's last check-in.
        </p>
      }
      <p class="fine">
        Signing a device out asks it to drop its credentials the next time it connects — there's no
        server here to force it. To lock a lost device out for certain, revoke the GitHub token and
        change the sync passphrase.
      </p>
    </section>

    <app-confirm-dialog
      [open]="!!pending()"
      [heading]="pending()?.self ? 'Sign out this device?' : 'Sign out ' + (pending()?.name ?? '') + '?'"
      [message]="
        pending()?.self
          ? 'This device keeps its data but stops syncing until you link it again.'
          : 'It will stop syncing and forget its credentials the next time it connects.'
      "
      confirmLabel="Sign out"
      [danger]="true"
      (confirmed)="confirm()"
      (dismissed)="pending.set(null)"
    />
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
        margin: 0 0 16px;
      }
      .banner {
        background: var(--bg-elev-2);
        border: 1px solid var(--line);
        border-left: 3px solid var(--gold);
        border-radius: var(--radius-sm);
        padding: 12px 14px;
        margin-bottom: 16px;
      }
      .banner strong {
        display: block;
        font-size: 13.5px;
      }
      .banner small {
        color: var(--text-dim);
        font-size: 12.5px;
      }
      .list {
        list-style: none;
        margin: 0;
        padding: 0;
        border: 1px solid var(--line-soft);
        border-radius: var(--radius-sm);
        overflow: hidden;
      }
      li {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        background: var(--bg-elev-2);
      }
      li + li {
        border-top: 1px solid var(--line-soft);
      }
      .ic {
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        background: var(--bg-elev);
        color: var(--text-faint);
        flex: none;
      }
      .ic.on {
        color: var(--good);
        box-shadow: 0 0 0 1px rgba(52, 211, 153, 0.35);
      }
      .who {
        flex: 1;
        min-width: 0;
      }
      .who strong {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13.5px;
        min-width: 0;
      }
      /* the name truncates; the "this device" chip must not be eaten with it */
      .nm {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .who small {
        color: var(--text-faint);
        font-size: 12px;
      }
      .who small.live {
        color: var(--good);
      }
      .chip {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 700;
        color: var(--text-dim);
        background: var(--bg-elev);
        border: 1px solid var(--line);
        padding: 1px 6px;
        border-radius: 999px;
        flex: none;
      }
      .btn.sm {
        padding: 6px 11px;
        font-size: 12px;
      }
      .in {
        flex: 1;
        min-width: 120px;
        background: var(--bg-elev);
        border: 1px solid var(--line);
        color: var(--text);
        padding: 7px 11px;
        border-radius: var(--radius-sm);
        font-size: 13px;
        outline: none;
      }
      .in:focus {
        border-color: #3a3f4a;
      }
      .btn.danger {
        color: var(--bad);
      }
      .btn.danger:hover {
        background: rgba(248, 113, 113, 0.1);
        border-color: transparent;
      }
      /* On a phone the name, the chip and two buttons can't share one line
         without shredding the name — give the actions their own row instead. */
      @media (max-width: 560px) {
        li {
          flex-wrap: wrap;
        }
        .who {
          min-width: calc(100% - 46px);
        }
      }
      .empty {
        color: var(--text-faint);
        font-size: 13px;
        padding: 8px 0;
      }
      .fine {
        color: var(--text-faint);
        font-size: 12px;
        line-height: 1.55;
        margin: 12px 0 0;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeviceSessionsCard {
  protected devices = inject(DeviceService);
  private sync = inject(SyncService);

  protected readonly sessions = this.devices.sessions;
  protected readonly pending = signal<DeviceSession | null>(null);
  /** Inline rename of this device (the only entry whose name we own). */
  protected readonly editing = signal(false);
  /** Presence is only meaningful while this device is in the P2P room. */
  protected readonly livePresence = computed(() => this.sync.connected());

  private readonly icons = { desktop: Monitor, mobile: Smartphone, tablet: Tablet };

  protected icon(s: DeviceSession) {
    return this.icons[s.platform] ?? Monitor;
  }

  protected ask(s: DeviceSession): void {
    this.pending.set(s);
  }

  protected confirm(): void {
    const target = this.pending();
    this.pending.set(null);
    if (!target) return;
    if (target.self) void this.devices.signOutSelf();
    else this.devices.signOut(target.id);
  }

  protected save(name: string): void {
    this.editing.set(false);
    if (name.trim()) void this.devices.rename(name);
  }

  /** Coarse "3 hours ago" — the roster only tracks time to within ~10 minutes. */
  protected ago(iso: string | undefined): string {
    if (!iso) return 'unknown';
    const diff = Date.now() - Date.parse(iso);
    if (Number.isNaN(diff)) return 'unknown';
    const mins = Math.round(diff / 60_000);
    if (mins < 15) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
  }
}
