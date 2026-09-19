#!/usr/bin/env bash
# Re-runs the whole spike. Needs: Docker running, node, bun, pnpm install + `npx playwright install chromium webkit firefox`.
set -uo pipefail
cd "$(dirname "$0")"
rm -f results/*.json
./docker-native.sh arm64 2>&1 | tail -3      # native aarch64 Linux (release, debug, target-cpu=native) + builds wasm/o3.wasm, wasm/os.wasm
./docker-native.sh amd64 2>&1 | tail -3      # native x86-64 Linux (emulated)
for o in o3 os; do
  node driver/run-js.mjs wasm/$o.wasm node-$o
  bun driver/run-js.mjs wasm/$o.wasm bun-$o
  node driver/run-browsers.mjs wasm/$o.wasm $o
done
./docker-node-amd64.sh 2>&1 | tail -2        # same wasm under V8's x64 backend (emulated)
# Native macOS: only if the host C linker works (needs `sudo xcodebuild -license` accepted).
if echo 'int main(){return 0;}' | cc -x c - -o /dev/null 2>/dev/null; then
  cargo build -q --release --features libm-crate && ./target/release/native native-macos-aarch64-release > results/native-macos-aarch64-release.json
  cargo build -q --features libm-crate && ./target/debug/native native-macos-aarch64-debug > results/native-macos-aarch64-debug.json
else
  echo "SKIPPED native macOS: host cc unusable (Xcode license?)"
fi
node driver/compare.mjs > results/TABLE.md
node driver/probe-precision.mjs wasm/o3.wasm > results/PRECISION.md
grep -c "DIVERGE" results/TABLE.md
