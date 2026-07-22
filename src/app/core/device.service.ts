import { Injectable, computed, inject, signal } from '@angular/core';
import { DocService } from './doc.service';
import { GistSyncService } from './gist-sync.service';
import { LocalConfigService } from './local-config.service';
import { SyncService } from './sync.service';

export type DevicePlatform = 'desktop' | 'mobile' | 'tablet';

/** What a device publishes about itself into the synced roster. */
export interface DeviceRecord {
  name: string;
  platform: DevicePlatform;
  /** ISO — when this device first joined the fleet. */
  linkedAt: string;
  /** ISO — last launch/heartbeat. Coarse by design (see HEARTBEAT_MS). */
  lastSeen: string;
}

/** A roster entry joined with live presence, as the Settings list renders it. */
export interface DeviceSession extends DeviceRecord {
  id: string;
  /** In the P2P room right now (from WebRTC awareness). */
  online: boolean;
  /** This browser. */
  self: boolean;
}

/** How often a device refreshes its `lastSeen` in the synced roster. */
const HEARTBEAT_MS = 10 * 60_000;
/** Don't rewrite `lastSeen` more often than this (multi-tab, quick relaunches). */
const TOUCH_MIN_GAP_MS = 5 * 60_000;

/**
 * Identity and roster for the user's device fleet — the "active sessions" list.
 *
 * Two halves, deliberately kept apart:
 *  - the *roster* (`docs.devices`) is synced CRDT state: which devices are
 *    linked, what they're called, when each was last seen. Survives being
 *    offline, so a phone in a drawer still shows up.
 *  - *presence* comes from WebRTC awareness (SyncService.presences) and is pure
 *    ephemera: it says who is in the room this second and nothing more.
 *
 * Signing a device out is cooperative, not enforced — there is no server to
 * revoke against. Removing an entry makes every honest device that sees the
 * deletion drop its own credentials; the UI says as much rather than implying a
 * lockout it can't deliver.
 */
@Injectable({ providedIn: 'root' })
export class DeviceService {
  private docs = inject(DocService);
  private config = inject(LocalConfigService);
  private sync = inject(SyncService);
  private gist = inject(GistSyncService);

  private readonly _id = signal('');
  private readonly _roster = signal<Record<string, DeviceRecord>>({});
  private readonly _signedOut = signal(false);

  /** Stable id for this browser profile (device-local, never synced by itself). */
  readonly id = this._id.asReadonly();
  /** True when this device has been unlinked — data kept, syncing stopped. */
  readonly signedOut = this._signedOut.asReadonly();
  /** The roster is the source of truth once we're in it; before that, local. */
  readonly name = computed(() => this._roster()[this._id()]?.name ?? this._localName());

  /** Ids seen in the P2P room right now. */
  private readonly onlineIds = computed(
    () => new Set(this.sync.presences().map((p) => p['id'] as string)),
  );

  /**
   * The roster, newest-active first, with this device pinned to the top —
   * the same ordering WhatsApp's linked-devices list uses.
   */
  readonly sessions = computed<DeviceSession[]>(() => {
    const self = this._id();
    const online = this.onlineIds();
    return Object.entries(this._roster())
      .map(([id, rec]) => ({ ...rec, id, self: id === self, online: id === self || online.has(id) }))
      .sort((a, b) => {
        if (a.self !== b.self) return a.self ? -1 : 1;
        if (a.online !== b.online) return a.online ? -1 : 1;
        return (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '');
      });
  });

  /** Devices other than this one — what the "sign out" affordance applies to. */
  readonly others = computed(() => this.sessions().filter((s) => !s.self));

  private readonly _localName = signal(describeDevice().name);
  private timer?: ReturnType<typeof setInterval>;
  private started = false;

  /**
   * Adopt an identity, publish presence and start the heartbeat. Called once at
   * launch, after LocalConfigService and the doc are ready.
   */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;

    let id = this.config.get<string>('deviceId');
    if (!id) {
      id = crypto.randomUUID();
      await this.config.set('deviceId', id);
    }
    this._id.set(id);
    this._localName.set(this.config.get<string>('deviceName') ?? this._localName());
    this._signedOut.set(!!this.config.get<boolean>('signedOut'));

    this.bindRoster();
    if (this._signedOut()) return;
    // A revocation that landed while this device was offline still applies.
    if (this.docs.revokedDevices.has(id)) return void this.signOutSelf(false);
    this.activate();
  }

  /** Register in the roster, publish presence, keep both fresh. */
  private activate(): void {
    this.touch();
    this.publishPresence();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.touch(), HEARTBEAT_MS);
  }

  /** Mirror the synced roster into a signal, and watch for our own revocation. */
  private bindRoster(): void {
    const map = this.docs.devices;
    this._roster.set(map.toJSON() as Record<string, DeviceRecord>);
    map.observe(() => this._roster.set(map.toJSON() as Record<string, DeviceRecord>));

    // Another device signed this one out — either live, or in an update that
    // only reached us now, which is why the check is on the tombstone rather
    // than on our roster entry going missing.
    this.docs.revokedDevices.observe(() => {
      if (!this._signedOut() && this.docs.revokedDevices.has(this._id())) {
        void this.signOutSelf(false);
      }
    });
  }

  /** Refresh this device's roster entry (throttled — see TOUCH_MIN_GAP_MS). */
  private touch(): void {
    const id = this._id();
    if (!id || this._signedOut() || this.docs.revokedDevices.has(id)) return;
    const now = new Date();
    const prev = this.docs.devices.get(id) as DeviceRecord | undefined;
    if (prev?.lastSeen && now.getTime() - Date.parse(prev.lastSeen) < TOUCH_MIN_GAP_MS) return;

    const detected = describeDevice();
    this.docs.devices.set(id, {
      name: prev?.name ?? this.config.get<string>('deviceName') ?? detected.name,
      platform: prev?.platform ?? detected.platform,
      linkedAt: prev?.linkedAt ?? now.toISOString(),
      lastSeen: now.toISOString(),
    } satisfies DeviceRecord);
  }

  private publishPresence(): void {
    const rec = this.docs.devices.get(this._id()) as DeviceRecord | undefined;
    this.sync.setPresence({
      id: this._id(),
      name: rec?.name ?? this._localName(),
      platform: rec?.platform ?? describeDevice().platform,
    });
  }

  /** Rename this device — shows up in every device's session list. */
  async rename(name: string): Promise<void> {
    const clean = name.trim().slice(0, 40);
    if (!clean) return;
    await this.config.set('deviceName', clean);
    this._localName.set(clean);
    const id = this._id();
    const prev = this.docs.devices.get(id) as DeviceRecord | undefined;
    if (prev) this.docs.devices.set(id, { ...prev, name: clean });
    this.publishPresence();
  }

  /**
   * Sign another device out: tombstone it and drop it from the roster, as one
   * transaction. That travels over the same sync channels, and the device
   * applies it to itself the next time it connects (see bindRoster).
   *
   * It cannot be *forced* — an offline device holds working credentials until
   * it next syncs, and a modified client could ignore the tombstone entirely.
   * For a hard lockout the user must rotate the GitHub token and the P2P
   * passphrase, which the Settings copy spells out.
   */
  signOut(id: string): void {
    if (!id || id === this._id()) return;
    this.docs.doc.transact(() => {
      this.docs.revokedDevices.set(id, new Date().toISOString());
      this.docs.devices.delete(id);
    });
  }

  /**
   * Unlink *this* device: stop syncing and forget the credentials that let it
   * rejoin. Local data is untouched — this is a sign-out, not a wipe.
   *
   * `announce` removes our roster entry first so the rest of the fleet sees it
   * go; on a remote sign-out the entry is already gone and re-adding it would
   * undo what the user just asked for.
   */
  async signOutSelf(announce = true): Promise<void> {
    if (announce) this.docs.devices.delete(this._id());
    clearInterval(this.timer);
    this.timer = undefined;
    this._signedOut.set(true);
    await this.config.set('signedOut', true);
    this.sync.setPresence(null);
    // disconnect(), not forget(): the room + passphrase live in the *synced*
    // doc, so deleting them here would unlink the whole fleet, not this device.
    this.sync.disconnect();
    this.gist.forget(); // token + gist id are device-local — safe to drop
  }

  /**
   * Called after a successful pairing: this device is part of the fleet again.
   * Clearing our own tombstone is the one legitimate write to that map — the
   * user just re-authorized this device by scanning a live code.
   */
  async reactivate(): Promise<void> {
    this._signedOut.set(false);
    await this.config.delete('signedOut');
    this.docs.revokedDevices.delete(this._id());
    this.activate();
  }
}

/**
 * A human-readable name for this device, WhatsApp-style ("Chrome on Android").
 * Best-effort UA sniffing: a wrong guess is cosmetic, and the name is editable.
 */
export function describeDevice(): { name: string; platform: DevicePlatform } {
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPod|Mobile/i.test(ua);
  const tablet = /iPad|Tablet/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const platform: DevicePlatform = tablet ? 'tablet' : mobile ? 'mobile' : 'desktop';

  const os =
    /iPhone|iPod/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Macintosh|Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'this device';

  // Order matters: every one of these UAs also contains "Safari"/"Chrome".
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';

  return { name: `${browser} on ${os}`, platform };
}
