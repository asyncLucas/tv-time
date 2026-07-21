/**
 * Shared runtime bindings and per-connection state.
 *
 * `PeerId` is the server-authoritative identity handed to each WebSocket the
 * moment it is accepted. It is stored on the socket via `serializeAttachment`
 * so it survives Durable Object hibernation, and is *also* registered as a
 * hibernation tag so a peer can be located with an O(1) `getWebSockets(peerId)`
 * lookup during targeted relaying.
 */

import type { Room } from './room';

export type PeerId = string;

export interface Env {
  /** One Durable Object instance per room (keyed by `idFromName(roomId)`). */
  ROOMS: DurableObjectNamespace<Room>;
}

/**
 * Metadata attached to every hibernatable WebSocket. Kept intentionally tiny —
 * the attachment is serialized on every accept and rehydrated on every wake, so
 * it must stay well under the 2 KB attachment limit.
 */
export interface PeerAttachment {
  peerId: PeerId;
}
