/**
 * Room — the topic pub/sub relay behind the signaling endpoint.
 *
 * One Durable Object holds a set of WebSockets and a per-socket topic list, and
 * forwards every `publish` to the sockets subscribed to that topic. That is the
 * whole server: y-webrtc peers do their own identity, addressing and encryption
 * inside the payloads we relay (see protocol.ts).
 *
 * Design notes (why this is cheap and correct at scale):
 *
 *  - **Hibernation.** Sockets are accepted with `ctx.acceptWebSocket()`, so the
 *    DO can be evicted from memory between messages while the connections stay
 *    open. We never keep a socket in a JS field; the *live* roster is always
 *    read back from `ctx.getWebSockets()`, which the runtime repopulates on
 *    wake. This is what lets a mostly-idle rendezvous point cost almost nothing.
 *
 *  - **No storage on the hot path.** Subscriptions live in each socket's
 *    hibernation attachment, not in SQLite, and are only rewritten when a peer
 *    (un)subscribes — never per relayed message. The `new_sqlite_classes`
 *    migration is still required to create the namespace, but the durable store
 *    stays empty and free.
 *
 *  - **Free keepalives.** `{"type":"ping"}` is auto-answered at the edge via
 *    `setWebSocketAutoResponse`, so the 15-second heartbeat every idle client
 *    sends never wakes the DO at all.
 *
 *  - **Automatic cleanup.** With no alarms and no stored state, the runtime
 *    evicts the DO once its last socket closes — there is nothing to tear down,
 *    and a socket's subscriptions die with it.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  CloseCode,
  MAX_MESSAGE_BYTES,
  MAX_TOPICS_PER_SOCKET,
  PING_FRAME,
  PONG_FRAME,
  parseClientMessage,
  type ServerMessage,
} from './protocol';
import type { Env, SocketAttachment } from './types';

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answer heartbeats from the edge without waking the DO. The frames are
    // matched byte for byte, hence the exact literals in protocol.ts.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
  }

  /** WebSocket upgrade, already routed here by the Worker entrypoint. */
  async fetch(_request: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    // A fresh socket is subscribed to nothing; the client says what it wants.
    server.serializeAttachment({ topics: [] } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /* ----------------------------- Hibernation ----------------------------- */

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // The protocol is UTF-8 JSON only; binary frames are not part of it.
    if (typeof message !== 'string') return;
    if (message.length > MAX_MESSAGE_BYTES) {
      ws.close(CloseCode.MessageTooBig, 'Message exceeds size limit');
      return;
    }

    const msg = parseClientMessage(message);
    if (!msg) return; // malformed or unknown — dropped, like the reference server

    switch (msg.type) {
      case 'subscribe':
        this.#updateTopics(ws, (topics) => {
          for (const topic of msg.topics) {
            if (topics.size >= MAX_TOPICS_PER_SOCKET) break;
            topics.add(topic);
          }
        });
        return;

      case 'unsubscribe':
        this.#updateTopics(ws, (topics) => {
          for (const topic of msg.topics) topics.delete(topic);
        });
        return;

      case 'publish':
        this.#relay(msg.topic, msg.data);
        return;

      case 'ping':
        // Normally handled by the edge auto-responder; this catches clients
        // whose ping frame isn't byte-identical to PING_FRAME.
        this.#send(ws, { type: 'pong' });
        return;
    }
  }

  /* ------------------------------- Relaying ------------------------------ */

  /**
   * Fan a publish out to every socket subscribed to `topic`.
   *
   * The sender is included, matching the reference server: y-webrtc drops
   * messages whose `from` is its own peer id, and the echo is a useful signal
   * that the room is live.
   */
  #relay(topic: string, data: unknown): void {
    const receivers = this.ctx.getWebSockets().filter((ws) => this.#topicsOf(ws).includes(topic));
    if (receivers.length === 0) return;

    const forwarded: ServerMessage = {
      type: 'publish',
      topic,
      data,
      clients: receivers.length,
    };
    for (const ws of receivers) this.#send(ws, forwarded);
  }

  /* ------------------------------- Helpers ------------------------------- */

  /** Read/modify/write a socket's subscriptions, persisting only on a change. */
  #updateTopics(ws: WebSocket, mutate: (topics: Set<string>) => void): void {
    const before = this.#topicsOf(ws);
    const topics = new Set(before);
    mutate(topics);
    if (topics.size === before.length && before.every((t) => topics.has(t))) return;
    ws.serializeAttachment({ topics: [...topics] } satisfies SocketAttachment);
  }

  #topicsOf(ws: WebSocket): string[] {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    return attachment?.topics ?? [];
  }

  /** Serialize + send, tolerating a socket that raced into a closing state. */
  #send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Peer is already gone; the runtime will drop it (and its subscriptions).
    }
  }
}
