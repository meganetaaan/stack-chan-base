import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RtpPacket } from 'werift'
import {
  OpusRtpAudioDecoder,
  OpusRtpAudioSender,
  WEBRTC_AUDIO_FRAME_MILLISECONDS,
  WEBRTC_AUDIO_FRAME_SAMPLES,
} from '../src/audio/webrtc.js'
import { decodePcm16Le, encodePcm16Le, pcmChunk } from '../src/audio/pcm.js'

describe('OpusRtpAudioSender pacing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the RTP audio timeline alive with one silence packet every 20 ms', () => {
    const packets: RtpPacket[] = []
    const sender = new OpusRtpAudioSender({
      writeRtp(packet) {
        if (Buffer.isBuffer(packet)) throw new Error('unexpected serialized RTP packet')
        packets.push(packet)
      },
    })

    sender.start()
    vi.advanceTimersByTime(WEBRTC_AUDIO_FRAME_MILLISECONDS * 3)

    expect(packets).toHaveLength(3)
    for (let index = 1; index < packets.length; index += 1) {
      expect(
        ((packets[index]!.header.timestamp - packets[index - 1]!.header.timestamp) >>> 0),
      ).toBe(WEBRTC_AUDIO_FRAME_SAMPLES)
    }

    const decoder = new OpusRtpAudioDecoder()
    for (const packet of packets) {
      const decoded = decodePcm16Le(decoder.decode(packet).data)
      expect(Math.max(...decoded.map(Math.abs))).toBe(0)
    }

    sender.stop()
    vi.advanceTimersByTime(WEBRTC_AUDIO_FRAME_MILLISECONDS * 2)
    expect(packets).toHaveLength(3)
  })

  it('uses queued microphone PCM for the next slot and falls back to silence afterwards', () => {
    const packets: RtpPacket[] = []
    const sender = new OpusRtpAudioSender({
      writeRtp(packet) {
        if (Buffer.isBuffer(packet)) throw new Error('unexpected serialized RTP packet')
        packets.push(packet)
      },
    })
    const microphoneFrame = pcmChunk(
      encodePcm16Le(
        Int16Array.from({ length: WEBRTC_AUDIO_FRAME_SAMPLES }, (_, index) =>
          Math.round(Math.sin(index / 8) * 4_000),
        ),
      ),
      48_000,
    )

    sender.start()
    sender.push(microphoneFrame)
    vi.advanceTimersByTime(WEBRTC_AUDIO_FRAME_MILLISECONDS * 6)

    expect(packets).toHaveLength(6)
    const decoder = new OpusRtpAudioDecoder()
    const microphoneOutput = decodePcm16Le(decoder.decode(packets[0]!).data)
    const silenceOutputs = packets
      .slice(1)
      .map((packet) => decodePcm16Le(decoder.decode(packet).data))
    const silenceOutput = silenceOutputs.at(-1)!
    expect(Math.max(...microphoneOutput.map(Math.abs))).toBeGreaterThan(100)
    expect(Math.max(...silenceOutput.map(Math.abs))).toBeLessThan(100)

    sender.stop()
  })

  it('continues silence pacing while microphone state is reset', () => {
    const packets: RtpPacket[] = []
    const sender = new OpusRtpAudioSender({
      writeRtp(packet) {
        if (Buffer.isBuffer(packet)) throw new Error('unexpected serialized RTP packet')
        packets.push(packet)
      },
    })

    sender.start()
    sender.reset()
    vi.advanceTimersByTime(WEBRTC_AUDIO_FRAME_MILLISECONDS * 2)

    expect(packets).toHaveLength(2)
    sender.stop()
  })
})
