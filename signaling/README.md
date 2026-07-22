# tv-time — WebRTC signaling (Cloudflare Workers + Durable Objects)

The rendezvous point the app's peer-to-peer sync needs. A Worker upgrades
WebSockets and hands them to a **Durable Object** (`Room`) that relays messages
between peers subscribed to the same topic. Sockets use the **WebSocket
Hibernation API**, so idle rooms cost effectively nothing while staying open.

It speaks the **y-webrtc signaling protocol** — it is a drop-in replacement for
`y-webrtc/bin/server.js`, which is what makes it usable from the app without a
custom client. Deployed at `wss://tv-time.lucasluizss.workers.dev` and wired in
as `DEFAULT_SIGNALING_URL` in `src/app/core/sync.service.ts`.

```
src/
  index.ts      Worker entrypoint — health check, validate upgrade, route to the DO
  room.ts       Room Durable Object — topic pub/sub relay, hibernation lifecycle
  protocol.ts   Wire protocol (typed unions), validation, framing limits
  types.ts      Env bindings + per-socket attachment
```

## How it stays cheap

- **Hibernation, not memory.** Sockets are accepted with `ctx.acceptWebSocket()`
  and the live roster is always read from `ctx.getWebSockets()` — never held in a
  field — so the DO can be evicted between messages.
- **No storage writes on the hot path.** A socket's topic list rides in its
  hibernation attachment, rewritten only on (un)subscribe; SQLite stays empty.
  `new_sqlite_classes` is only there because a new DO namespace requires it (and
  it's the cheaper tier).
- **Free keepalives.** Every idle client sends `{"type":"ping"}` twice a minute;
  it is auto-answered with `{"type":"pong"}` at the edge via
  `setWebSocketAutoResponse`, without ever waking the DO.
- **Auto-cleanup.** No alarms + no stored state ⇒ the runtime evicts a room once
  its last socket closes, and a socket's subscriptions die with it.

## Protocol

A dumb topic pub/sub relay. The server has no notion of peer identity: y-webrtc
peers mint their own ids and address each other with `from`/`to` *inside* the
payload, which in a password-protected room is encrypted before it is published.
The server only ever sees base64 blobs.

**Client → server**

```jsonc
{ "type": "subscribe",   "topics": ["<room>", ...] }  // start receiving these topics
{ "type": "unsubscribe", "topics": ["<room>", ...] }  // stop
{ "type": "publish",     "topic": "<room>", "data": ... } // fan out to that topic
{ "type": "ping" }                                     // keepalive
```

**Server → client**

```jsonc
{ "type": "publish", "topic": "<room>", "data": ..., "clients": 2 } // relayed verbatim
{ "type": "pong" }
```

A publish goes to **every** socket subscribed to the topic, the sender included
(y-webrtc filters its own messages by `from`); `clients` is the current
subscriber count. Malformed or unknown frames are dropped silently — the
protocol has no error frame. A frame over 256 KB closes the socket with 1009.

Per-socket caps: 32 topics, 128 chars each — the topic list lives in the 2 KB
hibernation attachment. Real usage is a fleet room plus, briefly, a pairing room.

## Routing

Every connection lands on one shared Durable Object by default. Sharding per
*chat room* would be wrong: a y-webrtc client opens **one** WebSocket per
signaling URL and multiplexes all its rooms over it as topics, and peers only
meet if they land on the same DO. Topics do the isolation.

`?shard=<name>` selects a different instance (e.g. to split unrelated user
bases). Every peer that needs to see each other must use the same value.

Plain HTTP (no upgrade) returns `200 okay`, matching the reference server, so an
uptime probe pointed at the URL works.

## Frontend usage

Nothing custom — point y-webrtc at it:

```js
new WebrtcProvider(roomName, doc, {
  signaling: ['wss://tv-time.lucasluizss.workers.dev'],
  password: 'a passphrase only your devices know',
});
```

## Develop & deploy

```bash
npm install
npm run dev        # wrangler dev — ws://127.0.0.1:8787
npm run typecheck  # tsc --noEmit
npm run deploy     # wrangler deploy → https://tv-time.lucasluizss.workers.dev/
```

The `v1` migration created the `Room` DO namespace on the first deploy; the class
name is unchanged, so later deploys need no new migration. Run `wrangler login`
once if you haven't authenticated this machine.
