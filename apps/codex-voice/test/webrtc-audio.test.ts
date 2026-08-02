import assert from 'node:assert/strict'
import test from 'node:test'
import { Application, createEncoder } from 'libopus-wasm'
import { RtpHeader, RtpPacket } from 'werift'
import {
  OpusRtpAudioDecoder,
  OpusRtpAudioReceiver,
  OpusRtpAudioSender,
  createWebRtcOpusEncoder,
  opusPayloadTypeFromSdp,
  Pcm16FrameBuffer,
  RealtimeAudioClockBoundaryTracker,
  WEBRTC_AUDIO_FRAME_MILLISECONDS,
  WEBRTC_AUDIO_FRAME_SAMPLES,
  WEBRTC_AUDIO_SAMPLE_RATE,
  type OpusRtpAudioSenderScheduler,
} from '../src/audio/webrtc.js'
import { decodePcm16Le, encodePcm16Le, pcmChunk } from '../src/audio/pcm.js'

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
    this.#runThrough(target)
    this.#now = target
  }

  advanceBeforeTimers(milliseconds: number, callback: () => void): void {
    const target = this.#now + milliseconds
    this.#runThrough(target, false)
    this.#now = target
    callback()
    this.#runThrough(target)
    this.#now = target
  }

  stall(milliseconds: number): void {
    this.#now += milliseconds
    const next = [...this.#tasks.entries()]
      .filter(([, task]) => task.at <= this.#now)
      .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
    if (!next) return
    const [id, task] = next
    this.#tasks.delete(id)
    task.callback()
  }

  #runThrough(target: number, inclusive = true): void {
    while (true) {
      const next = [...this.#tasks.entries()]
        .filter(([, task]) => inclusive ? task.at <= target : task.at < target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!next) break
      const [id, task] = next
      this.#tasks.delete(id)
      this.#now = task.at
      task.callback()
    }
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

test('Opus RTP sender frames 16 kHz microphone PCM and decoder returns 48 kHz mono PCM', async () => {
  const packets: RtpPacket[] = []
  const scheduler = new ManualScheduler()
  const encoder = await createWebRtcOpusEncoder()
  const decoder = await OpusRtpAudioDecoder.create()
  const sender = new OpusRtpAudioSender({
    writeRtp(packet) {
      if (Buffer.isBuffer(packet)) throw new Error('sender unexpectedly wrote serialized RTP')
      packets.push(packet)
    },
  }, { scheduler, encoder })
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

  const decoded = decoder.decode(packets[0]!)
  assert.equal(decoded.sampleRate, 48_000)
  assert.equal(decoded.channels, 1)
  assert.equal(decoded.format, 's16le')
  assert.equal(decoded.data.byteLength, WEBRTC_AUDIO_FRAME_SAMPLES * 2)
  decoder.close()
  encoder.free()
})

test('Opus decoder recovers one missing 20 ms frame with in-band FEC and preserves state', async () => {
  const encoder = await createEncoder({
    sampleRate: WEBRTC_AUDIO_SAMPLE_RATE,
    channels: 1,
    frameSize: WEBRTC_AUDIO_FRAME_SAMPLES,
    application: Application.Voip,
    bitrate: 32_000,
    fec: true,
    packetLossPercent: 30,
  })
  const fecDecoder = await OpusRtpAudioDecoder.create()
  const plcDecoder = await OpusRtpAudioDecoder.create()
  try {
    const packets = Array.from({ length: 3 }, (_, frameIndex) => {
      const samples = Int16Array.from(
        { length: WEBRTC_AUDIO_FRAME_SAMPLES },
        (_, sampleIndex) => {
          const index = sampleIndex + frameIndex * WEBRTC_AUDIO_FRAME_SAMPLES
          return Math.round(Math.sin(index / 17) * 5_000 + Math.sin(index / 43) * 2_500)
        },
      )
      return new RtpPacket(
        new RtpHeader({
          version: 2,
          payloadType: 111,
          sequenceNumber: frameIndex,
          timestamp: frameIndex * WEBRTC_AUDIO_FRAME_SAMPLES,
          ssrc: 1,
        }),
        Buffer.from(encoder.encode(samples)),
      )
    })

    fecDecoder.decode(packets[0]!)
    plcDecoder.decode(packets[0]!)
    const recovered = decodePcm16Le(
      fecDecoder.recoverFec(packets[2]!, WEBRTC_AUDIO_FRAME_SAMPLES).data,
    )
    const concealed = decodePcm16Le(plcDecoder.conceal(WEBRTC_AUDIO_FRAME_SAMPLES).data)

    assert.equal(recovered.length, WEBRTC_AUDIO_FRAME_SAMPLES)
    assert.notDeepEqual(recovered, concealed)
    assert.equal(fecDecoder.decode(packets[2]!).data.byteLength, WEBRTC_AUDIO_FRAME_SAMPLES * 2)
  } finally {
    fecDecoder.close()
    plcDecoder.close()
    encoder.free()
  }
})

test('Opus RTP sender uses the payload type negotiated in the answer SDP', async () => {
  const packets: RtpPacket[] = []
  const scheduler = new ManualScheduler()
  const encoder = await createWebRtcOpusEncoder()
  const payloadType = opusPayloadTypeFromSdp(
    'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 109\r\na=rtpmap:109 opus/48000/2\r\n',
  )
  const sender = new OpusRtpAudioSender({
    writeRtp(packet) {
      if (Buffer.isBuffer(packet)) throw new Error('sender unexpectedly wrote serialized RTP')
      packets.push(packet)
    },
  }, { scheduler, payloadType, encoder })

  sender.start()
  scheduler.advance(WEBRTC_AUDIO_FRAME_MILLISECONDS)
  sender.stop()

  assert.equal(packets[0]?.header.payloadType, 109)
  assert.equal(opusPayloadTypeFromSdp('v=0\r\n'), 111)
  encoder.free()
})

test('Opus RTP receiver reorders bursty packets and emits them on the RTP clock', () => {
  const scheduler = new ManualScheduler()
  const output: number[] = []
  const receiver = new OpusRtpAudioReceiver({
    scheduler,
    decoder: sequenceDecoder,
    playoutDelayMilliseconds: 120,
    onAudio: (chunk) => output.push(decodePcm16Le(chunk.data)[0] ?? 0),
  })

  receiver.push(remotePacket(10, 0))
  receiver.push(remotePacket(12, WEBRTC_AUDIO_FRAME_SAMPLES * 2))
  receiver.push(remotePacket(11, WEBRTC_AUDIO_FRAME_SAMPLES))

  scheduler.advance(119)
  assert.deepEqual(output, [])
  scheduler.advance(1)
  assert.deepEqual(output, [10])
  scheduler.advance(WEBRTC_AUDIO_FRAME_MILLISECONDS * 2)
  assert.deepEqual(output, [10, 11, 12])
  receiver.stop()
})

test('Opus RTP receiver repairs a lost packet with FEC from the next packet', () => {
  const scheduler = new ManualScheduler()
  const output: number[] = []
  const losses: number[] = []
  const repairs: string[] = []
  const decoderCalls: string[] = []
  const receiver = new OpusRtpAudioReceiver({
    scheduler,
    decoder: {
      decode(packet) {
        decoderCalls.push(`decode:${packet.header.sequenceNumber}`)
        return sequenceDecoder.decode(packet)
      },
      recoverFec(packet, samples) {
        decoderCalls.push(`fec:${packet.header.sequenceNumber}:${samples}`)
        return silentPcm(samples)
      },
      conceal(samples) {
        decoderCalls.push(`plc:${samples}`)
        return silentPcm(samples)
      },
    },
    playoutDelayMilliseconds: 40,
    onAudio: (chunk) => output.push(decodePcm16Le(chunk.data)[0] ?? 0),
    onPacketLoss: (packets) => losses.push(packets),
    onPacketRepair: (method) => repairs.push(method),
  })

  receiver.push(remotePacket(20, 0))
  receiver.push(remotePacket(22, WEBRTC_AUDIO_FRAME_SAMPLES * 2))

  scheduler.advance(40 + WEBRTC_AUDIO_FRAME_MILLISECONDS * 2)
  assert.deepEqual(output, [20, 0, 22])
  assert.deepEqual(losses, [1])
  assert.deepEqual(repairs, ['fec'])
  assert.deepEqual(decoderCalls, [
    'decode:20',
    `fec:22:${WEBRTC_AUDIO_FRAME_SAMPLES}`,
    'decode:22',
  ])
  receiver.stop()
})

test('Opus RTP receiver repairs an isolated decoder failure from the next packet', () => {
  const scheduler = new ManualScheduler()
  const output: number[] = []
  const decodeErrors: Array<{ message: string; sequence: number }> = []
  const repairs: string[] = []
  const receiver = new OpusRtpAudioReceiver({
    scheduler,
    decoder: {
      ...repairingDecoder,
      decode(packet) {
        if (packet.header.sequenceNumber === 51) throw new Error('invalid Opus packet')
        return sequenceDecoder.decode(packet)
      },
    },
    playoutDelayMilliseconds: 20,
    onAudio: (chunk) => output.push(decodePcm16Le(chunk.data)[0] ?? 0),
    onDecodeError: (error, packet) => decodeErrors.push({
      message: error.message,
      sequence: packet.header.sequenceNumber,
    }),
    onPacketRepair: (method) => repairs.push(method),
  })

  receiver.push(remotePacket(50, 0))
  receiver.push(remotePacket(51, WEBRTC_AUDIO_FRAME_SAMPLES))
  receiver.push(remotePacket(52, WEBRTC_AUDIO_FRAME_SAMPLES * 2))

  scheduler.advance(20 + WEBRTC_AUDIO_FRAME_MILLISECONDS * 2)
  assert.deepEqual(output, [50, 0, 52])
  assert.deepEqual(decodeErrors, [{ message: 'invalid Opus packet', sequence: 51 }])
  assert.deepEqual(repairs, ['fec'])
  receiver.stop()
})

test('Opus RTP receiver fails only after five consecutive decoder failures', () => {
  const scheduler = new ManualScheduler()
  const errors: string[] = []
  const receiver = new OpusRtpAudioReceiver({
    scheduler,
    decoder: {
      ...repairingDecoder,
      decode() {
        throw new Error('invalid Opus packet')
      },
    },
    playoutDelayMilliseconds: 0,
    onAudio() {},
    onError: (error) => errors.push(error.message),
  })

  for (let index = 0; index < 5; index += 1) {
    receiver.push(remotePacket(
      60 + index,
      WEBRTC_AUDIO_FRAME_SAMPLES * index,
    ))
  }
  scheduler.advance(WEBRTC_AUDIO_FRAME_MILLISECONDS * 4)

  assert.deepEqual(errors, [
    'WebRTC Opus decoder failed for 5 consecutive packets',
  ])
  receiver.stop()
})

test('Opus RTP receiver treats a non-negotiated payload type as timed silence', () => {
  const scheduler = new ManualScheduler()
  const output: number[] = []
  const receiver = new OpusRtpAudioReceiver({
    scheduler,
    decoder: sequenceDecoder,
    payloadType: 111,
    playoutDelayMilliseconds: 0,
    onAudio: (chunk) => output.push(decodePcm16Le(chunk.data)[0] ?? 0),
  })

  receiver.push(remotePacket(70, 0, 13))
  receiver.push(remotePacket(71, WEBRTC_AUDIO_FRAME_SAMPLES, 111))
  scheduler.advance(WEBRTC_AUDIO_FRAME_MILLISECONDS)

  assert.deepEqual(output, [0, 71])
  receiver.stop()
})

test('Opus RTP receiver preserves timestamp gaps from discontinuous transmission', () => {
  const scheduler = new ManualScheduler()
  const output: number[] = []
  const sources: string[] = []
  const repairs: string[] = []
  const receiver = new OpusRtpAudioReceiver({
    scheduler,
    decoder: sequenceDecoder,
    playoutDelayMilliseconds: 20,
    onAudio: (chunk, timing) => {
      output.push(decodePcm16Le(chunk.data)[0] ?? 0)
      sources.push(timing.source)
    },
    onPacketRepair: (method) => repairs.push(method),
  })

  receiver.push(remotePacket(30, 0))
  receiver.push(remotePacket(31, WEBRTC_AUDIO_FRAME_SAMPLES * 3))

  scheduler.advance(20 + WEBRTC_AUDIO_FRAME_MILLISECONDS * 3)
  assert.deepEqual(output, [30, 0, 0, 31])
  assert.deepEqual(sources, ['packet', 'dtx', 'dtx', 'packet'])
  assert.deepEqual(repairs, [])
  receiver.stop()
})

test('Opus RTP receiver stops generating silence after the idle timeout and restarts', () => {
  const scheduler = new ManualScheduler()
  const output: number[] = []
  const receiver = new OpusRtpAudioReceiver({
    scheduler,
    decoder: sequenceDecoder,
    playoutDelayMilliseconds: 0,
    idleTimeoutMilliseconds: 60,
    onAudio: (chunk) => output.push(decodePcm16Le(chunk.data)[0] ?? 0),
  })

  receiver.push(remotePacket(40, 0))
  scheduler.advance(100)
  assert.deepEqual(output, [40, 0, 0])

  receiver.push(remotePacket(80, 50_000))
  scheduler.advance(0)
  assert.deepEqual(output, [40, 0, 0, 80])
  receiver.stop()
})

test('Opus RTP receiver re-buffers rather than speculatively concealing a late packet', () => {
  const scheduler = new ManualScheduler()
  const output: number[] = []
  const sources: string[] = []
  const errors: string[] = []
  const receiver = new OpusRtpAudioReceiver({
    scheduler,
    decoder: sequenceDecoder,
    playoutDelayMilliseconds: 0,
    idleTimeoutMilliseconds: 100,
    onAudio: (chunk, timing) => {
      output.push(decodePcm16Le(chunk.data)[0] ?? 0)
      sources.push(timing.source)
    },
    onError: (error) => errors.push(error.message),
  })

  receiver.push(remotePacket(90, 0))
  scheduler.advance(WEBRTC_AUDIO_FRAME_MILLISECONDS)
  receiver.push(remotePacket(91, WEBRTC_AUDIO_FRAME_SAMPLES))
  scheduler.advance(WEBRTC_AUDIO_FRAME_MILLISECONDS)
  receiver.push(remotePacket(92, WEBRTC_AUDIO_FRAME_SAMPLES * 2))
  scheduler.advance(WEBRTC_AUDIO_FRAME_MILLISECONDS)

  assert.deepEqual(output, [90, 0, 91, 92])
  assert.deepEqual(sources, ['packet', 'rebuffering', 'packet', 'packet'])
  assert.deepEqual(errors, [])
  receiver.stop()
})

test('Opus RTP receiver does not burst through buffered audio after an event-loop stall', () => {
  const scheduler = new ManualScheduler()
  const output: number[] = []
  const receiver = new OpusRtpAudioReceiver({
    scheduler,
    decoder: sequenceDecoder,
    playoutDelayMilliseconds: 20,
    onAudio: (chunk) => output.push(decodePcm16Le(chunk.data)[0] ?? 0),
  })
  for (let index = 0; index < 10; index += 1) {
    receiver.push(remotePacket(200 + index, WEBRTC_AUDIO_FRAME_SAMPLES * index))
  }

  scheduler.stall(200)
  scheduler.advance(0)
  assert.deepEqual(output, [200])
  scheduler.advance(WEBRTC_AUDIO_FRAME_MILLISECONDS)
  assert.deepEqual(output, [200, 201])
  receiver.stop()
})

test('Opus RTP receiver recovers from every bounded four-packet network trace', () => {
  const delayedPackets = 4
  const recoveryPackets = 4
  const networkEventClasses = 7
  const missingPacket = 5
  const duplicatePacket = 6
  let traces = 0

  for (const arrivalsBeforeDeadline of [false, true]) {
    for (
      let encodedEvents = 0;
      encodedEvents < networkEventClasses ** delayedPackets;
      encodedEvents += 1
    ) {
      const events: number[] = []
      let remaining = encodedEvents
      for (let index = 0; index < delayedPackets; index += 1) {
        events.push(remaining % networkEventClasses)
        remaining = Math.floor(remaining / networkEventClasses)
      }

      const scheduler = new ManualScheduler()
      const decodedSequences: number[] = []
      const errors: string[] = []
      const receiver = new OpusRtpAudioReceiver({
        scheduler,
        decoder: recordingDecoder(decodedSequences),
        playoutDelayMilliseconds: WEBRTC_AUDIO_FRAME_MILLISECONDS * 2,
        idleTimeoutMilliseconds: 1_000,
        onAudio() {},
        onError: (error) => errors.push(error.message),
      })
      const packetsByArrival = new Map<number, RtpPacket[]>()
      for (let index = 1; index <= delayedPackets + recoveryPackets; index += 1) {
        const event = index <= delayedPackets ? events[index - 1]! : 0
        if (event === missingPacket) continue
        const delay = event === duplicatePacket ? 2 : event
        const arrival = (index + delay) * WEBRTC_AUDIO_FRAME_MILLISECONDS
        const packets = packetsByArrival.get(arrival) ?? []
        const packet = remotePacket(
          100 + index,
          WEBRTC_AUDIO_FRAME_SAMPLES * index,
        )
        packets.push(packet)
        if (event === duplicatePacket) packets.push(packet)
        packetsByArrival.set(arrival, packets)
      }

      receiver.push(remotePacket(100, 0))
      const end = (delayedPackets + recoveryPackets + networkEventClasses + 3) *
        WEBRTC_AUDIO_FRAME_MILLISECONDS
      for (let now = WEBRTC_AUDIO_FRAME_MILLISECONDS; now <= end; now += WEBRTC_AUDIO_FRAME_MILLISECONDS) {
        const deliver = () => {
          for (const packet of packetsByArrival.get(now) ?? []) receiver.push(packet)
        }
        if (arrivalsBeforeDeadline) {
          scheduler.advanceBeforeTimers(WEBRTC_AUDIO_FRAME_MILLISECONDS, deliver)
        } else {
          scheduler.advance(WEBRTC_AUDIO_FRAME_MILLISECONDS)
          deliver()
        }
      }

      const recoveryStart = 100 + delayedPackets + 1
      assert.deepEqual(
        decodedSequences.slice(-recoveryPackets),
        Array.from({ length: recoveryPackets }, (_, index) => recoveryStart + index),
        `arrivalOrder=${arrivalsBeforeDeadline ? 'before' : 'after'} events=${events.join(',')}`,
      )
      assert.deepEqual(errors, [])
      receiver.stop()
      traces += 1
    }
  }

  assert.equal(traces, 4_802)
})

test('Opus RTP receiver preserves sequence and timestamp wraparound', () => {
  const scheduler = new ManualScheduler()
  const decodedSequences: number[] = []
  const receiver = new OpusRtpAudioReceiver({
    scheduler,
    decoder: recordingDecoder(decodedSequences),
    playoutDelayMilliseconds: 0,
    onAudio() {},
  })

  receiver.push(remotePacket(0xffff, 0xffff_fc40))
  receiver.push(remotePacket(0, 0))
  scheduler.advance(WEBRTC_AUDIO_FRAME_MILLISECONDS)

  assert.deepEqual(decodedSequences, [0xffff, 0])
  receiver.stop()
})

test('audio boundary uses the session RTP origin even when media precedes turn.created', () => {
  const tracker = new RealtimeAudioClockBoundaryTracker()
  const origin = 50_000
  tracker.observePacket(origin, 7)
  tracker.advance(
    {
      timestamp: origin,
      advancesMediaTime: true,
      source: 'packet',
    },
    WEBRTC_AUDIO_FRAME_SAMPLES,
  )
  tracker.start({ id: 'turn-1', startMilliseconds: 2_000 })
  const done = {
    id: 'turn-1',
    startMilliseconds: 2_000,
    endMilliseconds: 2_040,
    transcript: '最後まで読む',
  }
  assert.equal(tracker.finish(done), undefined)
  assert.equal(
    tracker.advance(
      {
        timestamp: (origin + 2_020 * 48) >>> 0,
        advancesMediaTime: true,
        source: 'packet',
      },
      WEBRTC_AUDIO_FRAME_SAMPLES,
    ),
    done,
  )
})

test('audio boundary completes immediately when turn.done arrives after its RTP media', () => {
  const tracker = new RealtimeAudioClockBoundaryTracker()
  const origin = 90_000
  tracker.observePacket(origin, 8)
  tracker.advance(
    {
      timestamp: (origin + 1_020 * 48) >>> 0,
      advancesMediaTime: true,
      source: 'packet',
    },
    WEBRTC_AUDIO_FRAME_SAMPLES,
  )
  tracker.start({ id: 'turn-2', startMilliseconds: 1_000 })
  const done = {
    id: 'turn-2',
    startMilliseconds: 1_000,
    endMilliseconds: 1_040,
    transcript: '短い音声',
  }
  assert.equal(tracker.finish(done), done)
})

test('audio boundary does not advance during local rebuffering silence', () => {
  const tracker = new RealtimeAudioClockBoundaryTracker()
  tracker.observePacket(10_000, 9)
  tracker.start({ id: 'turn-3', startMilliseconds: 0 })
  const done = {
    id: 'turn-3',
    startMilliseconds: 0,
    endMilliseconds: 40,
    transcript: '短い音声',
  }
  assert.equal(tracker.finish(done), undefined)
  assert.equal(
    tracker.advance(
      { timestamp: 10_000, advancesMediaTime: true, source: 'packet' },
      WEBRTC_AUDIO_FRAME_SAMPLES,
    ),
    undefined,
  )
  assert.equal(
    tracker.advance(
      { timestamp: 10_960, advancesMediaTime: false, source: 'rebuffering' },
      WEBRTC_AUDIO_FRAME_SAMPLES,
    ),
    undefined,
  )
  assert.equal(
    tracker.advance(
      { timestamp: 10_960, advancesMediaTime: true, source: 'packet' },
      WEBRTC_AUDIO_FRAME_SAMPLES,
    ),
    done,
  )
})

test('audio boundary preserves RTP timestamp wraparound', () => {
  const tracker = new RealtimeAudioClockBoundaryTracker()
  tracker.observePacket(0xffff_fc40, 10)
  tracker.start({ id: 'turn-wrap', startMilliseconds: 0 })
  const done = {
    id: 'turn-wrap',
    startMilliseconds: 0,
    endMilliseconds: 40,
    transcript: 'wrap',
  }
  assert.equal(tracker.finish(done), undefined)
  assert.equal(
    tracker.advance(
      { timestamp: 0xffff_fc40, advancesMediaTime: true, source: 'packet' },
      WEBRTC_AUDIO_FRAME_SAMPLES,
    ),
    undefined,
  )
  assert.equal(
    tracker.advance(
      { timestamp: 0, advancesMediaTime: true, source: 'packet' },
      WEBRTC_AUDIO_FRAME_SAMPLES,
    ),
    done,
  )
})

test('audio boundary rejects an SSRC change that invalidates the v3 clock mapping', () => {
  const tracker = new RealtimeAudioClockBoundaryTracker()
  tracker.observePacket(1_000, 11)
  assert.throws(
    () => tracker.observePacket(2_000, 12),
    /SSRC changed from 11 to 12/,
  )
})

const repairingDecoder = {
  recoverFec(_packet: RtpPacket, samples: number) {
    return silentPcm(samples)
  },
  conceal(samples: number) {
    return silentPcm(samples)
  },
}

const sequenceDecoder = {
  decode(packet: RtpPacket) {
    return pcmChunk(
      encodePcm16Le(
        new Int16Array(WEBRTC_AUDIO_FRAME_SAMPLES).fill(packet.header.sequenceNumber),
      ),
      48_000,
    )
  },
  ...repairingDecoder,
}

function recordingDecoder(decodedSequences: number[]) {
  return {
    decode(packet: RtpPacket) {
      decodedSequences.push(packet.header.sequenceNumber)
      return pcmChunk(WEBRTC_SILENCE_BYTES_FOR_TEST, 48_000)
    },
    ...repairingDecoder,
  }
}

function silentPcm(samples: number) {
  return pcmChunk(encodePcm16Le(new Int16Array(samples)), 48_000)
}

const WEBRTC_SILENCE_BYTES_FOR_TEST = encodePcm16Le(
  new Int16Array(WEBRTC_AUDIO_FRAME_SAMPLES),
)

function remotePacket(sequenceNumber: number, timestamp: number, payloadType = 111): RtpPacket {
  return new RtpPacket(
    new RtpHeader({
      version: 2,
      payloadType,
      sequenceNumber,
      timestamp,
      ssrc: 1234,
    }),
    Buffer.of(1),
  )
}
