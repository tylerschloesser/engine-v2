// docs/decisions/0017-packaging-and-build.md §6: what a game writes, verbatim (one plugin line).

import { fileURLToPath } from 'node:url'
import { engine } from 'engine/vite'
import { defineConfig } from 'vite'

// `publicDir: 'assets'` (Deviations): the script-generated art this brief's own Scope commits at
// `games/reference/assets/` (the exit criterion's own `git diff --exit-code ... games/reference/
// assets` path) is served at the URL root by Vite's ordinary static-file convention -- so
// `assets/tiles.json` on disk is `fetch('/tiles.json')` at runtime, the same "public dir contents
// at /" rule `tests/browser/pages/public/terrain/tiles.json` already uses (there, the directory is
// literally named `public`; here it is named `assets` to match this brief's own Scope wording).
export default defineConfig({
  publicDir: 'assets',
  // `bindings.dir` is relative to the *crate* dir (`./sim`, `exportBindings`'s own contract), and
  // this package's committed bindings live at `games/reference/src/bindings/` -- a sibling of
  // `sim/`, not inside it (0017 §1's layout is the *package* root's `src/bindings/`, unlike a
  // `fixtures/<game>` crate where the fixture root and the crate root are the same directory) --
  // hence `../src/bindings`. Step 4's own scope ("ts-rs bindings written to `src/bindings/` and
  // committed"); steps 1-3 left this unset since a no-op action/reject/ui carried nothing worth
  // generating a real binding for yet.
  plugins: [engine({ crate: './sim', bindings: { dir: '../src/bindings' } })],
  // Two entries (docs/plan/20b-reference-player-and-collect-ui.md step 0): `index.html` (the
  // production page) and `test.html` (the test-only page with `ClientOptions.test` and every
  // diagnostic `window.__*` hook, never shipped to a player). Vite only builds `index.html` by
  // default; both must land in `dist/` so `vite preview` (the `reference` Playwright project's own
  // webServer, M20 Deviations) can serve `test.html` too.
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        test: fileURLToPath(new URL('./test.html', import.meta.url)),
      },
    },
  },
})
