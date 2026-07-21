# tv-time — WebRTC signaling (Cloudflare Workers + Durable Objects)

Zero-backend WebRTC signaling. A Worker upgrades WebSockets and routes each
`?room=<id>` to its own **Durable Object** (`Room`). Sockets use the
**WebSocket Hibernation API**, so idle rooms cost effectively nothing while
staying open — the design scales to thousands of concurrent rooms.

```
src/
  index.ts      Worker entrypoint — validate upgrade, route to the room's DO
  room.ts       Room Durable Object — connections, relay, hibernation lifecycle
  protocol.ts   Wire protocol (typed unions), validation, close codes
  types.ts      Env bindings + per-socket attachment
```

## How it stays cheap

- **Hibernation, not memory.** Sockets are accepted with `ctx.acceptWebSocket()`
  and the live roster is always read from `ctx.getWebSockets()` — never held in a
  field — so the DO can be evicted between messages.
- **No storage writes on the hot path.** Peer identity rides in each socket's
  hibernation attachment; SQLite stays empty. `new_sqlite_classes` is only there
  because a new DO namespace requires it (and it's the cheaper tier).
- **Free keepalives.** `ping` text frames are auto-answered with `pong` at the
  edge via `setWebSocketAutoResponse`, without waking the DO.
- **Auto-cleanup.** No alarms + no stored state ⇒ the runtime evicts a room once
  its last socket closes. Nothing to tear down.

## Protocol

**Client → server**

```jsonc
{ "type": "join" }                                        // ask for your id + roster
{ "type": "offer",     "target": "<peerId>", "sdp": ... } // relayed to `target` only
{ "type": "answer",    "target": "<peerId>", "sdp": ... }
{ "type": "candidate", "target": "<peerId>", "candidate": ... }
{ "type": "leave" }                                       // graceful exit
```

**Server → client**

```jsonc
{ "type": "welcome",     "peerId": "<you>", "peers": ["<peerId>", ...] } // reply to join
{ "type": "peer-joined", "peerId": "<peerId>" }                          // broadcast
{ "type": "peer-left",   "peerId": "<peerId>" }                          // broadcast
{ "type": "offer",       "from": "<peerId>", "sdp": ... }                // relayed
{ "type": "answer",      "from": "<peerId>", "sdp": ... }
{ "type": "candidate",   "from": "<peerId>", "candidate": ... }
{ "type": "error",       "code": "...", "message": "..." }               // non-fatal
```

The server is authoritative over identity: it stamps every relayed frame with a
trusted `from` and strips the client-supplied `target`.

### Close codes

| Code | Meaning                                                        |
| ---- | ------------------------------------------------------------- |
| 1000 | Normal — client sent `leave`.                                 |
| 1009 | Frame exceeded 256 KB.                                         |
| 4001 | `Replaced` — this peer id was taken over by a newer socket.   |

Invalid JSON or an unknown `target` produces an `error` frame — the socket is
**not** closed.

## Frontend usage

```js
// Connect. Add &peer=<yourOldId> to resume an identity after a reconnect.
const socket = new WebSocket('wss://tv-time.lucasluizss.workers.dev/?room=ROOM_ID');

let myId = null;
const peers = new Set();

socket.addEventListener('open', () => {
  socket.send(JSON.stringify({ type: 'join' }));
});

socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'welcome':
      myId = msg.peerId;
      msg.peers.forEach((id) => peers.add(id)); // start a PeerConnection to each
      break;
    case 'peer-joined': peers.add(msg.peerId); break;
    case 'peer-left':   peers.delete(msg.peerId); /* tear down that PeerConnection */ break;
    case 'offer':     /* pc.setRemoteDescription(msg.sdp); then send an answer */ break;
    case 'answer':    /* pc.setRemoteDescription(msg.sdp) */ break;
    case 'candidate': /* pc.addIceCandidate(msg.candidate) */ break;
    case 'error':     console.warn('signal error', msg.code, msg.message); break;
  }
});

// Send an offer to a specific peer
socket.send(JSON.stringify({ type: 'offer', target: peerId, sdp: pc.localDescription }));

// Send an answer
socket.send(JSON.stringify({ type: 'answer', target: peerId, sdp: pc.localDescription }));

// Send an ICE candidate (from pc.onicecandidate)
socket.send(JSON.stringify({ type: 'candidate', target: peerId, candidate: event.candidate }));

// Leave the room
socket.send(JSON.stringify({ type: 'leave' }));

// Optional cheap keepalive (auto-answered at the edge, never wakes the DO)
setInterval(() => socket.readyState === WebSocket.OPEN && socket.send('ping'), 30_000);
```

## Develop & deploy

```bash
npm install
npm run dev        # wrangler dev — ws://127.0.0.1:8787/?room=test
npm run typecheck  # tsc --noEmit
npm run deploy     # wrangler deploy → https://tv-time.lucasluizss.workers.dev/
```

First deploy applies the `v1` migration that creates the `Room` DO namespace.
Run `wrangler login` once if you haven't authenticated this machine.
