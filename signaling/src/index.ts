/**
 * Worker entrypoint. Its only job is to answer health checks, validate the
 * WebSocket upgrade, and hand the request to a rendezvous Durable Object. All
 * signaling logic lives in {@link Room}.
 */

import { Room } from './room';
import type { Env } from './types';

// The runtime discovers the Durable Object class by its export name.
export { Room };

/**
 * Every connection lands on this instance unless it asks for another.
 *
 * Sharding per *chat room* is deliberately not the default: a y-webrtc client
 * opens one WebSocket per signaling URL and multiplexes every room it has joined
 * over it as topics (fleet sync and a device-pairing room at the same time, for
 * instance). Peers only meet if they land on the same Durable Object, so the
 * safe default is one shared rendezvous point with topics doing the isolation —
 * which is also all the reference server does.
 *
 * `?shard=<name>` opts into a separate instance (e.g. to split unrelated user
 * bases). It must be identical on every peer that needs to see each other.
 */
const DEFAULT_SHARD = 'y-webrtc';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      // Plain HTTP is only ever a health check — same reply as the reference
      // y-webrtc server, so an uptime probe pointed here keeps working.
      return new Response('okay', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const shard = new URL(request.url).searchParams.get('shard') || DEFAULT_SHARD;
    if (shard.length > 512) {
      return new Response('Invalid "shard" query parameter', { status: 400 });
    }

    // idFromName is deterministic: the same shard name always maps to the same
    // DO, so every peer converges on one instance worldwide.
    const stub = env.ROOMS.get(env.ROOMS.idFromName(shard));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
