#!/usr/bin/env bash
# Runs the wasm builds under x86-64 Node (V8's x64 backend) inside an emulated amd64 container.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
docker run --rm --platform linux/amd64 -v "$HERE":/work -w /work node:22 bash -euc '
  node driver/run-js.mjs wasm/o3.wasm node-x64-emulated-o3
  node driver/run-js.mjs wasm/os.wasm node-x64-emulated-os
  uname -m; cat /proc/cpuinfo | grep -m1 "model name" || true
'
