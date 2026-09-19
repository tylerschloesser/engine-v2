# Spike result: cross-environment determinism hash

Date: 2026-09-19. Machine: Apple M3 Max, macOS 26.6.2. Rust 1.93 (host 1.93.0; Docker image 1.93.1), `wasm32-unknown-unknown`, plain `extern "C"` ABI, no wasm-bindgen. Throwaway code; timebox about 45 minutes.

## Verdict

**Feasible.** The "safe" code (hand-written f32 and f64 2D simplex fBm restricted to `+ - * floor`, integer lattice hash, SplitMix64 scatter hash, f32 spring sim, 16.16 fixed-point sim, hand-written polynomial sin/cos) produced **identical 64-bit hashes in all 20 runs**: 6 native builds (aarch64 and x86-64 Linux; release, debug, `target-cpu=native`) and 14 WASM runs (Node/V8, Bun/JSC, Chromium, Chrome, Firefox/SpiderMonkey, WebKit/JSC, plus Node x64 under emulation; each at `opt-level=3` and `opt-level="s"`). The hash covers raw f32 bit patterns of every noise value, not just classified tiles, over 2,048 chunks including chunk coords around +-250,000 (= +-8,000,000 tiles).

Only two classes of operation diverged, both as predicted by `docs/research/simulation.md` 1.1:

1. **std transcendentals, native vs. WASM** (never WASM vs. WASM).
2. **NaN bit patterns**, by CPU architecture (even for the *same* `.wasm` file) and by optimization level.

### Deviation from the brief (read this)

- **Native aarch64 macOS could not be built.** The host C linker refuses to run: `You have not agreed to the Xcode license agreements` (`cc` exit 69). I did not work around a license gate. Fix: `sudo xcodebuild -license`, then `./run-all.sh` picks macOS native up automatically.
- Substitute: native builds ran in Docker (`rust:1.93`, Debian, glibc 2.41) as **aarch64 Linux** (native speed, same CPU) and **x86-64 Linux** (emulated by Rosetta: `VirtualApple`). I started Docker Desktop for this and quit it afterwards; images `rust:1.93` and `node:22` remain pulled.
- Because the `libm` crate has a build script (needs the host linker), the `.wasm` files were also built inside the arm64 container and copied to `wasm/`. A host-built `.wasm` (without the `libm-crate` feature) was also run in Node, Bun and all four browsers earlier and gave the same `safe_chunks`/`safe_sim_f32` hashes (`9ae2f43a6fc43415` / `3607d7bf9efcf084`).

## Environments

| env | runtime |
|---|---|
| native-linux-amd64-debug | rustc native |
| native-linux-amd64-release | rustc native |
| native-linux-amd64-release-cpunative | rustc native |
| native-linux-arm64-debug | rustc native |
| native-linux-arm64-release | rustc native |
| native-linux-arm64-release-cpunative | rustc native |
| bun-o3 | bun 1.3.8 |
| bun-os | bun 1.3.8 |
| chrome-o3 | chrome 153.0.8010.52|
| chrome-os | chrome 153.0.8010.52|
| chromium-o3 | chromium 153.0.8010.12|
| chromium-os | chromium 153.0.8010.12|
| firefox-o3 | firefox 155.0|
| firefox-os | firefox 155.0|
| node-o3 | node v22.18.0 v8 12.4.254.21-node.27 |
| node-os | node v22.18.0 v8 12.4.254.21-node.27 |
| node-x64-emulated-o3 | node v22.23.2 v8 12.4.254.21-node.56 |
| node-x64-emulated-os | node v22.23.2 v8 12.4.254.21-node.56 |
| webkit-o3 | webkit 26.6|
| webkit-os | webkit 26.6|

`-o3` / `-os` = wasm built with `opt-level=3` / `opt-level="s"` (both `lto=true, codegen-units=1, panic=abort`). `cpunative` = `RUSTFLAGS="-C target-cpu=native"` (FMA-capable CPU; checks LLVM does not fuse `a*b+c`). "chrome" is the installed Google Chrome via Playwright `channel: "chrome"`; "webkit" is Playwright's WebKit build, not Safari.app.

## Safe variant: actual hashes

Inputs: seed `0x5EED1234ABCD0042`; `safe_chunks*` = 2,048 chunks; sims = 256 entities x 100,000 ticks, 4 PRNG-driven actions per tick, hashed every 1,000 ticks; `safe_det_trig` = 200,000 hand-written sin+cos; `bench_*` = the 2,000 timed chunks.

| env | safe_chunks | safe_chunks_tiles_only | safe_chunks_f64 | safe_sim_f32 | safe_sim_fixed | safe_det_trig | bench_chunks | bench_chunks_f64 |
|---|---|---|---|---|---|---|---|---|
| native-linux-amd64-debug | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| native-linux-amd64-release | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| native-linux-amd64-release-cpunative | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| native-linux-arm64-debug | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| native-linux-arm64-release | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| native-linux-arm64-release-cpunative | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| bun-o3 | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| bun-os | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| chrome-o3 | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| chrome-os | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| chromium-o3 | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| chromium-os | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| firefox-o3 | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| firefox-os | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| node-o3 | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| node-os | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| node-x64-emulated-o3 | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| node-x64-emulated-os | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| webkit-o3 | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |
| webkit-os | `9ae2f43a6fc43415` | `3460f07c95d60b88` | `6ffc648955592a25` | `3607d7bf9efcf084` | `d835366cc4b6dfdf` | `0ab86426305e93f6` | `ab9b746b1dbb6a71` | `7d8109a8e12fa120` |

## Every row, grouped by value

| row | distinct values | value -> environments |
|---|---|---|
| safe_chunks | 1 (MATCH) | `9ae2f43a6fc43415` (all 20) |
| safe_chunks_tiles_only | 1 (MATCH) | `3460f07c95d60b88` (all 20) |
| safe_chunks_f64 | 1 (MATCH) | `6ffc648955592a25` (all 20) |
| safe_sim_f32 | 1 (MATCH) | `3607d7bf9efcf084` (all 20) |
| safe_sim_fixed | 1 (MATCH) | `d835366cc4b6dfdf` (all 20) |
| safe_det_trig | 1 (MATCH) | `0ab86426305e93f6` (all 20) |
| risky_std_sin | **2 (DIVERGE)** | `544ae182a511825b`: *[all 6 native Linux builds]*<br>`7257471484241179`: *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_cos | **2 (DIVERGE)** | `0f9545b0e20af70e`: *[all 6 native Linux builds]*<br>`569d1d2e71c1e4a8`: *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_tan | **2 (DIVERGE)** | `992a75ce62f82916`: *[all 6 native Linux builds]*<br>`141a2e2e597fa674`: *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_exp | **2 (DIVERGE)** | `31f43588d61b119c`: *[all 6 native Linux builds]*<br>`cfedd2d04403fb7a`: *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_ln | **2 (DIVERGE)** | `53bf23f0ef3ac70f`: *[all 6 native Linux builds]*<br>`acb32c10252a01b8`: *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_powf | **2 (DIVERGE)** | `168a69458f28dc17`: *[all 6 native Linux builds]*<br>`93da237fa14e0372`: *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_atan2 | **2 (DIVERGE)** | `bd0f613612128117`: *[all 6 native Linux builds]*<br>`45a6b2ffdd749d1b`: *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_sqrt | 1 (MATCH) | `e487a6539cd70ad1` (all 20) |
| risky_std_cbrt | 1 (MATCH) | `d0a132d434fb9caf` (all 20) |
| risky_std_hypot | **2 (DIVERGE)** | `6339c1b293ac9c52`: *[all 6 native Linux builds]*<br>`d05e69c29f0c66df`: *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_sin_f64 | **2 (DIVERGE)** | `99108980f0cc3708`: *[all 6 native Linux builds]*<br>`c40359267883bbbb`: *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_pow_f64 | **2 (DIVERGE)** | `bcd02ff469f22624`: *[all 6 native Linux builds]*<br>`c6a6c6c61f8f655d`: *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_libm_sin | 1 (MATCH) | `7257471484241179` (all 20) |
| risky_libm_cos | 1 (MATCH) | `569d1d2e71c1e4a8` (all 20) |
| risky_libm_tan | 1 (MATCH) | `141a2e2e597fa674` (all 20) |
| risky_libm_exp | 1 (MATCH) | `cfedd2d04403fb7a` (all 20) |
| risky_libm_ln | 1 (MATCH) | `acb32c10252a01b8` (all 20) |
| risky_libm_powf | 1 (MATCH) | `93da237fa14e0372` (all 20) |
| risky_libm_atan2 | 1 (MATCH) | `45a6b2ffdd749d1b` (all 20) |
| risky_libm_sqrt | 1 (MATCH) | `e487a6539cd70ad1` (all 20) |
| risky_libm_cbrt | 1 (MATCH) | `d0a132d434fb9caf` (all 20) |
| risky_libm_hypot | 1 (MATCH) | `d05e69c29f0c66df` (all 20) |
| risky_libm_sin_f64 | 1 (MATCH) | `c40359267883bbbb` (all 20) |
| risky_libm_pow_f64 | 1 (MATCH) | `c6a6c6c61f8f655d` (all 20) |
| risky_mul_add_fused | 1 (MATCH) | `f388597b86c2997c` (all 20) |
| risky_mul_add_plain | 1 (MATCH) | `0cf4eae81befdb07` (all 20) |
| risky_mul_add_ndiffer | 1 (MATCH) | `0x000067eb` (all 20) |
| risky_conv | 1 (MATCH) | `ee6fbfef24a4362d` (all 20) |
| risky_nan_hash | **4 (DIVERGE)** | `0e7f35534857ea98`: native-linux-amd64-debug<br>`dc2f7d300e851158`: native-linux-amd64-release, native-linux-amd64-release-cpunative, node-x64-emulated-o3, node-x64-emulated-os<br>`d323e6d966b5f998`: native-linux-arm64-debug<br>`bfca81cc13044058`: native-linux-arm64-release, native-linux-arm64-release-cpunative, *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, webkit-o3, webkit-os |
| nan: 0/0 runtime | **2 (DIVERGE)** | `0xffc00000`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, node-x64-emulated-o3, node-x64-emulated-os<br>`0x7fc00000`: native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative, *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, webkit-o3, webkit-os |
| nan: inf-inf | **2 (DIVERGE)** | `0xffc00000`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, node-x64-emulated-o3, node-x64-emulated-os<br>`0x7fc00000`: native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative, *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, webkit-o3, webkit-os |
| nan: inf*0 | **2 (DIVERGE)** | `0xffc00000`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, node-x64-emulated-o3, node-x64-emulated-os<br>`0x7fc00000`: native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative, *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, webkit-o3, webkit-os |
| nan: sqrt(-1) | **2 (DIVERGE)** | `0xffc00000`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, node-x64-emulated-o3, node-x64-emulated-os<br>`0x7fc00000`: native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative, *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, webkit-o3, webkit-os |
| nan: -(0/0) | **2 (DIVERGE)** | `0x7fc00000`: native-linux-amd64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative, *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, webkit-o3, webkit-os<br>`0xffc00000`: native-linux-amd64-release, native-linux-amd64-release-cpunative, native-linux-arm64-debug, node-x64-emulated-o3, node-x64-emulated-os |
| nan: qNaN(payload 1)+1 | 1 (MATCH) | `0x7fc00001` (all 20) |
| nan: sNaN(payload 1)+1 | 1 (MATCH) | `0x7fc00001` (all 20) |
| nan: sNaN f32->f64->f32 (no arithmetic) | **2 (DIVERGE)** | `0x7fc00001`: native-linux-amd64-debug, native-linux-arm64-debug<br>`0x7f800001`: native-linux-amd64-release, native-linux-amd64-release-cpunative, native-linux-arm64-release, native-linux-arm64-release-cpunative, *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| nan: qNaN payload f32->f64 low32 | 1 (MATCH) | `0x20000000` (all 20) |
| nan: NaN.min(1) | 1 (MATCH) | `0x3f800000` (all 20) |
| nan: NaN*0 as i32 | 1 (MATCH) | `0x00000000` (all 20) |
| nan: 0/0 const-folded by compiler | 1 (MATCH) | `0x7fc00000` (all 20) |
| nan: normalize zero vector x/len | **2 (DIVERGE)** | `0xffc00000`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, node-x64-emulated-o3, node-x64-emulated-os<br>`0x7fc00000`: native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative, *[10 arm64 JS runs: bun, chrome, chromium, firefox, node x o3/os]*, webkit-o3, webkit-os |
| nan: two NaN payloads a+b | 1 (MATCH) | `0xffc00123` (all 20) |
| bench_chunks | 1 (MATCH) | `ab9b746b1dbb6a71` (all 20) |
| bench_chunks_f64 | 1 (MATCH) | `7d8109a8e12fa120` (all 20) |

`risky_mul_add_ndiffer` = in how many of 200,000 random triples `a.mul_add(b,c)` differs bitwise from `a*b+c`: 26,603 (13%). So fusion *would* be visible if any compiler or engine did it; none did.

## What diverged, and why

| Operation | Result | Why |
|---|---|---|
| `f32::sin cos tan exp ln powf atan2 hypot`, `f64::sin powf` via **std** | Native != WASM. All WASM runs agree with each other; all 6 native Linux builds agree with each other (same glibc). | On `wasm32-unknown-unknown` std links the pure-Rust libm from `compiler-builtins` into the module; native calls the system libm (here glibc 2.41; macOS libSystem would be a third answer, untested). |
| Same functions via the **pinned `libm` crate** (`=0.2.15`) | MATCH in all 20, and equal to the WASM std hashes. | Same Rust source compiled everywhere; it only uses IEEE-exact primitive ops. |
| Hand-written polynomial sin/cos (`+ - * floor`) | MATCH in all 20. | Same reason. Accuracy about 1e-6, not correctly rounded, which does not matter for determinism. |
| `sqrt` (std or libm) | MATCH. | IEEE-754 requires correct rounding; hardware instruction / wasm `f32.sqrt`. |
| `cbrt` via std | MATCH (by luck). | glibc and Rust libm both descend from the same FreeBSD msun routine. Do not rely on it. |
| `mul_add` | MATCH. | RFC 3514: always the correctly rounded fused result; hardware FMA natively, software `fma` in wasm. Deterministic, just slow in wasm. |
| `a*b+c` with `target-cpu=native` | MATCH. | rustc never sets fp-contract/fast-math, so LLVM does not fuse. |
| Division, f64<->f32, int<->float, saturating `as` casts (incl. out-of-range and NaN -> 0) | MATCH. | All fully specified by IEEE-754 / Rust / Wasm (`nontrapping-fptoint`). |
| **NaN produced by an operation** (`0/0`, `inf-inf`, `inf*0`, `sqrt(-1)`, normalizing a zero vector) | **aarch64: `0x7fc00000`; x86-64: `0xffc00000`**, for native *and for the identical `.wasm` under Node x64*. | Hardware default NaN sign differs; Wasm leaves it nondeterministic. This is the x86-server-vs-ARM-phone hazard. |
| `0/0` const-folded by LLVM | `0x7fc00000` everywhere, **including x86**, where the runtime value is `0xffc00000`. | Compile-time folding and run-time hardware disagree; whether a NaN is folded depends on optimization. |
| `-(0/0)` | Differs **between debug and release on the same CPU** (arm64 debug `0xffc00000`, release `0x7fc00000`; x86 the reverse). | LLVM rewrites `-(a/b)` to `(-a)/b`, legal because NaN sign is unspecified. |
| sNaN `f32 -> f64 -> f32` | Debug `0x7fc00001` (quieted), release and wasm `0x7f800001`. | Optimizer elides the round trip. |
| NaN payload propagation (`qNaN+1`, `NaN+NaN`), `NaN.min(1)`, `NaN as i32` | MATCH here. | Payload propagation is permitted to vary by the Wasm spec; it just did not on these CPUs. Not a guarantee. |

Nothing diverged between JS engines, between `opt-level=3` and `"s"`, or between debug and release, except NaN bits.

## Timing

Mean over 2,000 chunks after a 200-chunk warm-up. One chunk = 1,024 tiles x 8 simplex evaluations (5-octave height + 3-octave moisture) + scatter hash. **The hash over all chunk bytes and raw floats (12 KiB of FNV-1a per chunk) is inside the timed region**, so generation alone is somewhat cheaper. Last run:

| env | ms / 32x32 chunk (f32, 8 simplex evals per tile) | ms / chunk (f64) | sim: us / tick (256 springs) |
|---|---|---|---|
| native-linux-amd64-debug | 0.77075 | 0.77415 | 5.9154 |
| native-linux-amd64-release | 0.19622 | 0.19049 | 0.1378 |
| native-linux-amd64-release-cpunative | 0.23817 | 0.19515 | 0.7744 |
| native-linux-arm64-debug | 0.56845 | 0.59844 | 4.3333 |
| native-linux-arm64-release | 0.08389 | 0.08147 | 0.1673 |
| native-linux-arm64-release-cpunative | 0.08782 | 0.08577 | 0.1397 |
| bun-o3 | 0.08477 | 0.08516 | 0.2934 |
| bun-os | 0.14065 | 0.21118 | 1.1431 |
| chrome-o3 | 0.0947 | 0.09685 | 0.312 |
| chrome-os | 0.0972 | 0.09895 | 0.358 |
| chromium-o3 | 0.0924 | 0.09625 | 0.309 |
| chromium-os | 0.0966 | 0.09915 | 0.357 |
| firefox-o3 | 0.205 | 0.6745 | 1.44 |
| firefox-os | 0.385 | 0.4895 | 0.75 |
| node-o3 | 0.09176 | 0.0863 | 0.2924 |
| node-os | 0.35078 | 0.12818 | 0.5044 |
| node-x64-emulated-o3 | 0.29439 | 0.23863 | 0.8853 |
| node-x64-emulated-os | 0.17417 | 0.18699 | 0.6793 |
| webkit-o3 | 0.0895 | 0.087 | 0.31 |
| webkit-os | 0.089 | 0.0905 | 0.38 |

Timings were noisy between runs (other load on the machine, including the Docker VM; the outliers moved between engines from run to run, so they are not engine properties). Across three runs the arm64 JS engines ranged, in ms/chunk f32: Node 0.09-0.35, Bun 0.08-0.18, Chromium/Chrome 0.09-0.11, WebKit 0.087-0.097, Firefox 0.10-0.39. The first and quietest run (JSON since overwritten) read Node 0.095/0.097, Bun 0.093/0.090, Chrome 0.108/0.094, Chromium 0.104/0.100, Firefox 0.105/0.096, WebKit 0.097/0.087 for o3/os. Quiet-machine reading: **about 0.09-0.11 ms per chunk in every engine, about 1.1-1.3x native release (0.084 ms)**. `opt-level="s"` vs `3`: no consistent difference for this code (wasm 69 KiB vs 75 KiB, mostly libm). f64 noise costs the same as f32 on this hardware. Debug native is about 7x slower. Browser `performance.now()` is coarsened, which is irrelevant over a 200 ms total.

Extrapolation (not measured): a phone 3-5x slower per core gives about 0.3-0.5 ms per chunk, so Factorio's 41x41 = 1,681-chunk ring would be under 1 s of worker time. Client-side regeneration looks cheap relative to shipping 4 KiB per chunk.

## Side finding: f32 precision at +-8M tiles (quality, not determinism)

Tile-level terrain disagreement between the f32 and f64 generators (`driver/probe-precision.mjs`, base frequency 1/128, 5 octaves):

| chunk coord | tile coord | terrain tiles differing from f64 (of 1024, mean of 16 chunks) | max abs height error |
|---|---|---|---|
| 0 | 0 | 0.0 | 0.000001 |
| 100 | 3200 | 0.0 | 0.000011 |
| 1000 | 32000 | 0.1 | 0.000174 |
| 10000 | 320000 | 1.3 | 0.002693 |
| 31250 | 1000000 | 2.5 | 0.002992 |
| 100000 | 3200000 | 7.5 | 0.008849 |
| 250000 | 8000000 | 14.8 | 0.024162 |
| -250000 | -8000000 | 14.2 | 0.021013 |

f32 is deterministic everywhere but visibly degrades far out (about 1.4% of tiles classified differently at 8M tiles; the highest octave has only about 2 ulps per tile there). Since f64 measured the same speed and is equally deterministic, **use f64 for noise coordinates** (or integer lattice coords + float fractional part) if the +-8M range is real. Relevant to `docs/research/world.md`.

## Rules for a deterministic crate

1. **Allowed float ops:** `+ - * /`, `sqrt`, `floor/ceil/trunc/round`, `abs`, comparisons, `min/max` on non-NaN values, int<->float and f32<->f64 `as` casts. f32 and f64 are both fine. Constants as decimal literals (e.g. skew factors), never computed at startup with a transcendental.
2. **Transcendentals:** never `f32::sin`/`powf`/etc. from std in sim or worldgen code. Either (a) hand-written polynomials/tables from the allowed ops, or (b) the `libm` crate pinned with `=` and called explicitly (`libm::sinf`). Enforce with clippy `disallowed_methods` on the std float methods. If the server runs the same `.wasm` as the clients (the `simulation.md` 3.2 recommendation) std calls are *also* consistent, but native `cargo test` would then disagree with production, so ban them anyway.
3. **`mul_add`:** deterministic, but a software call in wasm. Avoid for speed, not correctness. Never enable fast-math-style flags or intrinsics (`fadd_fast`, `-C llvm-args=-fp-contract=fast`).
4. **NaN:** NaN bits must never be observable. No NaN in persistent state; guard every division/sqrt/normalize whose input can be zero or negative; `debug_assert!(x.is_finite())` at state writes; the hash/codec canonicalizes (`if x != x { 0x7fc00000 }`) as a backstop. Never `to_bits`, `total_cmp`, `copysign`, `is_sign_negative`, or transmute on a possibly-NaN value. This is the one rule that matters even with a single `.wasm` everywhere, because an x86 server and an ARM phone produce different NaN signs from identical bytes, and debug/release differ too.
5. **Integers:** wrapping ops written explicitly (`wrapping_mul`), no `usize` in hashed or serialized state, hash-based gradient selection instead of a seeded permutation table, fixed iteration order.
6. **Compiler flags:** default wasm32 target features only. Never `+relaxed-simd`; `+simd128` is deterministic but was not tested here. `opt-level` 3 vs `s`, LTO, debug vs release and `target-cpu=native` did not change any non-NaN result. `panic=abort` is fine.
7. **Testing:** keep this as a permanent CI test: one fixed seed, golden hashes checked in (the table above), run natively and as `.wasm` in Node + Playwright Chromium/Firefox/WebKit. Hash raw float bits, not just derived tiles, so low-bit drift cannot hide behind thresholds.

## Not tested, and how much it matters

| Gap | Matters? |
|---|---|
| Native aarch64 macOS (blocked by Xcode license) | Low. Same CPU as the aarch64 Linux container, same rustc/LLVM; only the system libm differs, which affects only operations already banned. One command to close. |
| Real x86-64 hardware (x86 here was Rosetta emulation, both for native and for V8's x64 JIT output) | Low-medium. Non-NaN IEEE arithmetic under Rosetta must be exact and matched; the NaN sign result matches documented x86 behaviour. A CI run on a real x86 runner closes it for free. |
| Real iPhone / Safari.app / Android Chrome | Medium for *timing*, low for *hashes*. Playwright WebKit and Bun exercise JSC's wasm tiers on arm64, but not Apple's shipping Safari build or iOS's JIT configuration (or Lockdown Mode's interpreter). Phone ms/chunk is an extrapolation. Serve the driver page and open it on a phone once a dev server exists. |
| 32-bit ARM, RISC-V, x87-era x86 | Negligible. |
| `wasm-opt`, `+simd128`, other rustc versions | Medium. A toolchain bump may change libm or codegen; treat the `.wasm` content hash as the sim identity (`simulation.md` 3.4) and let the golden-hash test catch drift. |
| Only about 2,000 chunks and 1e5 ticks per run (brief in `world.md` suggested about 10,000 chunks) | Low. Raise `N_CHUNKS` in `driver/plan.mjs` and `src/main.rs` together. |
| Windows/MSVC native | Irrelevant unless a native Windows server is ever wanted. |

## Re-run

```sh
cd spikes/determinism-hash
pnpm install && npx playwright install chromium webkit firefox
# Docker Desktop must be running (native Linux builds + the wasm build with the libm feature)
./run-all.sh            # writes results/*.json, results/TABLE.md, results/PRECISION.md
```

Without Docker, once the Xcode license is accepted: `cargo build --release --features libm-crate --target wasm32-unknown-unknown --lib`, copy the `.wasm` to `wasm/o3.wasm`, then `node driver/run-js.mjs wasm/o3.wasm node-o3`, `bun driver/run-js.mjs ...`, `node driver/run-browsers.mjs wasm/o3.wasm o3`, `cargo run --release --features libm-crate -- native-macos > results/native-macos.json`, `node driver/compare.mjs`.

Files: `src/lib.rs` (noise, chunk gen, sims, risky variants, C ABI), `src/main.rs` (native runner), `driver/plan.mjs` (the plan, mirrored by `main.rs`), `driver/run-js.mjs`, `driver/run-browsers.mjs`, `driver/compare.mjs`, `driver/probe-precision.mjs`, `docker-native.sh`, `docker-node-amd64.sh`, `wasm/*.wasm` (the exact binaries measured).
