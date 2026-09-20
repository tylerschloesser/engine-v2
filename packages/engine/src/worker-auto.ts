// Pattern A's worker script (0017 §2, §3): `dist/client.js` constructs `new Worker(new
// URL('./worker-auto.js', import.meta.url), { type: 'module' })`. Internal: no exports-map entry.
import { run } from './worker.js'

run()
