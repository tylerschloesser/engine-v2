# Research: state sync and networking

Phase 1 research for `docs/spec/sync.md`. Evidence and recommendations, not decisions. All URLs accessed 2026-09-19. Page content was read through a summarizing fetch tool, so treat quoted numbers as "what the page said today" and re-check before relying on any single figure. Items marked *(from memory)* were not re-verified today.

Spec correction applied: the camera is **not** an action. Camera + viewport are an unlogged subscription message (section 3.4). Player position options (a) presence and (b) movement action are covered in 3.9.

Assumptions borrowed from sibling research (not decided here): 32x32-tile chunks, 4-byte tiles, clients regenerate pristine terrain from the seed so the server sends only overlays + entities (`docs/research/world.md` 3.2), fixed-point positions in 1/256 tile (`docs/research/reference-game.md`).

---

## 1. Findings

### 1.1 WebTransport: browsers

- **Safari 26.4 (released 2026-03-24) ships WebTransport** on macOS, iOS, and iPadOS: bidirectional streams and datagrams over HTTP/3, with an HTTP/2 fallback when QUIC is unavailable. https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
- caniuse: Chrome 97+, Edge 98+, Firefox 114+, Safari/iOS Safari 26.4+, Samsung Internet 18+; global support 91.3%. https://caniuse.com/webtransport
- MDN: "Baseline, newly available since March 2026"; secure contexts only; available in Web Workers. https://developer.mozilla.org/en-US/docs/Web/API/WebTransport
- Safari 26.3 and earlier do not expose `WebTransport`, so iPhones stuck below iOS 26.4 need a WebSocket path regardless. Note that the engine requires WebGPU, which already restricts iOS to recent Safari (verify the exact floor in client research); the *browser* gap for WebTransport is therefore narrow. The blocker is the server side.

### 1.2 WebTransport: servers

| Runtime / host | Status today | Source |
|---|---|---|
| Node.js (v26.9 docs) | No WebTransport. `node:quic` exists behind `--experimental-quic`, Stability 1.0 "early development". Third-party native addon `@fails-components/webtransport` (libquiche), actively published | https://nodejs.org/api/globals.html , https://www.npmjs.com/package/@fails-components/webtransport |
| Bun | Experimental HTTP/3 in `Bun.serve` since v1.3.14 (May 2026); **no WebTransport** in core (open issue #13656). Community napi-rs addons exist | https://github.com/oven-sh/bun/issues/13656 , https://bun.com/docs/runtime/http/server |
| Deno | `Deno.QuicEndpoint` + `Deno.upgradeWebTransport` exist but are **unstable**; open 2026 bugs about stream FIN/RESET and sessions stalling after 100 streams | https://docs.deno.com/api/deno/~/Deno.upgradeWebTransport , https://github.com/denoland/deno/issues/36822 |
| Cloudflare Workers / Durable Objects | **No WebTransport** found in docs or changelog. WebSockets only (plus inbound TCP via Spectrum) | https://developers.cloudflare.com/durable-objects/best-practices/websockets/ |
| Vercel | None; WebSockets only, and only just (1.4) | https://vercel.com/docs/functions/websockets |
| Rust crates | `wtransport` 0.7.1 (updated ~July 2026), `web-transport-quinn` (updated 2026-04); `webtransport-quinn` deprecated | https://docs.rs/wtransport/latest/wtransport/ , https://lib.rs/crates/web-transport-quinn |
| Fly.io (if self-hosting QUIC) | UDP needs a **dedicated IPv4 ($2/mo)** and binding to the special `fly-global-services` address; no UDP over shared IPv4 or IPv6. The process must terminate TLS/QUIC itself | https://fly.io/docs/networking/udp-and-tcp/ , https://fly.io/docs/about/pricing/ |

Conclusion: no JS server runtime has a stable built-in WebTransport server, the most attractive edge host has none, and every workable option needs a native addon or a native Rust server plus UDP ingress and in-process certificates. That conflicts with "zero runtime npm dependencies" and with host-agnosticism.

### 1.3 WebSocket servers per runtime

- **Node.js: still no built-in WebSocket server.** The v26.9 docs describe only the browser-compatible client (`WebSocket` global, stable since v22.4). A server needs `ws` or a hand-rolled RFC 6455 upgrade on `node:http`'s `'upgrade'` event. https://nodejs.org/api/globals.html , https://nodejs.org/learn/getting-started/websocket
- **Bun:** built in (`Bun.serve({ websocket })`, `server.upgrade(req)`), exposes backpressure (`send()` returns `-1`, `drain` handler). https://bun.com/docs/runtime/http/server
- **Deno:** built in (`Deno.serve` + `Deno.upgradeWebSocket`), stable. https://docs.deno.com/examples/http_server_websocket/
- **workerd / Durable Objects:** `WebSocketPair` with two APIs. The *standard* API (`accept()`) keeps the object in memory and billed while connected. The *Hibernation* API lets the object be evicted while sockets stay open, but **in-memory state is discarded on hibernation**, per-socket attachment is capped at 16,384 bytes, and **any pending `setTimeout`/`setInterval` prevents hibernation**. A ticking sim therefore uses the standard API while players are connected; hibernation only matters for a paused world. Received messages are capped at 32 MiB. https://developers.cloudflare.com/durable-objects/best-practices/websockets/ , https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ , https://developers.cloudflare.com/durable-objects/platform/limits/

### 1.4 Hosting a long-lived, stateful, in-memory world

| Host | Fits the model? | Limits that matter | Rough hobby cost |
|---|---|---|---|
| **Plain VM / container** running Node, Bun, or Deno | Yes, fully | None beyond the box | Lightsail $5/mo with IPv4 ($3.50 IPv6-only, 512 MB); comparable small VPSes elsewhere. https://cloudburn.io/blog/amazon-lightsail-pricing (secondary source) |
| **Fly.io Machines** | Yes | `shared-cpu-1x`: 256 MB $2.02/mo, 512 MB $3.32/mo, 1 GB $5.92/mo always-on (Amsterdam prices); volumes $0.15/GB-mo; egress $0.02/GB NA/EU; stopped machines bill only rootfs ($0.15/GB-mo). Autostop/autostart stops idle machines and starts them on an incoming request; the docs I read do not state whether an open WebSocket counts as activity, so the safe pattern is for the server to exit itself when the world is idle and let autostart wake it | ~$2-6/mo always-on; near $0 when stopped. https://fly.io/docs/about/pricing/ , https://fly.io/docs/launch/autostop-autostart/ |
| **Cloudflare Durable Objects** | Yes, with a hard memory ceiling | **128 MB per isolate "including the JavaScript heap and WebAssembly allocations"**; script bundle 64 MiB uncompressed (WASM counts); CPU per invocation 30 s default, configurable to 5 min; **Free plan CPU is 10 ms per request**; startup must finish in 1 s; objects restart on every code deploy and on runtime updates; a non-hibernatable idle object is evicted after 70-140 s. WASM is supported. Routing a world id to one object (`idFromName`) is free and global | Duration is billed at 128 MB regardless of use: an active world = 0.128 x 3600 = **461 GB-s/hour**. Free plan: 13,000 GB-s/day and 100,000 requests/day. Paid ($5/mo Workers plan): 400,000 GB-s/mo (= ~868 world-hours, more than a month 24/7) then $12.50/M GB-s; 1 M requests then $0.15/M; **incoming WebSocket messages bill 20:1** (8 players x 10 msg/s = 14,400 requests/hour = $0.002/hour). Realistically: **$5/mo flat** (the free plan's 10 ms CPU cap is too tight for a tick). https://developers.cloudflare.com/workers/platform/limits/ , https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| **Cloudflare Containers** | Yes (a VM-like escape hatch behind a DO) | Instance types from `lite` (1/16 vCPU, 256 MiB) to `standard-4` (4 vCPU, 12 GiB); billed per 10 ms while running; sleeps after a timeout; WebSockets pass through | Memory $0.0000025/GiB-s, CPU $0.000020/vCPU-s, with included usage on the $5 plan. https://developers.cloudflare.com/containers/pricing/ |
| **AWS** | Only as a VM/container (EC2, Lightsail, ECS/Fargate) | Fargate needs a load balancer or public IP plumbing for a stable `wss://` endpoint, which dominates hobby cost. **API Gateway WebSocket APIs do not fit**: per-message Lambda invocations with no shared memory, 2 h max connection, 10 min idle timeout | Lightsail $5/mo. Fargate small task roughly $9-18/mo by my arithmetic from list prices, before any load balancer (verify). https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html , https://aws.amazon.com/fargate/pricing/ |
| **Vercel Functions** | **No** | WebSockets entered **public beta on 2026-06-22** (Fluid compute; Node, Bun, Python). But the connection dies at the function's max duration (**Hobby 300 s; Pro/Enterprise 800 s, 1800 s extended beta**), and "new WebSocket connections are **not guaranteed to reach the same Vercel Function instance**"; the docs tell you to keep rooms and state in an external store such as Redis. A world whose 2-8 players must share one in-memory sim cannot be built on that | Fine for hosting the *client* (static assets + headers) and a tiny directory API. https://vercel.com/docs/functions/websockets , https://vercel.com/docs/functions/limitations , https://vercel.com/changelog/websocket-support-is-now-in-public-beta |
| **Deno Deploy** | No | Isolates may be shut down "even if the application is actively receiving traffic" (scale-down, resource pressure, infra updates); no single-instance guarantee | https://docs.deno.com/deploy/reference/runtime/ |

### 1.5 Mobile networks: what to budget against

Verified today:
- Opensignal Q4 2025 (UK, via a secondary summary): 4G latency ~55-58 ms, 5G ~35-42 ms; 5G at off-peak ~28-32 ms, at peak hours 45-60 ms with more variance. https://spenza.com/telecom/5g-vs-4g-speed-comparison/
- Ookla H2 2025 (US): best median 5G latency 44 ms (T-Mobile). https://www.rcrwireless.com/20260203/5g/ookla
- These are RTTs to nearby test servers. A single-region game server adds distance: budget +20-80 ms within a continent.
- Opensignal's Games Experience metric is built from UDP latency, jitter, and loss, but the thresholds were not in anything I could fetch. https://insights.opensignal.com/2023/01/27/understanding-mobile-network-experience-what-do-opensignals-metrics-mean
- iOS suspends a backgrounded Safari tab or PWA within seconds and its sockets die; WebSockets are not among the connection types allowed for suspended apps. There is also a 2025-26 report of sockets being closed ~1 s after connect in an iPadOS 26 PWA on a local network. https://developer.apple.com/forums/thread/716118 , https://developer.apple.com/forums/thread/811063 , https://github.com/socketio/socket.io/issues/2924

Engineering budget (my assumption for "decent, not great 5G"; jitter/loss/stall figures are *from memory*, not from a current primary source):

| Quantity | Budget |
|---|---|
| RTT to server | median 60-100 ms, p95 200 ms, p99 400 ms |
| Jitter | 10-30 ms typical, spikes over 100 ms |
| Loss | 0.5-2%, bursty |
| Stalls (handover, radio state change) | 0.3-3 s, a few per hour |
| Disconnects | every app switch / screen lock on iOS; frequent on Android |
| Usable downlink / uplink | at least 5 Mbps / 1 Mbps, but we should use under 10% of that |

TCP head-of-line blocking, sized: at 1% loss and ~20 packets/s, expect one loss-induced stall about every 5 s, each costing roughly 1-2 RTT (60-200 ms) with modern loss recovery (RACK/TLP, *from memory*). An adaptive interpolation buffer absorbs most of these; multi-second radio stalls hurt equally on QUIC.

---

## 2. Prior art and what to take from it

| Source | What it does | Take | Leave |
|---|---|---|---|
| **Factorio** FFF-83, FFF-302. https://www.factorio.com/blog/post/fff-83 , https://www.factorio.com/blog/post/fff-302 | Deterministic lockstep at 60 UPS. "Latency state": each tick, apply confirmed actions to the game state, drop confirmed actions from the local queue, **reset the latency state to the game state, re-apply the still-pending local actions**, render the combination. Hidden: movement, building, mining, GUI. **Not hidden: combat and vehicles**, because they cascade. Server skips a slow client's input rather than stalling everyone | The reset-and-replay overlay is exactly our prediction model (3.7). Opt-out for cascading actions. FFF-302's megapacket bug came from **order-dependent relative encodings in the input stream**: keep actions absolute and self-contained | Lockstep itself: every client holds the whole world, joining means downloading the map, the slowest client paces everyone. We keep determinism for replay and prediction only |
| **Gambetta**. https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html | Per-input sequence numbers; server echoes last processed sequence; client re-applies unacked inputs on top of each authoritative state; remote entities rendered in the past | The ack-and-replay loop, verbatim. Sequence numbers per player, monotonic across reconnects | Nothing |
| **Fiedler**, snapshot interpolation and compression. https://gafferongames.com/post/snapshot_interpolation/ , https://gafferongames.com/post/snapshot_compression/ | Interpolation delay of ~3x the send interval tolerates 2-5% loss over UDP (350 ms at 10 Hz; 150 ms at 30 Hz; 85 ms at 60 Hz). Hermite interpolation with velocity removes artifacts at low rates. Extrapolation mispredicts. Quantize, delta against an acked baseline, index-encode changes: 17 Mbps down to 256 kbps | Hermite with velocity for anything that moves (presence). Quantization and bounded fields. Buffer sized from send interval + measured jitter. Priority ordering under a byte budget (his state-synchronization article, *from memory*) for chunk streaming | Acked baselines: they exist to survive UDP loss; on a reliable ordered stream the baseline is implicit (3.3) |
| **Quake 3**. https://fabiensanglard.net/quake3/network.php | Delta each snapshot against the last one the client acked; 32-snapshot history per client; if the baseline is too old, delta against an all-zero dummy state, which *is* a full snapshot | "Full state is just a delta from nothing": one encoder for chunk snapshots and updates. "Baseline too old, resend full" is our reconnect and backlog-overflow rule | Per-client snapshot history |
| **Overwatch**, GDC 2017. https://www.gdcvault.com/play/1024001/-Overwatch-Gameplay-Architecture-and , summary https://edgegap.com/blog/game-backend-deep-dive-overwatch-2016-netcode-architecture-rollback | Fixed 16 ms command frames; client runs ahead of the server by RTT/2 + one buffered frame; server input buffer, with the server telling a starving client to dilate time; rollback and replay on misprediction; **predict by default, opt out** | Predict-by-default. The ack and the state it produced arrive together. This is also the bill for tick-aligned *continuous* input: run-ahead clock, server input jitter buffer, time dilation. That cost is the core argument in 3.9 | All of the run-ahead machinery, unless option (b) is chosen |
| **lightyear** 0.30 (Bevy 0.19). https://github.com/cBournhonesque/lightyear | Prediction with rollback, snapshot interpolation, input delay, bandwidth cap with **priority-based send queue**, transports incl. WebSocket and WebTransport, WASM client; now delegates replication/visibility to bevy_replicon | Visual correction (decay the error instead of snapping), priority accumulation under a byte cap, optional input delay | ECS coupling; whole-world rollback |
| **bevy_replicon** 0.41-0.44. https://github.com/projectharmonia/bevy_replicon | Server-authoritative replication with **no built-in I/O** (five third-party transports plug in), per-client visibility, prediction/interpolation deliberately out of scope | **The transport-injection boundary** is the right shape for our host-agnostic server. Splitting "entity appeared" (reliable) from "value changed" (superseding) maps to our message classes | Engine-side reflection/diffing of components |
| **naia** ~0.24. https://github.com/naia-lib/naia | Rooms (coarse) + per-user scope (fine) for interest management; field-level diffs; `TickBuffered` channel delivers inputs at a matching server tick; WebRTC for browsers | Two-tier scope = our subscription ring + relevance rule. Entering scope sends full entity state; leaving sends a despawn | WebRTC data channels (signaling + STUN/TURN complexity for a client-server game) |
| **Colyseus**. https://docs.colyseus.io/room , https://github.com/colyseus/schema | Schema-driven incremental binary patches; default **patch rate 50 ms (20 Hz)**; `StateView` filters per client; `allowReconnection` holds a seat for N seconds against a reconnection token | 20 Hz as a sane default; seat-holding grace period; per-client filtered views | Reflection-based change tracking in JS; token regenerated per connection (ours must survive page reloads) |
| **SpacetimeDB** 2.8.x. https://spacetimedb.com/docs/clients/subscriptions/ | Deterministic WASM reducers inside a database; clients subscribe to queries and hold a local cache; updates pushed per transaction | **Subscribe = consistent initial rows, then atomic per-transaction updates** is the same contract as our chunk-enter followed by per-tick frames. Validates "logic in deterministic WASM, clients hold a partial replica" | A database as the sim; SQL subscriptions; hosted dependency |

---

## 3. Recommendations per open question

### 3.1 Rates

| Parameter | Recommendation |
|---|---|
| Sim tick rate | **20 Hz (50 ms)**, per-game config, allowed range 10-60 |
| Server -> client frame rate | **One frame per tick (20 Hz) when there is anything to say; a heartbeat frame at least every 500 ms**. Per-client degrade to every 2nd or 4th tick under backpressure (frames coalesce by concatenation) |
| Interpolation delay for remote motion | **Adaptive: max(2 x frame interval, frame interval + p95 inter-arrival jitter)**, initial **150 ms**, floor 100 ms, cap 400 ms, slewed at no more than 10% time dilation so it never jumps |
| Subscription (camera) message | **On change, at most 5 Hz**, leading + trailing edge, quantized to whole tiles (3.4) |
| Presence (if option a) | **10 Hz while changing**, plus one final sample at rest (3.9) |
| Client -> server batching | One uplink message per 50 ms at most, carrying actions + presence + subscription + `last_received_tick` |
| Liveness | Client treats 3 s without a frame as dead and reconnects; checks immediately on `visibilitychange` and `online` |

Bandwidth budget per client (application bytes unless noted):

| | Budget |
|---|---|
| Steady state, typical | **1-4 KB/s down** (8-32 kbps), about 0.3 KB/s up |
| Steady state, soft cap for tick frames | **16 KB/s** (128 kbps). Above it, halve that client's frame rate; if a chunk's pending deltas exceed its snapshot size, replace them with a snapshot |
| Chunk streaming | Token bucket: **48 KB/s refill, 128 KB burst**, spent visible-first, then nearest to `camera + velocity x 0.5 s`. Tick frames are never queued behind chunk data |
| Hard ceiling | **64 KB/s** (512 kbps) |
| Data use | ~10-15 MB per hour of play at typical rates |

Worked numbers behind those: a frame header is 8 bytes; per-frame wire overhead (WebSocket + TLS + TCP/IP) is ~85 bytes, so 20 Hz of near-empty frames costs ~1.7 KB/s on the wire, which is why idle ticks send nothing. 200 active machines that each change state twice per 5 s produce ~80 deltas/s x ~8 B = 0.6 KB/s. Seven remote players' presence at 10 Hz x 14 B is ~1 KB/s worst case. A dense factory chunk is ~3 KB (overlay RLE ~0.5-1 KB + 200 entities x ~12 B); a pristine chunk enter is ~3 bytes in a batched list because the client regenerates terrain. **Join** on a phone (35 chunks at ring 1): under 1 KB in wilderness, ~100 KB in a dense base, inside the burst allowance. **Worst-case pan**: a desktop fling at two viewport-widths per second exposes ~180 chunks/s; wilderness costs ~1 KB/s; a dense base would want ~500 KB/s, so pacing caps it at 48 KB/s and far chunks arrive late behind the look-ahead ring. That is acceptable: nothing is legible at that pan speed.

A rule this imposes on games: **never replicate per-tick progress**. Replicate parameters ("smelting started at tick 1234, done at 1334") and let the client derive the bar from the synced tick clock. Future belt-like content must likewise be parametric (runs of items on a segment), or it blows every budget above.

Confidence: **medium** on 20 Hz (it is config; the reference game would work at 10). High on "send rate is decoupled from tick rate and adapts per client". Rejected: **60 Hz like Factorio** (3x server CPU and log timestamps for no visible gain, since clients interpolate and only lockstep needs the client to simulate every tick); fixed 10 Hz sends (doubles interpolation delay and gives TCP fewer following packets to trigger fast retransmit).

### 3.2 Wire format

- **Hand-rolled little-endian binary, no self-description, no field tags, no schema evolution.** The version handshake (3.12) guarantees both ends run the same build, which removes the need for all of that. Varints for ids/counts/tick deltas, fixed-width for positions, RLE for tile-overlay runs. No `permessage-deflate` (CPU, allocation, uneven runtime support).
- **The client never decodes in JavaScript.** The socket lives in the client worker that owns the client-side WASM instance. On `message`, JS copies the `ArrayBuffer` into a preallocated receive region of linear memory (`Uint8Array.set`) and calls one export, `on_frame(ptr, len)`. Rust parses in place with a borrowing `Reader<'a>`; no JS objects per entity, no `DataView` loops.
- Honest caveat on "zero allocation": the WebSocket API itself allocates one `ArrayBuffer` and one `MessageEvent` per message (at most ~20/s). That is irreducible with WebSockets, it is short-lived young-generation garbage, and it happens in a worker, not on the thread that renders. The zero-GC definition in `runtime-and-packaging.md` should exempt it explicitly. (WebTransport's BYOB readers could remove even that, later.)
- **Frame layout (server -> client), one WebSocket binary message per frame:**
  `[type u8][tick u32][last_processed_action_seq u16][flags u8]` then sections `[section_id u8][len varint][bytes]`: action results, global deltas, own-player deltas, pristine chunk-enter list, chunk snapshots, chunk leaves, per-chunk delta runs, presence, hash checks. A frame is applied **atomically** before the next render.
- **How game-defined deltas plug in:** the engine owns framing, sections, scopes, ids, and ordering; payloads are opaque game bytes. The game implements small `WireWrite`/`WireRead` traits (an engine derive macro generates them for plain structs and enums) writing into an engine-provided buffer and reading from a borrowed slice.
- **Deltas are the only write path to replicated state.** The game defines `enum Delta` and `fn apply(state, &Delta)`. Sim rules mutate replicated state by calling `world.apply(scope, delta)`, which both mutates the authoritative state and appends the encoded delta to that scope's outbound buffer. The client runs the same `apply`. A rule that "forgets to emit" cannot exist, server and client share one mutation function, and prediction (3.7) reuses it. A snapshot is the same encoder applied from empty (the Quake 3 trick).

Confidence: **high** on binary/no-tags/decode-in-WASM; **medium** on "deltas as the only write path" (it shapes the game-facing API in `simulation.md`; see spike 5.1). Rejected: serde + postcard/bitcode (fine technically and borrow-friendly, but a crate-dependency decision that belongs to `runtime-and-packaging.md`; the trait boundary lets it be swapped in); engine-side field diffing in the style of replicon/naia/Colyseus (needs the engine to understand the game's data model, which contradicts "the game defines the deltas"); JSON or protobuf-style tagged formats (allocation, size, and evolution we do not need).

### 3.3 Delta mechanics, chunk enter/leave, hysteresis

- **No acks or baselines inside a connection.** On a reliable ordered stream, "what the client has" is exactly "everything sent". The baseline is implicit. Acks exist only for backpressure: every uplink batch carries `last_received_tick`, which gives the server RTT and in-flight backlog on any transport (workerd exposes no `bufferedAmount`, so this is the portable signal; `bufferedAmount`/Bun's `-1` are optional extras).
- **Per-chunk version** = tick of the chunk's last replicated change. It is the only baseline bookkeeping, and it is what makes reconnect cheap (3.11).
- **Chunk enter**: inside frame T, either an entry in the batched *pristine* list (coord only: no overlay, no entities) or a snapshot `{coord, version, overlay runs, entities}` that is consistent as of the end of tick T. Deltas for that chunk start at T+1. Because a frame is atomic, there is no ordering problem between the snapshot and deltas.
- **Entity relevance** follows `world.md`: an entity is delivered if *any* chunk its footprint overlaps is subscribed, deduplicated by entity id, owned by its anchor chunk for persistence and hashing. Moving entities (future games): subscribed to both chunks -> ordinary delta; entering a subscribed chunk from an unsubscribed one -> full entity state; leaving to an unsubscribed one -> removal. The engine does this, not the game.
- **Chunk leave**: `{coord}`; the client frees overlay + entity state for it. The pristine terrain cache is separate and survives.
- **Hysteresis** (rings counted in chunks around the clamped view rectangle): **subscribe at ring 1**, plus look-ahead of `velocity x 1.0 s` in the direction of travel capped at 2 extra chunks; **unsubscribe only beyond ring 3 and after 5 s** continuously outside the subscribe set. Oscillating pans under ~2 chunks (64 tiles) and zoom wiggles cause zero traffic. Over `max_subscribed_chunks`, evict farthest-first immediately.
- **Backlog overflow**: if a client's pending deltas for a chunk exceed the chunk's snapshot size, drop them and send a snapshot.

Confidence: **high**. Rejected: Quake-style acked baselines with per-client history (solves loss we do not have); a client-side overlay cache validated by version on re-enter (a good later optimization; with pristine regeneration the saving is small, so not in v1).

### 3.4 Subscription message and the untrusted viewport

- Message (client -> host, **not an action, unlogged, never visible to the sim**): `{center_x i32, center_y i32 (tiles), half_w u16, half_h u16 (tiles), vel_x i16, vel_y i16 (tiles/s)}` = 16 bytes. Idempotent and latest-wins, so it coalesces freely and would map to a datagram on a future transport. The client sends the *view*; the **server** derives the chunk set, so look-ahead, margins, and hysteresis stay under server control.
- Sent only when the tile-quantized rect or velocity bucket changes, at most 5 Hz, with an immediate leading-edge send when motion starts and a trailing send when it stops. The server drops anything beyond 20/s.
- **Clamps (per-game config, delivered to the client in `Welcome` so it clamps zoom-out to match):** `max_view_tiles` default **640 x 384** (agrees with `world.md`; about 345 chunks at ring 1), `max_subscribed_chunks` default **512**, center must lie inside the world cap, non-finite or negative extents rejected. An over-large request is clamped about its center, never rejected. Teleporting the camera is allowed; the chunk token bucket is the rate limit.
- The clamp bounds memory and chunk count, not bandwidth; bandwidth is bounded by the pacing in 3.1. Games with dense content should configure a smaller view than the default.

Confidence: **high**. Rejected: client sends chunk-set diffs (larger, stateful, harder to clamp); camera as a logged action (ruled out by the spec correction).

### 3.5 Non-spatial state

Four **scopes**, one mechanism (snapshot on subscribe, then deltas through the same `apply`):

| Scope | Audience | Examples |
|---|---|---|
| `Global` | every connected client | player list with public profile (name, colour, online flag), world clock, shared research |
| `Player(id)` | that player only | inventory, unlocks, craft queue, in-progress collect |
| `Chunk(coord)` | subscribers of the chunk | tile overlays, buildings, machines |
| `Presence` | every connected client | ephemeral, unlogged, **not sim state** (3.9) |

`Global` and `Player` are snapshotted in full on every (re)connect; they are tiny by construction. A game that lets players inspect each other puts that data in `Global`. With at most 8 players there is no need for interest management on anything but chunks.

Confidence: **high**. Rejected: forcing player state into chunks (it would vanish when you pan away from yourself).

### 3.6 What is predicted

- **Only the local player's own game actions**, by default all of them, with a per-action opt-out (`PREDICT = false`) for anything that cascades (the Factorio and Overwatch rule).
- **The client does not run tick rules at all in v1.** Prediction executes *action handlers* only. Time-based consequences are rendered from parameters plus the synced tick clock: a predicted `StartCraft` writes "started at my estimate of the server tick"; when the confirmation arrives with the real tick, the bar shifts by a few ticks out of 100 and is eased. This is the single biggest simplification available for "prediction on partial state": only action handlers, not tick systems, must tolerate a partial world.
- Remote players and machines are never predicted; they are interpolated (motion) or clock-derived (progress).

Confidence: **high** for this genre. Rejected: full client-side simulation of subscribed chunks with rollback (lightyear/Overwatch style). It needs tick rules that are correct on a partial world, where off-screen inputs such as a belt feeding in from an unsubscribed chunk make mispredictions systematic rather than rare.

### 3.7 Expressing prediction in Rust on a partial world

- The game writes **one** handler per action: `fn handle(ctx: &mut impl WorldAccess, player: PlayerId, action: &Action) -> Result<ActionResult, Reject>`. It reads through `ctx` and writes only via `ctx.apply(scope, delta)`.
- On the server, `ctx` is the full world. On the client, `ctx` is `authoritative replica + prediction overlay`: reads consult the overlay first; writes land in the overlay as predicted deltas. The overlay is small and preallocated (overridden entities, overridden tiles, a copy of own-player state).
- Partiality is explicit: terrain reads are total on the client too (regenerated from the seed, per `world.md`); **entity/overlay reads outside the subscription return `Unknown`**. The provided helpers turn `Unknown` into `Err(Reject::NotPredictable)`: the action is still sent, just not predicted, and the UI shows it as pending. Actions target what the player can see, so in practice this only triggers within a chunk or two of the subscription edge.
- **Reconciliation loop** (Factorio's latency state + Gambetta's acks), run once per received frame: (1) apply the frame's deltas to the authoritative replica; (2) drop pending actions with `seq <= last_processed_action_seq`, surfacing any `Reject{seq, reason}` to the game UI; (3) clear the overlay; (4) re-run the handlers of the still-pending actions. With under ~10 pending actions and O(1) handlers this is microseconds.
- Two-stage validation, consistent with `reference-game.md` research: a host-side, non-deterministic **admit** hook (may read presence and rate limits; never runs in replay) and the deterministic handler above (never reads presence). I second that file's variant in which a collect action *carries a claimed position* and the handler checks range deterministically: the identical rule then runs in prediction, replay, and headless tests.

Confidence: **medium**; the API ergonomics need the spike in 5.1. Rejected: a separate game-written `predict()` per action (two implementations of each rule will drift apart; allow it only as an optional override); cloning the replica per frame instead of an overlay (simple, but copies every subscribed chunk 20 times a second).

### 3.8 Where the predicting instance lives; single-player

- **A client worker, never the main thread.** Socket, frame decode, authoritative replica, overlay, presence buffers, and interpolation state are co-located in one WASM instance so nothing is copied between them. Whether that worker is also the render worker is for `runtime-and-packaging.md`/`client.md`; sync only needs the renderer to read the replica without copying (same instance, or shared memory).
- **Single-player uses the identical protocol and the identical client worker.** The sim worker is "the server"; the transport is a `MessagePort` (or a shared ring buffer) carrying the same byte frames. That means two WASM instances, but "double the memory" is a misreading: the replica holds only subscribed chunks' overlays and entities (hundreds of KB to a few MB), not the world. Compile the `WebAssembly.Module` once and instantiate it per role.
- **Prediction stays on in single-player.** An action otherwise waits for the next tick boundary (up to 50 ms) plus two hops and a frame, which is perceptible, and keeping it on means single-player exercises the multiplayer code path on every run. The interpolation delay can drop to one frame interval on the in-process transport.

Confidence: **medium-high**. Rejected: renderer reads the sim's memory directly in single-player (saves a few MB, creates a second code path, and single-player stops being the multiplayer test bed).

### 3.9 Player position: (a) presence vs (b) movement action

**What an engine-level presence channel looks like (a):**
- Payload: a game-defined fixed-size POD of at most 32 bytes, e.g. `{pos: [i32; 2] in 1/256 tile, vel: [i16; 2]}` = 12 bytes. The client writes it every frame; the engine samples it at **10 Hz while it changes** plus one final at-rest sample, in the same uplink batch as the subscription message.
- The host keeps only the latest sample per player, stamps it with the receive tick, and relays it in each frame's presence section **to all clients regardless of viewport** (8 players x 10 Hz x ~14 B is ~1 KB/s worst case; global relay enables off-screen indicators and avoids a second interest system). Never queued: a slow client gets the newest sample only. It is the natural datagram candidate on a future transport.
- Remote rendering: the same interpolation buffer as any moving entity; **Hermite interpolation using pos + vel** at `server_time - interpolation_delay`; extrapolate at most 250 ms, then hold; fade the avatar after 2 s of silence. A remote player is seen roughly `RTT_a/2 + RTT_b/2 + delay` = 200-300 ms in the past, which is invisible in co-op.
- Trust: validate finite values inside the world cap; an optional game-configured max speed. Presence is visible to the host's `admit` hook only. It is never sim input, never logged, never hashed. The host remembers the last sample per player token in a side table (not sim state) so a returning player can resume there; the client also remembers its camera.
- Consequences: the sim cannot see a player walk away, so leaving range mid-collect is a client-sent `CancelCollect`; replays show the world evolving without avatars unless presence is recorded as an optional non-authoritative track; **sim rules can never depend on player position** (no enemies that chase players) in a game built this way.

**What (b) costs:**
- Action stream: one `MoveTo`-like action per tick while the camera moves: 20 Hz x ~11 B payload, ~1.4 KB/s on the wire uplink per moving player.
- Log: at 30% of play time in motion, ~21,600 actions per player-hour, roughly **100-260 KB per player-hour** depending on encoding, versus **~4 KB per player-hour** for discrete actions at ~0.1/s. Movement would be 95%+ of a log that is kept forever (8 players x 100 hours is up to ~200 MB).
- Prediction complexity is the real cost. A spring integrated per tick is sensitive to *which tick* each input lands on. If the server applies inputs on arrival, network jitter puts two inputs in one tick and none in the next, so the client's prediction is slightly wrong all the time and corrections are continuous. Fixing that requires the Overwatch apparatus: client-stamped ticks, a client clock running ahead by RTT/2 + buffer, a server-side input jitter buffer with time dilation feedback, and visual error smoothing. None of that is needed for discrete actions. The spring also becomes deterministic sim code (fixed-point, or a float-determinism burden).
- What it buys: position is replayable, server-visible, and available to sim rules; a sim-owned entity moves, exercising chunk-crossing replication and continuous prediction.

**Recommendation: (a), confidence medium-high.** It matches the fixed decision that the camera lives independently of the sim, keeps the log ~50x smaller, makes reconnect trivial, and avoids building tick-aligned input machinery that this genre rarely needs. Under (a), prediction is exercised by collect, craft, place, and deposit. Keep (b) *possible* without building it: actions already carry a sequence number and the client's tick estimate, and nothing in the overlay model forbids a continuous predicted value later (it would add the error-decay smoothing from 3.10 and the input buffer). The coverage gap under (a), that no sim-owned entity ever moves, is accepted by routing presence and entities through one interpolation path.

### 3.10 Reconciliation without snapping

- **Discrete state** (the whole reference game under (a)): there is nothing to blend, so the design goal is *no flicker*. Guaranteed by construction: the ack for action N and the deltas it caused arrive in the **same atomic frame**, so the overlay's ghost disappears in the same render in which the authoritative result appears. The action result carries a game-defined payload (e.g. the new `EntityId`) so the renderer can carry animation state from the predicted entity to the real one.
- The renderer is told which entities/tiles are **predicted**, so the game can style pending things (a slight transparency) and animate a rejection (fade out + reason) instead of popping. Rejections carry a game-defined reason code to the UI.
- **Clock-derived values** (progress bars): when the confirmed start tick differs from the predicted one, ease the displayed offset to zero over ~200 ms.
- **Continuous values** (only under (b) or in future games): keep `visual = predicted + error`, where `error` is set to `old_visual - new_predicted` on each correction and decays exponentially with a ~100 ms time constant; snap outright above a game-set threshold.

Confidence: **high** for discrete; medium for continuous (unbuilt).

### 3.11 Sessions

- **Identity: the client mints it.** On first run the client generates a 128-bit secret with `crypto.getRandomValues` and keeps it in `localStorage`. The server stores `SHA-256(secret) -> PlayerId` in a host-side table persisted next to snapshots; the log only ever contains `PlayerId`. The first sighting of a secret is a join. This needs no round trip or issuing service and behaves identically in single-player. Because anyone with the URL could otherwise join, each world has a **join key** (a shared secret from server config, typically carried in the invite link's fragment) and `max_players`.
- **Join = late join** (there is no other kind in a server-authoritative design): connect -> `Hello{protocol_version, build_hash, join_key, player_secret, view rect, resume?}` -> `Welcome{player_id, tick, tick_rate, clamps, last_processed_action_seq}` or `Reject{VersionMismatch | BadKey | Full}` -> the host injects the engine action `PlayerConnected` (logged) -> the first frames carry `Global` + `Player` snapshots and chunk enters, visible chunks first. The client reveals the world when the *visible* chunks are in.
- **Reconnect is the same path plus a resume hint**, and the server keeps **no** per-session state for it. `Hello.resume = {last_tick, [(chunk, version)...]}` (8 bytes per chunk; ~0.3-3 KB). For each chunk still wanted, the server compares versions: equal -> a 3-byte "keep"; different -> snapshot. `Global`/`Player` are always resent. The client then resends pending actions with `seq > last_processed_action_seq`, so nothing is applied twice or lost. Typical cost: one RTT plus about 1 KB. A page that iOS discarded reloads, presents the same secret, and takes the plain join path back to the same inventory.
- **Client reconnect policy:** dead after 3 s without a frame, or on `close`; on `visibilitychange -> visible` or `online`, probe immediately (1 s ping deadline); backoff 0, 0.5, 1, 2, 5 s (cap) with jitter; open the new socket before discarding the old. The UI stays live on the last known state with a small indicator after 1 s; no modal and no error for outages under ~10 s.
- **Disconnect:** presence disappears from other clients at once. The logged `PlayerDisconnected` action is injected only after a **10 s grace**, so tab switches do not churn the log or other players' UIs. The game gets the event and decides consequences (the reference game: cancel an in-progress collect; crafting and furnaces continue). **Player state persists indefinitely** under its `PlayerId`. Under option (b) the entity would stay in the world flagged offline, and the game chooses how to draw it.
- **Same secret in two tabs:** newest wins; the old socket gets `Bye{Superseded}` and must not auto-reconnect.
- **Leave:** explicit `Bye` skips the grace period.

Confidence: **high** on stateless resume via chunk versions; **medium** on client-minted identity (a taste call; see 6). Rejected: server-minted tokens (equivalent security without accounts, plus an issuance step); Colyseus-style seat reservation as the *only* reconnect path (the reconnect must also work after a page reload or a server restart).

### 3.12 Version handshake

- `Hello` carries `protocol_version: u16` (engine wire format) and `build_hash` (truncated SHA-256 of the exact `.wasm` bytes, emitted by the build and baked into the client bundle and the server). **Strict equality**, no compatibility ranges: that strictness is what allows a tagless wire format, bit-identical prediction, and client-side worldgen.
- On mismatch the server replies `Reject{VersionMismatch, server_build_hash}` and closes. The engine raises an event; the default handler reloads the page **once** (guarded in `sessionStorage`), and if it still mismatches shows "updating" and retries with backoff, which covers deploy skew between static hosting and the sim host in either order.
- A server redeploy mid-session is therefore: sockets drop -> clients reconnect -> mismatch -> reload -> normal join with the same secret. A few seconds of disruption and no lost state beyond the snapshot/log loss window. Games that cache the bundle in a service worker must make that reload bypass the cache.

Confidence: **high**.

### 3.13 World lifecycle on the server

Adopt the spec's proposal. **One server instance hosts exactly one world.** `createWorldServer(config)` loads the newest snapshot and replays the log tail if storage has one, otherwise creates the world from `config.seed/params`. URL-to-world mapping, spawning, and teardown belong to the deployer; the repo documents two recipes (a Durable Object per world id via `idFromName`; one Fly machine per world) without engine code for either.

**Pause when empty:** after the last player's grace period plus 30 s, snapshot, flush the log, stop the tick timer, and report idle to the host adapter, which may exit the process or let the object hibernate. Ticks are counted, never inferred from wall-clock, so pausing is replay-safe. This is what makes scale-to-zero hosts cost ~$0 when nobody is playing. It is a gameplay choice as well (furnaces do not smelt overnight), so it is a Tyler question with a per-game flag.

Confidence: **high** on one-world-per-instance; medium on pause-by-default.

### 3.14 Desync detection

- What can drift is the **authoritative replica** (a delta-apply bug, a non-deterministic `apply`). Prediction mismatches are not desyncs; they heal by design.
- Per-chunk hash = 64-bit hash of the chunk's canonical snapshot encoding (overlay + owned entities; the same encoder as chunk-enter, so no second canonical form). Pristine terrain is covered by `build_hash` plus the sampled checks `world.md` proposes.
- The server piggybacks `{chunk, hash}` for **one subscribed chunk per 4 ticks**, round-robin with recently modified chunks first: ~50 B/s, a full sweep of 35 chunks in ~7 s. `Global` and `Player` hashes every 5 s. The client computes the same hash on its replica (never the overlay) immediately after applying that frame, so both sides hash the same tick.
- On mismatch: the client sends `ResyncChunk{coord}`, the server replies with a snapshot, and both log a desync report. Dev builds check every chunk every frame and dump both encodings for diffing (`testing.md`).
- Server-side CPU is one snapshot encode + hash per client per 4 ticks: negligible. A small non-cryptographic 64-bit hash can be written in-engine in ~30 lines (no crate needed).

Confidence: **high**.

### 3.15 Transport

**WebSocket (binary, `wss`), one socket per client, in the client worker. Confidence: high.**

- WebTransport became Baseline in March 2026, so the browser objection has mostly expired. The server side has not: no stable built-in server in Node, Bun, or Deno; **none at all on Cloudflare Workers/DO or Vercel**; it needs UDP ingress (a dedicated IPv4 and a special bind address on Fly) and in-process TLS; it would require a native addon or a native Rust server, breaking the zero-dependency rule and halving the host list.
- The benefit we would be buying is small for this genre. Nothing we send is twitch-critical; the adaptive interpolation buffer absorbs ordinary TCP loss stalls; and the multi-second radio stalls and tab suspensions that dominate mobile pain affect QUIC equally (QUIC connection migration would help across network switches, but our reconnect costs one RTT + ~1 KB anyway).
- Keep the door open cheaply: a `Transport` interface (`send(bytes)`, `onMessage`, `close`, optional `bufferedAmount`) and a **message class** on every message type: `reliable-ordered` (frames, actions) or `latest-wins` (presence, subscription). A future WebTransport adapter maps the second class onto datagrams with no protocol change. Revisit when workerd or Node ships a stable server.
- WebSocket details: `binaryType = 'arraybuffer'`; no compression extension; exactly one message per frame; never write to a socket whose backlog exceeds the frame budget (coalesce instead).

Rejected: WebTransport now (above); WebRTC data channels, as naia uses (unreliable delivery in every browser, but signaling + ICE/TURN and no server support on any candidate host without a native dependency).

### 3.16 Hosting and what "host-agnostic" honestly means

**Definition.** The server entrypoint is a **library, not a process**. It assumes nothing about HTTP, files, or process lifecycle, and needs exactly four things from its host:

1. one long-lived, single-threaded JS context with `WebAssembly` and enough memory for the world;
2. a repeating timer and a monotonic clock;
3. a way to hand it WebSocket-like connections that **all arrive in that same context** (`Connection = { send(bytes), close(code), onMessage, onClose, bufferedAmount? }`);
4. a small storage interface (append to the log, put/get a snapshot blob), injected.

Any host that provides these works, through a thin adapter. Hosts that **cannot pin all of a world's connections to one long-lived instance are out of scope by construction**: Vercel Functions (5-30 min connection cap and no instance affinity, per its own docs), AWS Lambda / API Gateway WebSockets, Deno Deploy. So the spec's example "AWS vs. Vercel" is not achievable for the sim: on AWS it means a VM or container, and Vercel can serve the client and perhaps a world directory, never the world. This adapter-injection shape is the same one bevy_replicon uses for transports, and it also resolves "zero npm dependencies vs. a WebSocket server".

**Runtimes to target first:**

1. **Node (current LTS) on a VM/container/Fly machine: primary.** Most universal, and it is where tests already run. Since Node has no built-in WebSocket server, the adapter accepts a `ws`-compatible server **supplied by the game's server package** (the reference game depends on `ws`; the engine does not). Fallback if Tyler wants literally zero dependencies anywhere: a hand-rolled RFC 6455 server over `node:http` `'upgrade'` (~250 lines: handshake, unmasking, fragmentation, ping/pong, close; no extensions). I would not start there.
2. **Cloudflare Durable Objects: second, as the proof of host-agnosticism.** No process, no filesystem, fetch-style upgrade, SQLite storage, forced restarts on deploy: if the library runs there unmodified, the abstraction is real. It is also the best hobby economics ($5/mo flat, global, world-id routing for free). The price is a **hard 128 MB ceiling for JS heap + WASM**, which fits `world.md`'s 64 MiB default sim budget but caps it.
3. **Bun and Deno: adapters only** (each ~30 lines over a built-in server), CI smoke-tested, not a focus.

The server runs the **same WASM module as the client** inside a JS runtime. That gives the strongest bit-identical guarantee for prediction and worldgen and a single build artifact. A native Rust server binary is the main alternative: rejected for v1 because it adds a second build target and networking crate dependencies, cannot run on Durable Objects, and its one real advantage (WebTransport via `wtransport`) is not needed.

Confidence: **high** on the definition; **medium** on Node-first over Bun-first (Bun removes the `ws` question, but is one more variable for determinism and longevity).

---

## 4. Cross-domain interactions

**Simulation (`simulation.md`)**
- "Deltas are the only write path" and the shared `WorldAccess` handler (3.2, 3.7) *are* the game-facing API question. Replicated state must be partitioned into `Global` / `Player` / `Chunk` scopes at the type level.
- Action envelope: `{seq u32 per player, client_tick_estimate, payload}`. The server assigns the tick on receipt (next tick boundary) and orders within a tick by `(PlayerId, seq)`. Every action gets a result (ok + payload, or reject + reason) in the frame of the tick that processed it. `last_processed_action_seq` is per-player sim state, so it survives restarts and keeps resend idempotent.
- Two-stage validation: non-deterministic host `admit` (presence, rate limits; not replayed) vs deterministic handler. Only admitted actions are logged.
- Host-side, unlogged, non-sim state: subscriptions, presence, token table, pacing buckets. The sim must not be able to read any of it (enforce through the API surface).
- With the camera unlogged and position as presence, the log is ~4 KB per player-hour. Under option (b) it would be 100-260 KB per player-hour.
- Durable Objects and redeploys restart the server routinely, so crash recovery (snapshot + log tail) is a normal weekly path on that host, and log appends must be near-continuous.
- Pause-when-empty (3.13) answers "Idle worlds" and needs counted ticks.
- The client needs a synced tick clock exposed to game rendering code (progress bars derive from it).

**Runtime and packaging**
- One client worker owns socket + WASM replica + prediction; it needs a zero-copy path to the renderer. Workers must be able to open WebSockets (they can, including on iOS Safari).
- The per-message `ArrayBuffer` from the WebSocket API should be a named exemption in the zero-GC definition.
- Build must emit `build_hash` and inject it into both client and server bundles. One compiled `WebAssembly.Module`, several instances (sim, client replica, generation workers).
- `memory.grow` detaching views matters on the receive path: copy frames into a fixed preallocated region.
- The server entrypoint's shape (library + adapters; `ws` injected) settles the "zero npm dependencies vs. WebSocket server" question. Workerd loads WASM as a module import, Node/Bun/Deno from bytes: the adapter owns that difference.
- Durable Objects limit the world to well under 128 MB if that host is supported.

**World**
- Relies on client-side pristine regeneration; if that is rejected, chunk snapshots grow from ~3 B to ~0.3-1 KB each and the pan-burst numbers in 3.1 need redoing (still feasible).
- The subscription ring (1), unsubscribe ring (3), look-ahead, and `max_view_tiles` 640 x 384 are intended to match `world.md`. Entity footprints must not exceed one chunk.

**Client**
- The camera stays fully local; the sync layer only observes it (5 Hz, on change). Client zoom-out is clamped from `Welcome`.
- The renderer needs a `predicted` flag per entity/tile, and interpolation of presence/entities happens at render time from buffered samples.
- Input -> worker -> predicted render is the latency path to measure; it argues for the replica living with the renderer.
- DOM overlay needs action results and reject reasons, and own-player state, surfaced without per-frame garbage.

**Testing**
- A fake transport with scripted latency, jitter, loss-stall, and disconnect makes the entire protocol testable headlessly, in single-player topology.
- Desync reports with both encodings; dev mode hashes everything every frame.
- Property test: random action sequences through server + client replica must produce equal per-chunk hashes; reconnect at random points must converge.

**Reference game**
- Under (a): needs `CancelCollect`, a claimed position on range-checked actions, and accepts that no sim-owned entity moves.

---

## 5. Needs a spike

1. **`WorldAccess` + overlay prototype (decision-critical for 3.2, 3.6, 3.7).** Write the reference game's `StartCollect`, `Craft`, and `PlaceFurnace` handlers once in Rust and run them (i) against a full world and (ii) against a partial replica with a copy-on-write overlay, including the reset-and-replay loop and an `Unknown` read at the subscription edge. Success = one handler per action, no allocation in the loop, and code a game author would tolerate writing. If this fails, fall back to separate `predict()` functions and game-emitted deltas.
2. **Durable Object feasibility (only gates "is DO a supported host", not the core design).** Run a WASM sim at 20 Hz from `setInterval` in a DO with standard-API WebSockets: how CPU limits are accounted for timer-driven work, timer accuracy and clock behaviour, memory headroom under 128 MB, observed restart frequency, and whether the lack of `bufferedAmount` matters given `last_received_tick`.
3. *(Small, can wait for Phase 3.)* iOS Safari resume behaviour for a WebSocket owned by a worker: does `close` fire promptly after the tab returns, or does the socket go silent? It tunes the 3 s liveness timeout and the probe-on-visible rule; the design does not change.

---

## 6. Questions for Tyler

1. **Player position: presence (a) or logged movement action (b)?** Recommended default: **(a)**, with range-checked actions carrying a claimed position. The cost is that sim rules can never depend on where players are, and continuous prediction goes unexercised.
2. **Is hosting the sim on Vercel a real requirement?** It is not feasible (no instance affinity; 5-30 min connection cap). Recommended default: define host-agnostic as in 3.16, target **Node on a VM/Fly first and Cloudflare Durable Objects second**, and use Vercel only for the client if at all.
3. **May the reference game's server package depend on `ws`** (the engine itself stays dependency-free by taking an injected server)? Recommended default: **yes**. The alternative is ~250 lines of hand-rolled RFC 6455 in the engine.
4. **Should a world keep ticking with nobody connected?** Recommended default: **pause** (idle cost ~$0; furnaces do not run overnight), with a per-game flag to keep ticking.
5. **Is a shared join key in the invite link enough access control**, with identity as a device-local secret and no cross-device recovery? Recommended default: **yes**; a "copy my player link" escape hatch can come later.
6. **Hosting budget.** Recommended default: design for **about $5/month per always-available world and ~$0 while idle**; if Durable Objects are wanted, accept the 128 MB world ceiling on that host.

## Spike results

- **Spike 1 (`WorldAccess` overlay API):** works; one `apply` handler runs on the host and under the client's reset-and-replay overlay with zero steady-state allocation. See `spikes/prediction-api/RESULT.md`.
- **Spike 2 (Durable Objects at 20 Hz):** not run; it needs an external deployment and gates only whether that host is supported. Deferred in ADR 0009.
