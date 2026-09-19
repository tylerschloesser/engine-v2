# Spike result: Vite consumer of a worker-shipping engine package + cargo-only game WASM

Covers S1 and the build-pipeline part of S3 from `docs/research/runtime-and-packaging.md`. Run 2026-09-19. Throwaway code.

## Verdict

Everything in scope works. One deterministic failure mode was found (pattern A + symlinked engine outside a workspace root, dev only). Nothing was flaky: the final matrix was 192/192.

## Versions

Vite 8.3.0 (Rolldown), TypeScript 7.0.2, Playwright 1.63.0 (Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6), binaryen 132 (npm, spike-only), Node 22.18.0, pnpm 11.25.0, Bun 1.3.8, rustc/cargo 1.93.0, macOS 26.6.2, Apple M3 Max. No wasm-bindgen, no wasm-pack.

## What was built

- `engine/`: fake npm package `fake-engine`, zero runtime deps, `tsc`-compiled. Exports `.` (`dist/client.js`), `./worker` (`dist/worker.js`, exports `run()`), `./vite` (`dist/vite.js`, Node built-ins only). `dist/worker-auto.js` is the two-line pattern-A entry (`import { run } from './worker.js'; run()`). Rust crate shipped inside it at `crates/engine` (`Game` trait, `export_game!` `macro_rules!`, imports `engine.panic` / `engine.log`).
- `game/`: Vite app that installs `engine/fake-engine-0.0.1.tgz` (`pnpm pack` output; lands in `node_modules/.pnpm/...`, not a workspace link). `game/sim` is the cdylib; it depends on the engine crate by `path = "../node_modules/fake-engine/crates/engine"`.
- `game/bare/`: control app with an empty Vite config and no engine plugin.

## Proven (ran it, saw it pass)

1. **Cargo-only pipeline.** `cargo build --target wasm32-unknown-unknown --release` on the game crate, with the engine crate as a path dep through pnpm's `node_modules` symlink, produces the `.wasm`. `WebAssembly.Module.imports` is exactly `engine.panic, engine.log`. Exports are `engine_abi_version, engine_init, engine_tick, engine_state_hash, engine_add` plus the linker's `memory, __data_end, __heap_base`. Asserted in the browser on every `compile=main` run, and again after `wasm-opt`.
2. **Matrix, tarball install: 192/192.** {dev, build+preview} x {`optimizeDeps.exclude` on, off} x {`worker.format` `'es'`, Vite default} x {pattern A, B} x {wasm URL from plugin virtual module, from game-side `?url`} x {compile on main + `postMessage(Module)`, `instantiateStreaming` inside the worker} x {Chromium, Firefox, WebKit}. Each run asserts: worker instantiated the wasm, `add(40,2)` round-tripped main -> worker -> wasm -> main as 42, ABI version matched, `engine.log` message arrived, a deliberate Rust panic arrived through `engine.panic` with its message, 1000 ticks gave the same state hash everywhere (3819726183), wasm `Content-Type` was `application/wasm`, and in preview the wasm URL was a hashed `/assets/*.wasm` (not inlined).
3. **`optimizeDeps.exclude` is NOT required in Vite 8.3.** With it off, the engine really is pre-bundled (`node_modules/.vite/deps/fake-engine.js`) and pattern A still works: Vite rewrites the worker URL to the real file (`/node_modules/.pnpm/fake-engine@.../dist/worker-auto.js?worker_file&type=module`). See `test/probe-dev.mjs`.
4. **`worker.format: 'es'` is NOT required** for this worker (no dynamic imports / code splitting). The default emits an IIFE worker that still loads under `{ type: 'module' }`. It would become required if the worker ever code-splits.
5. **A `WebAssembly.Module` compiled on main can be posted to a worker and instantiated** in Chromium, Firefox and Playwright WebKit. (Playwright WebKit is not Safari; real Safari was not tested.)
6. **Zero-config control** (`game/bare`, no plugin, no headers, wasm built by hand, `?url` import): patterns A and B pass in dev and build+preview.
7. **Both ways of getting the wasm to the worker work.** Plugin virtual module `virtual:engine/wasm-url`: dev serves `/@engine/game.wasm?v=N` from a middleware with `application/wasm`; build uses `this.emitFile` + `import.meta.ROLLUP_FILE_URL_<ref>` (works under Rolldown). Game-side `import url from '../sim/target/wasm32-unknown-unknown/release/sim.wasm?url'` also works, but the path bakes in the cargo profile and the file must exist before Vite starts, so the virtual module is the better API. When both were used in one build, Vite emitted a single deduplicated `sim-<hash>.wasm`.
8. **Plugin behaviour.** Cargo build on start (`buildStart`, once), `fs.watch` recursive rebuild on `.rs`/`Cargo.toml` change, `server.ws.send({type:'full-reload'})`, and cargo errors forwarded to Vite's error overlay with rustc's message, then recovery after the fix (`test/overlay.mjs`). With a linked engine, editing the engine crate also triggered a rebuild (252 ms to reload sent).
9. **Same `.wasm` in Node 22.18 and Bun 1.3.8** through the same loader shape: same hash 3819726183 (`test/node-bun.mjs`).
10. Everything above ran with COOP/COEP `require-corp` headers on (`crossOriginIsolated === true`), except the bare control (`false`). Both fine.

## Failed / caveats

- **Pattern A fails in `vite dev` when the engine is a symlink (`link:../engine`) and there is no workspace root marker.** Error in the page: `worker error: unknown`; Vite log: `The request id ".../engine/dist/worker-auto.js" is outside of Vite serving allow list.` `client.js` is served (it is in the module graph) but the worker URL is a fresh request outside `server.fs.allow`. Build+preview is unaffected, pattern B is unaffected (16/64 failed, all dev + A). Adding a `pnpm-workspace.yaml` above both packages fixed it (Vite's workspace-root search then allows the path), so the in-repo reference game should be fine. Untested idea: have the plugin add the engine's real directory to `server.fs.allow`.
- **Native `cargo test` of the game crate could not be verified on this machine**: linking failed with `You have not agreed to the Xcode license agreements` (`sudo xcodebuild -license`). Environment issue, unrelated to the design; wasm builds use `rust-lld` and are unaffected. It compiled up to the link step, including the native cdylib.
- **`wasm-opt` rejects the stripped module unless features are passed explicitly.** Error: `memory.copy operations require bulk memory operations [--enable-bulk-memory-opt]`. Rust 1.93 enables bulk-memory, sign-ext, mutable-globals, nontrapping-fptoint, multivalue and reference-types by default on `wasm32-unknown-unknown`, and `strip = true` removes the `target_features` section `wasm-opt` detects them from. Fix: pass the `--enable-*` flags (see `test/sizes.mjs`). `wasm-opt` came from npm `binaryen` (a JS/wasm build, slower than native).
- Not tested: real Safari, a wasm under Vite's 4 KB `assetsInlineLimit` via `?url`, a worker that code-splits, Windows/Linux `fs.watch`.
- Re-packing the tarball with an unchanged version: pnpm reinstalled without complaint here, but the tarball contents were identical; behaviour with changed contents and an existing lockfile integrity hash was not checked.

## Measured numbers

Dev loop, warm incremental, save `.rs` -> new value visible on the page (Chromium, pattern B, median):

| Game crate | Profile | cargo | save -> page |
|---|---|---|---|
| trivial (~45 lines) | dev (`opt-level=1`, deps 3) | 140 ms | **220 ms** (n=6) |
| trivial | release (fat LTO, cgu=1) | 125 ms | 201 ms (n=6) |
| synthetic 36k lines, 3000 fns, one crate, no deps | dev | 395 ms | **573 ms** (n=5) |
| synthetic 36k lines | release (no incremental, fat LTO) | 3832 ms | 4072 ms (n=3) |

Fixed overhead outside cargo is ~80 ms (watcher fires at +11 ms, 30 ms debounce, process spawn, reload, fetch + compile). Cold builds: trivial release ~0.2 s from an empty target dir (1.7 s the very first time, including lockfile); synthetic crate cold 7.3 s dev, 3.9 s release. These are floors on a fast machine: no third-party crates, no generics-heavy code. The research estimate of 1-4 s is not contradicted, but the pipeline itself adds almost nothing.

Size of the trivial module (std, `Vec`, panic hook that formats the message), bytes:

| Release profile (`lto="fat"`, `codegen-units=1`, `panic="abort"`, `strip=true`) | raw | gzip -9 | brotli 11 |
|---|---|---|---|
| `opt-level=3` | 19,836 | 8,500 | 7,263 |
| + `wasm-opt -O3` | 16,680 | 7,596 | 6,434 |
| + `wasm-opt -Oz` | 16,623 | 7,583 | 6,463 |
| `opt-level="s"` | 20,954 | 8,976 | 7,706 |
| + `wasm-opt -O3` / `-Oz` | 17,379 / 17,323 | 8,006 / 7,986 | 6,847 / 6,837 |
| `opt-level="z"` | 20,892 | 9,138 | 7,869 |
| + `wasm-opt -O3` / `-Oz` | 17,431 / 17,377 | 8,101 / 8,096 | 6,863 / 6,908 |
| dev profile (debuginfo) | 1,507,880 | 392,815 | 306,450 |

At this size `s`/`z` do not beat `3`; the ~20 KB is std's allocator + panic/fmt machinery, i.e. the fixed floor. `wasm-opt` saves ~16% raw, ~11% brotli, ~0.45 s. The dev-profile wasm is 1.5 MB (8 MB for the synthetic crate) because of DWARF; irrelevant on localhost but worth `debug = "line-tables-only"` if it ever matters.

## Minimal required game-side config

`vite.config.ts`: nothing is strictly required for worker + wasm to function (the bare control passed). With the plugin:

```ts
import { defineConfig } from 'vite'
import { engine } from '<engine>/vite'
export default defineConfig({ plugins: [engine({ crate: './sim' })] })
```

The plugin may keep injecting `worker.format: 'es'` and `optimizeDeps.exclude` as belt and braces (both harmless, both verified), but S1 shows neither is needed on Vite 8.3. COOP/COEP headers are an S2 concern; they did not interfere.

`sim/Cargo.toml` (as used):

```toml
[package]
name = "sim"
edition = "2024"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
engine = { path = "../node_modules/<engine>/crates/engine" }

[profile.dev]
opt-level = 1
[profile.dev.package."*"]
opt-level = 3

[profile.release]
opt-level = "s"      # 3 was smaller AND presumably faster for the trivial module; re-measure with a real sim
lto = "fat"
codegen-units = 1
panic = "abort"
strip = true
```

plus `rust-toolchain.toml` (`channel = "stable"`, `targets = ["wasm32-unknown-unknown"]`) and `engine::export_game!(MyGame);`. Edition 2024 notes: exports need `#[unsafe(no_mangle)]`, import blocks need `unsafe extern "C"`, and the macro's global uses an `UnsafeCell` wrapper rather than `static mut`. Keep the game crate out of an ancestor directory of `node_modules` with a `[workspace]` table, or cargo will try to treat the engine crate as a workspace member (not tested, standard cargo behaviour).

## Recommendation: default to pattern A, keep `createWorker` (pattern B) as the escape hatch

A passed every tarball case in three browsers, in dev and build, with and without pre-bundling, so the historical `node_modules` detection problem is gone in Vite 8.3 and the game needs zero worker code. Its only failure is deterministic, has a clear message in the Vite log, happens only for a symlinked engine outside a workspace root, and B fixes it in two lines. Supporting both costs one optional `createWorker` option in the client. If the project wants exactly one pattern, choose B: it never failed, and it also survives non-Vite bundlers.

## How to re-run

`dist/`, `*.tgz`, `node_modules/`, `target/` are git-ignored, so rebuild first. `--ignore-workspace` keeps pnpm from looking for a workspace above the spike.

```sh
cd spikes/vite-lib-worker-wasm/engine
pnpm install --ignore-workspace && pnpm build && pnpm pack
cd ../game
pnpm install --ignore-workspace && npx playwright install chromium firefox webkit
(cd sim && cargo build --target wasm32-unknown-unknown --release)   # the `?url` import needs this file to exist

BROWSERS=chromium,firefox,webkit node test/run.mjs   # full matrix -> test/matrix-result.json (~1 min)
node test/probe-dev.mjs 0        # shows the engine is pre-bundled and pattern A still resolves its worker
node test/devloop.mjs dev 6      # dev-loop timing; `release` for the release profile
node test/gen-bulk.mjs 3000      # synthetic crate: then add `mod bulk;` + a `bulk::run_all(&mut self.cells, x)` call in tick(); remove afterwards
node test/sizes.mjs              # sizes -> test/sizes-result.json
node test/overlay.mjs            # cargo error -> Vite overlay -> recovery
node test/bare.mjs               # zero-config control
node test/node-bun.mjs && bun test/node-bun.mjs
```

Linked-engine variant: change the game's dependency to `"fake-engine": "link:../engine"`, reinstall, run `node test/run.mjs` (results kept in `test/matrix-result.link-chromium.json`); `node test/probe-status.mjs` shows the allow-list error; add a `pnpm-workspace.yaml` listing `engine` and `game` in the spike root to see it pass.
