### Environments

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
| chrome-o3 | chrome 153.0.8010.52 / Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36 |
| chrome-os | chrome 153.0.8010.52 / Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36 |
| chromium-o3 | chromium 153.0.8010.12 / Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36 |
| chromium-os | chromium 153.0.8010.12 / Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36 |
| firefox-o3 | firefox 155.0 / Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0 |
| firefox-os | firefox 155.0 / Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0 |
| node-o3 | node v22.18.0 v8 12.4.254.21-node.27 |
| node-os | node v22.18.0 v8 12.4.254.21-node.27 |
| node-x64-emulated-o3 | node v22.23.2 v8 12.4.254.21-node.56 |
| node-x64-emulated-os | node v22.23.2 v8 12.4.254.21-node.56 |
| webkit-o3 | webkit 26.6 / Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15 |
| webkit-os | webkit 26.6 / Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15 |

### Safe variant: every hash, every environment

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

### All rows: agreement summary

| row | distinct values | value -> environments |
|---|---|---|
| safe_chunks | 1 (MATCH) | `9ae2f43a6fc43415` (all 20) |
| safe_chunks_tiles_only | 1 (MATCH) | `3460f07c95d60b88` (all 20) |
| safe_chunks_f64 | 1 (MATCH) | `6ffc648955592a25` (all 20) |
| safe_sim_f32 | 1 (MATCH) | `3607d7bf9efcf084` (all 20) |
| safe_sim_fixed | 1 (MATCH) | `d835366cc4b6dfdf` (all 20) |
| safe_det_trig | 1 (MATCH) | `0ab86426305e93f6` (all 20) |
| risky_std_sin | **2 (DIVERGE)** | `544ae182a511825b`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative<br>`7257471484241179`: bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_cos | **2 (DIVERGE)** | `0f9545b0e20af70e`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative<br>`569d1d2e71c1e4a8`: bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_tan | **2 (DIVERGE)** | `992a75ce62f82916`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative<br>`141a2e2e597fa674`: bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_exp | **2 (DIVERGE)** | `31f43588d61b119c`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative<br>`cfedd2d04403fb7a`: bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_ln | **2 (DIVERGE)** | `53bf23f0ef3ac70f`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative<br>`acb32c10252a01b8`: bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_powf | **2 (DIVERGE)** | `168a69458f28dc17`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative<br>`93da237fa14e0372`: bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_atan2 | **2 (DIVERGE)** | `bd0f613612128117`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative<br>`45a6b2ffdd749d1b`: bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_sqrt | 1 (MATCH) | `e487a6539cd70ad1` (all 20) |
| risky_std_cbrt | 1 (MATCH) | `d0a132d434fb9caf` (all 20) |
| risky_std_hypot | **2 (DIVERGE)** | `6339c1b293ac9c52`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative<br>`d05e69c29f0c66df`: bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_sin_f64 | **2 (DIVERGE)** | `99108980f0cc3708`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative<br>`c40359267883bbbb`: bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| risky_std_pow_f64 | **2 (DIVERGE)** | `bcd02ff469f22624`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative<br>`c6a6c6c61f8f655d`: bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
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
| risky_nan_hash | **4 (DIVERGE)** | `0e7f35534857ea98`: native-linux-amd64-debug<br>`dc2f7d300e851158`: native-linux-amd64-release, native-linux-amd64-release-cpunative, node-x64-emulated-o3, node-x64-emulated-os<br>`d323e6d966b5f998`: native-linux-arm64-debug<br>`bfca81cc13044058`: native-linux-arm64-release, native-linux-arm64-release-cpunative, bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, webkit-o3, webkit-os |
| nan: 0/0 runtime | **2 (DIVERGE)** | `0xffc00000`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, node-x64-emulated-o3, node-x64-emulated-os<br>`0x7fc00000`: native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative, bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, webkit-o3, webkit-os |
| nan: inf-inf | **2 (DIVERGE)** | `0xffc00000`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, node-x64-emulated-o3, node-x64-emulated-os<br>`0x7fc00000`: native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative, bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, webkit-o3, webkit-os |
| nan: inf*0 | **2 (DIVERGE)** | `0xffc00000`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, node-x64-emulated-o3, node-x64-emulated-os<br>`0x7fc00000`: native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative, bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, webkit-o3, webkit-os |
| nan: sqrt(-1) | **2 (DIVERGE)** | `0xffc00000`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, node-x64-emulated-o3, node-x64-emulated-os<br>`0x7fc00000`: native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative, bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, webkit-o3, webkit-os |
| nan: -(0/0) | **2 (DIVERGE)** | `0x7fc00000`: native-linux-amd64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative, bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, webkit-o3, webkit-os<br>`0xffc00000`: native-linux-amd64-release, native-linux-amd64-release-cpunative, native-linux-arm64-debug, node-x64-emulated-o3, node-x64-emulated-os |
| nan: qNaN(payload 1)+1 | 1 (MATCH) | `0x7fc00001` (all 20) |
| nan: sNaN(payload 1)+1 | 1 (MATCH) | `0x7fc00001` (all 20) |
| nan: sNaN f32->f64->f32 (no arithmetic) | **2 (DIVERGE)** | `0x7fc00001`: native-linux-amd64-debug, native-linux-arm64-debug<br>`0x7f800001`: native-linux-amd64-release, native-linux-amd64-release-cpunative, native-linux-arm64-release, native-linux-arm64-release-cpunative, bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, node-x64-emulated-o3, node-x64-emulated-os, webkit-o3, webkit-os |
| nan: qNaN payload f32->f64 low32 | 1 (MATCH) | `0x20000000` (all 20) |
| nan: NaN.min(1) | 1 (MATCH) | `0x3f800000` (all 20) |
| nan: NaN*0 as i32 | 1 (MATCH) | `0x00000000` (all 20) |
| nan: 0/0 const-folded by compiler | 1 (MATCH) | `0x7fc00000` (all 20) |
| nan: normalize zero vector x/len | **2 (DIVERGE)** | `0xffc00000`: native-linux-amd64-debug, native-linux-amd64-release, native-linux-amd64-release-cpunative, node-x64-emulated-o3, node-x64-emulated-os<br>`0x7fc00000`: native-linux-arm64-debug, native-linux-arm64-release, native-linux-arm64-release-cpunative, bun-o3, bun-os, chrome-o3, chrome-os, chromium-o3, chromium-os, firefox-o3, firefox-os, node-o3, node-os, webkit-o3, webkit-os |
| nan: two NaN payloads a+b | 1 (MATCH) | `0xffc00123` (all 20) |
| bench_chunks | 1 (MATCH) | `ab9b746b1dbb6a71` (all 20) |
| bench_chunks_f64 | 1 (MATCH) | `7d8109a8e12fa120` (all 20) |

### Timing

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
