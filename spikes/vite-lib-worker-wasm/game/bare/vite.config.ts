// Zero-config control: no engine plugin, no headers, no worker.format, no optimizeDeps.exclude.
// The wasm must already be built by hand: (cd ../sim && cargo build --target wasm32-unknown-unknown --release)
import { defineConfig } from 'vite'
export default defineConfig({ server: { fs: { allow: ['..'] } } }) // allow only because ../sim/target is outside this root
