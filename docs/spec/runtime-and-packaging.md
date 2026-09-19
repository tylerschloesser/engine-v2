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

- **JS↔WASM boundary.** wasm-bindgen (generated glue tends to allocate) vs. a hand-rolled ABI over linear memory; how much glue the zero-GC goal tolerates.
- **Cross-thread communication.** SharedArrayBuffer + Atomics (ring buffers, shared state) vs. `postMessage` with transferables (structured clone creates garbage). SAB requires cross-origin isolation (COOP/COEP headers): what does that demand of the game's dev server and production hosting, and does it break anything the game might embed?
- **Worker topology.** Which workers exist (sim, render via OffscreenCanvas, chunk generation pool, network decode), who owns which memory, and whether WASM threads (shared memory across workers) are worth their constraints.
- **What "zero GC" means, measurably.** Proposed: after load, the steady-state hot paths (frame loop, tick, message handling) allocate nothing on the JS heap. DOM UI and one-time setup are exempt. Define how it's measured (see `testing.md`).
- **Exports map.** Entry points (e.g. `engine`, `engine/worker`, `engine/server`), how `new Worker(new URL(...))` and `.wasm` assets resolve under Vite when they originate in a library, and exactly what a game must configure. Verify against the current Vite version with a spike.
- **Rust build pipeline.** cargo + wasm-bindgen-cli, wasm-pack, or a Vite plugin; how the engine crate reaches the game (in-repo path, crates.io, bundled in the npm package); rebuild speed and what the dev loop (edit Rust → see change) feels like.
- **Rust dependency policy.** "Zero dependencies" is stated for npm. What's the bar for crates (e.g. serialization, noise is the game's problem, wgpu if the renderer is Rust)?
- **Zero npm dependencies vs. a WebSocket server.** Node ships a WebSocket *client* but (verify) no server; `ws` would be a runtime dependency. Bun, Deno, and workerd have built-in servers. Options: the engine's server entrypoint takes a transport adapter injected by the host (which also serves host-agnosticism), hand-rolls the upgrade over `node:http`, or targets only runtimes with a built-in server.
- **WASM memory behavior.** Linear memory never shrinks, `memory.grow` detaches every JS `ArrayBuffer` view (a zero-GC and correctness hazard for cached views; shared memory behaves differently), and mobile Safari's practical ceiling is well under 4 GB. Decide between preallocating a fixed arena sized from the game's world cap and growing on demand.
- **One module, several roles.** A multiplayer client still loads the game's WASM (prediction, decode, possibly worldgen and rendering), and single-player loads it as the sim too. One module instantiated in several places, or separate client/sim builds for size? What is the download-size budget on mobile?
- **Publishing.** Is the package actually published publicly (name/scope, license, crates.io for the Rust side), or is "published" a packaging discipline for a private repo? A Tyler question; it affects how the engine crate reaches a game.
- **Server runtime.** Which JS runtimes the server entrypoint supports (Node, Bun, Deno, workerd) and how each loads the WASM module; or whether the server is a native Rust binary instead (ties to determinism in `simulation.md` and hosting in `sync.md`).
