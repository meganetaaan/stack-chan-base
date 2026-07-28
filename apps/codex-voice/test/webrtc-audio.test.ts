import assert from 'node:assert/strict'
import test from 'node:test'
import type { RtpPacket } from 'werift'
import {
  OpusRtpAudioDecoder,
  OpusRtpAudioSender,
  opusPayloadTypeFromSdp,
  Pcm16FrameBuffer,
  WEBRTC_AUDIO_FRAME_MILLISECONDS,
  WEBRTC_AUDIO_FRAME_SAMPLES,
  type OpusRtpAudioSenderScheduler,
} from '../src/audio/webrtc.js'
import { encodePcm16Le, pcmChunk } from '../src/audio/pcm.js'

class ManualScheduler implements OpusRtpAudioSenderScheduler {
  #now = 0
  #nextId = 1
  readonly #tasks = new Map<number, { at: number; callback: () => void }>()

  now(): number {
    return this.#now
  }

  setTimeout(callback: () => void, milliseconds: number): number {
    const id = this.#nextId
    this.#nextId += 1
    this.#tasks.set(id, { at: this.#now + milliseconds, callback })
    return id
  }

  clearTimeout(handle: number | object): void {
    if (typeof handle === 'number') this.#tasks.delete(handle)
  }

  advance(milliseconds: number): void {
    const target = this.#now + milliseconds
    while (true) {
      const next = [...this.#tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!next) break
      const [id, task] = next
      this.#tasks.delete(id)
      this.#now = task.at
      task.callback()
    }
    this.#now = target
  }
}

test('PCM frame buffer emits exact Opus frames and retains the tail', () => {
  const buffer = new Pcm16FrameBuffer(4)
  assert.deepEqual(buffer.push(Int16Array.of(1, 2, 3)), [])
  assert.deepEqual(buffer.push(Int16Array.of(4, 5, 6, 7, 8)), [
    Int16Array.of(1, 2, 3, 4),
    Int16Array.of(5, 6, 7, 8),
  ])
  buffer.reset()
  assert.deepEqual(buffer.push(Int16Array.of(9, 10, 11, 12)), [
    Int16Array.of(9, 10, 11, 12),
  ])
})

test('Opus RTP sender frames 16 kHz microphone PCM and decoder returns 48 kHz mono PCM', () => {
  const packets: RtpPacket[] = []
  const scheduler = new ManualScheduler()
  const sender = new OpusRtpAudioSender({
    writeRtp(packet) {
      if (Buffer.isBuffer(packet)) throw new Error('sender unexpectedly wrote serialized RTP')
      packets.push(packet)
    },
  }, { scheduler })
  const microphoneFrame = pcmChunk(
    encodePcm16Le(Int16Array.from({ length: 320 }, (_, index) => Math.round(Math.sin(index / 8) * 2_000))),
    16_000,
  )

  sender.push(microphoneFrame)
  assert.equal(packets.length, 0)
  sender.push(microphoneFrame)
  sender.push(microphoneFrame)
  sender.start()
  scheduler.advance(WEBRTC_AUDIO_FRAME_MILLISECONDS * 2)
  sender.stop()
  assert.equal(packets.length, 2)
  assert.equal(packets[0]?.header.marker, true)
  assert.equal(packets[1]?.header.marker, false)
  assert.equal(
    ((packets[1]?.header.timestamp ?? 0) - (packets[0]?.header.timestamp ?? 0)) >>> 0,
    WEBRTC_AUDIO_FRAME_SAMPLES,
  )

  const decoded = new OpusRtpAudioDecoder().decode(packets[0]!)
  assert.equal(decoded.sampleRate, 48_000)
  assert.equal(decoded.channels, 1)
  assert.equal(decoded.format, 's16le')
  assert.equal(decoded.data.byteLength, WEBRTC_AUDIO_FRAME_SAMPLES * 2)
})

test('Opus RTP sender uses the payload type negotiated in the answer SDP', () => {
  const packets: RtpPacket[] = []
  const scheduler = new ManualScheduler()
  const payloadType = opusPayloadTypeFromSdp(
    'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 109\r\na=rtpmap:109 opus/48000/2\r\n',
  )
  const sender = new OpusRtpAudioSender({
    writeRtp(packet) {
      if (Buffer.isBuffer(packet)) throw new Error('sender unexpectedly wrote serialized RTP')
      packets.push(packet)
    },
  }, { scheduler, payloadType })

  sender.start()
  scheduler.advance(WEBRTC_AUDIO_FRAME_MILLISECONDS)
  sender.stop()

  assert.equal(packets[0]?.header.payloadType, 109)
  assert.equal(opusPayloadTypeFromSdp('v=0\r\n'), 111)
})
