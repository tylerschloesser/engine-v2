# packages/engine (TypeScript side)

The one publishable package (working name `engine`, private for now). Layout and package fields: `docs/decisions/0017-packaging-and-build.md` §1–§2. The Rust crate inside it has its own file: `crates/engine/CLAUDE.md`.

## Commands

- `pnpm --filter engine build`: `tsc -p tsconfig.build.json`, `src/` → `dist/`. No bundler. `pnpm test` runs this as its first build step.
- `pnpm --filter engine typecheck`: `tsc --noEmit` over `src/` including tests. `pnpm lint` runs it.
- `pnpm test unit [-t pattern]`: the Vitest `unit` suite (this package's `src/**/*.test.ts` plus `scripts/**/*.test.mjs`).

## Conventions

- Zero runtime dependencies, and no devDependencies here: every tool (`tsc`, Vitest, Biome) is pinned in the root `package.json` and resolves from there.
- Add an `exports` subpath only together with the file that backs it. The final map is 0017 §2; M35 audits it.
- `tsconfig.json` type-checks everything in `src/`; `tsconfig.build.json` extends it and excludes `*.test.ts` from `dist/`. Base options are in the root `tsconfig.base.json` (`types: []`: a tsconfig that needs Node types opts in).
- TypeScript must be erasable (`erasableSyntaxOnly`): no enums, namespaces or parameter properties. Relative imports carry the `.js` extension (`nodenext`).

## Where tests live

- `unit`: `*.test.ts` beside the source in `src/`. No globals: import `test`, `expect` from `vitest`.
- `wasm`, `netcode`, `browser` (later milestones): `tests/<suite>/`; browser pages under `tests/browser/pages/`; shared helpers in `tests/support/`.
- Fixture game crates: `fixtures/<name>/`, with golden hashes and recorded logs in `fixtures/<name>/golden/` (Rust, Node/Bun and browser suites read the same files).
- `tests/` and `fixtures/` are outside `files`, so neither is published.
- Slow tier: put `@slow` in the Vitest test title. `pnpm test` skips it; `pnpm test:slow` runs only those.
- New suites and build steps are registered in `scripts/suites.mjs`, nowhere else.
