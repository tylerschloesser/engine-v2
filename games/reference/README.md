# games/reference

The reference game: a Vite app plus `sim/`, a game crate on the engine's `Game` trait. Working notes: `CLAUDE.md`.

- **Pattern A (default):** write no worker code; `createClient` builds its own workers. **Pattern B:** a two-line `src/worker.ts` (`import { run } from 'engine/worker'; run()`) and `createClient({ createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) })`: the fix for a project with no workspace marker above it and for non-Vite bundlers (0017 §3).
- **Support check:** `const support = await checkSupport()` before starting. `support.ok` is false when `failures` is non-empty; branch on each failure's `code` (`not-isolated`, `no-sab`, `no-wasm`, `no-module-worker`, `no-webgpu`, `no-adapter`, `limits-too-low`), never on `message` (developer English).
- **Warnings** (`support.warnings`: `no-opfs`, `no-web-locks`) mean the game runs with less (a world is `durable: false`, no cross-tab lock); show them or ignore them, they never stop it.
- **Capability screen:** `src/ui/capability.ts` shows one line per failure instead of a blank canvas (`main.ts` calls it first); it keeps `data-code` on each line.
- **Hosting:** every response needs COOP/COEP (`engine/vite` sets them in dev and preview); assets must be same-origin, so GitHub Pages and popup OAuth do not work (0015 §3).
