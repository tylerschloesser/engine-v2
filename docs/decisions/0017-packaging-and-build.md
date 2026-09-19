# 0017: Packaging and build

Status: Accepted (2026-09-19). Amended by [0024](0024-planning-amendments.md) §13.

## Context

Requirements in [`../spec/runtime-and-packaging.md`](../spec/runtime-and-packaging.md) fix: a pnpm monorepo; one engine npm package with zero runtime dependencies and several entrypoints; the Rust crate shipped inside that package; stable Rust; the crate allowlist; private packaging discipline; tested server runtimes; the `.wasm` size budget. Because the game's build produces the `.wasm`, the engine ships prebuilt JS plus Rust source, and must make a Rust toolchain in every game's build painless. Fixed elsewhere: the ABI and loader ([0014](0014-js-wasm-boundary.md)), which workers exist and that main compiles the module once ([0015](0015-threads-memory-and-topology.md)), the adapter interface ([0009](0009-transport-and-hosting.md)), the `ts-rs`/`serde_json` use ([0003](0003-game-facing-api.md)), the test entrypoint and rebuild target ([0020](0020-testing-strategy.md)). `spikes/vite-lib-worker-wasm` measured the rest on Vite 8.3.

## Decision

**1. Layout.** One pnpm workspace (`packages/*`, `games/*`) and one cargo workspace (root `Cargo.toml`: members, `[profile.*]`, shared lints of [0002](0002-determinism-same-wasm-everywhere.md); one `Cargo.lock`, one `target/`).

```
pnpm-workspace.yaml  Cargo.toml  Cargo.lock  rust-toolchain.toml
packages/engine/             the one publishable package; working name `engine`, "private": true for now
  src/ -> dist/              TypeScript, compiled by `tsc` (no bundler): client, worker, server, adapters, vite, test
  crates/engine/             the Rust crate; listed in "files", so it ships inside the npm tarball
  fixtures/<name>/           tiny fixture game crates (0020); not in "files"
games/reference/             private Vite app: vite.config.ts, src/ (bootstrap + DOM UI), src/bindings/ (generated), sim/ (game crate, cdylib + rlib)
games/reference-server/      private; depends on `engine` and `ws`; constructs the WebSocketServer and injects it (0009)
```

In-repo, `games/reference` depends on the package by `workspace:*` and on the crate by a direct relative path (`../../../packages/engine/crates/engine`), never through `node_modules`, so cargo sees the crate at one path inside one workspace. The `node_modules` path is what external games use, and the tarball test (8) covers it.

**2. Exports map.** Explicit subpaths, no runtime conditions.

```jsonc
{
  "name": "engine", "private": true, "type": "module", "sideEffects": false,
  "files": ["dist", "crates"],
  "exports": {
    ".":              { "types": "./dist/client.d.ts",      "default": "./dist/client.js" },      // main thread: createClient
    "./worker":       { "types": "./dist/worker.d.ts",      "default": "./dist/worker.js" },      // run(): every worker kind of 0015
    "./server":       { "types": "./dist/server.d.ts",      "default": "./dist/server.js" },      // createWorldServer; web-standard APIs only
    "./server/node":  { "types": "./dist/server-node.d.ts", "default": "./dist/server-node.js" }, // node:fs, structural `ws` typing
    "./server/bun":   { "types": "./dist/server-bun.d.ts",  "default": "./dist/server-bun.js" },
    "./server/deno":  { "types": "./dist/server-deno.d.ts", "default": "./dist/server-deno.js" }, // best-effort
    "./vite":         { "types": "./dist/vite.d.ts",        "default": "./dist/vite.js" },        // engine() plugin + buildGame(); Node built-ins only
    "./virtual":      { "types": "./dist/virtual.d.ts" },                                         // declares `virtual:engine/wasm`
    "./test":         { "types": "./dist/test.d.ts",        "default": "./dist/test.js" },        // 0020 section 8; never imported by production code
    "./package.json": "./package.json"
  },
  "dependencies": {},
  "peerDependencies": { "vite": "^8.0.0" }, "peerDependenciesMeta": { "vite": { "optional": true } }
}
```

`dist/worker.js` is one self-contained ES module (no bare imports, no shared chunks, no dynamic `import()`); the worker kind arrives in the setup message ([0015](0015-threads-memory-and-topology.md)), so there is one worker script however many workers run. `dist/worker-auto.js` (`import { run } from './worker.js'; run()`) is internal. A Durable Object adapter subpath is added with the work deferred in [0009](0009-transport-and-hosting.md).

**3. Who constructs workers: pattern A by default, pattern B as the escape hatch.** A: `dist/client.js` contains `new Worker(new URL('./worker-auto.js', import.meta.url), { type: 'module' })`; the game writes no worker code. B: the game has a two-line `worker.ts` (`import { run } from 'engine/worker'; run()`) and passes `createClient({ createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) })`. Measured: both passed 192/192 (tarball install; dev and build+preview; pre-bundled and excluded; Chromium, Firefox, WebKit). A's one failure is deterministic: `vite dev` with the engine reached through a symlink (`link:`) and **no workspace-root marker** above both packages, where the worker URL falls outside `server.fs.allow` (16/64, all dev + A; message in the Vite log). This repo avoids it by construction (the root `pnpm-workspace.yaml` puts the engine inside Vite's workspace-root allow list), tarball installs are unaffected, and the plugin additionally appends the engine package's real directory to `server.fs.allow` (keeping Vite's default root). B is the documented fix for anything else, including non-Vite bundlers.

**4. How the `.wasm` travels.** It is data, never a JS import. `buildGame()` (5) writes `game.wasm` and `game.json` (`{ buildHash, abiVersion, profile }`) to `<crate>/target/engine/<profile>/`.
- *Browser:* `import wasm from 'virtual:engine/wasm'` yields `{ url, buildHash }`, passed whole to `createClient({ canvas, wasm })`. Dev: a middleware serves the file as `application/wasm` with a `?v=N` cache-buster. Build: `this.emitFile` + `import.meta.ROLLUP_FILE_URL_<ref>` gives a hashed `/assets/*.wasm`, never inlined (works under Rolldown). Main calls `WebAssembly.compileStreaming(fetch(url))` once and posts the `Module` ([0015](0015-threads-memory-and-topology.md)); a worker handed a URL instead calls `instantiateStreaming` itself. Both paths passed the whole matrix, so the second is the fallback if real Safari (untested) refuses a posted `Module`. A game-side `?url` import of cargo's output also works but bakes the profile into a path that must exist before Vite starts; it is not the API.
- *Server:* each adapter exports `loadGame(dir): Promise<{ wasm: WebAssembly.Module, buildHash: string }>`; Node, Bun and Deno read the bytes and `WebAssembly.compile` them (one loader shape gave the same state hash under Node 22.18 and Bun 1.3.8). `wasm` goes into `HostServices`, `buildHash` into the world config ([0009](0009-transport-and-hosting.md)). workerd can only import a precompiled module and takes the hash from `game.json`.
- *Build hash* = SHA-256 (`node:crypto`) of the final bytes, after `wasm-opt` if it ran; it is the handshake token of [0013](0013-sessions-and-integrity.md) and the log-segment stamp of [0005](0005-persistence-and-recovery.md). Client asset and server file are copies of the same `game.wasm`, so one build feeds both. `vite dev` uses the dev profile and `vite build` release (`engine({ profile })` overrides), so a dev client cannot join a release server, by design.

**5. Build pipeline: plain cargo, driven by the engine's Vite plugin.** `buildGame({ crate, profile })` runs `cargo build --target wasm32-unknown-unknown [--release]` on the game's cdylib, then `wasm-opt` if requested and found on `PATH`, then hashes; the plugin, `pnpm test` and the server package's scripts all call it. No wasm-bindgen, no wasm-pack, no other tool. The plugin: builds once in `buildStart`; in dev watches the game crate and the engine crate (`fs.watch` recursive, `.rs`/`Cargo.toml`, 30 ms debounce), sends `full-reload` on success, and forwards rustc's message to Vite's error overlay on failure, recovering after the fix; sets COOP/COEP on `server.headers` and `preview.headers` ([0015](0015-threads-memory-and-topology.md)), `worker.format: 'es'` (dev and build then load the same module form) and the `fs.allow` entry. It does **not** set `optimizeDeps.exclude`: the pre-bundled engine resolved its worker correctly. Measured save → page, warm, median: **220 ms** (trivial crate), **573 ms** (synthetic 36k-line crate) on the dev profile; 4.1 s for that crate on release; about 80 ms of it is outside cargo. These are floors (M3 Max, no third-party crates).
- **Bindings step.** After a successful build the plugin runs, without gating the reload, `TS_RS_EXPORT_DIR=<game>/src/bindings cargo test export_bindings` natively ([0003](0003-game-facing-api.md)); generated files are committed so `tsc` works on a fresh clone. It needs a native linker (macOS: the `DEVELOPER_DIR` note in [0020](0020-testing-strategy.md)).
- **`wasm-opt`** is optional, off in dev and tests, never an npm dependency. It must be passed `--enable-bulk-memory --enable-bulk-memory-opt --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int --enable-multivalue --enable-reference-types`: `strip = true` removes the `target_features` section it would detect them from, and it otherwise rejects the module. It saved ~16% raw, ~11% brotli for ~0.45 s.

**6. What a game writes.**

```ts
// vite.config.ts                       // tsconfig: "types": ["engine/virtual"]
import { defineConfig } from 'vite'
import { engine } from 'engine/vite'
export default defineConfig({ plugins: [engine({ crate: './sim' })] })
```

```toml
# sim/Cargo.toml  (plus rust-toolchain.toml: the exact stable pin of section 10)
[package]
name = "sim"
edition = "2024"
[lib]
crate-type = ["cdylib", "rlib"]        # cdylib -> the .wasm; rlib -> native tests and the bindings step
[dependencies]
engine = { path = "../node_modules/engine/crates/engine" }
[profile.dev]
opt-level = 1
[profile.dev.package."*"]
opt-level = 3                          # the engine and other deps stay fast in dev
[profile.release]
opt-level = 3                          # "s"/"z" were larger on the spike module; re-measure with a real sim
lto = "fat"
codegen-units = 1
panic = "abort"                        # 0014
strip = true
```

and `engine::export_game!(MyGame);` in `lib.rs`. An external game crate must not have a `[workspace]` table in an ancestor directory of its `node_modules`, or cargo tries to adopt the engine crate as a member (standard cargo behaviour, untested); in this repo the profiles live in the root `Cargo.toml` (cargo ignores member profiles). Production hosting must send the two headers on every path; the reference game's README carries the host recipes of [0015](0015-threads-memory-and-topology.md).

**7. Rust dependency policy.** Engine crate runtime dependencies are exactly: `serde` (`derive`, `alloc`), `postcard` (`default-features = false, features = ["alloc"]`, which drops `heapless`), `serde_json` (the exception argued in [0003](0003-game-facing-api.md)), `ts-rs` (nothing of it is reachable from an export, so LTO removes it; the size test watches this), and `libm` pinned with `=` if the engine ever needs a transcendental ([0002](0002-determinism-same-wasm-everywhere.md)). Anything else needs an ADR that shows: no transitive `wasm-bindgen`/`js-sys`/`web-sys`; no ambient time, randomness, threads or seeded hashing; no build script or proc-macro unless unavoidable; measured size; MIT/Apache. PRNG, hasher and noise helpers are owned code. Dev-dependencies are unrestricted. Game crates are the game's choice, gated mechanically by the import allowlist ([0014](0014-js-wasm-boundary.md)) and the lint bans ([0002](0002-determinism-same-wasm-everywhere.md)). npm: zero runtime dependencies; `vite` is an optional types-only peer; everything else is a devDependency.

**8. Publishing.** Not published; name, scope and license are chosen when there is a reason to publish. Discipline is kept by a **tarball-install test**: `pnpm pack` the engine, install the `.tgz` with `--ignore-workspace` into a fresh scratch Vite app outside both workspaces (no lockfile, so a re-packed unchanged version cannot hit a stale integrity hash), path-depend on `node_modules/engine/crates/engine`, then run dev and build+preview with patterns A and B and assert the round trip, `application/wasm`, a hashed non-inlined asset, and the import allowlist. This is the only test that sees a pre-bundled engine, because linked workspace packages are treated as source.

**9. Size budgets and profiles.** Budgets are owned by Requirements and [0015](0015-threads-memory-and-topology.md) (`.wasm` ≤ 1 MB brotli warn, 2 MB fail; engine JS ≤ 50 KB brotli), measured on the release `game.wasm` at brotli 11. Baseline, stub engine + trivial game with std, `Vec` and a formatting panic hook: **19,836 B raw / 7,263 B brotli** (`opt-level = 3`); 16,680 / 6,434 after `wasm-opt -O3`. That is the fixed floor of allocator plus panic/fmt. The dev-profile module is 1.5 MB raw (8 MB for the synthetic crate) because of DWARF and is never measured against the budget.
**Fast tier = dev profile.** `pnpm test` builds native test binaries and the `.wasm` on the dev profile (incremental, no LTO), including the `vite build` of the packaging smoke (`profile: 'dev'`); that is how the ≤ 30 s target of [0020](0020-testing-strategy.md) is met. The release profile is built by `vite build`, and in the slow tier by the size test, the tarball test, and a replay of the golden hashes on the release module (hashes were identical across `opt-level` 3 and `"s"` in [0002](0002-determinism-same-wasm-everywhere.md)).

**10. Toolchain.** Exact pins, so every session, worktree and CI run uses the same tools. Requirements say stable Rust; an exact stable release satisfies that, and a floating `channel = "stable"` would let a toolchain update change codegen, and with it the build hash ([0005](0005-persistence-and-recovery.md)), between two machines.

```toml
# rust-toolchain.toml (repo root; an external game ships the same file)
[toolchain]
channel = "1.93.0"                     # the release the Rust-building spikes ran on
targets = ["wasm32-unknown-unknown"]
components = ["rustfmt", "clippy"]
```

| Tool | Pin | Where | Evidence |
|---|---|---|---|
| Rust | 1.93.0 | `rust-toolchain.toml` | spikes `vite-lib-worker-wasm`, `determinism-hash` |
| Node | ≥ 22.18 (`engines`; `.node-version` = 22.18.0) | root `package.json` | both spikes ran on 22.18.0; Vite 8.3.0 needs `^20.19.0 \|\| >=22.12.0`, Vitest 5.0.1 `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` |
| pnpm | 11.x (`packageManager: "pnpm@11.25.0"`) | root `package.json` | spike: 11.25.0 |
| Bun | 1.3.8 | Bun leg of the WASM suite ([0020](0020-testing-strategy.md)) only | spike: same state hash as Node |
| Vite | 8.3.0 | devDependency (peer range stays `^8.0.0`) | spike matrix |
| TypeScript | 7.0.2 | devDependency | spike |
| `@playwright/test` | 1.63.0 (bundled Chromium 153) | devDependency | spikes `vite-lib-worker-wasm`, `zero-gc-webgpu` |
| Vitest | 5.0.1 | devDependency | `npm view vitest version`, 2026-09-19; its `vite` peer range includes `^8.0.0` |
| cargo-nextest | 0.9.145 | `cargo install cargo-nextest --locked --version 0.9.145` | `cargo search cargo-nextest`, 2026-09-19 |
| Biome | 2.5.14 | devDependency `@biomejs/biome`, installed with `-E` | `npm view @biomejs/biome version`, 2026-09-19 |

npm devDependencies are exact versions (no `^`), and `pnpm-lock.yaml` and `Cargo.lock` are committed. Bumping a pin is an ordinary commit that re-runs both tiers; a Rust or Playwright bump also re-checks the golden hashes ([0002](0002-determinism-same-wasm-everywhere.md)) and the zero-GC negative controls ([0016](0016-zero-gc-definition.md)).

**Formatting and linting.** TypeScript, JavaScript and JSON: **Biome**, one devDependency and one native binary that formats, lints and sorts imports, configured by one root `biome.json`. Rust: `rustfmt` and `clippy` from the pinned toolchain, with the workspace lints of [0002](0002-determinism-same-wasm-everywhere.md). The commands:

| Purpose | Command |
|---|---|
| Check TS/JS/JSON (format + lint, writes nothing) | `pnpm exec biome check .` |
| Fix TS/JS/JSON | `pnpm exec biome check --write .` |
| Check Rust formatting | `cargo fmt --check` |
| Fix Rust formatting | `cargo fmt` |
| Lint Rust (compiles, so not in the hook) | `cargo clippy --workspace --all-targets -- -D warnings` |
| Type-check TypeScript (Biome does not) | `pnpm exec tsc --noEmit` per package |

The two check rows that need no compile (Biome, `cargo fmt`) are the commit hook of [0021](0021-context-architecture.md). `pnpm lint` runs all four checks; its place next to `pnpm test` is in [0020](0020-testing-strategy.md) section 2.

## Alternatives rejected

- **wasm-pack, wasm-bindgen:** generated per-build glue cannot be imported by a prebuilt loader, and an exact CLI/crate version lock enters every game's build ([0014](0014-js-wasm-boundary.md)). `@wasm-tool/rollup-plugin-rust` and `vite-plugin-wasm` assume wasm-bindgen; the first has 7 runtime dependencies.
- **A separate prebuilt engine `.wasm`:** impossible while game and engine link into one module (Requirements); two modules would mean a second ABI between them and a call per game hook.
- **Publishing the crate on crates.io now:** two registries to keep in lockstep for one private consumer; loader and ABI are one version-locked interface, and one tarball makes skew impossible. crates.io can become a mirror later.
- **Export conditions (`node`/`bun`/`workerd`/`browser`) for runtime selection:** condition sets differ between Vite, wrangler and Bun; subpaths are predictable and keep `node:`/`Bun.`/`Deno.` out of the portable core.
- **Requiring `optimizeDeps.exclude` or `worker.format` from the game:** measured unnecessary on Vite 8.3 (fixed by Vite PR #21434).
- **Pattern B only:** never failed, but costs every game a file and an option for a failure this repo and tarball installs cannot hit. **`?url` as the API:** above. **A bundled engine `dist`:** `tsc` output passed everything; a bundler adds a build step and nothing else.
- **Release profile in the fast tier:** fat LTO disables incremental compilation; 10x slower on the synthetic crate.
- **ESLint + Prettier:** two tools, two configs and a plugin chain (`typescript-eslint`, the Prettier-conflict config) where Biome is one pinned binary with one file; both start a Node process and ESLint's typed rules start the TypeScript program, which does not fit a commit gate that must stay under 3 s ([0021](0021-context-architecture.md)). Type-aware lint rules are given up; `tsc` and the tests cover what they would catch.
- **`channel = "stable"`:** floats with every Rust release, so two machines can build different `.wasm` bytes from one commit.

## Consequences

- Every game needs rustup; `rust-toolchain.toml` installs the pinned release, the `wasm32-unknown-unknown` target and the components on first build. A native linker is needed for bindings and native tests.
- Dev and release modules differ (overflow checks, debug assertions, `log` levels); only the slow tier proves the release module against golden hashes.
- A deploy must ship client and server from one `buildGame` output: a machine with `wasm-opt` and one without produce different hashes.
- Untested by the spike, first exercised in Phase 3: the plugin's `fs.allow` entry; real Safari with a posted `Module`; `fs.watch` recursive on Linux/Windows; a `.wasm` under Vite's 4 KB inline limit (moot: the floor is ~17 KB); `ts-rs` adding zero bytes.
- Deferred to Phase 2: whether `crates/` holds one crate or several, because it follows the module breakdown in `PLAN.md`; splitting is also the first lever if the dev loop slows.
- Deferred to Phase 3: the real release build time and size, whether an intermediate profile (thin LTO, incremental) is needed for browser-suite speed, `debug = "line-tables-only"` for smaller dev modules, and snapshot → reload → restore so a Rust edit keeps the world, because none can be measured without a real sim.

## Sources

- Spike: [`../../spikes/vite-lib-worker-wasm/RESULT.md`](../../spikes/vite-lib-worker-wasm/RESULT.md) (matrix, caveats, dev-loop and size tables, minimal config; `game/test/sizes.mjs` for the `wasm-opt` flags).
- [`../research/runtime-and-packaging.md`](../research/runtime-and-packaging.md) 1.1, 1.3, 1.7, 3.5–3.7, 3.9–3.12.
- Vite 8.3: https://vite.dev/guide/features.html#web-workers · https://vite.dev/config/worker-options.html · https://vite.dev/guide/dep-pre-bundling.html · https://vite.dev/config/server-options.html#server-fs-allow · https://github.com/vitejs/vite/pull/21434
- Node exports and WASM loading: https://nodejs.org/api/packages.html#conditional-exports · https://runtime-keys.proposal.wintertc.org/ · https://nodejs.org/api/esm.html#wasm-modules · https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/
- Crates (registry, 2026-09-19): postcard 1.1.3 features https://crates.io/crates/postcard · ts-rs 12.0.1 export via `cargo test export_bindings` and `TS_RS_EXPORT_DIR` https://docs.rs/ts-rs/12.0.1/ts_rs/ · serde 1.0.229 https://crates.io/crates/serde
- Toolchain (checked 2026-09-19): Biome 2.5.14 https://biomejs.dev/guides/getting-started/ (`biome check`, `-E` pinning) · https://biomejs.dev/reference/cli/ · Vitest 5.0.1 https://www.npmjs.com/package/vitest · cargo-nextest 0.9.145 https://crates.io/crates/cargo-nextest · toolchain file https://rust-lang.github.io/rustup/overrides.html#the-toolchain-file · versions of Rust, Node, pnpm, Bun, Vite, TypeScript and Playwright: the "Versions" line of the `vite-lib-worker-wasm` spike and the header of [`../../spikes/zero-gc-webgpu/RESULT.md`](../../spikes/zero-gc-webgpu/RESULT.md)
- wasm-pack status and the cargo-only view: https://github.com/wasm-bindgen/wasm-pack/releases · https://nickb.dev/blog/life-after-wasm-pack-an-opinionated-deconstruction/ · https://github.com/wasm-tool/rollup-plugin-rust
