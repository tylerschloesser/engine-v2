# Runtime, performance, and packaging

## Requirements

### Runtime and performance

- In general, everything is async. The main thread does only what is necessary in JavaScript.
- Do as much as possible in Rust→WASM running in web workers.
- Optimize for minimal or no garbage collection, to prevent dropped frames.

### Packaging

- pnpm monorepo, TypeScript.
- The engine has no dependencies and is the single export of the overall repo. The reference game is a separate package (Vite + a simple game).
- Exports must be modeled so a bundler like Vite can import each piece in the right place. The exact web-worker bundle splitting is probably the game's responsibility, but the engine has to know about web workers, so the separation isn't perfectly clean. Figure out how to export things to accommodate this.
- The engine also exports a server entrypoint, agnostic to where it runs.

- "Zero dependencies" means zero *runtime* npm dependencies in the engine package. devDependencies are fine. An `engine/vite` plugin entrypoint is compatible (Node built-ins only; Vite is a types-only optional peer).
- The engine takes an injected transport adapter. On Node, which has no built-in WebSocket server, the *game's* server package installs `ws` and passes it in; the engine does not hand-roll the protocol.
- Rust crate policy: `serde` and `postcard` are allowed in the engine crate, `ts-rs` at build time; anything else needs an ADR. Stable Rust only (so no WASM threads).
- Publishing: packaging discipline in a private repo for now (the Rust crate is bundled inside the npm package; a tarball-install test keeps it honest). Not published publicly yet.
- Server runtimes: Node ≥ 22 and Bun are tested; Deno is best-effort.

### Platform requirements and budgets

- **Cross-origin isolation is mandatory** for every game (COOP `same-origin` + COEP `require-corp`), so SharedArrayBuffer is always available. There is no `postMessage` fallback.
- Baseline phone: iPhone 12-class / 4 GB Android. At most 256 MB per WASM instance; 64 MiB default world budget.
- Download: game `.wasm` ≤ 1 MB brotli (warn), 2 MB (fail).

### Consequence of "games are written in Rust"

Because the game crate and engine crate link into one WASM module, the engine **cannot ship a prebuilt WASM binary**. The engine is delivered as an npm package (main-thread client, worker bootstrap, server bootstrap) *plus* Rust crate(s), and the game's build produces the WASM. Every game therefore needs a Rust toolchain in its build, and the engine should make that painless.

## Open questions

- **JS↔WASM boundary.** Decided in [0014](../decisions/0014-js-wasm-boundary.md).
- **Cross-thread communication.** Decided in [0015](../decisions/0015-threads-memory-and-topology.md).
- **Worker topology.** Decided in [0015](../decisions/0015-threads-memory-and-topology.md) and [0018](../decisions/0018-renderer.md).
- **What "zero GC" means, measurably.** Decided in [0016](../decisions/0016-zero-gc-definition.md).
- **Exports map.** Decided in [0017](../decisions/0017-packaging-and-build.md).
- **Rust build pipeline.** Decided in [0017](../decisions/0017-packaging-and-build.md).
- **Rust dependency policy.** Decided in [0017](../decisions/0017-packaging-and-build.md); the `serde_json` exception is argued in [0003](../decisions/0003-game-facing-api.md).
- **Zero npm dependencies vs. a WebSocket server.** Decided in [0009](../decisions/0009-transport-and-hosting.md).
- **WASM memory behavior.** Decided in [0015](../decisions/0015-threads-memory-and-topology.md) and [0014](../decisions/0014-js-wasm-boundary.md).
- **One module, several roles.** Decided in [0015](../decisions/0015-threads-memory-and-topology.md).
- **Publishing.** Decided in [0017](../decisions/0017-packaging-and-build.md).
- **Server runtime.** Decided in [0009](../decisions/0009-transport-and-hosting.md) and [0002](../decisions/0002-determinism-same-wasm-everywhere.md).
