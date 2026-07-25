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
