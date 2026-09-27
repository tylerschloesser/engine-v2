// The host-side handshake (docs/decisions/0013-sessions-and-integrity.md "Handshake";
// docs/plan/28-sessions-and-reconnect.md steps 1-2): `Hello`/`Welcome`/`Reject` framing constants,
// the `Reject` builder (must not depend on a live instance -- Scope), and `CloseCode`, the only
// signal a non-parsing net worker acts on (Seams).
//
// `Hello`'s frozen prefix (`magic u32 · protocol_version u16 · build_hash [u8; 32]`) is parsed
// here with `DataView`: the server is outside 0016's zero-GC rule (`.claude/rules/hot-paths.md`
// doc comment), and this runs once per connection, not per frame or tick.

/** `Connection.close(code)` (0009). The close code, not the message body, is what a non-parsing
 * net worker acts on (M29's own boundary; Seams). */
export const CloseCode = {
  Superseded: 4001,
  VersionMismatch: 4002,
  BadKey: 4003,
  Full: 4004,
  ProtocolError: 4005,
} as const
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode]

/** Covers only the frozen prefixes (0013 "Build-hash handshake"). */
export const PROTOCOL_VERSION = 1

/** `session::MAGIC` (`crates/engine/src/session/mod.rs`), mirrored here byte for byte: spells
 * `\x80ENG` in wire (little-endian) order. Low byte `0x80` satisfies 0024 §8's "first wire byte
 * is `>= 0x80`" constraint so `Hello`/`Reject` never collide with a post-handshake `MsgType`
 * byte (`0x01..=0x05`). Two independent literals (here and in Rust) are intentional: `golden_hello`/
 * `golden_reject` (session module) and `reject bytes match the Rust golden` (this file's own test)
 * both fail if they ever drift apart. */
export const MAGIC = 0x474e_4580

export const BUILD_HASH_LEN = 32
export const SECRET_LEN = 16
/** `wire::CameraReport::LEN` (Rust), mirrored: the minimum a well-formed `helloTail` must carry --
 * `sim_attach`'s own Rust-side parse always reads a `CameraReport` (16 B) off the front of the
 * tail before anything else, so a tail shorter than this can never be a real `Hello`, only a
 * truncated one. */
export const CAMERA_REPORT_LEN = 16

/** `session::RejectReason` (Rust), mirrored: `0 VersionMismatch, 1 BadKey, 2 Full` (0013). */
export const RejectReason = {
  VersionMismatch: 0,
  BadKey: 1,
  Full: 2,
} as const
export type RejectReason = (typeof RejectReason)[keyof typeof RejectReason]

/** `RejectReason` -> `CloseCode`: the wire byte a `Reject` carries and the code its `close()`
 * call uses are two different numbering schemes (0013's frozen reject byte vs. 0009's close-code
 * range), so this is the one place that maps between them. */
export function rejectReasonCloseCode(reason: RejectReason): CloseCode {
  switch (reason) {
    case RejectReason.VersionMismatch:
      return CloseCode.VersionMismatch
    case RejectReason.BadKey:
      return CloseCode.BadKey
    case RejectReason.Full:
      return CloseCode.Full
  }
}

export const REJECT_LEN = 4 + 2 + 1 + BUILD_HASH_LEN // magic · protocol_version · reason · build_hash

/**
 * Builds `Reject` bytes (0013, frozen layout): `[magic u32][protocol_version u16][reason
 * u8][build_hash [u8; 32]]`. Pure: takes the server's own `buildHash` as a parameter rather than
 * reading it from a live instance (Scope: "it must not depend on the instance") so a connection
 * can be rejected before any `WorldServer`/`SimHost` exists to ask (`VersionMismatch`/`BadKey`
 * both fire from the frozen prefix alone; `Full` only needs the session table and `WorldConfig`,
 * neither of which is instance state either).
 */
export function buildReject(reason: RejectReason, buildHash: Uint8Array): Uint8Array {
  if (buildHash.length !== BUILD_HASH_LEN) {
    throw new Error(
      `buildReject: buildHash must be ${BUILD_HASH_LEN} bytes, got ${buildHash.length}`,
    )
  }
  const out = new Uint8Array(REJECT_LEN)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint16(4, PROTOCOL_VERSION, true)
  out[6] = reason
  out.set(buildHash, 7)
  return out
}

/** The frozen-prefix fields `Hello` and `Reject` both open with. */
export interface FrozenPrefix {
  magic: number
  protocolVersion: number
  buildHash: Uint8Array
}

export const FROZEN_PREFIX_LEN = 4 + 2 + BUILD_HASH_LEN

/** Reads the 38-byte frozen prefix from the start of `bytes` with `DataView` (no `Codec`
 * dependency: this must parse before any instance, and possibly before any game, exists). Throws
 * a plain `Error`, not `ProtocolError` (below) -- a caller too short to carry a frozen prefix at
 * all is `ProtocolError` regardless of what the caller does with a well-formed-but-wrong one. */
export function readFrozenPrefix(bytes: Uint8Array): FrozenPrefix {
  if (bytes.length < FROZEN_PREFIX_LEN) {
    throw new Error(`readFrozenPrefix: need ${FROZEN_PREFIX_LEN} bytes, got ${bytes.length}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint32(0, true)
  const protocolVersion = view.getUint16(4, true)
  const buildHash = bytes.slice(6, 6 + BUILD_HASH_LEN)
  return { magic, protocolVersion, buildHash }
}

/** Parsed `Hello` fields the host handshake needs: the frozen prefix plus `join_key`/
 * `player_secret` (DataView, `Hello`'s own layout: `wire/CLAUDE.md`/`session::Hello`'s own doc
 * comment -- `session_hello`'s golden bytes are this exact shape). The camera report and any
 * resume hint are left as the untouched `helloTail` (Seams: "Hello tail = camera report +
 * optional resume, which M28 ignores"), forwarded verbatim into `sim_attach`'s input region.
 */
export interface ParsedHello {
  protocolVersion: number
  buildHash: Uint8Array
  joinKey: Uint8Array
  playerSecret: Uint8Array
  /** Bytes following `player_secret`: `CameraReport` (16 B) plus the optional resume block,
   * exactly as `session::Hello`'s own writer produced them. Opaque here. */
  helloTail: Uint8Array
}

/** Thrown for anything that closes the connection with `CloseCode.ProtocolError` (Scope: "magic
 * or version wrong, or no `Hello` within 5 s, closes with `ProtocolError`"; malformed bytes are
 * the same failure mode -- decode is also a protocol violation, not a `Reject`, since `Reject`'s
 * own frozen layout requires a build hash the sender has not proven it agrees on yet). */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

/** Varint reader matching `session::read_varint_len`'s own LEB128 shape (`crate::bytes::
 * ByteReader::varint`), used only for `join_key`'s length prefix here -- everything else in
 * `Hello` up to `helloTail` is fixed-width. */
function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0
  let shift = 0
  let pos = offset
  for (let i = 0; i < 10; i++) {
    if (pos >= bytes.length) throw new ProtocolError('Hello: truncated join_key length varint')
    const byte = bytes[pos]
    if (byte === undefined) throw new ProtocolError('Hello: truncated join_key length varint')
    pos++
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: pos }
    shift += 7
  }
  throw new ProtocolError('Hello: join_key length varint too long')
}

/** Parses a full `Hello` message (magic through `player_secret`), throwing `ProtocolError` on a
 * bad magic or version, or on any truncation -- the host's own gate before a session-table
 * lookup ever runs (Scope). Does not check `join_key` against `WorldConfig.joinKey`: that is
 * `BadKey`, a `Reject`, not a `ProtocolError` (0013's own two-tier failure model), decided by the
 * caller once it knows the world's real join key.
 */
export function parseHello(bytes: Uint8Array): ParsedHello {
  if (bytes.length < FROZEN_PREFIX_LEN) {
    throw new ProtocolError(`Hello: need ${FROZEN_PREFIX_LEN} bytes, got ${bytes.length}`)
  }
  const prefix = readFrozenPrefix(bytes)
  if (prefix.magic !== MAGIC) {
    throw new ProtocolError(`Hello: bad magic 0x${prefix.magic.toString(16)}`)
  }
  if (prefix.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      `Hello: protocol version ${prefix.protocolVersion} != ${PROTOCOL_VERSION}`,
    )
  }
  const { value: joinKeyLen, next } = readVarint(bytes, FROZEN_PREFIX_LEN)
  const joinKeyEnd = next + joinKeyLen
  const secretEnd = joinKeyEnd + SECRET_LEN
  if (secretEnd > bytes.length) {
    throw new ProtocolError('Hello: truncated join_key or player_secret')
  }
  const joinKey = bytes.slice(next, joinKeyEnd)
  const playerSecret = bytes.slice(joinKeyEnd, secretEnd)
  const helloTail = bytes.slice(secretEnd)
  if (helloTail.length < CAMERA_REPORT_LEN) {
    throw new ProtocolError(
      `Hello: truncated tail, need >= ${CAMERA_REPORT_LEN} bytes for CameraReport, got ${helloTail.length}`,
    )
  }
  return {
    protocolVersion: prefix.protocolVersion,
    buildHash: prefix.buildHash,
    joinKey,
    playerSecret,
    helloTail,
  }
}
