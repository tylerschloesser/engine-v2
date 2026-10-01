// First step of the package's `build`: `tsc` never deletes, so a renamed or removed source file would
// leave its old output in `dist/` and in the tarball (M35). Node built-ins only, no shell `rm`.
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

rmSync(fileURLToPath(new URL('../dist', import.meta.url)), { recursive: true, force: true })
