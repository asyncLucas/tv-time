/**
 * The y-webrtc signaling protocol: the exact shape of every message on the wire.
 *
 * This server is a drop-in replacement for `y-webrtc/bin/server.js`, so the
 * protocol is dictated by the client library, not by us. It is a dumb topic
 * pub/sub relay:
 *
 *   - a peer `subscribe`s to the topics (= room names) it cares about;
 *   - anything it `publish`es to a topic is fanned out to every socket
 *     subscribed to that topic, verbatim and opaquely.
 *
 * The relayed payloads are WebRTC offers/answers/ICE candidates, and in a
 * password-protected room they are encrypted by the client before they are
 * published — so this server never sees anything but base64 blobs. It has no
 * notion of peer identity either: y-webrtc peers mint their own ids and address
 * each other with `from`/`to` *inside* the opaque payload.
 *
 * Both directions are modelled as discriminated unions so `switch (msg.type)`
 * is exhaustively type-checked.
 */

/* -------------------------------------------------------------------------- */
/* Client -> Server                                                            */
/* -------------------------------------------------------------------------- */

/** Start receiving everything published to these topics. Idempotent. */
export interface SubscribeMessage {
  type: 'subscribe';
  topics: string[];
}

/** Stop receiving them. Unknown topics are ignored. */
export interface UnsubscribeMessage {
  type: 'unsubscribe';
  topics: string[];
}

/**
 * Fan `data` out to everyone on `topic`. `data` is whatever the client put
 * there — a signaling envelope, or a base64 string when the room is encrypted.
 * We forward it untouched.
 */
export interface PublishMessage {
  type: 'publish';
  topic: string;
  data?: unknown;
}

/** Liveness probe; answered with `pong`. See PING_FRAME below. */
export interface PingMessage {
  type: 'ping';
}

export type ClientMessage =
  | SubscribeMessage
  | UnsubscribeMessage
  | PublishMessage
  | PingMessage;

/* -------------------------------------------------------------------------- */
/* Server -> Client                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A relayed publish. The original message is echoed back with `clients` — the
 * number of sockets subscribed to the topic — added by the server, matching the
 * reference implementation.
 */
export interface RelayedPublish extends PublishMessage {
  clients: number;
}

export interface PongMessage {
  type: 'pong';
}

export type ServerMessage = RelayedPublish | PongMessage;

/* -------------------------------------------------------------------------- */
/* Framing limits & keepalive                                                  */
/* -------------------------------------------------------------------------- */

/** Hard cap on a single inbound frame. SDP is large; ICE is small — 256 KB is
 * generous while still bounding memory and cost from abusive clients. */
export const MAX_MESSAGE_BYTES = 256 * 1024;

/** Per-socket subscription caps. The topic list lives in the socket's
 * hibernation attachment, which the runtime limits to 2 KB, so it must stay
 * small. A device subscribes to its fleet room plus (briefly) a pairing room —
 * these ceilings are orders of magnitude above real usage. */
export const MAX_TOPICS_PER_SOCKET = 32;
export const MAX_TOPIC_LENGTH = 128;

/**
 * Exact keepalive frames. lib0's websocket client (which y-webrtc uses) sends
 * `JSON.stringify({ type: 'ping' })` and treats any `{ type: 'pong' }` as proof
 * the link is alive; without one within `messageReconnectTimeout` it tears the
 * socket down and reconnects.
 *
 * These two literals are handed to `setWebSocketAutoResponse`, which matches the
 * request *byte for byte* and answers at the edge without waking the Durable
 * Object — so keepalives are free. {@link parseClientMessage} still handles
 * `ping` as a fallback for any client that spells the frame differently.
 */
export const PING_FRAME = '{"type":"ping"}';
export const PONG_FRAME = '{"type":"pong"}';

/** WebSocket close codes. 1000 is standard; 1009 is "message too big". */
export const CloseCode = {
  Normal: 1000,
  MessageTooBig: 1009,
} as const;

/* -------------------------------------------------------------------------- */
/* Parsing / validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Parse a raw text frame into a known message, or return `null`.
 *
 * Unparseable and unknown frames are dropped silently rather than answered with
 * an error, exactly like the reference server: the protocol has no error frame,
 * and inventing one would confuse a client that already ignores what it doesn't
 * recognise.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;

  const msg = data as Record<string, unknown>;
  switch (msg['type']) {
    case 'subscribe':
    case 'unsubscribe':
      return { type: msg['type'], topics: sanitizeTopics(msg['topics']) };

    case 'publish':
      // A publish without a usable topic has nowhere to go; drop it.
      return isUsableTopic(msg['topic'])
        ? { type: 'publish', topic: msg['topic'], data: msg['data'] }
        : null;

    case 'ping':
      return { type: 'ping' };

    default:
      return null;
  }
}

/** Keep only well-formed, deduplicated topic names, bounded by the caps above. */
function sanitizeTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const topics = new Set<string>();
  for (const topic of value) {
    if (isUsableTopic(topic)) topics.add(topic);
    if (topics.size >= MAX_TOPICS_PER_SOCKET) break;
  }
  return [...topics];
}

function isUsableTopic(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOPIC_LENGTH;
}
