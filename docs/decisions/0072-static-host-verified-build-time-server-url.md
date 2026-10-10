# 0072: Static host verified on Cloudflare Pages; the server URL is set at build time

Status: Accepted (2026-10-10). Closes the "unverified static host" gap of [0067](0067-phase-3-decisions-runtime-packaging-hosting.md) §1 and exercises [0015](0015-threads-memory-and-topology.md) §3's cross-origin `wss`.

## Context

0015 §3 listed per-host COOP/COEP setups and said the client may sit on a static host with the game server on another origin. Neither was ever run: Phase 3 served the client from the server itself (`games/reference-server --static`, one origin). The release page also had no way to name another origin: with `#k=` it always connected to `wsUrl(location)`, its own `/ws`. Tyler approved one Cloudflare Pages deploy on 2026-10-10.

## Decision

1. **`VITE_SERVER_URL` at build time** (`wss://<host>/ws`) is the release page's server when the page has `#k=`; unset, it stays `wsUrl(location)`. Read in `games/reference/src/main.ts`, passed as `selectHost`'s existing `serverUrl`. A static deploy and its server are paired per build; no runtime parameter (a `?server=` on the release page would let a link point a player at any server).
2. **`games/reference/assets/_headers`** (the Cloudflare Pages / Netlify listing, `publicDir` is `assets`) and **`assets/404.html`** ship in every build. Without a `404.html`, Pages answers an unknown path with the index page and status 200.
3. **Verified** on Cloudflare Pages (classic Pages on `pages.dev`, created with `wrangler pages project create --force`: wrangler 4.149 otherwise delegates Pages to Workers static assets): `check-coi.mjs` passes on `/`, the worker, the `.wasm`, an image and the 404; a `304` carries both headers; `deployed/coi-and-online @slow` reached `online` in 1.7 s over `wss` to a `games/reference-server` on another origin (a Cloudflare quick tunnel to the Mac). The project was deleted afterwards.

## Alternatives rejected

- **A runtime `?server=` on the release page.** Any link could send a player to an arbitrary server; `test.html?server=` stays test-only.
- **Workers static assets instead of classic Pages.** Same `_headers` file, but it needs an account workers.dev subdomain, which was removed with `reference-server-do` the same day.

## Consequences

- Netlify and Vercel listings stay from documentation; only Cloudflare Pages is verified.
- The server does not check `Origin`, which is what lets a static-host page connect; a server that needs to restrict who connects adds an allow-list then.

## Sources

- Session of 2026-10-10: deployments `750d545e` and `af187154` of `engine-v2-reference.pages.dev`, the `check-coi.mjs` output and the `packaging` log line `deployed/coi-and-online: online 1736 ms after navigation`.
