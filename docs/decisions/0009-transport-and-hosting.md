# 0009: Transport and hosting

Status: Accepted (2026-09-19)

## Context

The sim is one long-lived, stateful, in-memory process per world with 2–8 persistent connections (`docs/spec/overview.md`). Requirements in `docs/spec/sync.md` fix what host-agnostic means, the hosting targets, and the cost target; Requirements in `docs/spec/runtime-and-packaging.md` fix zero runtime npm dependencies and `ws` injected by the game. Open: WebSocket vs. WebTransport, the adapter shape, and which hosts honestly fit. Patterns taken from bevy_replicon (replication with no built-in I/O; transports plug in) and naia (rejected: its WebRTC transport).

## Decision

**WebSocket (`wss`, binary) now.** `binaryType = 'arraybuffer'`, no `permessage-deflate`, one socket per client, owned by the net worker ([0015](0015-threads-memory-and-topology.md)).

**Message classes.** Every message type and every frame section ([0011](0011-wire-format-and-deltas.md)) is tagged with one of two classes:

| Class | Meaning | Members |
|---|---|---|
| `reliable-ordered` | delivered once, in order | handshake, actions, action results, deltas, chunk enter/leave, hashes |
| `latest-wins` | idempotent; a newer one supersedes an older one; may be dropped | camera report, presence |

On a transport without datagrams the engine packs both classes into one packet per flush. A future WebTransport adapter sets `datagrams: true` and receives `latest-wins` data separately; the protocol does not change.

**Injected adapter.** The server entrypoint is a library; the host pushes connections into it.

```ts
export const enum MsgClass { ReliableOrdered = 0, LatestWins = 1 }
export interface Connection {
  send(cls: MsgClass, bytes: Uint8Array): void; // engine-owned buffer, valid only during the call
  close(code: number): void;
  onMessage: ((bytes: Uint8Array) => void) | null;
  onClose: ((code: number) => void) | null;
  readonly datagrams: boolean;       // false for WebSocket
  readonly bufferedAmount?: number;  // optional; workerd has none
}
export interface HostServices {      // everything the library needs from its host
  wasm: WebAssembly.Module;          // the adapter owns how it was loaded (0017)
  storage: Storage;                  // 0005
  clock: { now(): number };          // monotonic ms
  timer: { every(ms: number, fn: () => void): () => void };
  onIdle?: () => void;               // world paused (0013): host may exit or allow eviction
}
export function createWorldServer(cfg: WorldConfig, host: HostServices): { accept(c: Connection): void; stop(): Promise<void> };
```

**`WorldConfig`** is the one host-side configuration value, used unchanged by a server and by the single-player sim worker (`createClient` forwards it there). This is the consolidated field list; the meaning and default of each field are owned by the ADR named in its comment, and a field is added here when an ADR adds a knob (the disconnect grace, idle timeout and snapshot cadence are fixed numbers in [0013](0013-sessions-and-integrity.md) and [0005](0005-persistence-and-recovery.md), not knobs). Tick rate and chunk size are compile-time constants of the game crate ([0003](0003-game-facing-api.md)), not config.

```ts
export interface WorldConfig<Params = unknown> {
  worldId: string;                    // storage key prefix `worlds/<id>` (0005)
  buildHash: string;                  // hex SHA-256 from loadGame() / virtual:engine/wasm (0017); handshake token (0013), log stamp (0005)
  params: {                           // WORLD PARAMS: read only when storage holds no world, then stored with genesis and
                                      // fixed for the world's life; a stored world ignores this block (0005, 0013)
    seed: string;                     // u64 as decimal text, since TS-facing values avoid u64 (0003); worldgen input (0008)
    worldgen: Params;                 // the game's `Worldgen::Params`, typed by ts-rs (0008)
    maxEntities?: number;             // state budget, default 262,144 (0007)
    maxModifiedTiles?: number;        // state budget, default 1,048,576 (0007)
    maxActionGrowth?: number;         // bytes of nominal headroom one action may need, default 4,096 (0007; check in 0004)
  };
  joinKey?: string;                   // default "": single-player and open servers (0013)
  maxPlayers?: number;                // default 8 (0013)
  keepTickingWhenEmpty?: boolean;     // default false: ticking stops with the last Disconnected (0013)
  view?: { maxTilesPerAxis?: number; maxChunks?: number };   // untrusted-view clamp 256 and subscription cap 128, sent in Welcome (0010);
                                      // the client-side zoom range is camera.setConstraints (0019)
  cacheChunks?: number;               // host dense-chunk cache, default 1,024 = 4 MiB; invisible to the sim (0007)
  arenaBytes?: number;                // sim-role arena, default 96 MiB (0015)
  actionRate?: { perSecond?: number; burst?: number };       // default 20 / 40 per connection (0004)
  bandwidth?: { softCapBytesPerS?: number; chunkRefillBytesPerS?: number; chunkBurstBytes?: number; hardCapBytesPerS?: number };  // 0010
}
```

The host passes `params`, the budgets and `arenaBytes` to the instance as the one-time JSON config of [0014](0014-js-wasm-boundary.md). Client-only settings (client and gen arenas, worldgen worker count, camera constraints) are `createClient` options, not part of this type ([0015](0015-threads-memory-and-topology.md), [0008](0008-chunk-generation.md), [0019](0019-camera-input-and-overlay.md)).

**Node.** The game's server package installs `ws`, constructs the `WebSocketServer`, and passes it to the engine's Node adapter, which is typed structurally (`{ on('connection', cb) }`, socket `{ send, close, on, bufferedAmount }`) so the engine imports nothing. The engine contains no RFC 6455 code. Bun and Deno adapters wrap their built-in servers.

**Host-agnostic, honestly.** As defined under Hosting in `docs/spec/sync.md`: one long-lived single-threaded JS context with `WebAssembly`, a timer and monotonic clock, connections that all arrive in that same context, injected storage. A host that cannot pin all of a world's connections to one long-lived instance is out of scope by construction.

**Targets, in order.**
1. Node ≥ 22 or Bun as a process on a VM, container, or Fly machine. Primary; tests run here.
2. Cloudflare Durable Objects, as the proof that the library assumes no process, filesystem, or HTTP server.
3. Deno: adapter only, best-effort.

**Vercel is out for the sim** (it may serve the static client): its WebSocket support (public beta 2026-06-22) ends connections at the function's max duration (300 s Hobby, 800 s Pro) and states new connections "are not guaranteed to reach the same Vercel Function instance". AWS API Gateway WebSockets/Lambda and Deno Deploy fail the same test.

**Durable Objects constraints the design accepts.** 128 MB per isolate including WASM memory (the 64 MiB default world budget fits; larger worlds cannot run there); WASM only as a precompiled module import; the standard WebSocket API while players are connected (the Hibernation API discards memory and any pending timer prevents it), so the object is billed while a world is active and becomes evictable only once paused; restart on every deploy and runtime update, so recovery ([0005](0005-persistence-and-recovery.md)) is a routine path; no `bufferedAmount`, so backpressure uses `last_received_tick` ([0010](0010-rates-and-subscriptions.md)); incoming messages bill 20:1, which is one reason uplink is batched; the free plan's 10 ms CPU limit is too tight for a tick.

**Cost target: about $5/month per always-available world, about $0 idle.** Met by a Fly `shared-cpu-1x` 512 MB machine ($3.32/mo always-on; a stopped machine bills only rootfs; the server exits on `onIdle` and autostart wakes it) and by the $5/mo Workers plan (400,000 GB-s included = ~868 world-hours at 128 MB).

**Single-player** runs the same protocol bytes between the sim worker and the client worker over an in-browser transport (a SAB ring pair, [0015](0015-threads-memory-and-topology.md)) implementing the same `Connection` shape with `datagrams: false`. No net worker, no socket.

## Alternatives rejected

- **WebTransport now.** Browsers are ready (Baseline March 2026; Safari 26.4+), but Tier-1 iOS 26.0–26.3 lacks it, and no server is: none in Node (`node:quic` experimental), Bun, or stable Deno; none on Cloudflare Workers/DO; it needs UDP ingress (dedicated IPv4 on Fly) and in-process TLS, i.e. a native addon or native server. The gain is small: nothing sent is twitch-critical, the interpolation buffer absorbs TCP loss stalls, and radio stalls and tab suspension hit QUIC equally.
- **WebRTC data channels** (naia): signaling plus ICE/TURN, and no candidate host supports it without a native dependency.
- **Hand-rolled RFC 6455 server in the engine:** ~300 lines of protocol code to own; ruled out by Requirements.
- **`ws` as an engine dependency:** violates zero runtime dependencies.
- **Native Rust server binary:** second build target, cannot run on Durable Objects, weakens [0002](0002-determinism-same-wasm-everywhere.md).
- **Runtime-conditional code paths inside the server core:** `node:`/`Bun.`/`Deno.` appear only in adapters ([0017](0017-packaging-and-build.md)).

## Consequences

- The WebSocket API allocates one `ArrayBuffer` and `MessageEvent` per message; that garbage is confined to the net worker and exempted in [0016](0016-zero-gc-definition.md).
- Head-of-line blocking stays: at ~1% loss expect a 1–2 RTT stall every few seconds, absorbed by the interpolation delay in [0010](0010-rates-and-subscriptions.md).
- Tests use the real in-memory adapter pair, or real loopback WebSockets, wrapped in a deterministic network conditioner (latency, jitter, stall, disconnect); nothing is mocked ([0020](0020-testing-strategy.md)).
- URL-to-world routing, TLS, and process supervision are the deployer's; the repo documents two recipes (one Fly machine per world; one Durable Object per world id) without engine code for either.
- Deferred to Phase 2: the Durable Object adapter and its feasibility check (CPU accounting for timer-driven ticks, timer accuracy, headroom under 128 MB, restart frequency), because it gates only whether DO is a supported host, not the design.
- Deferred to Phase 2: a WebTransport adapter, because no target server runtime ships a stable implementation; revisit when Node or workerd does.

## Sources

- `docs/research/sync.md` sections 1.1–1.4, 2, 3.15, 3.16; `docs/research/runtime-and-packaging.md` sections 1.7, 3.10, 3.11.
- https://caniuse.com/webtransport (checked 2026-09-19: Safari/iOS 26.4+, 91.3% global) · https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
- https://nodejs.org/en/learn/getting-started/websocket (no built-in server) · https://www.npmjs.com/package/ws · https://bun.com/docs/runtime/http/server
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/ · https://developers.cloudflare.com/workers/platform/limits/ · https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://vercel.com/docs/functions/websockets · https://vercel.com/docs/functions/limitations
- https://fly.io/docs/about/pricing/ · https://fly.io/docs/launch/autostop-autostart/ · https://fly.io/docs/networking/udp-and-tcp/
- https://github.com/projectharmonia/bevy_replicon (transport-injection boundary) · https://github.com/naia-lib/naia
