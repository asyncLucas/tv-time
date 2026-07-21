/**
 * Worker entrypoint. Its only job is to validate the WebSocket upgrade, read the
 * room id, and hand the request to that room's Durable Object. All signaling
 * logic lives in {@link Room}.
 */

import { Room } from './room';
import type { Env } from './types';

// The runtime discovers the Durable Object class by its export name.
export { Room };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade request', { status: 426 });
    }

    const url = new URL(request.url);
    const roomId = url.searchParams.get('room');
    if (!roomId || roomId.length > 512) {
      return new Response('Missing or invalid "room" query parameter', { status: 400 });
    }

    // idFromName is deterministic: the same room id always maps to the same DO,
    // so every peer with `?room=<id>` converges on one instance worldwide.
    const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
