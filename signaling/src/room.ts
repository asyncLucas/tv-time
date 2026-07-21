/**
 * Room — one Durable Object per room id.
 *
 * Design notes (why this is cheap and correct at scale):
 *
 *  - **Hibernation.** Sockets are accepted with `ctx.acceptWebSocket()`, so the
 *    DO can be evicted from memory between messages while the connections stay
 *    open. We never keep a socket in a JS field; the *live* roster is always
 *    read back from `ctx.getWebSockets()`, which the runtime repopulates on
 *    wake. This is what lets thousands of mostly-idle rooms cost almost nothing.
 *
 *  - **No storage on the hot path.** Peer identity lives in each socket's
 *    hibernation attachment, not in SQLite. We therefore issue zero storage
 *    writes per message. The `new_sqlite_classes` migration is still required to
 *    create the namespace, but the durable store stays empty and free.
 *
 *  - **O(1) targeted relay.** Each socket is tagged with its own peer id, so a
 *    directed offer/answer/candidate resolves the recipient with
 *    `ctx.getWebSockets(target)` rather than scanning the room.
 *
 *  - **Automatic cleanup.** With no alarms and no stored state, the runtime
 *    evicts the DO once its last socket closes — there is nothing to tear down.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  CloseCode,
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  type RelayMessage,
  type ServerMessage,
  type SignalErrorCode,
} from './protocol';
import type { Env, PeerAttachment, PeerId } from './types';

export class Room extends DurableObject<Env> {
  /**
   * Guards against announcing the same departure twice when the runtime fires
   * both `webSocketError` and `webSocketClose` for one socket. Only meaningful
   * within a single wake cycle, which is exactly the window in which both events
   * for a given socket are delivered — so an in-memory set is sufficient.
   */
  #announced = new Set<PeerId>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answer bare "ping" frames from the edge without waking the DO. Keepalives
    // are then effectively free instead of billing a wall-clock request each.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** WebSocket upgrade, already routed to this room by the Worker entrypoint. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const peerId = this.#resolvePeerId(url.searchParams.get('peer'));

    // Reconnect / duplicate-id handling: if this id is somehow already live,
    // evict the stale socket so the newest connection wins.
    for (const stale of this.ctx.getWebSockets(peerId)) {
      this.#announced.add(peerId); // suppress a spurious peer-left for the takeover
      stale.close(CloseCode.Replaced, 'Replaced by a newer connection');
    }
    this.#announced.delete(peerId);

    const { 0: client, 1: server } = new WebSocketPair();
    // Tag = peerId → enables getWebSockets(peerId) targeted lookups.
    this.ctx.acceptWebSocket(server, [peerId]);
    server.serializeAttachment({ peerId } satisfies PeerAttachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ----------------------------- Hibernation ----------------------------- */

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const self = this.#peerIdOf(ws);

    if (typeof message !== 'string') {
      this.#sendError(ws, 'INVALID_MESSAGE', 'Only UTF-8 JSON text frames are supported');
      return;
    }
    if (message.length > MAX_MESSAGE_BYTES) {
      ws.close(CloseCode.MessageTooBig, 'Message exceeds size limit');
      return;
    }

    let msg;
    try {
      msg = parseClientMessage(message);
    } catch (err) {
      this.#sendError(ws, 'INVALID_MESSAGE', (err as Error).message);
      return;
    }

    switch (msg.type) {
      case 'join':
        this.#handleJoin(ws, self);
        return;
      case 'offer':
      case 'answer':
      case 'candidate':
        this.#relay(ws, self, msg);
        return;
      case 'leave':
        // Announce now; the imminent close event would otherwise be the trigger.
        this.#announceLeft(self, ws);
        ws.close(CloseCode.Normal, 'Client left');
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // Fires for graceful closes *and* abrupt drops — the single source of truth
    // for "this peer is gone". Idempotent via #announced.
    this.#announceLeft(this.#peerIdOf(ws), ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // A transport error means the socket is dead; webSocketClose may not follow.
    this.#announceLeft(this.#peerIdOf(ws), ws);
  }

  /* ------------------------------ Handlers ------------------------------- */

  #handleJoin(ws: WebSocket, self: PeerId): void {
    const peers: PeerId[] = [];
    for (const other of this.ctx.getWebSockets()) {
      const id = this.#peerIdOf(other);
      if (id && id !== self) peers.push(id);
    }

    this.#send(ws, { type: 'welcome', peerId: self, peers });
    this.#broadcast({ type: 'peer-joined', peerId: self }, self);
  }

  #relay(sender: WebSocket, self: PeerId, msg: RelayMessage): void {
    if (msg.target === self) {
      this.#sendError(sender, 'INVALID_TARGET', 'Cannot signal yourself');
      return;
    }

    const [target] = this.ctx.getWebSockets(msg.target);
    if (!target) {
      this.#sendError(sender, 'PEER_NOT_FOUND', `No peer with id ${msg.target}`);
      return;
    }

    // Re-stamp with the trusted sender id; strip the client-supplied target.
    const forwarded: ServerMessage =
      msg.type === 'candidate'
        ? { type: 'candidate', from: self, candidate: msg.candidate }
        : { type: msg.type, from: self, sdp: msg.sdp };

    this.#send(target, forwarded);
  }

  #announceLeft(peerId: PeerId, exclude: WebSocket): void {
    if (!peerId || this.#announced.has(peerId)) return;
    this.#announced.add(peerId);
    this.#broadcast({ type: 'peer-left', peerId }, peerId, exclude);
  }

  /* ------------------------------- Helpers ------------------------------- */

  /** Fresh random id, or a caller-supplied one for reconnect/identity resume. */
  #resolvePeerId(requested: string | null): PeerId {
    if (requested && requested.length > 0 && requested.length <= 128) return requested;
    return crypto.randomUUID();
  }

  #peerIdOf(ws: WebSocket): PeerId {
    const attachment = ws.deserializeAttachment() as PeerAttachment | null;
    return attachment?.peerId ?? '';
  }

  /** Send to everyone except the origin peer (matched by id and by socket). */
  #broadcast(message: ServerMessage, exceptId: PeerId, exceptSocket?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exceptSocket) continue;
      if (this.#peerIdOf(ws) === exceptId) continue;
      this.#send(ws, message);
    }
  }

  #sendError(ws: WebSocket, code: SignalErrorCode, message: string): void {
    this.#send(ws, { type: 'error', code, message });
  }

  /** Serialize + send, tolerating a socket that raced into a closing state. */
  #send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Peer is already gone; its close/error handler will reconcile the roster.
    }
  }
}
