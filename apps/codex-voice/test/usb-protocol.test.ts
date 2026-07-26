import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeStackChanFrame,
  encodeStackChanFrame,
  STACKCHAN_HOST_CAPABILITIES,
  StackChanCapability,
  StackChanControl,
  StackChanEventDecoder,
  StackChanEventEncoder,
  StackChanFrameParser,
  StackChanFrameType,
  STACKCHAN_MAX_EVENT_BYTES,
} from '../src/usb/protocol.js'
import { loadContractFixture } from './contract-fixtures.js'

type ContractFrameFields = {
  type: number
  flags: number
  streamId: number
  sequence: number
  sampleRate: number
  payloadHex: string
}

type ContractFrameVector = {
  name: string
  frame: ContractFrameFields
  encodedHex: string
}

type InvalidContractFrameVector = {
  name: string
  reason: string
  encodedHex: string
}

type ContractVectors = {
  schema: string
  protocolVersion: number
  validFrames: ContractFrameVector[]
  invalidFrames: InvalidContractFrameVector[]
}

const contractVectors = loadContractFixture<ContractVectors>('test-vectors.json')

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'hex'))
}

test('USB frame round-trips with CRC32 and v2 header fields', () => {
  const encoded = encodeStackChanFrame({
    type: StackChanFrameType.CONTROL,
    flags: StackChanControl.MIC_START,
    streamId: 7,
    sequence: 11,
    sampleRate: 16_000,
    payload: Uint8Array.of(1, 2, 3),
  })
  const decoded = decodeStackChanFrame(encoded)
  assert.equal(decoded.type, StackChanFrameType.CONTROL)
  assert.equal(decoded.flags, StackChanControl.MIC_START)
  assert.equal(decoded.streamId, 7)
  assert.equal(decoded.sequence, 11)
  assert.equal(decoded.sampleRate, 16_000)
  assert.deepEqual(decoded.payload, Uint8Array.of(1, 2, 3))
})

test('stream parser handles garbage, fragmented frames, and combined frames', () => {
  const first = encodeStackChanFrame({
    type: StackChanFrameType.MICROPHONE_PCM,
    streamId: 1,
    sequence: 0,
    sampleRate: 16_000,
    payload: new Uint8Array(640),
  })
  const second = encodeStackChanFrame({
    type: StackChanFrameType.CONTROL,
    flags: StackChanControl.MIC_STOPPED,
    streamId: 1,
  })
  const bytes = new Uint8Array(3 + first.byteLength + second.byteLength)
  bytes.set([9, 8, 7])
  bytes.set(first, 3)
  bytes.set(second, 3 + first.byteLength)
  const parser = new StackChanFrameParser()
  assert.deepEqual(parser.push(bytes.slice(0, 27)), [])
  const result = parser.push(bytes.slice(27))
  assert.equal(result.length, 2)
  assert.equal(result[0]?.type, StackChanFrameType.MICROPHONE_PCM)
  assert.equal(result[1]?.flags, StackChanControl.MIC_STOPPED)
})

test('stream parser skips a corrupt frame and resynchronizes', () => {
  const corrupt = encodeStackChanFrame({
    type: StackChanFrameType.CONTROL,
    flags: StackChanControl.HELLO,
  })
  corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 0xff
  const valid = encodeStackChanFrame({
    type: StackChanFrameType.CONTROL,
    flags: StackChanControl.HELLO_ACK,
  })
  const bytes = new Uint8Array(corrupt.byteLength + valid.byteLength)
  bytes.set(corrupt)
  bytes.set(valid, corrupt.byteLength)
  const result = new StackChanFrameParser().push(bytes)
  assert.equal(result.length, 1)
  assert.equal(result[0]?.flags, StackChanControl.HELLO_ACK)
})

test('EVENT fragments and reconstructs UTF-8 payloads', () => {
  const source = new TextEncoder().encode('承認イベント'.repeat(600))
  const frames = new StackChanEventEncoder().encode(source, 127)
  assert.ok(frames.length > 1)
  const decoder = new StackChanEventDecoder()
  let decoded: Uint8Array | undefined
  for (const frame of frames) decoded = decoder.push(frame) ?? decoded
  assert.deepEqual(decoded, source)
})

test('EVENT rejects payloads larger than the contract limit', () => {
  assert.throws(
    () => new StackChanEventEncoder().encode(new Uint8Array(STACKCHAN_MAX_EVENT_BYTES + 1)),
    /event is too large/,
  )
})

test('extended conversation status capability uses the next contract bit', () => {
  assert.equal(StackChanCapability.STATUS_EXTENDED, 1 << 11)
  assert.notEqual(STACKCHAN_HOST_CAPABILITIES & StackChanCapability.STATUS_EXTENDED, 0)
})

test('USB codec matches the shared contract frame vectors', () => {
  assert.equal(contractVectors.schema, 'stackchan.usb-cdc.test-vectors.v1')
  assert.equal(contractVectors.protocolVersion, 2)
  for (const vector of contractVectors.validFrames) {
    const expected = fromHex(vector.encodedHex)
    const encoded = encodeStackChanFrame({
      type: vector.frame.type as StackChanFrameType,
      flags: vector.frame.flags,
      streamId: vector.frame.streamId,
      sequence: vector.frame.sequence,
      sampleRate: vector.frame.sampleRate,
      payload: fromHex(vector.frame.payloadHex),
    })
    assert.deepEqual(encoded, expected, `${vector.name} encoded bytes`)

    const decoded = decodeStackChanFrame(expected)
    assert.equal(decoded.type, vector.frame.type, `${vector.name} type`)
    assert.equal(decoded.flags, vector.frame.flags, `${vector.name} flags`)
    assert.equal(decoded.streamId, vector.frame.streamId, `${vector.name} stream ID`)
    assert.equal(decoded.sequence, vector.frame.sequence, `${vector.name} sequence`)
    assert.equal(decoded.sampleRate, vector.frame.sampleRate, `${vector.name} sample rate`)
    assert.deepEqual(decoded.payload, fromHex(vector.frame.payloadHex), `${vector.name} payload`)
  }
})

test('USB parser rejects shared corrupt vectors and resynchronizes', () => {
  const invalid = contractVectors.invalidFrames[0]
  const valid = contractVectors.validFrames[0]
  assert.ok(invalid)
  assert.ok(valid)
  assert.equal(invalid.reason, 'crc_mismatch')
  assert.throws(() => decodeStackChanFrame(fromHex(invalid.encodedHex)), /CRC mismatch/)

  const corrupt = fromHex(invalid.encodedHex)
  const expected = fromHex(valid.encodedHex)
  const combined = new Uint8Array(corrupt.byteLength + expected.byteLength)
  combined.set(corrupt)
  combined.set(expected, corrupt.byteLength)
  const decoded = new StackChanFrameParser().push(combined)
  assert.equal(decoded.length, 1)
  assert.deepEqual(encodeStackChanFrame(decoded[0]!), expected)
})
