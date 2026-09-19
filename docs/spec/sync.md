# State sync and networking

## Requirements

- The sim sends deltas to each client/renderer, scoped to that client's viewport.
- A client-side layer manages the currently displayed state and the latest received state, and interpolates and predicts so lag isn't noticeable.
- The engine abstracts this: the game defines the data model, the deltas, and the interpolation and prediction logic; the engine pieces everything together.
- Tick rate is TBD. It must accommodate mobile network patterns: assume reasonably decent, modern speeds and bandwidth, but not great 5G.
- Transport: likely WebSockets, unless there's a better option.
- **Hosting.** The server entrypoint is host-agnostic in this sense: it is a library that needs one long-lived context, a timer, injected connections, and injected storage. Target a Node/Bun process (VM, container, Fly) first and Cloudflare Durable Objects second. Vercel is not a target for the sim (it can serve the static client). Cost target: about $5/month per always-available world, about $0 while idle.
- **Sessions.** Access control is a join key in the invite link plus a device-local identity secret; no cross-device recovery. A server process hosts exactly one world, created or loaded at startup; mapping URLs to worlds is the deployer's problem.

**Reading of the model:** this is server-authoritative with chunk-based interest management, not lockstep. Clients never hold the whole world. Determinism serves replay, persistence, testing, and client prediction (the client can run the same Rust rules). Single-player uses the identical protocol; the only difference is the transport (worker messages instead of a socket).

## Open questions

- **Rates.** Sim tick rate vs. network send rate (they needn't match), interpolation buffer delay, and a per-client bandwidth budget for the stated network assumptions.
- **Wire format.** Binary encoding that decodes on the client without allocating (see the zero-GC goal in `runtime-and-packaging.md`); how game-defined deltas plug into it.
- **Delta mechanics.** Baselines and acks over a reliable ordered transport; what a client receives when a chunk enters its subscription (full chunk state) and leaves it; hysteresis so panning back and forth doesn't thrash.
- **Prediction and reconciliation.** What gets predicted (only the local player's own actions?), how the game expresses prediction in Rust, how mispredictions and rejected actions are corrected without visible snapping.
- **Sessions.** Join, leave, reconnect, and late join; resync after a dropped connection; what happens to a disconnected player's entity.
- **Transport.** WebSocket vs. WebTransport: current browser support (especially iOS Safari), head-of-line blocking on lossy mobile links, and server-side support on candidate hosts.
- **Hosting.** The sim is a long-lived, stateful, in-memory process with persistent connections. Which hosting models actually support that (a plain Node/Bun process on a VM or container, Cloudflare Durable Objects, others) and which don't (classic serverless functions)? Define what "host-agnostic" can honestly mean, and what runtime(s) the server entrypoint targets.
- **Non-spatial state.** Deltas are "scoped to the viewport", but inventory, unlocks, and crafting progress belong to a player, not a chunk, and the player list is global. The delta model needs per-player private state and global state alongside chunk-scoped state, plus entities that cross chunk and subscription boundaries.
- **Prediction on partial state.** Clients never hold the whole world, yet prediction runs "the same Rust rules" on the client. Game rules therefore must run against a partial world (subscribed chunks + own player state), which constrains the game-facing API in `simulation.md`. Where does the predicting WASM instance live (main thread, client worker)? In single-player the sim is a worker hop away: is prediction skipped, or does the "identical protocol" mean two WASM instances and double the memory?
- **Untrusted viewport.** Subscriptions derive from a client-reported camera and viewport. The server must clamp viewport size and zoom-out (per-game config), since that bound sets the worst-case subscribed chunk count, bandwidth, and render load.
- **Version handshake.** Prediction and any client-side worldgen are only bit-identical if client and server run the same build. The handshake needs a build/protocol hash, and a defined behavior when they differ (e.g. the server redeploys mid-session).
- **Mobile reconnect is the common path.** iOS and Android drop sockets whenever the tab is backgrounded or the radio switches. Reconnect + resync must be cheap and invisible, not an error flow. Identity follows from the no-accounts non-goal: who mints the opaque player token, and how a returning player reclaims their entity and inventory.
- **World lifecycle on the server.** With no lobbies or matchmaking, how does a world come to exist? Proposed: the server entrypoint hosts exactly one world, created or loaded at startup from config; anything that maps URLs to worlds or spawns processes is the deployer's problem.
- **Desync detection.** Cheap production checks that prediction and authority agree (e.g. per-chunk state hashes piggybacked on deltas), given that whole-world hashes are impossible on a client.
- **Prior art to evaluate.** At minimum: Factorio's deterministic lockstep and latency hiding (Friday Facts), Gabriel Gambetta's and Glenn Fiedler's netcode articles, the Quake 3 snapshot model, Overwatch's GDC netcode talk, Rust netcode libraries (lightyear, bevy_replicon, naia), and hosted approaches (Colyseus, SpacetimeDB). Take patterns, not dependencies.
