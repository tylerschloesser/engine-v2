---
name: run-tests
description: Run this engine-v2 repo's test suites and read their output. Use whenever asked to run tests, run one test by name, check the browser suite, regenerate a golden, look at a running page, or serve the engine on a phone.
---

# Run tests

One entrypoint, quiet by default (docs/decisions/0020 §2): `pnpm test [suite] [-t pattern]` runs the
incremental build, then every fast-tier suite in parallel. One line per suite; a failure prints the
test name, message, seed (if any) and artefact paths, then nothing else. Non-zero exit on failure.
`pnpm test:slow` runs the slow tier the same way. `pnpm lint` (Biome, `cargo fmt --check`, clippy,
`tsc`) is a separate command, same quiet-on-success contract.

## Suites

`rust` (nextest) · `unit` (Vitest, pure TS) · `wasm` (Vitest against the built fixtures, plus a Bun
leg) · `netcode` (Vitest: the real server entrypoint + real `.wasm` + K `HeadlessClient`s over
in-memory `Connection`s behind a seeded conditioner, docs/decisions/0020 §7; `packages/engine/tests/
netcode/CLAUDE.md` for how to write a scenario) · `browser` (Playwright Test: `packages/engine/
playwright.config.ts`). Ids come from `scripts/suites.mjs`; that file is the registration point for
a new suite, nowhere else.

Run one test by name: `pnpm test <suite> -t "<substring>"`, e.g. `pnpm test wasm -t "import
allowlist"`, `pnpm test browser -t determinism`, `pnpm test unit -t "manual clock"`. `-t` is a plain
substring match, not a regex.

Reference game (M34b): `pnpm test browser -t reference_` (its `reference` Playwright project), `pnpm test wasm -t reference_`
(Node and Bun golden replay, persistence, state budget), `pnpm test rust -t golden_replay`, `pnpm test:slow -t reference_` (the two `test-hooks` tests); the zero-GC page is `pnpm test browser -t reference_single_player`; `pnpm --filter reference golden:record` regenerates the
full-game golden (a reviewed diff, never to make a red test pass).

## The slow tier and the benchmarks (M36)

`pnpm test:slow [suite] [-t pattern]` runs every `@slow` title and every nextest `slow_*` test, one line per suite, run one suite per call when you can (`browser` alone can pass 5 minutes). Layout: `rust` (`slow_tick_large_save`, `slow_snapshot_large_save`, `slow_heavy_large_save`, release-profile benches re-run themselves with `cargo test --release`), `wasm` (`heavy-n1 all logs`, `release-golden` on Node and Bun, `bench-build`, `highwater-large-save`), `netcode` (`soak-netcode`, `tick-large-save node`), `browser` (`soak-browser`, `webkit-readback`, the packaging tests, the engines leg), and **`frame-bench`**, its own `solo` suite that runs after every other suite has finished: `bench.frame_worstcase` and `bench.frame_reference` (`pnpm test:slow frame-bench -t bench.frame_reference`; `pnpm bench:frame` is the same project for the worst-case one). `bench.frame_reference` builds the reference game's bench build itself (`vite build --mode bench`, `games/reference/dist-bench/`, cargo feature `bench`).

Wall-clock benchmarks (`scripts/lib/bench-gate.mjs`, ADR 0020 §9, §10): each feeds `gate(name, sample)`, which **fails only when this machine's fingerprint (`os.cpus()[0].model` + `os.arch()`) equals the baseline's** and a gated metric is over 1.25 x its baseline or over its ADR limit; elsewhere (CI, another Mac) it only records. Every run writes `test-results/<suite>/bench/<name>.json` (`rust`, `netcode`, `frame-bench`) and prints a `warn:` line for a warn-only miss. Baselines live in `packages/engine/baselines/*.json` (`tick`, `tick-node`, `worldgen`, `frame`, `frame-reference`). **Regeneration rule: a baseline is rewritten only by `pnpm bench:baseline <name>`** (it promotes the newest record from this machine; run the benchmark several times first, review the diff, fill `conditions` by hand), and only for a change that is expected to cost more and was reviewed as such; a missed gate is reported with a profile (`profile-frame` skill), never handled by moving a baseline, a limit or the workload. Load matters: check `uptime` first, the machine is shared.

Soaks run on virtual time or stepped frames and stay short in wall-clock (`soak-netcode` about 8 s, `soak-browser` about 6 s). Their memory assertions are real: a leak injected into `RefGame::tick` turns each red (`arena exhausted` / `sim memory.buffer.byteLength` changed).

## First time / after a Playwright bump

`pnpm setup:tools` installs everything `pnpm test` cannot install itself: `cargo-nextest`, `bun`, and
the Playwright browsers (`playwright install chromium webkit firefox`, downloaded to
`~/Library/Caches/ms-playwright` or the platform equivalent, shared across every project on the
machine). `pnpm test` only probes pinned tools and tells you to run `pnpm setup:tools` if one is
missing or at the wrong version; it never installs anything itself.

## Reading output

Every suite's build/run log lands under `test-results/<suite>/` (gitignored), named in the failure
block's `artefact:` line. `test-results/browser/report.json` is Playwright's own `--reporter=json`
output (project name, per-test timing, `errors[]`, `attachments[]` for a trace) when run through
`pnpm test`; it is overwritten on every run, so read it right after a failing `pnpm test browser`.

## Build step timings

Every `pnpm test`/`pnpm test:slow` writes `test-results/build/timings.json` (`{ steps: [{ name,
ms }] }`, one entry per `scripts/suites.mjs` build step, in order), win or WARN; a `build WARN`
line also names its three slowest steps right there. Rule found the hard way (docs/plan/
17d-fast-tier-wall-time.md): every cargo invocation of the build must share one environment and
package-selection scope (`--workspace`, matching `cargo-tests`'s own `cargo nextest run
--workspace --no-run`) -- a mismatched scope (even with an *identical* env var value) dirties a
shared dependency's fingerprint and recompiles a crate on every single run, not just a cold one.

## Reading `size.json` (M35)

`pnpm test:slow wasm -t "size @slow"` writes `test-results/wasm/size.json`: `wasm` (`raw`, `brotli`, `warnBudget`, `failBudget`, `status` `ok|warn|fail`: release `game.wasm` of `games/reference`, brotli 11) and `engineJs` (`browser`: the minified client + render + worker bundle the `size.engineJsBrotli` ceiling is read against, per file; `dist`: every reachable `dist/*.js` unminified, recorded only). A `warn` status passes with a `console.warn` line: note it, do not hide it. Budgets live in `packages/engine/budgets.json` `size.*` (`engineJsBrotliExact` is the number the ceiling was set from; the test prints the delta). Other slow packaging tests: `-t tarball-install` (browser suite), `-t "ts-rs zero bytes"`, `-t "release "`, `-t wasm-opt` (`REQUIRE_WASM_OPT=1` fails when no `wasm-opt`).

## The `browser` suite specifically

Four projects: `chromium` runs everything under `packages/engine/tests/browser/*.spec.ts` except
`gc-*.spec.ts`; `gc` runs only those (the zero-GC suite, `gc-test` skill); `webkit` and `firefox`
run only specs tagged `@engines` (the determinism spec: three engines, one hash) or, for `webkit`
alone, `@webkit-gpu`. `pnpm test browser` (fast tier) runs `chromium` and `gc` only -- WebKit and
Firefox moved to the slow tier entirely at gate round 3 (`scripts/suites.mjs`'s `browser` suite
`args: ['--project', 'chromium', '--project', 'gc']`; docs/decisions/0020 §4, first rung): `pnpm
test:slow browser` (and CI) runs every `@engines`/`@webkit-gpu` test on WebKit and Firefox through
a separate `engines` leg (`onlyTier: 'slow'`, its own preview port so it can run alongside the main
leg), plus every `@slow`-tagged title as usual. `-t` composes with both: `pnpm test:slow browser -t
determinism` runs the determinism spec on WebKit and Firefox (and on chromium/gc if also tagged
`@slow`); `pnpm test browser -t determinism` runs it on chromium alone.

Playwright's own `webServer` only runs `vite preview` against an already-built app (dev profile);
`pnpm test`'s `pages` build step is what runs `vite build` first (`scripts/suites.mjs`). If you
change a page's source, `pnpm test browser` rebuilds it as part of that build step; running the raw
`playwright test` CLI (below) does not rebuild it for you.

**Running one Playwright project directly** (bypasses the runner and its `-t` tag composition, for
fast iteration on one spec/project while debugging):

```
pnpm exec playwright test --config packages/engine/playwright.config.ts --project chromium -g "wiring"
```

This writes its own `packages/engine/test-results/browser/report.json` (the config's own
`outputFile`, resolved relative to the config's directory) — a different path from `pnpm test`'s
repo-root `test-results/browser/report.json` (set by the runner's `PLAYWRIGHT_JSON_OUTPUT_FILE`).
Don't confuse the two when reading a report.

**`ENGINE_TEST_PORT`** (default `4517`, `strictPort`): the fixture app's dev/preview port, read by
both `tests/browser/pages/vite.config.ts` and `playwright.config.ts`. Set it to run the browser
suite from two worktrees at once without a port clash.

## GPU/readback tests

`terrain-readback.spec.ts` and any later `*-readback.spec.ts` (docs/plan/09-renderer-terrain.md) are
semantic pixel probes (0020 §6), not golden images: they render to an offscreen `rgba8unorm` target
and assert individual pixels with `expectPixel` (`engine/test`), never a page screenshot. There is no
actual/expected PNG pair checked in for them yet; if you add one for a failing scene's debugging (an
`encodePNG` helper already exists at `packages/engine/scripts/lib/png.mjs`), write it under
`test-results/browser/readback/<test-name>-{actual,expected}.png` (gitignored, next to every other
suite's own artefacts under `test-results/`).

A netcode desync (hash-all mode, `docs/plan/31b-desync-hashes.md`) leaves `test-results/desync/<tick>-<cx>_<cy>.{client,host}.bin`: the replica's encoding of the chunk when its hash mismatched, and the host's after the resync snapshot. The failure message of `assertNoDesync()` names both paths and the first differing offset.

## Golden hashes

`pnpm golden [fixture]` is the only writer of a fixture's `golden/golden.json` (rebuilds first, runs
the scenario on the `.wasm` under Node, docs/decisions/0020 §5). Review the diff before committing
one: a changed golden is a changed sim, never something to regenerate to make a test pass. Never run
it on an existing fixture just because a test disagrees with the checkpoint.

## CI

GitHub Actions (`.github/workflows/ci.yml`), `ubuntu-latest`, on every push to `main` and every
`pull_request`: `pnpm lint`, then `pnpm test`, then `pnpm test:slow`, each with `CI=true
ENGINE_GPU=swiftshader GC_MODE=software` and `--budget-scale 1000 --timings-json
test-results/timings[-slow].json` (docs/plan/10-ci-workflow.md). `ENGINE_GPU=swiftshader` makes
`playwright.config.ts` switch the `chromium`/`gc` projects to `channel: 'chromium-headless-shell'`
and add the 0020 §6 SwiftShader launch flags (the full `chromium` channel, "new headless", returned
a null adapter on this runner — the headless-shell channel is the one that works). `GC_MODE=software`
makes every `gc`-project test use software-mode arithmetic: `main` compares `attributedBytesPerFrame`
against `budgets.json`'s `gc.pages.<page>.software.isolates.main`; every other isolate compares raw
`bytesPerFrame` against its own hardware budget, same as hardware mode (a page's `software.isolates`
map needs only a `main` key). `--budget-scale 1000` means no suite fails on time; timings are
recorded to the job summary and the `test-results` artifact, never gating.

**Reading a failed run**: `gh run list` (find the run) → `gh run view <id> --log-failed` (the
failing step's own output; the runner's own quiet contract, 0020 §2, keeps this short) → `gh run
download <id> -n test-results` instead of re-running to look (Playwright traces, `report.json`,
`timings.json`). `gh run watch <id>` blocks; prefer a bounded `gh run view --json status,conclusion`
poll or just wait for the run to finish before reading it.

**`@gpu-local`**: reserved, not used. M10's own spike B closed on the first working fallback
(`chromium-headless-shell`); a GPU test that cannot run on a software adapter would be tagged
`@gpu-local` and excluded from CI by grep, but no test needed this.

**Per-adapter-class goldens**: also reserved, not used. Every M09 readback scene, pixel probe and
the whole `gc` project (including `terrain`/`input`'s zero-GC pages) matched the Apple-silicon
goldens exactly on SwiftShader (0020 §6's tolerance never approached, no golden mismatch at all) —
0020 §6's naming (`<scene>.swiftshader.png`, checked in beside a scene's existing golden once one
exists) is the convention a future scene reaches for only if Metal and SwiftShader ever disagree
beyond tolerance; no scene has needed one, and no goldens directory exists yet for any scene (see
"GPU/readback tests" above).

## A look at a running page

For a one-off look at a page (not an assertion, not something to keep running) use the
`playwright-cli` skill against a server you started yourself, e.g.:

```
pnpm exec vite preview --config packages/engine/tests/browser/pages/vite.config.ts --host 127.0.0.1 &
playwright-cli open http://127.0.0.1:4517/determinism.html
playwright-cli --raw eval "document.getElementById('result').textContent"
playwright-cli close
```

Reach for this instead of writing a throwaway `.spec.ts` when you just want to see what a page does;
reach for a real spec when the check should run again later.

## Serving on a phone

`pnpm device:serve [--tunnel]` (docs/plan/03-browser-harness.md, "Determinism on a physical phone"):
builds the fixture app and serves it statically on `127.0.0.1:4173` — plain, that's a desktop-only
check (`http://<LAN IP>` is not a secure context, so `crossOriginIsolated` stays `false`). On an
iPhone, `--tunnel` also runs a Cloudflare quick tunnel and prints an `https://….trycloudflare.com`
URL good for the length of that run; it exits with a one-line message if `cloudflared` is not on
`PATH`, rather than trying to install it. `determinism.html` is the page to open: a PASS/FAIL banner,
each checkpoint next to the golden, the user agent and `crossOriginIsolated`.
