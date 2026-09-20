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
leg) · `browser` (Playwright Test: `packages/engine/playwright.config.ts`). Ids come from
`scripts/suites.mjs`; that file is the registration point for a new suite, nowhere else.

Run one test by name: `pnpm test <suite> -t "<substring>"`, e.g. `pnpm test wasm -t "import
allowlist"`, `pnpm test browser -t determinism`, `pnpm test unit -t "manual clock"`. `-t` is a plain
substring match, not a regex.

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

## The `browser` suite specifically

Three projects: `chromium` runs everything under `packages/engine/tests/browser/*.spec.ts`; `webkit`
and `firefox` run only specs tagged `@engines` in the title (the determinism spec: three engines,
one hash). Both tags compose with `-t`: `pnpm test browser -t determinism` runs the determinism spec
in all three; `pnpm test browser` alone runs chromium's full set plus the two `@engines` runs.

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

## Golden hashes

`pnpm golden [fixture]` is the only writer of a fixture's `golden/golden.json` (rebuilds first, runs
the scenario on the `.wasm` under Node, docs/decisions/0020 §5). Review the diff before committing
one: a changed golden is a changed sim, never something to regenerate to make a test pass. Never run
it on an existing fixture just because a test disagrees with the checkpoint.

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
