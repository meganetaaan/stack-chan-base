import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodePcm16Le,
  encodePcm16Le,
  StreamingPcm16ByteFramer,
  StreamingPcm16Resampler,
} from '../src/audio/pcm.js'

test('PCM16LE encoding preserves signed samples', () => {
  const samples = Int16Array.of(-32768, -1, 0, 1, 32767)
  assert.deepEqual(decodePcm16Le(encodePcm16Le(samples)), samples)
})

test('resampler converts 16 kHz input to continuous 24 kHz output', () => {
  const source = Int16Array.from({ length: 640 }, (_, index) => index * 31 - 9_000)
  const whole = new StreamingPcm16Resampler(16_000, 24_000).process(source)
  const streamingResampler = new StreamingPcm16Resampler(16_000, 24_000)
  const first = streamingResampler.process(source.slice(0, 320))
  const second = streamingResampler.process(source.slice(320))
  const chunked = new Int16Array(first.length + second.length)
  chunked.set(first)
  chunked.set(second, first.length)
  assert.deepEqual(chunked, whole)
  assert.equal(first.length, 479)
  assert.equal(second.length, 480)
})

test('resampler copies 24 kHz samples unchanged', () => {
  const source = Int16Array.of(-10, 0, 10)
  assert.deepEqual(new StreamingPcm16Resampler(24_000, 24_000).process(source), source)
})

test('PCM16 byte framer reconstructs samples across arbitrary byte boundaries', () => {
  const framer = new StreamingPcm16ByteFramer()
  assert.deepEqual(framer.push(Uint8Array.of(0x34)), new Uint8Array())
  assert.deepEqual(
    framer.push(Uint8Array.of(0x12, 0x78, 0x56, 0xbc)),
    Uint8Array.of(0x34, 0x12, 0x78, 0x56),
  )
  assert.deepEqual(framer.push(Uint8Array.of(0x9a)), Uint8Array.of(0xbc, 0x9a))
  assert.doesNotThrow(() => framer.finish())
})

test('PCM16 byte framer rejects an incomplete final sample', () => {
  const framer = new StreamingPcm16ByteFramer()
  framer.push(Uint8Array.of(0x34))
  assert.throws(() => framer.finish(), /incomplete sample/)
})
