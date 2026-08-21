import { Injectable, computed, inject, signal } from '@angular/core';
import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import { DeviceService, describeDevice } from './device.service';
import { DocService } from './doc.service';
import { GistSyncService } from './gist-sync.service';
import { LocalConfigService } from './local-config.service';
import { DEFAULT_SIGNALING_URL, SyncService } from './sync.service';

export type PairState =
  /** nothing in flight */
  | 'idle'
  /** host: code on screen, waiting to be scanned */
  | 'waiting'
  /** joiner: its own code on screen, waiting for a logged-in device to scan it */
  | 'offering'
  /** joiner: reaching the device that showed the code */
  | 'connecting'
  /** host: scanned a new device's code, waiting for the go-ahead to hand creds over */
  | 'confirming'
  /** credentials are moving / being applied */
  | 'linking'
  /** done */
  | 'linked'
  /** the code timed out unused */
  | 'expired'
  | 'error';

/** How long a code stays valid. Short on purpose — it carries a live secret. */
export const PAIR_TTL_MS = 120_000;
/** How long a joiner waits for the host to answer before giving up. */
const CLAIM_TIMEOUT_MS = 30_000;
const ROOM_PREFIX = 'tvtime-link-';
/** Y.Map holding the handshake inside the throwaway pairing doc. */
const HANDSHAKE = 'handshake';

/** What the QR code (and the typed fallback code) actually contains. */
interface PairPayload {
  v: 1;
  /** pairing room id — public; the signaling server sees it */
  i: string;
  /** room key — the only secret in the code, and it dies with the room */
  k: string;
  /** custom signaling server, when the fleet uses one */
  s?: string;
  /**
   * Set when the code was minted by the *new* device, i.e. it is waiting to be
   * scanned by one that already has the library. Absent means the other
   * direction — the code came from a logged-in device. Which way a code points
   * decides who waits for whom, so redeeming one the wrong way round is an
   * error we can name rather than two devices staring at each other.
   */
  o?: 1;
}

/** The bundle handed to the new device over the encrypted pairing room. */
interface Credentials {
  room: string;
  pass: string;
  sig?: string;
  tmdb?: string;
  gist?: string;
  /** name of the device that granted the link, for the confirmation screen */
  from?: string;
}

/**
 * WhatsApp-style device linking: one device shows a QR code, the other opens it
 * and lands fully configured — P2P sync connected and the GitHub Gist token
 * installed, without either being typed twice.
 *
 * The code itself carries no lasting secret. It names a throwaway WebRTC room
 * plus a random 128-bit key; the credentials travel *inside* that room, which is
 * end-to-end encrypted with the key and torn down the moment the handshake
 * completes. A photographed code is worthless once the room is gone, and the
 * signaling server — the only third party in the path — sees ciphertext.
 *
 * Handshake, over one Y.Map in a doc that exists only for this exchange:
 *
 *   joiner  hs.req   = { id, name, platform }   "here I am"
 *   host    hs.creds = { room, pass, … }        "here's the fleet"
 *   joiner  hs.ack   = { name }                 "applied" → both sides close
 *
 * The room is single-use: the host serves exactly one `req` and then stops.
 *
 * Either side can be the one holding the camera, because the handshake above
 * never says who *minted* the room — only who ends up with the credentials:
 *
 *   host()  shows a code  ↔  claim()  scans it   (the new device scans)
 *   offer() shows a code  ↔  grant()  scans it   (the signed-in device scans)
 *
 * The second pair exists because the device that can't scan isn't always the
 * new one: a desktop or a TV can display a code far more easily than it can
 * find a camera. A code carries which way it points (`o`), so redeeming one
 * backwards is a message rather than two devices waiting on each other.
 */
@Injectable({ providedIn: 'root' })
export class PairingService {
  private docs = inject(DocService);
  private config = inject(LocalConfigService);
  private sync = inject(SyncService);
  private gist = inject(GistSyncService);
  private devices = inject(DeviceService);

  readonly state = signal<PairState>('idle');
  readonly error = signal<string | null>(null);
  /** The other device's name, once it announces itself. */
  readonly peerName = signal<string | null>(null);
  /** Seconds left on the displayed code (host side). */
  readonly secondsLeft = signal(0);
  /** The deep link encoded in the QR — also the typed fallback code. */
  readonly link = signal<string | null>(null);
  /** Whether the code being offered includes the Gist token. */
  readonly sharesGistToken = signal(false);
  /**
   * What the joiner actually turned on — not what it was *sent*. A credential
   * can arrive and still fail to take (a token GitHub refuses, a key the device
   * already had), and a linking screen that reports the wish rather than the
   * outcome is how someone ends up believing sync works when it doesn't.
   */
  readonly applied = signal<{
    p2p: boolean;
    gist: boolean;
    tmdb: boolean;
    /** Why cloud sync didn't come up, when it didn't. */
    gistError?: string;
  } | null>(null);

  readonly busy = computed(() => this.state() === 'connecting' || this.state() === 'linking');

  private doc?: Y.Doc;
  private provider?: WebrtcProvider;
  private ttlTimer?: ReturnType<typeof setTimeout>;
  private tickTimer?: ReturnType<typeof setInterval>;
  /** Guards the one-shot rule: a code serves a single device. */
  private served = false;

  // ---------------------------------------------------------------------------
  // Host — the device that already has the library
  // ---------------------------------------------------------------------------
  /**
   * Put a code on screen. If this device has no P2P room yet one is minted and
   * joined first, so linking always produces working peer-to-peer sync rather
   * than depending on the user having set it up beforehand.
   */
  host(): void {
    this.reset();
    try {
      const { room, pass } = this.ensureFleetRoom();
      const id = randomToken(9);
      const key = randomToken(16);
      const sig = str(this.docs.settings.get('signalingUrl'));
      const token = str(this.config.get('gistToken'));

      const hs = this.openRoom(id, key);
      this.sharesGistToken.set(!!token);
      this.link.set(encodeLink({ v: 1, i: id, k: key, ...(sig ? { s: sig } : {}) }));
      this.state.set('waiting');
      this.startCountdown();

      hs.observe(() => {
        const req = hs.get('req') as { name?: string } | undefined;
        if (req && !this.served) {
          this.served = true;
          this.peerName.set(req.name ?? 'New device');
          this.state.set('linking');
          this.link.set(null); // the code is spent — stop showing it
          this.stopCountdown();
          hs.set('creds', {
            room,
            pass,
            ...(sig ? { sig } : {}),
            ...(str(this.docs.settings.get('tmdbKey'))
              ? { tmdb: str(this.docs.settings.get('tmdbKey')) }
              : {}),
            ...(token ? { gist: token } : {}),
            from: this.devices.name(),
          } satisfies Credentials);
        }
        if (hs.get('ack')) {
          this.state.set('linked');
          // Let the ack reach the peer before tearing the room down.
          setTimeout(() => this.closeRoom(), 1_500);
        }
      });
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * The room + passphrase the whole fleet shares, creating them on first use.
   * Connecting here is what persists them into the synced doc.
   */
  private ensureFleetRoom(): { room: string; pass: string } {
    const room = str(this.docs.settings.get('syncRoom')) ?? `fleet-${randomToken(6)}`;
    const pass = str(this.docs.settings.get('syncPass')) ?? randomToken(16);
    if (!this.sync.room()) this.sync.connect(room, pass);
    return { room, pass };
  }

  /**
   * The other direction: this device *scans* a code shown by a new one.
   *
   * Same room, same encryption, roles swapped — the new device is already in
   * the room announcing itself, so all this does is join, learn who is asking,
   * and stop. Nothing is handed over until `approve()`; scanning is how you
   * find a device, not how you trust it.
   */
  async grant(code: string): Promise<void> {
    this.reset();
    const payload = decodeLink(code);
    if (!payload) {
      this.error.set("That doesn't look like a valid link code.");
      this.state.set('error');
      return;
    }
    if (!payload.o) {
      this.error.set(
        'That code came from a device that already has your library. Show a code from the new device and scan that one instead.',
      );
      this.state.set('error');
      return;
    }

    this.state.set('connecting');
    this.sharesGistToken.set(!!str(this.config.get('gistToken')));
    try {
      const hs = this.openRoom(payload.i, payload.k, this.meetingPoints(payload.s));
      const req = await new Promise<{ name?: string }>((resolve, reject) => {
        // The announcement is usually already in the doc by the time we sync,
        // in which case no change event is ever coming — check before waiting.
        const seen = hs.get('req') as { name?: string } | undefined;
        if (seen) return resolve(seen);
        hs.observe(() => {
          const r = hs.get('req') as { name?: string } | undefined;
          if (r) resolve(r);
        });
        this.ttlTimer = setTimeout(
          () => reject(new Error('That device didn’t answer. Is its code still on screen?')),
          CLAIM_TIMEOUT_MS,
        );
      });
      clearTimeout(this.ttlTimer);
      this.peerName.set(req.name ?? 'New device');
      this.state.set('confirming');
    } catch (e) {
      this.closeRoom();
      this.fail(e);
    }
  }

  /** Confirmed by a human: hand the fleet's credentials to the scanned device. */
  async approve(): Promise<void> {
    if (this.state() !== 'confirming' || !this.doc) return;
    const hs = this.doc.getMap<any>(HANDSHAKE);
    this.state.set('linking');
    try {
      const { room, pass } = this.ensureFleetRoom();
      const sig = str(this.docs.settings.get('signalingUrl'));
      const tmdb = str(this.docs.settings.get('tmdbKey'));
      const token = str(this.config.get('gistToken'));

      const acked = new Promise<void>((resolve, reject) => {
        hs.observe(() => {
          if (hs.get('ack')) resolve();
        });
        this.ttlTimer = setTimeout(
          () => reject(new Error('The new device stopped responding before it finished linking.')),
          CLAIM_TIMEOUT_MS,
        );
      });

      hs.set('creds', {
        room,
        pass,
        ...(sig ? { sig } : {}),
        ...(tmdb ? { tmdb } : {}),
        ...(token ? { gist: token } : {}),
        from: this.devices.name(),
      } satisfies Credentials);

      await acked;
      clearTimeout(this.ttlTimer);
      this.state.set('linked');
      setTimeout(() => this.closeRoom(), 1_500);
    } catch (e) {
      this.closeRoom();
      this.fail(e);
    }
  }

  // ---------------------------------------------------------------------------
  // Joiner — the new device
  // ---------------------------------------------------------------------------
  /**
   * The mirror of `host()`: put *this* device's code on screen and wait to be
   * scanned by one that already has the library. Useful whenever the new device
   * is the one that can't scan — a desktop, a TV — or simply when the phone in
   * your hand is the one that's already signed in.
   */
  offer(): void {
    this.reset();
    try {
      const id = randomToken(9);
      const key = randomToken(16);
      const me = describeDevice();
      const name = this.devices.name() || me.name;
      const sig = str(this.docs.settings.get('signalingUrl'));

      const hs = this.openRoom(id, key, this.meetingPoints(sig));
      this.link.set(encodeLink({ v: 1, i: id, k: key, o: 1, ...(sig ? { s: sig } : {}) }));
      this.state.set('offering');
      this.startCountdown();
      // Announce before anyone arrives: the scanner joins a room that already
      // says who wants in, so it can name this device on its confirm screen
      // without a second round trip.
      hs.set('req', { id: this.devices.id(), name, platform: me.platform });
      hs.observe(() => void this.consume(hs, name));
    } catch (e) {
      this.fail(e);
    }
  }

  /** Apply the credentials the scanning device dropped into the room. */
  private async consume(hs: Y.Map<any>, name: string): Promise<void> {
    const creds = hs.get('creds') as Credentials | undefined;
    if (!creds || this.served) return;
    this.served = true;
    this.stopCountdown();
    this.link.set(null);
    this.peerName.set(creds.from ?? null);
    this.state.set('linking');
    try {
      await this.applyCredentials(creds);
      hs.set('ack', { name });
      this.state.set('linked');
      setTimeout(() => this.closeRoom(), 1_500);
    } catch (e) {
      this.closeRoom();
      this.fail(e);
    }
  }

  /** Redeem a scanned link (or a pasted code) and adopt the fleet's config. */
  async claim(code: string): Promise<void> {
    this.reset();
    const payload = decodeLink(code);
    if (!payload) {
      this.error.set("That doesn't look like a valid link code.");
      this.state.set('error');
      return;
    }
    if (payload.o) {
      this.error.set(
        'That code was made by a device waiting to be added. Scan it from a device that already has your library instead.',
      );
      this.state.set('error');
      return;
    }

    this.state.set('connecting');
    const me = describeDevice();
    const name = this.devices.name() || me.name;
    try {
      const hs = this.openRoom(payload.i, payload.k, payload.s ? [payload.s] : undefined);
      const settled = new Promise<Credentials>((resolve, reject) => {
        hs.observe(() => {
          const creds = hs.get('creds') as Credentials | undefined;
          if (creds) resolve(creds);
        });
        this.ttlTimer = setTimeout(
          () => reject(new Error('The other device didn’t answer. Is the code still on screen?')),
          CLAIM_TIMEOUT_MS,
        );
      });

      hs.set('req', { id: this.devices.id(), name, platform: me.platform });
      const creds = await settled;
      clearTimeout(this.ttlTimer);

      this.peerName.set(creds.from ?? null);
      this.state.set('linking');
      await this.applyCredentials(creds);
      hs.set('ack', { name });
      this.state.set('linked');
      setTimeout(() => this.closeRoom(), 1_500);
    } catch (e) {
      this.closeRoom();
      this.fail(e);
    }
  }

  /**
   * Turn the received bundle into a working device.
   *
   * Order is deliberate: the signaling URL must be in place before P2P dials
   * out, and the gist is pulled first because it carries the whole library —
   * the new device has something to show by the time the screen says "linked".
   */
  private async applyCredentials(c: Credentials): Promise<void> {
    if (c.sig) this.docs.settings.set('signalingUrl', c.sig);

    // A key already on this device wins — linking should not overwrite what
    // someone typed here. Report success only if this device ends up holding
    // the key that was sent, however it got there.
    let tmdbOk = false;
    if (c.tmdb) {
      const existing = str(this.docs.settings.get('tmdbKey'));
      if (!existing) this.docs.settings.set('tmdbKey', c.tmdb);
      tmdbOk = !existing || existing === c.tmdb;
    }
    await this.devices.reactivate();

    let gistOk = false;
    let gistError: string | undefined;
    if (c.gist) {
      await this.gist.connect(c.gist); // resolves after the first pull+push
      gistOk = this.gist.status() !== 'error';
      // connect() swallows its own failures into the status signal, so the
      // reason lives there rather than in a rejection we could catch.
      if (!gistOk) gistError = this.gist.error() ?? 'Cloud sync could not start on this device.';
    }
    if (c.room && c.pass) this.sync.connect(c.room, c.pass);
    this.applied.set({
      p2p: !!c.room,
      gist: gistOk,
      tmdb: tmdbOk,
      ...(gistError ? { gistError } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  /** Open the throwaway, end-to-end encrypted pairing room. */
  private openRoom(id: string, key: string, signaling = this.sync.signalingUrls()): Y.Map<any> {
    this.doc = new Y.Doc();
    this.provider = new WebrtcProvider(ROOM_PREFIX + id, this.doc, {
      signaling,
      password: key,
    });
    return this.doc.getMap<any>(HANDSHAKE);
  }

  /**
   * Signaling servers for a code-scanned-in-app handshake.
   *
   * The two sides may disagree about the fleet's signaling server — a brand-new
   * device has never heard of a custom one — so instead of picking, both dial
   * every candidate. y-webrtc is happy to hold several, and one shared server
   * is all the handshake needs.
   */
  private meetingPoints(...extra: (string | undefined)[]): string[] {
    return [...new Set([...extra, ...this.sync.signalingUrls(), DEFAULT_SIGNALING_URL])].filter(
      (u): u is string => !!u,
    );
  }

  private startCountdown(): void {
    const until = Date.now() + PAIR_TTL_MS;
    this.secondsLeft.set(Math.round(PAIR_TTL_MS / 1000));
    this.tickTimer = setInterval(() => {
      this.secondsLeft.set(Math.max(0, Math.round((until - Date.now()) / 1000)));
    }, 1_000);
    this.ttlTimer = setTimeout(() => {
      if (this.state() === 'waiting' || this.state() === 'offering') {
        this.closeRoom();
        this.link.set(null);
        this.state.set('expired');
      }
    }, PAIR_TTL_MS);
  }

  private stopCountdown(): void {
    clearInterval(this.tickTimer);
    clearTimeout(this.ttlTimer);
    this.tickTimer = this.ttlTimer = undefined;
    this.secondsLeft.set(0);
  }

  /** Tear the pairing room down; the app's own sync providers are untouched. */
  closeRoom(): void {
    this.stopCountdown();
    this.provider?.destroy();
    this.provider = undefined;
    this.doc?.destroy();
    this.doc = undefined;
  }

  /** Back to square one (also used by "show a new code"). */
  reset(): void {
    this.closeRoom();
    this.served = false;
    this.state.set('idle');
    this.error.set(null);
    this.peerName.set(null);
    this.link.set(null);
    this.applied.set(null);
  }

  private fail(e: unknown): void {
    this.error.set(String((e as Error)?.message ?? e));
    this.state.set('error');
  }
}

/** A trimmed non-empty string, or undefined — settings arrive as `any`. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** `bytes * 8` bits of randomness, base64url — safe in a URL and in a QR code. */
export function randomToken(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * The link a QR code carries: an absolute URL to the app's /link route with the
 * payload in the **fragment**, which browsers never send to a server. It stays
 * a URL even for the codes only ever read in-app, so that a code shown by a new
 * device can *also* be scanned by the phone's own camera app and followed as a
 * link — the in-app scanner is the convenient path, never the required one.
 */
function encodeLink(p: PairPayload): string {
  const json = JSON.stringify(p);
  const code = b64url(new TextEncoder().encode(json));
  return `${new URL('link', document.baseURI).href}#${code}`;
}

/**
 * The payload half of whatever was scanned or pasted — a full link URL carries
 * it in the fragment, a hand-copied code *is* it. Exported because a caller
 * that decides to hand a code to another screen has to pass on the same part
 * this decoder reads.
 */
export function codePart(input: string): string {
  const raw = input.trim();
  return raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : raw;
}

/** Accepts a full scanned URL or just the bare code pasted by hand. */
export function decodeLink(input: string): PairPayload | null {
  const code = codePart(input);
  if (!code) return null;
  try {
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const p = JSON.parse(new TextDecoder().decode(bytes)) as PairPayload;
    return p?.v === 1 && typeof p.i === 'string' && typeof p.k === 'string' ? p : null;
  } catch {
    return null;
  }
}
