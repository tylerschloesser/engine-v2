// Prefix of the `fatal` a worker posts when the `WebAssembly.Module` in its setup message could not be
// deserialised (`messageerror`, M35): `createClient` answers it by re-sending the setup with the URL
// (0017 §4). Its own file: `client.ts` may not import `worker/*` (`main.no_wasm_instantiate`), and
// `worker.ts` and `client.ts` both need the string.
export const MODULE_REFUSED = 'module-refused'
