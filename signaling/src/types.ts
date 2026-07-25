/**
 * Shared runtime bindings and per-connection state.
 */

import type { Room } from './room';

export interface Env {
  /** One Durable Object instance per rendezvous shard (see the Worker entry). */
  ROOMS: DurableObjectNamespace<Room>;
}

/**
 * Metadata attached to every hibernatable WebSocket.
 *
 * A socket's subscriptions are the *only* state this server keeps, and they live
 * here rather than in a field or in SQLite: `serializeAttachment` survives
 * Durable Object hibernation, so a room can be evicted from memory between
 * messages and still relay correctly when it wakes. Kept small on purpose — the
 * attachment is capped at 2 KB, which is what `MAX_TOPICS_PER_SOCKET` bounds.
 */
export interface SocketAttachment {
  topics: string[];
}
