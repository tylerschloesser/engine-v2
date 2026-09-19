#!/usr/bin/env bash
# Native Linux builds inside Docker (glibc libm). usage: docker-native.sh arm64|amd64
# Used because the macOS host linker was blocked (Xcode license not accepted); also the
# only way to get an x86-64 data point on this machine (emulated by Docker Desktop).
set -euo pipefail
ARCH="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
docker run --rm --platform "linux/$ARCH" -v "$HERE":/work -w /work \
  -e CARGO_TARGET_DIR="/work/target/docker-$ARCH" -e CARGO_HOME="/work/target/docker-cargo-home-$ARCH" \
  rust:1.93 bash -euc '
    export PATH=/usr/local/cargo/bin:$PATH
    F="--features libm-crate"
    cargo build -q --release $F && $CARGO_TARGET_DIR/release/native native-linux-'"$ARCH"'-release > results/native-linux-'"$ARCH"'-release.json
    cargo build -q $F && $CARGO_TARGET_DIR/debug/native native-linux-'"$ARCH"'-debug > results/native-linux-'"$ARCH"'-debug.json
    RUSTFLAGS="-C target-cpu=native" CARGO_TARGET_DIR=$CARGO_TARGET_DIR-cpunative cargo build -q --release $F \
      && $CARGO_TARGET_DIR-cpunative/release/native native-linux-'"$ARCH"'-release-cpunative > results/native-linux-'"$ARCH"'-release-cpunative.json
    if [ "'"$ARCH"'" = arm64 ]; then
      rustup target add wasm32-unknown-unknown >/dev/null 2>&1
      cargo build -q --release --lib --target wasm32-unknown-unknown $F
      cargo build -q --profile release-s --lib --target wasm32-unknown-unknown $F
      mkdir -p wasm
      cp $CARGO_TARGET_DIR/wasm32-unknown-unknown/release/determinism_hash.wasm wasm/o3.wasm
      cp $CARGO_TARGET_DIR/wasm32-unknown-unknown/release-s/determinism_hash.wasm wasm/os.wasm
    fi
    rustc --version; uname -m; ldd --version | head -1
  '
