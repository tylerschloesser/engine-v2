# games/reference

The reference game: a Vite app plus `sim/`, a game crate on the engine's `Game` trait. Working notes: `CLAUDE.md`.

- **Pattern A (default):** write no worker code; `createClient` builds its own workers. **Pattern B:** a two-line `src/worker.ts` (`import { run } from 'engine/worker'; run()`) and `createClient({ createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) })`: the fix for a project with no workspace marker above it and for non-Vite bundlers (0017 §3).
- **Support check:** `const support = await checkSupport()` before starting. `support.ok` is false when `failures` is non-empty; branch on each failure's `code` (`not-isolated`, `no-sab`, `no-wasm`, `no-module-worker`, `no-webgpu`, `no-adapter`, `limits-too-low`), never on `message` (developer English).
- **Warnings** (`support.warnings`: `no-opfs`, `no-web-locks`) mean the game runs with less (a world is `durable: false`, no cross-tab lock); show them or ignore them, they never stop it.
- **Capability screen:** `src/ui/capability.ts` shows one line per failure instead of a blank canvas (`main.ts` calls it first); it keeps `data-code` on each line.

## Hosting

Cross-origin isolation (0015 §3) needs **two headers on every response, 404s and worker scripts included**, with exactly these values:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`engine/vite` sets them in dev and preview. `node scripts/check-coi.mjs <url>` asserts both, exact values, on `/`, the hashed worker script, the `.wasm`, an image and a 404. Limits (0015 Consequences): no GitHub Pages (it cannot set headers), no CORP-less third-party content, no popup-based OAuth; assets are same-origin; a phone-hosted single-player world must fit the sim arena.

**Verified:** only our own handler, `games/reference-server --static <dir>` on a Fly machine ([`../reference-server/README.md`](../reference-server/README.md)); `check-coi.mjs` passes against it and the page reaches `online`.

**Per-host listings, from documentation, unverified.** No static host was deployed to (the Cloudflare Pages deploy was not approved). The listings below come from the spike's reading of each host's docs (`spikes/cross-origin-sab/RESULT.md` §4); **the claim that they work, and 0015 §3's sentence about a cross-origin `wss`, are UNVERIFIED** and carried to M39b (`docs/plan/39b-phase-4-handoff.md`, open items). To close it: deploy `vite build` to one host with its listing, run `check-coi.mjs <url>` and `DEPLOYED_URL=<url> pnpm test:slow -t deployed/` with the server on another origin.

- **Cloudflare Pages / Workers static assets** (unverified): `public/_headers` with `/*` then the two header lines above (indented two spaces).
- **Netlify** (unverified): the same `_headers` file in `public/`, or `netlify.toml` with `[[headers]] for = "/*"` and `[headers.values]` holding the two headers. Not applied to proxied content or functions.
- **Vercel** (unverified): `vercel.json` with `"headers": [{ "source": "/(.*)", "headers": [` the two key/value pairs `] }]`.
- **GitHub Pages:** cannot set headers; `coi-serviceworker` is a workaround this repo has not tested.
