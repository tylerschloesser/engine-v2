// `handshake.ts` unit tests (M28 steps 1-2). Reject bytes are
// checked byte-identical against the same native golden file `session::tests::golden_reject`
// blesses (`crates/engine/tests/golden/session_reject.hex`) -- the milestone's own "Reject golden
// bytes are identical from the TS builder and the Rust parser" exit criterion, both halves against
// one file.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
  BUILD_HASH_LEN,
  buildReject,
  CloseCode,
  FROZEN_PREFIX_LEN,
  MAGIC,
  PROTOCOL_VERSION,
  ProtocolError,
  parseHello,
  RejectReason,
  readFrozenPrefix,
  rejectReasonCloseCode,
} from './handshake.js'

const GOLDEN_REJECT_PATH = fileURLToPath(
  new URL('../../crates/engine/tests/golden/session_reject.hex', import.meta.url),
)

function readGoldenHex(path: string): Uint8Array {
  const text = readFileSync(path, 'utf8')
  const digits = text.replace(/\s+/g, '')
  const out = new Uint8Array(digits.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** The exact fixture `session::tests::golden_reject` (Rust) built its golden from: `reason =
 * VersionMismatch`, `build_hash[i] = i * 3`. Two independent literals (there and here) are
 * intentional: this test is what proves they still agree. */
function goldenBuildHash(): Uint8Array {
  const h = new Uint8Array(BUILD_HASH_LEN)
  for (let i = 0; i < h.length; i++) h[i] = (i * 3) & 0xff
  return h
}

test('reject bytes match the Rust golden', () => {
  const golden = readGoldenHex(GOLDEN_REJECT_PATH)
  const built = buildReject(RejectReason.VersionMismatch, goldenBuildHash())
  expect(Array.from(built)).toEqual(Array.from(golden))
})

test('buildReject: frozen layout, magic/version/reason/build_hash in that order', () => {
  const hash = new Uint8Array(BUILD_HASH_LEN).fill(7)
  const out = buildReject(RejectReason.BadKey, hash)
  expect(out.length).toBe(4 + 2 + 1 + BUILD_HASH_LEN)
  const view = new DataView(out.buffer)
  expect(view.getUint32(0, true)).toBe(MAGIC)
  expect(view.getUint16(4, true)).toBe(PROTOCOL_VERSION)
  expect(out[6]).toBe(RejectReason.BadKey)
  expect(Array.from(out.slice(7))).toEqual(Array.from(hash))
})

test('buildReject: throws on a wrong-length build hash rather than truncating or padding', () => {
  expect(() => buildReject(RejectReason.Full, new Uint8Array(31))).toThrow()
})

test('rejectReasonCloseCode: maps every reason to its own close code', () => {
  expect(rejectReasonCloseCode(RejectReason.VersionMismatch)).toBe(CloseCode.VersionMismatch)
  expect(rejectReasonCloseCode(RejectReason.BadKey)).toBe(CloseCode.BadKey)
  expect(rejectReasonCloseCode(RejectReason.Full)).toBe(CloseCode.Full)
})

function helloBytes(opts: {
  magic?: number
  protocolVersion?: number
  buildHash?: Uint8Array
  joinKey?: Uint8Array
  secret?: Uint8Array
  tail?: Uint8Array
}): Uint8Array {
  const buildHash = opts.buildHash ?? new Uint8Array(BUILD_HASH_LEN).fill(1)
  const joinKey = opts.joinKey ?? new Uint8Array([])
  const secret = opts.secret ?? new Uint8Array(16).fill(2)
  const tail = opts.tail ?? new Uint8Array(16) // a zeroed CameraReport is a well-formed tail
  const out = new Uint8Array(FROZEN_PREFIX_LEN + 1 + joinKey.length + secret.length + tail.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, opts.magic ?? MAGIC, true)
  view.setUint16(4, opts.protocolVersion ?? PROTOCOL_VERSION, true)
  out.set(buildHash, 6)
  let off = FROZEN_PREFIX_LEN
  out[off] = joinKey.length // fits one varint byte for every join key this file uses
  off += 1
  out.set(joinKey, off)
  off += joinKey.length
  out.set(secret, off)
  off += secret.length
  out.set(tail, off)
  return out
}

test('parseHello: round-trips a well-formed Hello', () => {
  const joinKey = new TextEncoder().encode('open-sesame')
  const secret = new Uint8Array(16).fill(9)
  const buildHash = new Uint8Array(BUILD_HASH_LEN).fill(5)
  const tail = new Uint8Array(20).fill(3)
  const bytes = helloBytes({ joinKey, secret, buildHash, tail })
  const parsed = parseHello(bytes)
  expect(parsed.protocolVersion).toBe(PROTOCOL_VERSION)
  expect(Array.from(parsed.buildHash)).toEqual(Array.from(buildHash))
  expect(Array.from(parsed.joinKey)).toEqual(Array.from(joinKey))
  expect(Array.from(parsed.playerSecret)).toEqual(Array.from(secret))
  expect(Array.from(parsed.helloTail)).toEqual(Array.from(tail))
})

test('parseHello: bad magic is a ProtocolError', () => {
  const bytes = helloBytes({ magic: 0xdeadbeef })
  expect(() => parseHello(bytes)).toThrow(ProtocolError)
})

test('parseHello: bad protocol version is a ProtocolError', () => {
  const bytes = helloBytes({ protocolVersion: PROTOCOL_VERSION + 1 })
  expect(() => parseHello(bytes)).toThrow(ProtocolError)
})

test('parseHello: truncated input is a ProtocolError, not a thrown index error', () => {
  const full = helloBytes({})
  expect(() => parseHello(full.slice(0, FROZEN_PREFIX_LEN - 1))).toThrow(ProtocolError)
  expect(() => parseHello(full.slice(0, full.length - 1))).toThrow(ProtocolError)
})

test('readFrozenPrefix: fails cleanly under the 38-byte minimum', () => {
  expect(() => readFrozenPrefix(new Uint8Array(10))).toThrow()
})
