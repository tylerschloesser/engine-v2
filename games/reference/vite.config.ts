// docs/decisions/0017-packaging-and-build.md §6: what a game writes, verbatim (one plugin line).

import { fileURLToPath } from 'node:url'
import { engine } from 'engine/vite'
import { defineConfig } from 'vite'
import { servePreview, walkProxy } from '../../packages/engine/scripts/walk-preview-plugin.ts'

// M29 Scope: `pnpm device:serve --app reference`
// serves this app (instead of the fixture app) on the same port/tunnel/proxy shape `packages/
// engine/tests/browser/pages/vite.config.ts` already has -- mirrored here rather than shared,
// since the two are separate Vite apps in separate packages. `ENGINE_TEST_PORT` unset (every
// `pnpm --filter reference dev`/`preview`/the `reference`/`gc-reference` Playwright projects, which
// always pass an explicit `--port`/`--strictPort` CLI flag that overrides this) keeps Vite's own
// default preview port, so this is additive.
const port = Number(process.env.ENGINE_TEST_PORT ?? 4173)

// `publicDir: 'assets'` (Deviations): the script-generated art this brief's own Scope commits at
// `games/reference/assets/` (the exit criterion's own `git diff --exit-code ... games/reference/
// assets` path) is served at the URL root by Vite's ordinary static-file convention -- so
// `assets/tiles.json` on disk is `fetch('/tiles.json')` at runtime, the same "public dir contents
// at /" rule `tests/browser/pages/public/terrain/tiles.json` already uses (there, the directory is
// literally named `public`; here it is named `assets` to match this brief's own Scope wording).
// `vite build --mode bench` (M36, M36 step 6): the bench build.
// It compiles the sim with cargo feature `bench` (the standard large save, 0020 section 9), defines
// `__BENCH__` so `main.ts` carries the `?bench=large-save` page and its HUD (`src/bench.ts`), and
// writes to `dist-bench/`, never `dist/`. Every other mode defines `__BENCH__` false, so the bundle
// contains none of it (`bench.spec.ts` greps `dist/` for it). Never ships.
export default defineConfig(({ mode }) => {
  const bench = mode === 'bench'
  return {
    ...config(bench),
    define: { __BENCH__: JSON.stringify(bench) },
  }
})

function config(bench: boolean) {
  // `/ws` for `device-serve --ws` and `/__walk` for `device:walk` (M39f); empty (no `preview.proxy`) otherwise.
  const proxy = {
    ...(process.env.ENGINE_WS_PROXY_PORT
      ? { '/ws': { target: `ws://127.0.0.1:${process.env.ENGINE_WS_PROXY_PORT}`, ws: true } }
      : {}),
    ...walkProxy(),
  }
  return {
    publicDir: 'assets',
    // `bindings.dir` is relative to the *crate* dir (`./sim`, `exportBindings`'s own contract), and
    // this package's committed bindings live at `games/reference/src/bindings/` -- a sibling of
    // `sim/`, not inside it (0017 §1's layout is the *package* root's `src/bindings/`, unlike a
    // `fixtures/<game>` crate where the fixture root and the crate root are the same directory) --
    // hence `../src/bindings`. Step 4's own scope ("ts-rs bindings written to `src/bindings/` and
    // committed"); steps 1-3 left this unset since a no-op action/reject/ui carried nothing worth
    // generating a real binding for yet.
    plugins: [
      engine({
        crate: './sim',
        bindings: { dir: '../src/bindings' },
        ...(bench ? { features: ['bench'] } : {}),
      }),
      // `vite preview` only: COOP/COEP + no-store on every response (a bare 304 lacks them), and under
      // `pnpm device:walk` (`ENGINE_WALK_PORT`) the agent tag. Never in `vite build` output.
      ...servePreview(),
    ],
    // Three entries: `index.html` (production), `test.html` (step 0: `ClientOptions.test` and every
    // diagnostic `window.__*` hook), `gc.html` (step 6's own zero-allocation exit criterion: a
    // production-topology page driven by `engine/test.asHarness`, never shipped to a player). Vite
    // only builds `index.html` by default; all three must land in `dist/` so `vite preview` (the
    // `reference`/`gc-reference` Playwright projects' own shared webServer, M20/M20b Deviations) can
    // serve the other two.
    build: {
      ...(bench ? { outDir: 'dist-bench' } : {}),
      // Minified by default: the test build (`scripts/suites.mjs`'s `reference` step) passes
      // `--minify false`, because `gc.html`'s software-mode zero-GC attribution matches
      // `attributionRoots` against runtime function names, which minification renames (M20b gate).
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          // The bench build is the production page alone.
          ...(bench
            ? {}
            : {
                test: fileURLToPath(new URL('./test.html', import.meta.url)),
                gc: fileURLToPath(new URL('./gc.html', import.meta.url)),
                gcSinglePlayer: fileURLToPath(new URL('./gc-single-player.html', import.meta.url)),
              }),
        },
      },
    },
    preview: {
      port,
      strictPort: true,
      // `pnpm device:serve --tunnel --app reference` (M03; M29): same "the tunnel's `Host` header is a random
      // `*.trycloudflare.com` subdomain" reasoning as the fixture app's own config.
      ...(process.env.ENGINE_DEVICE === '1' ? { allowedHosts: ['.trycloudflare.com'] } : {}),
      // `pnpm device:serve --app reference --ws`: same `/ws` proxy shape as the fixture app's own
      // config, so a real multiplayer reference game (M34) reaches the socket cross-origin-isolated
      // on this same port. A no-op until then (the reference game itself ignores the socket, Scope).
      ...(Object.keys(proxy).length ? { proxy } : {}),
    },
  }
}
