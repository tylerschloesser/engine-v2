// docs/decisions/0017-packaging-and-build.md §6: what a game writes, verbatim (one plugin line).

import { engine } from 'engine/vite'
import { defineConfig } from 'vite'

// `publicDir: 'assets'` (Deviations): the script-generated art this brief's own Scope commits at
// `games/reference/assets/` (the exit criterion's own `git diff --exit-code ... games/reference/
// assets` path) is served at the URL root by Vite's ordinary static-file convention -- so
// `assets/tiles.json` on disk is `fetch('/tiles.json')` at runtime, the same "public dir contents
// at /" rule `tests/browser/pages/public/terrain/tiles.json` already uses (there, the directory is
// literally named `public`; here it is named `assets` to match this brief's own Scope wording).
export default defineConfig({ publicDir: 'assets', plugins: [engine({ crate: './sim' })] })
