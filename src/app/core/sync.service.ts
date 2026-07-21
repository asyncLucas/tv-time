import { Injectable, computed, inject, signal } from '@angular/core';
import { WebrtcProvider } from 'y-webrtc';
import { DocService } from './doc.service';
import { LocalConfigService } from './local-config.service';

export type SyncStatus = 'idle' | 'connecting' | 'connected' | 'error';

/**
 * Default signaling server. The old y-webrtc defaults (signaling.yjs.dev, the
 * Heroku hosts) are dead, so we ship a currently-live community server and let
 * the user override it in Settings.
 */
export const DEFAULT_SIGNALING_URL = 'wss://y-webrtc-eu.fly.dev';

/** How long to wait for the signaling server before calling the room unreachable. */
const SIGNALING_TIMEOUT_MS = 12_000;

/**
 * Decentralized sync for a single user's own device fleet.
 *
 * Transport: y-webrtc — devices find each other through a signaling server (a
 * dumb rendezvous point that relays only the WebRTC handshake), then exchange
 * CRDT updates directly, peer-to-peer. The Y.Doc is the only thing that travels,
 * and the room is end-to-end encrypted with a passphrase only your devices know,
 * so the signaling server only ever sees opaque blobs.
 *
 * No app server, no database. Same-browser tabs also connect instantly over
 * BroadcastChannel (no signaling needed); cross-device / incognito connections
 * require the signaling server to be reachable. A JSON export/import is the
 * always-works floor beneath this.
 *
 * NOTE: browser-to-browser WebRTC fundamentally needs *some* reachable rendezvous
 * point — you can pick which one, but not "none". The default below is a public
 * server; override it in Settings, self-host a ~30-line relay, or fall back to
 * export/import for a truly zero-dependency path.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private docs = inject(DocService);
  private config = inject(LocalConfigService);
  private provider?: WebrtcProvider;

  readonly status = signal<SyncStatus>('idle');
  readonly peers = signal(0);
  readonly room = signal<string | null>(null);
  readonly connected = computed(() => this.status() === 'connected' || this.peers() > 0);

  /** The signaling server currently in use (custom override, else the default). */
  signalingUrls(): string[] {
    const custom = this.config.get<string>('signalingUrl')?.trim();
    return [custom || DEFAULT_SIGNALING_URL];
  }

  /** If the user previously enabled sync, reconnect on launch (device-local). */
  autoStart(): void {
    const room = this.config.syncRoom();
    const pass = this.config.syncPass();
    if (room && pass) this.connect(room, pass);
  }

  connect(room: string, password: string): void {
    this.disconnect();
    this.status.set('connecting');
    this.room.set(room);
    let signalingOnline = false;

    // If the signaling server never comes online, surface an error rather than
    // spinning forever. (Being online with 0 peers is fine — you're the first
    // device, waiting for another to join; that stays 'connecting'.) The timer
    // is tracked on the instance so disconnect() can cancel it — otherwise it
    // would fire later and flip an already-idle service into 'error'.
    this.failTimer = setTimeout(() => {
      if (!signalingOnline && this.peers() === 0) this.status.set('error');
    }, SIGNALING_TIMEOUT_MS);

    try {
      this.provider = new WebrtcProvider(`tvtime-${room}`, this.docs.doc, {
        signaling: this.signalingUrls(),
        password,
      });
    } catch {
      this.clearFailTimer();
      this.status.set('error');
      return;
    }

    // signaling reachability (the part that was broken with the dead servers)
    this.provider.on('status', ({ connected }: { connected: boolean }) => {
      if (connected) {
        signalingOnline = true;
        this.clearFailTimer();
      }
    });

    // real peer set: WebRTC peers (cross-device) + BroadcastChannel peers (same browser)
    this.provider.on('peers', (e: { webrtcPeers: string[]; bcPeers: string[] }) => {
      const n = (e.webrtcPeers?.length ?? 0) + (e.bcPeers?.length ?? 0);
      this.peers.set(n);
      this.status.set(n > 0 ? 'connected' : 'connecting');
    });

    // remember for next launch — device-local, never synced to peers
    this.config.set('syncRoom', room);
    this.config.set('syncPass', password);
  }

  disconnect(): void {
    this.clearFailTimer();
    this.provider?.destroy();
    this.provider = undefined;
    this.status.set('idle');
    this.peers.set(0);
    this.room.set(null);
  }

  private clearFailTimer(): void {
    clearTimeout(this.failTimer);
    this.failTimer = undefined;
  }

  forget(): void {
    this.disconnect();
    this.config.delete('syncRoom');
    this.config.delete('syncPass');
  }
}
