import { Injectable, inject, signal } from '@angular/core';
import { WebrtcProvider } from 'y-webrtc';
import { DocService } from './doc.service';

/**
 * Decentralized sync for a single user's own device fleet.
 *
 * Transport: y-webrtc — devices find each other through public signaling
 * servers, then exchange CRDT updates directly, peer-to-peer. The Y.Doc is the
 * only thing that travels, and the room is end-to-end encrypted with a
 * passphrase only your devices know, so signaling servers relay opaque blobs.
 *
 * There is no app server and no database. Two devices that open the same
 * room+passphrase converge; offline edits merge automatically on reconnect.
 * A JSON export/import (DocService) is the always-works floor beneath this.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private docs = inject(DocService);
  private provider?: WebrtcProvider;

  readonly connected = signal(false);
  readonly peers = signal(0);
  readonly room = signal<string | null>(null);

  /** Public signaling servers (no data flows through them beyond WebRTC setup). */
  private readonly signaling = [
    'wss://signaling.yjs.dev',
    'wss://y-webrtc-signaling-eu.herokuapp.com',
  ];

  /** If the user previously enabled sync, reconnect on launch. */
  autoStart(): void {
    const room = this.docs.settings.get('syncRoom');
    const pass = this.docs.settings.get('syncPass');
    if (room && pass) this.connect(room, pass);
  }

  connect(room: string, password: string): void {
    this.disconnect();
    this.provider = new WebrtcProvider(`tvtime-${room}`, this.docs.doc, {
      signaling: this.signaling,
      password,
    });
    this.room.set(room);

    this.provider.on('synced', () => this.connected.set(true));
    this.provider.awareness.on('change', () => {
      // count remote peers (exclude self)
      this.peers.set(Math.max(0, this.provider!.awareness.getStates().size - 1));
      this.connected.set((this.provider?.connected ?? false) === true);
    });
    this.connected.set(true);

    // remember for next launch
    this.docs.settings.set('syncRoom', room);
    this.docs.settings.set('syncPass', password);
  }

  disconnect(): void {
    this.provider?.destroy();
    this.provider = undefined;
    this.connected.set(false);
    this.peers.set(0);
    this.room.set(null);
  }

  forget(): void {
    this.disconnect();
    this.docs.settings.delete('syncRoom');
    this.docs.settings.delete('syncPass');
  }
}
