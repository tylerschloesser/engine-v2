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

- **Rates.** Decided in [0010](../decisions/0010-rates-and-subscriptions.md).
- **Wire format.** Decided in [0011](../decisions/0011-wire-format-and-deltas.md).
- **Delta mechanics.** Decided in [0011](../decisions/0011-wire-format-and-deltas.md); hysteresis in [0010](../decisions/0010-rates-and-subscriptions.md).
- **Prediction and reconciliation.** Decided in [0012](../decisions/0012-prediction-and-reconciliation.md); the game-facing side in [0003](../decisions/0003-game-facing-api.md).
- **Sessions.** Decided in [0013](../decisions/0013-sessions-and-integrity.md).
- **Transport and hosting.** Decided in [0009](../decisions/0009-transport-and-hosting.md).
- **Non-spatial state.** Decided in [0011](../decisions/0011-wire-format-and-deltas.md).
- **Prediction on partial state.** Decided in [0012](../decisions/0012-prediction-and-reconciliation.md), [0003](../decisions/0003-game-facing-api.md), and [0015](../decisions/0015-threads-memory-and-topology.md).
- **Untrusted viewport.** Decided in [0010](../decisions/0010-rates-and-subscriptions.md).
- **Version handshake.** Decided in [0013](../decisions/0013-sessions-and-integrity.md).
- **Mobile reconnect is the common path.** Decided in [0013](../decisions/0013-sessions-and-integrity.md).
- **World lifecycle on the server.** Decided in [0013](../decisions/0013-sessions-and-integrity.md).
- **Desync detection.** Decided in [0013](../decisions/0013-sessions-and-integrity.md).
