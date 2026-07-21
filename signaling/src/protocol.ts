/**
 * Signaling protocol: the exact shape of every message on the wire plus the
 * WebSocket close codes the server uses. Both directions are modelled as
 * discriminated unions so `switch (msg.type)` is exhaustively type-checked.
 */

import type { PeerId } from './types';

/* -------------------------------------------------------------------------- */
/* Client -> Server                                                            */
/* -------------------------------------------------------------------------- */

/** Announce presence and ask for the current roster. */
export interface JoinMessage {
  type: 'join';
}

/** WebRTC offer/answer/candidate, all addressed to a single peer. */
export interface OfferMessage {
  type: 'offer';
  target: PeerId;
  sdp: unknown;
}

export interface AnswerMessage {
  type: 'answer';
  target: PeerId;
  sdp: unknown;
}

export interface CandidateMessage {
  type: 'candidate';
  target: PeerId;
  candidate: unknown;
}

/** Graceful departure; the socket is closed right after. */
export interface LeaveMessage {
  type: 'leave';
}

export type ClientMessage =
  | JoinMessage
  | OfferMessage
  | AnswerMessage
  | CandidateMessage
  | LeaveMessage;

/** The three message types that are relayed verbatim to a single `target`. */
export type RelayMessage = OfferMessage | AnswerMessage | CandidateMessage;

/* -------------------------------------------------------------------------- */
/* Server -> Client                                                            */
/* -------------------------------------------------------------------------- */

/** Sent in reply to `join`: your assigned id + everyone already in the room. */
export interface WelcomeMessage {
  type: 'welcome';
  peerId: PeerId;
  peers: PeerId[];
}

/** Broadcast to existing peers when someone joins. */
export interface PeerJoinedMessage {
  type: 'peer-joined';
  peerId: PeerId;
}

/** Broadcast to remaining peers when someone leaves or drops. */
export interface PeerLeftMessage {
  type: 'peer-left';
  peerId: PeerId;
}

/** A relayed offer/answer/candidate, stamped with the originating peer. */
export interface RelayedMessage {
  type: 'offer' | 'answer' | 'candidate';
  from: PeerId;
  sdp?: unknown;
  candidate?: unknown;
}

export interface ErrorMessage {
  type: 'error';
  code: SignalErrorCode;
  message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | RelayedMessage
  | ErrorMessage;

/* -------------------------------------------------------------------------- */
/* Errors & close codes                                                        */
/* -------------------------------------------------------------------------- */

export type SignalErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNKNOWN_TYPE'
  | 'INVALID_TARGET'
  | 'PEER_NOT_FOUND';

/**
 * WebSocket close codes. 1000/1009 are standard; the 4xxx range is reserved by
 * the spec for application use and is what a client should branch on.
 */
export const CloseCode = {
  /** Normal, client-initiated `leave` or server shutdown. */
  Normal: 1000,
  /** A single frame exceeded {@link MAX_MESSAGE_BYTES}. */
  MessageTooBig: 1009,
  /** This peer id was taken over by a newer connection (reconnect/duplicate). */
  Replaced: 4001,
} as const;

/** Hard cap on a single inbound frame. SDP is large; ICE is small — 256 KB is
 * generous while still bounding memory and cost from abusive clients. */
export const MAX_MESSAGE_BYTES = 256 * 1024;

/* -------------------------------------------------------------------------- */
/* Parsing / validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Parse and structurally validate a raw text frame. Throws with a human-readable
 * reason on malformed JSON or an unrecognised/ill-formed message so the caller
 * can reply with a single `error` frame instead of tearing down the socket.
 */
export function parseClientMessage(raw: string): ClientMessage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('Payload is not valid JSON');
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error('Message must be a JSON object');
  }

  const type = (data as Record<string, unknown>).type;

  switch (type) {
    case 'join':
    case 'leave':
      return { type };

    case 'offer':
    case 'answer':
    case 'candidate': {
      const target = (data as Record<string, unknown>).target;
      if (typeof target !== 'string' || target.length === 0) {
        throw new Error(`"${type}" requires a non-empty string "target"`);
      }
      // Payloads (sdp/candidate) are forwarded opaquely; we do not inspect them.
      return data as ClientMessage;
    }

    default:
      throw new Error(`Unknown message type: ${JSON.stringify(type)}`);
  }
}
