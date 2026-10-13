# Abu Farhan Collection — a multi-user website with no server of your own

A working demo + field guide for building sites where many users interact with
each other **without running or paying for any application server**.

Open `index.html` from any static host and multiple browsers can share a live
catalog, co-edit a note and chat — all peer‑to‑peer.

```
index.html      static shell (no build step needed to change markup)
styles.css      styling
src/app.js      wiring: DOM + store + network
src/store.js    shared state as a Yjs CRDT (conflict-free, local-first)
src/net.js      peer discovery + direct WebRTC transport (Trystero)
src/ui.js       rendering
test/           unit tests for the CRDT layer + a headless DOM smoke test
bundle.js       built from src/ via `npm run build` (committed so hosting works as-is)
deploy/         copy-in GitHub Pages workflow (see "Deploy")
```

---

## 1. The short answer

You cannot remove networking. You can remove **your** server.

A server normally does three jobs. Each one has a way to be replaced by
something you don't operate:

| Job a server normally does | Serverless replacement | Used here |
| --- | --- | --- |
| **Discovery** — "who else is in this room?" | Public relay networks (Nostr relays, BitTorrent trackers, MQTT brokers, IPFS), or a managed BaaS, or nothing at all if peers exchange a link/code out-of-band | ✅ Nostr relays via Trystero |
| **Transport** — moving messages between users | WebRTC `RTCDataChannel`s: browsers connect directly to each other, encrypted with DTLS | ✅ direct P2P mesh |
| **Storage / source of truth** — one copy of the data | A CRDT replicated in every browser, merged deterministically with no coordinator, cached locally | ✅ Yjs doc + `localStorage` |

The crucial trick is #3. If your data is a CRDT, there is no "master copy" that
needs to be authoritative, so peers can merge edits from each other in any
order and still agree. Once you have that, the network only needs to deliver
copies of small binary updates — the cheapest possible thing to build.

Static hosting (GitHub Pages, Netlify, Cloudflare Pages, S3) still is a server
in the literal sense, but it serves files and executes nothing: it never sees
your users' data and costs nothing to run.

---

## 2. Run it

```bash
npm install          # trystero + yjs (+ esbuild/jsdom for dev)
npm run build        # bundles src/ into bundle.js (already committed)
npm start            # serves the folder on http://localhost:8080
```

Open the URL in **two tabs or two devices** (phone + laptop on the same Wi-Fi
works), and you get live presence, shared edits and chat. "Copy invite link"
puts the room code in the URL (`#room=xyz123`) — anyone with that link joins
the same room. There is no sign-up, no API key, no backend, no database.

Useful commands:

```bash
npm test     # 7 CRDT tests: concurrent edits, late joiners, deletes, persistence
npm run smoke  # boots the real bundle in a headless DOM and asserts the UI works
npm run dev    # rebuild the bundle on save
```

If the status badge says *relays unreachable*, open **details → relay
endpoints** and paste different Nostr relays (comma separated). Public relays
are community infrastructure: free, unauthenticated, and occasionally flaky.

---

## 3. How this demo actually works

### 3.1 Discovery without a matchmaking server — `src/net.js`

```js
const room = joinRoom(
  { appId: 'abu-farhan-collection-v1', password: `afc:${roomId}` },
  roomId
)
```

`joinRoom` (from [Trystero](https://github.com/dmotz/trystero)) publishes an
"announcement" for the room onto public **Nostr relays** and subscribes to the
same topic. Other browsers that joined the same room see the announcement and
the two sides exchange WebRTC handshakes (SDP) through the relay. After that
the relay is out of the picture: relay operators only ever saw connection
metadata, never your content. `password` additionally derives a shared key from
the room code so the payloads the peers exchange are encrypted.

Trystero can do this over Nostr, MQTT, BitTorrent trackers, IPFS, Supabase,
Firebase, or a WebSocket relay you host yourself. Switching is a one-line
import change:

```js
import { joinRoom } from 'trystero'              // Nostr (default)
import { joinRoom } from 'trystero/mqtt'         // MQTT brokers
import { joinRoom } from 'trystero/torrent'      // BitTorrent trackers
import { joinRoom } from 'trystero/supabase'     // your free Supabase project
```

### 3.2 Direct transport

The room is a **full mesh**: every browser connects to every other browser.
Sending to one peer or to all of them is the same API:

```js
const chat = room.makeAction('chat')
chat.send({ text: 'salaam' })                 // broadcast
chat.send({ text: 'psst' }, { target: peerId }) // one peer
chat.onMessage = (data, { peerId }) => render(peerId, data)
```

Trystero serializes objects, chunks large payloads, tracks progress, and offers
request/response semantics (`room.makeAction('x', { kind: 'request', ... })`),
plus `room.ping(peerId)` for round-trip latency — that is where the `ms` values
in the presence list come from.

### 3.3 Shared state without a database — `src/store.js`

All shared data is one Yjs document:

```js
const catalog = doc.getMap('catalog') // id -> Y.Map of fields
const notes = doc.getText('notes')    // collaborative text
```

Two sync rules make it work with no server:

```js
// Local edits go out to everyone…
doc.on('update', (update, origin) => {
  if (origin === REMOTE) return        // …but never echo remote edits back
  yjsUpdate.send(update)               // (the mesh already delivered them)
})

// A peer that just joined gets the whole document, merged idempotently.
room.onPeerJoin = (peerId) => {
  profile.send({ name, color }, { target: peerId })
  yjsUpdate.send(Y.encodeStateAsUpdate(doc), { target: peerId })
}
```

Why this is safe without an authority: CRDT merges are commutative and
idempotent. Order does not matter, duplicates do not matter, and two people
editing the same field cannot "overwrite" each other into a bad state — the
document is just a set of operations, and everyone replays them.

Run `npm test` to watch it happen: peers edit concurrently, converge to the
same state, and the test asserts they match.

### 3.4 Presence and chat — ephemeral by design

Names, colours, typing indicators and latency live in a plain `Map` on each
client, fed by a `profile` action and `room.ping()`. They are *not* in the CRDT
because a disconnected user should simply disappear rather than leave a
"ghost" edit in the shared history. Chat is the same: broadcast now, gone
later. (If you want history, put it in a `Y.Array` instead — the store already
shows how.)

### 3.5 Persistence

`src/store.js` debounces a base64 Yjs snapshot into `localStorage`
(`afc:v1:doc:<room>`) on every change, so a reload restores your room and a
returning peer re-seeds the group with what it remembers. Replacing that with
`y-indexeddb` is a two-line change if you outgrow 5 MB.

---

## 4. The options, and when each is the right call

| Approach | Server you run | Good for | Watch out for |
| --- | --- | --- | --- |
| **P2P + free matchmaking** (this repo) | none | chat, co-editing, small group tools, demos, privacy-first apps, hobby projects | NAT traversal failures (~10–20% of pairs), no authority, rooms must stay small |
| **CRDT + static hosting** (Yjs/Automerge + `y-indexeddb`, `y-webrtc`, `y-websocket`) | none, or a tiny relay | documents, whiteboards, offline-first apps | same NAT caveats; public `y-webrtc` signaling servers are mostly dead — use community relay URLs or your own |
| **Managed realtime** (Supabase Realtime, Firebase, Ably, Pusher, Liveblocks, PartyKit/Cloudflare Durable Objects) | none | production products with real users | still a server — someone else's; free tiers expire; vendor lock-in |
| **Public relay networks as your backend** (Nostr itself, Matrix, GUN, IPFS/OrbitDB) | none | social/messaging-style apps that fit the protocol's model | you inherit the protocol's limits and the network's moderation/abuse reality |
| **Static site + third-party APIs** (forms, comments, comments, analytics) | none | marketing/content sites with light interactivity | each widget is a dependency and a data leak |
| **Local-only** (`BroadcastChannel`, `SharedWorker`, `localStorage`) | none | multi-tab experiences on one device | not multi-user at all |

Most real products land on **managed realtime**, because it is honest about the
trade: they still need identity, persistence guarantees, notifications and
moderation. Pick P2P when being server-less is the point — privacy, cost,
decentralisation, or an offline-friendly demo.

---

## 5. What you give up (read this before shipping)

1. **Reliability is not uniform.** A minority of network pairs cannot connect
   directly (symmetric NATs, locked-down corporate networks, some mobile
   carriers). Fix it with a TURN relay, which *does* relay your bytes:
   ```js
   const room = joinRoom({
     appId: '…',
     turnConfig: [{ urls: 'turns:turn.example.com:5349', username: '…', credential: '…' }]
   }, roomId)
   ```
   Cloudflare offers a free TURN tier (1,000 GB/month); coturn is self-hostable.
   Trystero also works with plain STUN by default, which covers most home
   networks.
2. **Everyone can see everything.** Anyone with the room code can join and read
   all state. There is no server-side validation, no anti-cheat, no rate
   limiting, no way to ban a bad actor, and no hidden fields. Treat the room
   code as a capability, not a password, unless you add real cryptography.
3. **No durability guarantee.** If the last browser holding a copy clears its
   storage, the room is gone. There is no backup, no audit log, and offline
   users miss everything (no push notifications, no "unread" state).
4. **No enumeration or server-side search.** You cannot list rooms, run
   aggregations, compute analytics, or send email from the client safely.
5. **Scale is quadratic.** A mesh has n(n−1)/2 connections; browsers start
   struggling past roughly 20–30 peers in one room. Design around it: shard by
   topic/geo/team, cap room size, or elect a small number of relays.
6. **Background tabs and mobile are hostile.** Browsers throttle timers, sleep
   WebRTC connections, and iOS Safari is stricter than desktop Chrome.
7. **Your data lives in your users' browsers.** GDPR-style deletion is
   impossible to guarantee, and you cannot promise a "right to be forgotten".
8. **Nothing is crawlable or indexable.** Search engines and social previews
   see an empty shell unless you add prerendering.
9. **Third-party infrastructure is a dependency, even if you don't run it.**
   Public relays rate-limit, change policy, or shut down. Keep a relay list in
   config (this demo has one in the details panel) and never assume a specific
   relay is up.

### Reach for a server anyway when you need

payments or entitlements · authoritative game state or anti-cheat · guaranteed
delivery and ordering · push/email notifications · search and reporting ·
secrets and API keys · content moderation · compliance paperwork · more than a
handful of peers in one session.

A good hybrid that stays cheap: static site + P2P for the live interaction +
one tiny managed service (Supabase/Firebase free tier, or a Cloudflare Worker)
for identity, backups and notifications.

---

## 6. Deploy

Anything that serves static files works — no runtime, no build step required
(the bundle is committed):

* **GitHub Pages** — copy `deploy/github-pages.yml` to
  `.github/workflows/pages.yml` and enable *Settings → Pages → Source: GitHub
  Actions* once; it rebuilds the bundle, runs the tests and publishes the
  folder on every push to `main`. (It lives in `deploy/` rather than
  `.github/workflows/` only because the automation used to create this repo is
  not allowed to write workflow files — GitHub treats that folder specially.)
* **Netlify / Cloudflare Pages** — drag the folder in, or connect the repo with
  build command `npm run build` and publish directory `.`.
* **Any bucket/CDN** — upload `index.html`, `styles.css`, `bundle.js`.

Serve over **HTTPS**. WebRTC and the secure relay sockets require a secure
context; `http://localhost` is the only exception (handy for testing).

## 7. Reusing this for your own app

1. Change `APP_ID` in `src/net.js` — peers only meet others with the same id.
2. Define your data in `src/store.js` (add `Y.Map`/`Y.Array`/`Y.Text` fields,
   and a small API around them).
3. Build your UI in `src/ui.js` and wire it in `src/app.js`. Keep the render
   functions dumb: `store.onChange(...)` already re-renders on local *and*
   remote edits.
4. `npm run build`, then `npm test && npm run smoke`.

If your app outgrows P2P (many users per room, need for history), keep
`src/store.js` and swap the transport in `src/net.js` for `y-websocket` — the
CRDT document does not change, which is the whole point of building it this
way.

---

## License

MIT — demo code written for this repository.
