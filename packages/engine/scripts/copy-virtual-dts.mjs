// tsc does not copy a hand-written `.d.ts` input file into `outDir` (it only emits declarations it
// compiles itself), so `engine/virtual`'s `dist/virtual.d.ts` needs one line after `tsc`. Runs as
// part of the package's `build` script.
import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

copyFileSync(
  fileURLToPath(new URL('../src/virtual.d.ts', import.meta.url)),
  fileURLToPath(new URL('../dist/virtual.d.ts', import.meta.url)),
)
