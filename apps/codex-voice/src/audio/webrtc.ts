import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  createDecoder,
  createEncoder,
  type OpusDecoderHandle,
  type OpusEncoderHandle,
} from 'libopus-wasm'
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  useOPUS,
  type RTCDataChannel,
} from 'werift'
import { Deferred } from '../async.js'
import type { CodexAppServer } from '../codex/app-server.js'
import type { PcmChunk } from '../types.js'
import { decodePcm16Le, encodePcm16Le, pcmChunk, StreamingPcm16Resampler } from './pcm.js'

export const WEBRTC_AUDIO_SAMPLE_RATE = 48_000
export const WEBRTC_AUDIO_FRAME_SAMPLES = 960
export const WEBRTC_AUDIO_FRAME_MILLISECONDS = 20

const WEBRTC_START_TIMEOUT_MS = 30_000
const WEBRTC_PEER_DISCONNECTED_GRACE_MS = 5_000
const WEBRTC_OPUS_BITRATE = 32_000
const RTP_PAYLOAD_TYPE_FALLBACK = 111
const RTP_TALKSPURT_GAP_MS = WEBRTC_AUDIO_FRAME_MILLISECONDS * 3
const MAX_QUEUED_MICROPHONE_FRAMES = 10
const REMOTE_AUDIO_PLAYOUT_DELAY_MS = 120
const REMOTE_AUDIO_IDLE_TIMEOUT_MS = 2_000
const MAX_CONSECUTIVE_REMOTE_DECODE_FAILURES = 5
const MAX_REMOTE_TIMESTAMP_GAP_SAMPLES =
  (WEBRTC_AUDIO_SAMPLE_RATE * REMOTE_AUDIO_IDLE_TIMEOUT_MS) / 1_000
const MAX_QUEUED_REMOTE_PACKETS = 500
const WEBRTC_SILENCE_FRAME = new Int16Array(WEBRTC_AUDIO_FRAME_SAMPLES)
const WEBRTC_SILENCE_BYTES = encodePcm16Le(WEBRTC_SILENCE_FRAME)

type WritableRtpTrack = {
  writeRtp(packet: RtpPacket | Buffer): void
}

export type OpusRtpAudioSenderTimer = number | object

export type OpusRtpAudioSenderScheduler = {
  now(): number
  setTimeout(callback: () => void, milliseconds: number): OpusRtpAudioSenderTimer
  clearTimeout(handle: OpusRtpAudioSenderTimer): void
}

export type OpusRtpAudioSenderOptions = {
  encoder: Pick<OpusEncoderHandle, 'encode'>
  scheduler?: OpusRtpAudioSenderScheduler
  onError?: (error: Error) => void
  payloadType?: number
}

const defaultAudioSenderScheduler: OpusRtpAudioSenderScheduler = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout | number),
}

type RealtimeWebRtcSessionEvents = {
  event: [event: Record<string, unknown>]
  audio: [chunk: PcmChunk]
  audioEnd: [turn: RealtimeAudioTurnEnd]
  close: [error?: Error]
}

export type RealtimeAudioTurnEnd = {
  id: string
  startMilliseconds: number
  endMilliseconds: number
  transcript: string
}

export interface RealtimeAudioSession {
  readonly closed: Promise<Error | undefined>
  start(): Promise<void>
  sendMicrophoneAudio(chunk: PcmChunk): void
  resetMicrophoneAudio(): void
  close(): Promise<void>
  on(event: 'event', listener: (event: Record<string, unknown>) => void): this
  on(event: 'audio', listener: (chunk: PcmChunk) => void): this
  on(event: 'audioEnd', listener: (turn: RealtimeAudioTurnEnd) => void): this
  off(event: 'event', listener: (event: Record<string, unknown>) => void): this
  off(event: 'audio', listener: (chunk: PcmChunk) => void): this
  off(event: 'audioEnd', listener: (turn: RealtimeAudioTurnEnd) => void): this
}

export type RealtimeWebRtcSessionOptions = {
  voice?: string
  prompt?: string
  startTimeoutMilliseconds?: number
}

/**
 * Converts arbitrary PCM16 chunks into exact 20 ms frames required by Opus.
 */
export class Pcm16FrameBuffer {
  readonly #frameSamples: number
  #pending = new Int16Array()

  constructor(frameSamples = WEBRTC_AUDIO_FRAME_SAMPLES) {
    if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
      throw new RangeError('PCM frame size must be a positive integer')
    }
    this.#frameSamples = frameSamples
  }

  push(samples: Int16Array): Int16Array[] {
    if (samples.length === 0) return []
    const combined = new Int16Array(this.#pending.length + samples.length)
    combined.set(this.#pending)
    combined.set(samples, this.#pending.length)
    const frames: Int16Array[] = []
    let offset = 0
    while (combined.length - offset >= this.#frameSamples) {
      frames.push(combined.slice(offset, offset + this.#frameSamples))
      offset += this.#frameSamples
    }
    this.#pending = combined.slice(offset)
    return frames
  }

  reset(): void {
    this.#pending = new Int16Array()
  }
}

/**
 * Stateful PCM16 -> Opus/RTP sender. RTP timestamps use the Opus 48 kHz clock.
 */
export class OpusRtpAudioSender {
  readonly #track: WritableRtpTrack
  readonly #encoder: Pick<OpusEncoderHandle, 'encode'>
  readonly #frames = new Pcm16FrameBuffer()
  readonly #queuedFrames: Int16Array[] = []
  readonly #ssrc = randomUint32()
  readonly #scheduler: OpusRtpAudioSenderScheduler
  readonly #onError: ((error: Error) => void) | undefined
  readonly #payloadType: number
  #sequenceNumber = randomUint16()
  #timestamp = randomUint32()
  #sourceSampleRate = 0
  #resampler: StreamingPcm16Resampler | undefined
  #marker = true
  #markNextMicrophoneFrame = true
  #lastPacketAt: number | undefined
  #timer: OpusRtpAudioSenderTimer | undefined
  #nextPacketAt = 0
  #running = false

  constructor(track: WritableRtpTrack, options: OpusRtpAudioSenderOptions) {
    this.#track = track
    this.#encoder = options.encoder
    this.#scheduler = options.scheduler ?? defaultAudioSenderScheduler
    this.#onError = options.onError
    this.#payloadType = options.payloadType ?? RTP_PAYLOAD_TYPE_FALLBACK
    if (!Number.isInteger(this.#payloadType) || this.#payloadType < 0 || this.#payloadType > 127) {
      throw new RangeError('RTP payload type must be an integer from 0 through 127')
    }
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#nextPacketAt = this.#scheduler.now() + WEBRTC_AUDIO_FRAME_MILLISECONDS
    this.#scheduleNextPacket()
  }

  stop(): void {
    this.#running = false
    if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer)
    this.#timer = undefined
    this.#queuedFrames.length = 0
  }

  push(chunk: PcmChunk): void {
    if (chunk.channels !== 1 || chunk.format !== 's16le') {
      throw new Error('WebRTC microphone input must be PCM16LE mono')
    }
    if (!Number.isInteger(chunk.sampleRate) || chunk.sampleRate <= 0) {
      throw new RangeError('WebRTC microphone sample rate must be a positive integer')
    }
    if (chunk.data.byteLength % 2 !== 0) {
      throw new RangeError('WebRTC microphone PCM contains an incomplete sample')
    }
    if (chunk.sampleRate !== this.#sourceSampleRate) {
      this.#sourceSampleRate = chunk.sampleRate
      this.#resampler = new StreamingPcm16Resampler(chunk.sampleRate, WEBRTC_AUDIO_SAMPLE_RATE)
      this.#frames.reset()
      this.#queuedFrames.length = 0
      this.#markNextMicrophoneFrame = true
    }
    const source = decodePcm16Le(chunk.data)
    const resampled = this.#resampler?.process(source) ?? source
    for (const frame of this.#frames.push(resampled)) {
      if (this.#queuedFrames.length >= MAX_QUEUED_MICROPHONE_FRAMES) {
        this.#queuedFrames.shift()
        this.#markNextMicrophoneFrame = true
      }
      this.#queuedFrames.push(frame)
    }
  }

  reset(): void {
    this.#sourceSampleRate = 0
    this.#resampler = undefined
    this.#frames.reset()
    this.#queuedFrames.length = 0
    this.#markNextMicrophoneFrame = true
  }

  #scheduleNextPacket(): void {
    if (!this.#running) return
    const delay = Math.max(0, this.#nextPacketAt - this.#scheduler.now())
    this.#timer = this.#scheduler.setTimeout(() => this.#tick(), delay)
  }

  #tick(): void {
    this.#timer = undefined
    if (!this.#running) return
    const now = this.#scheduler.now()
    if (now < this.#nextPacketAt) {
      this.#scheduleNextPacket()
      return
    }
    try {
      const microphoneFrame = this.#queuedFrames.shift()
      this.#sendFrame(microphoneFrame ?? WEBRTC_SILENCE_FRAME, microphoneFrame === undefined, now)
    } catch (error) {
      this.stop()
      const normalized = normalizeError(error)
      if (this.#onError) this.#onError(normalized)
      else queueMicrotask(() => {
        throw normalized
      })
      return
    }

    this.#nextPacketAt += WEBRTC_AUDIO_FRAME_MILLISECONDS
    if (this.#nextPacketAt <= now) {
      const missedFrames =
        Math.floor((now - this.#nextPacketAt) / WEBRTC_AUDIO_FRAME_MILLISECONDS) + 1
      this.#nextPacketAt += missedFrames * WEBRTC_AUDIO_FRAME_MILLISECONDS
    }
    this.#scheduleNextPacket()
  }

  #sendFrame(samples: Int16Array, generatedSilence: boolean, now: number): void {
    if (this.#lastPacketAt !== undefined) {
      const elapsed = now - this.#lastPacketAt
      if (elapsed >= RTP_TALKSPURT_GAP_MS) {
        const skippedFrames = Math.max(
          0,
          Math.round(elapsed / WEBRTC_AUDIO_FRAME_MILLISECONDS) - 1,
        )
        this.#timestamp = (this.#timestamp + skippedFrames * WEBRTC_AUDIO_FRAME_SAMPLES) >>> 0
        this.#marker = true
      }
    }
    const marker = this.#marker || (!generatedSilence && this.#markNextMicrophoneFrame)
    const encoded = this.#encoder.encode(samples)
    this.#track.writeRtp(
      new RtpPacket(
        new RtpHeader({
          version: 2,
          payloadType: this.#payloadType,
          sequenceNumber: this.#sequenceNumber,
          timestamp: this.#timestamp,
          ssrc: this.#ssrc,
          marker,
        }),
        Buffer.from(encoded),
      ),
    )
    this.#sequenceNumber = (this.#sequenceNumber + 1) & 0xffff
    this.#timestamp = (this.#timestamp + WEBRTC_AUDIO_FRAME_SAMPLES) >>> 0
    this.#marker = false
    this.#markNextMicrophoneFrame = generatedSilence
    this.#lastPacketAt = now
  }
}

/**
 * Stateful Opus/RTP -> PCM16 decoder. A mono decoder also downmixes stereo Opus.
 */
export class OpusRtpAudioDecoder {
  readonly #decoder: OpusDecoderHandle

  private constructor(decoder: OpusDecoderHandle) {
    this.#decoder = decoder
  }

  static async create(): Promise<OpusRtpAudioDecoder> {
    return new OpusRtpAudioDecoder(await createDecoder({
      sampleRate: WEBRTC_AUDIO_SAMPLE_RATE,
      channels: 1,
      maxFrameSize: WEBRTC_AUDIO_FRAME_SAMPLES * 6,
    }))
  }

  decode(packet: RtpPacket): PcmChunk {
    return this.#pcmChunk(this.#decoder.decode(packet.payload))
  }

  recoverFec(packet: RtpPacket, samples: number): PcmChunk {
    return this.#pcmChunk(
      this.#decoder.decode(packet.payload, { decodeFec: true, frameSize: samples }),
      samples,
    )
  }

  conceal(samples: number): PcmChunk {
    return this.#pcmChunk(this.#decoder.decodePacketLoss(samples), samples)
  }

  close(): void {
    this.#decoder.free()
  }

  #pcmChunk(decoded: Int16Array, expectedSamples?: number): PcmChunk {
    if (decoded.length === 0 || (expectedSamples !== undefined && decoded.length !== expectedSamples)) {
      throw new Error(
        expectedSamples === undefined
          ? 'WebRTC Opus decoder returned an empty PCM frame'
          : `WebRTC Opus decoder returned ${decoded.length} samples; expected ${expectedSamples}`,
      )
    }
    return pcmChunk(encodePcm16Le(decoded), WEBRTC_AUDIO_SAMPLE_RATE)
  }
}

export async function createWebRtcOpusEncoder(): Promise<OpusEncoderHandle> {
  return createEncoder({
    sampleRate: WEBRTC_AUDIO_SAMPLE_RATE,
    channels: 1,
    frameSize: WEBRTC_AUDIO_FRAME_SAMPLES,
    bitrate: WEBRTC_OPUS_BITRATE,
  })
}

export type OpusRtpAudioDecoderLike = Pick<
  OpusRtpAudioDecoder,
  'decode' | 'recoverFec' | 'conceal'
>

export type OpusRtpAudioReceiverOptions = {
  scheduler?: OpusRtpAudioSenderScheduler
  decoder: OpusRtpAudioDecoderLike
  payloadType?: number
  playoutDelayMilliseconds?: number
  idleTimeoutMilliseconds?: number
  onAudio(chunk: PcmChunk, timing: OpusRtpAudioFrameTiming): void
  onError?: (error: Error) => void
  onDecodeError?: (error: Error, packet: RtpPacket) => void
  onPacketLoss?: (packets: number) => void
  onPacketRepair?: (method: 'fec' | 'plc') => void
}

export type OpusRtpAudioFrameTiming = {
  /** RTP timestamp at the beginning of this output frame. */
  timestamp: number
  /** Whether this frame advances the remote RTP media timeline. */
  advancesMediaTime: boolean
  source: 'packet' | 'fec' | 'plc' | 'dtx' | 'rebuffering'
}

/**
 * Reorders and paces remote Opus/RTP before decoding it.
 *
 * The media track exposes packets at network arrival time. Feeding those
 * packets directly to the speaker collapses Opus DTX gaps and lets network
 * jitter drain the hardware buffer. Keep a small playout delay and use the RTP
 * timestamp as the audio clock. A timestamp gap with contiguous sequence
 * numbers is Opus DTX; a sequence gap is packet loss. If no future packet is
 * available, rebuffer without guessing which one occurred.
 *
 * The RTP timestamp is the sole media-time cursor. Sequence numbers are used
 * only for duplicate rejection and loss reporting. Every playout tick makes
 * exactly one terminal transition: decode a packet, conceal missing media,
 * rebuffer without advancing media time, or pause an idle timeline.
 */
export class OpusRtpAudioReceiver {
  readonly #scheduler: OpusRtpAudioSenderScheduler
  readonly #decoder: OpusRtpAudioDecoderLike
  readonly #payloadType: number | undefined
  readonly #playoutDelayMilliseconds: number
  readonly #idleTimeoutMilliseconds: number
  readonly #onAudio: (chunk: PcmChunk, timing: OpusRtpAudioFrameTiming) => void
  readonly #onError: ((error: Error) => void) | undefined
  readonly #onDecodeError: ((error: Error, packet: RtpPacket) => void) | undefined
  readonly #onPacketLoss: ((packets: number) => void) | undefined
  readonly #onPacketRepair: ((method: 'fec' | 'plc') => void) | undefined
  readonly #packets = new Map<number, RtpPacket>()
  #ssrc: number | undefined
  #playoutTimestamp: number | undefined
  #retiredSequence: number | undefined
  #lastReceivedAt = 0
  #nextPlayoutAt = 0
  #rebufferUntil: number | undefined
  #timer: OpusRtpAudioSenderTimer | undefined
  #consecutiveDecodeFailures = 0
  #closed = false

  constructor(options: OpusRtpAudioReceiverOptions) {
    this.#scheduler = options.scheduler ?? defaultAudioSenderScheduler
    this.#decoder = options.decoder
    this.#payloadType = options.payloadType
    this.#playoutDelayMilliseconds =
      options.playoutDelayMilliseconds ?? REMOTE_AUDIO_PLAYOUT_DELAY_MS
    this.#idleTimeoutMilliseconds =
      options.idleTimeoutMilliseconds ?? REMOTE_AUDIO_IDLE_TIMEOUT_MS
    this.#onAudio = options.onAudio
    this.#onError = options.onError
    this.#onDecodeError = options.onDecodeError
    this.#onPacketLoss = options.onPacketLoss
    this.#onPacketRepair = options.onPacketRepair
    if (
      this.#payloadType !== undefined &&
      (!Number.isInteger(this.#payloadType) || this.#payloadType < 0 || this.#payloadType > 127)
    ) {
      throw new RangeError('remote audio payload type must be an integer from 0 through 127')
    }
    if (!Number.isFinite(this.#playoutDelayMilliseconds) || this.#playoutDelayMilliseconds < 0) {
      throw new RangeError('remote audio playout delay must be a non-negative finite number')
    }
    if (!Number.isFinite(this.#idleTimeoutMilliseconds) || this.#idleTimeoutMilliseconds <= 0) {
      throw new RangeError('remote audio idle timeout must be a positive finite number')
    }
  }

  push(packet: RtpPacket): void {
    if (this.#closed) return
    const now = this.#scheduler.now()
    if (
      this.#playoutTimestamp === undefined ||
      this.#ssrc !== packet.header.ssrc ||
      now - this.#lastReceivedAt >= this.#idleTimeoutMilliseconds
    ) {
      this.#startTimeline(packet, now)
      return
    }

    if (
      this.#retiredSequence !== undefined &&
      sequenceDistance(packet.header.sequenceNumber, this.#retiredSequence) <= 0
    ) return
    if (this.#packets.has(packet.header.sequenceNumber)) return

    const timestampDelta = timestampDistance(
      packet.header.timestamp,
      this.#playoutTimestamp,
    )
    if (Math.abs(timestampDelta) > MAX_REMOTE_TIMESTAMP_GAP_SAMPLES) {
      // A newer packet outside the active RTP timeline is a stream
      // discontinuity, not jitter. An older packet is only a delayed duplicate.
      if (
        timestampDelta > 0 ||
        this.#retiredSequence === undefined ||
        sequenceDistance(packet.header.sequenceNumber, this.#retiredSequence) > 0
      ) {
        this.#startTimeline(packet, now)
      }
      return
    }
    if (this.#packets.size >= MAX_QUEUED_REMOTE_PACKETS) {
      this.#startTimeline(packet, now)
      return
    }
    this.#packets.set(packet.header.sequenceNumber, packet)
    this.#lastReceivedAt = now
    if (this.#rebufferUntil === Number.POSITIVE_INFINITY) {
      this.#rebufferUntil = now + this.#playoutDelayMilliseconds
    }
  }

  stop(): void {
    if (this.#closed) return
    this.#closed = true
    this.#pause()
  }

  #startTimeline(packet: RtpPacket, now: number): void {
    this.#pause()
    this.#ssrc = packet.header.ssrc
    this.#playoutTimestamp = packet.header.timestamp
    this.#retiredSequence = addSequence(packet.header.sequenceNumber, -1)
    this.#lastReceivedAt = now
    this.#nextPlayoutAt = now + this.#playoutDelayMilliseconds
    this.#rebufferUntil = undefined
    this.#consecutiveDecodeFailures = 0
    this.#packets.set(packet.header.sequenceNumber, packet)
    this.#schedule()
  }

  #schedule(): void {
    if (this.#closed || this.#timer !== undefined || this.#playoutTimestamp === undefined) return
    const delay = Math.max(0, this.#nextPlayoutAt - this.#scheduler.now())
    this.#timer = this.#scheduler.setTimeout(() => this.#tick(), delay)
  }

  #tick(): void {
    this.#timer = undefined
    if (this.#closed || this.#playoutTimestamp === undefined) return
    const now = this.#scheduler.now()
    if (now < this.#nextPlayoutAt) {
      this.#schedule()
      return
    }

    try {
      if (this.#rebufferUntil !== undefined) {
        if (now - this.#lastReceivedAt >= this.#idleTimeoutMilliseconds) {
          this.#pause()
          return
        }
        if (now < this.#rebufferUntil) {
          this.#emitRebufferingSilence()
          return
        }
        this.#rebufferUntil = undefined
      }
      const selection = this.#selectPacket()
      for (const packet of selection.stale) {
        this.#packets.delete(packet.header.sequenceNumber)
        this.#retirePacket(packet)
      }

      if (selection.current) {
        this.#decodeAndEmit(selection.current, selection.future)
        return
      }
      if (selection.future) {
        this.#fillTimestampGap(selection.future, selection.futureDelta)
        return
      }
      if (selection.stale.length > 0) {
        this.#emitRebufferingSilence()
        return
      }
      if (now - this.#lastReceivedAt >= this.#idleTimeoutMilliseconds) {
        this.#pause()
        return
      }
      this.#rebufferUntil = Number.POSITIVE_INFINITY
      this.#emitRebufferingSilence()
    } catch (error) {
      this.#fail(error)
    }
  }

  #selectPacket(): {
    stale: RtpPacket[]
    current: RtpPacket | undefined
    future: RtpPacket | undefined
    futureDelta: number
  } {
    if (this.#playoutTimestamp === undefined) {
      return { stale: [], current: undefined, future: undefined, futureDelta: 0 }
    }
    const stale: Array<{ packet: RtpPacket; timestampDelta: number }> = []
    let current: RtpPacket | undefined
    let future: RtpPacket | undefined
    let futureDelta = Number.POSITIVE_INFINITY
    for (const packet of this.#packets.values()) {
      const timestampDelta = timestampDistance(
        packet.header.timestamp,
        this.#playoutTimestamp,
      )
      if (timestampDelta < 0) {
        stale.push({ packet, timestampDelta })
      } else if (timestampDelta === 0) {
        if (!current || this.#isEarlierSequence(packet, current)) current = packet
      } else if (
        timestampDelta < futureDelta ||
        (timestampDelta === futureDelta && future && this.#isEarlierSequence(packet, future))
      ) {
        future = packet
        futureDelta = timestampDelta
      }
    }
    stale.sort((left, right) =>
      left.timestampDelta - right.timestampDelta ||
      sequenceDistance(left.packet.header.sequenceNumber, right.packet.header.sequenceNumber),
    )
    return {
      stale: stale.map(({ packet }) => packet),
      current,
      future,
      futureDelta: Number.isFinite(futureDelta) ? futureDelta : 0,
    }
  }

  #isEarlierSequence(left: RtpPacket, right: RtpPacket): boolean {
    if (this.#retiredSequence === undefined) {
      return left.header.sequenceNumber < right.header.sequenceNumber
    }
    return sequenceDistance(left.header.sequenceNumber, this.#retiredSequence) <
      sequenceDistance(right.header.sequenceNumber, this.#retiredSequence)
  }

  #decodeAndEmit(packet: RtpPacket, future: RtpPacket | undefined): void {
    this.#packets.delete(packet.header.sequenceNumber)
    this.#retirePacket(packet)
    this.#playoutTimestamp = packet.header.timestamp
    if (
      this.#payloadType !== undefined &&
      packet.header.payloadType !== this.#payloadType
    ) {
      this.#consecutiveDecodeFailures = 0
      this.#emitTimelineSilence(WEBRTC_AUDIO_FRAME_SAMPLES)
      return
    }
    let chunk: PcmChunk
    try {
      chunk = this.#decoder.decode(packet)
    } catch (error) {
      const normalized = normalizeError(error)
      this.#consecutiveDecodeFailures += 1
      this.#onDecodeError?.(normalized, packet)
      if (
        this.#consecutiveDecodeFailures >=
        MAX_CONSECUTIVE_REMOTE_DECODE_FAILURES
      ) {
        throw new Error(
          `WebRTC Opus decoder failed for ${this.#consecutiveDecodeFailures} consecutive packets`,
          { cause: normalized },
        )
      }
      this.#repairMissingMedia(
        WEBRTC_AUDIO_FRAME_SAMPLES,
        future &&
          timestampDistance(future.header.timestamp, packet.header.timestamp) ===
            WEBRTC_AUDIO_FRAME_SAMPLES
          ? future
          : undefined,
      )
      return
    }
    this.#consecutiveDecodeFailures = 0
    this.#emitMediaChunk(chunk, packet.header.timestamp, 'packet')
  }

  #retirePacket(packet: RtpPacket): void {
    const sequenceNumber = packet.header.sequenceNumber
    if (this.#retiredSequence === undefined) {
      this.#retiredSequence = sequenceNumber
      return
    }
    const distance = sequenceDistance(sequenceNumber, this.#retiredSequence)
    if (distance <= 0) return
    if (distance > 1) this.#onPacketLoss?.(distance - 1)
    this.#retiredSequence = sequenceNumber
  }

  #fillTimestampGap(future: RtpPacket, futureDelta: number): void {
    const samples = Math.min(WEBRTC_AUDIO_FRAME_SAMPLES, futureDelta)
    const missingPackets = this.#retiredSequence === undefined
      ? 0
      : Math.max(
          0,
          sequenceDistance(future.header.sequenceNumber, this.#retiredSequence) - 1,
        )
    const missingPacketSamples = missingPackets * WEBRTC_AUDIO_FRAME_SAMPLES
    if (futureDelta > missingPacketSamples) {
      this.#emitTimelineSilence(samples)
      return
    }
    this.#repairMissingMedia(
      samples,
      futureDelta <= WEBRTC_AUDIO_FRAME_SAMPLES ? future : undefined,
    )
  }

  #emitTimelineSilence(samples: number): void {
    if (this.#playoutTimestamp === undefined) return
    const timestamp = this.#playoutTimestamp
    this.#playoutTimestamp = addTimestamp(this.#playoutTimestamp, samples)
    this.#emitSilence(samples, {
      timestamp,
      advancesMediaTime: true,
      source: 'dtx',
    })
  }

  #repairMissingMedia(samples: number, fecPacket?: RtpPacket): void {
    if (this.#playoutTimestamp === undefined) return
    const timestamp = this.#playoutTimestamp
    let chunk: PcmChunk | undefined
    if (fecPacket) {
      try {
        chunk = this.#decoder.recoverFec(fecPacket, samples)
      } catch (error) {
        this.#onDecodeError?.(normalizeError(error), fecPacket)
      }
    }
    if (chunk) {
      this.#onPacketRepair?.('fec')
      this.#emitMediaChunk(chunk, timestamp, 'fec', samples)
      return
    }
    this.#onPacketRepair?.('plc')
    this.#emitMediaChunk(this.#decoder.conceal(samples), timestamp, 'plc', samples)
  }

  #emitRebufferingSilence(): void {
    if (this.#playoutTimestamp === undefined) return
    this.#emitSilence(WEBRTC_AUDIO_FRAME_SAMPLES, {
      timestamp: this.#playoutTimestamp,
      advancesMediaTime: false,
      source: 'rebuffering',
    })
  }

  #emitSilence(samples: number, timing: OpusRtpAudioFrameTiming): void {
    const byteLength = samples * 2
    this.#onAudio(
      pcmChunk(
        byteLength === WEBRTC_SILENCE_BYTES.byteLength
          ? WEBRTC_SILENCE_BYTES
          : WEBRTC_SILENCE_BYTES.slice(0, byteLength),
        WEBRTC_AUDIO_SAMPLE_RATE,
      ),
      timing,
    )
    this.#advancePlayout(samples)
  }

  #emitMediaChunk(
    chunk: PcmChunk,
    timestamp: number,
    source: 'packet' | 'fec' | 'plc',
    expectedSamples?: number,
  ): void {
    if (
      chunk.sampleRate !== WEBRTC_AUDIO_SAMPLE_RATE ||
      chunk.channels !== 1 ||
      chunk.format !== 's16le' ||
      chunk.data.byteLength % 2 !== 0
    ) {
      throw new Error('WebRTC Opus decoder returned incompatible PCM')
    }
    const samples = chunk.data.byteLength / 2
    if (
      !Number.isInteger(samples) ||
      samples <= 0 ||
      (expectedSamples !== undefined && samples !== expectedSamples)
    ) {
      throw new Error(
        expectedSamples === undefined
          ? 'WebRTC Opus decoder returned an empty PCM frame'
          : `WebRTC Opus repair returned ${samples} samples; expected ${expectedSamples}`,
      )
    }
    this.#playoutTimestamp = addTimestamp(timestamp, samples)
    this.#onAudio(chunk, {
      timestamp,
      advancesMediaTime: true,
      source,
    })
    this.#advancePlayout(samples)
  }

  #advancePlayout(samples: number): void {
    const interval = (samples * 1_000) / WEBRTC_AUDIO_SAMPLE_RATE
    this.#nextPlayoutAt = Math.max(
      this.#nextPlayoutAt + interval,
      this.#scheduler.now() + interval,
    )
    this.#schedule()
  }

  #pause(): void {
    if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer)
    this.#timer = undefined
    this.#packets.clear()
    this.#ssrc = undefined
    this.#playoutTimestamp = undefined
    this.#retiredSequence = undefined
    this.#lastReceivedAt = 0
    this.#nextPlayoutAt = 0
    this.#rebufferUntil = undefined
    this.#consecutiveDecodeFailures = 0
  }

  #fail(error: unknown): void {
    const normalized = normalizeError(error)
    this.stop()
    if (this.#onError) this.#onError(normalized)
    else queueMicrotask(() => {
      throw normalized
    })
  }
}

export type RealtimeAudioTurnStart = {
  id: string
  startMilliseconds: number
}

type PendingRealtimeAudioTurn = RealtimeAudioTurnStart & {
  end?: RealtimeAudioTurnEnd
  endTimestamp?: number
}

/**
 * Maps Frameless Bidi v3 turn timestamps onto the remote RTP media clock.
 *
 * The v3 transport emits RTP continuously, including while the assistant is
 * silent, and does not expose the public Realtime API's authoritative
 * `output_audio_buffer.stopped` event. Measurements across independent v3
 * sessions show that `start_ms` and `end_ms` use the same session-relative
 * clock as the remote 48 kHz RTP stream. Capture the RTP origin independently
 * of turn event arrival, then close only after both `turn.done` and receiver
 * playout reaching the declared end. No PCM audibility heuristic participates
 * in the boundary, so data-channel/RTP reordering cannot lose the origin.
 */
export class RealtimeAudioClockBoundaryTracker {
  #originTimestamp: number | undefined
  #ssrc: number | undefined
  #lastMediaEndTimestamp: number | undefined
  #turn: PendingRealtimeAudioTurn | undefined

  observePacket(timestamp: number, ssrc: number): void {
    requiredUint32(timestamp, 'remote RTP timestamp')
    requiredUint32(ssrc, 'remote RTP SSRC')
    if (this.#originTimestamp === undefined) {
      this.#originTimestamp = timestamp
      this.#ssrc = ssrc
      this.#updateEndTimestamp()
      return
    }
    if (ssrc !== this.#ssrc) {
      throw new Error(
        `remote RTP SSRC changed from ${String(this.#ssrc)} to ${ssrc}; the v3 media clock can no longer be correlated`,
      )
    }
  }

  start(turn: RealtimeAudioTurnStart): void {
    validateTurnStart(turn)
    if (this.#turn?.id === turn.id) {
      if (this.#turn.startMilliseconds === turn.startMilliseconds) return
      throw new Error(
        `assistant audio turn ${turn.id} changed its start time from ${this.#turn.startMilliseconds} to ${turn.startMilliseconds} ms`,
      )
    }
    if (this.#turn) {
      throw new Error(
        `assistant audio turn ${turn.id} started before ${this.#turn.id} reached its media boundary`,
      )
    }
    this.#turn = { ...turn }
  }

  finish(turn: RealtimeAudioTurnEnd): RealtimeAudioTurnEnd | undefined {
    validateTurnEnd(turn)
    const active = this.#turn
    if (!active) {
      throw new Error(`assistant audio turn ${turn.id} ended before it started`)
    }
    if (active.id !== turn.id) {
      throw new Error(
        `assistant audio turn ${turn.id} ended while ${active.id} was active`,
      )
    }
    if (active.startMilliseconds !== turn.startMilliseconds) {
      throw new Error(
        `assistant audio turn ${turn.id} changed its start time from ${active.startMilliseconds} to ${turn.startMilliseconds} ms`,
      )
    }
    active.end = turn
    this.#updateEndTimestamp()
    return this.#takeCompleted()
  }

  advance(
    timing: OpusRtpAudioFrameTiming,
    samples: number,
  ): RealtimeAudioTurnEnd | undefined {
    if (!Number.isSafeInteger(samples) || samples <= 0) {
      throw new RangeError('remote audio frame must contain a positive safe integer number of samples')
    }
    if (!timing.advancesMediaTime) return undefined
    requiredUint32(timing.timestamp, 'remote audio frame timestamp')
    if (this.#originTimestamp === undefined) {
      // Unit-level callers may provide decoded frames without the raw packet
      // callback. Production establishes this from observePacket first.
      this.#originTimestamp = timing.timestamp
      this.#updateEndTimestamp()
    }
    if (
      this.#lastMediaEndTimestamp !== undefined &&
      timestampDistance(timing.timestamp, this.#lastMediaEndTimestamp) < 0
    ) {
      throw new Error('remote RTP playout clock moved backwards')
    }
    this.#lastMediaEndTimestamp = addTimestamp(timing.timestamp, samples)
    return this.#takeCompleted()
  }

  reset(): void {
    this.#originTimestamp = undefined
    this.#ssrc = undefined
    this.#lastMediaEndTimestamp = undefined
    this.#turn = undefined
  }

  #updateEndTimestamp(): void {
    if (!this.#turn?.end || this.#originTimestamp === undefined) return
    const endSamples = this.#turn.end.endMilliseconds *
      (WEBRTC_AUDIO_SAMPLE_RATE / 1_000)
    if (!Number.isSafeInteger(endSamples)) {
      throw new RangeError('assistant audio turn end exceeds the v3 RTP clock range')
    }
    this.#turn.endTimestamp = addTimestamp(this.#originTimestamp, endSamples)
  }

  #takeCompleted(): RealtimeAudioTurnEnd | undefined {
    const turn = this.#turn
    if (
      !turn?.end ||
      turn.endTimestamp === undefined ||
      this.#lastMediaEndTimestamp === undefined ||
      timestampDistance(this.#lastMediaEndTimestamp, turn.endTimestamp) < 0
    ) return undefined
    const completed = turn.end
    this.#turn = undefined
    return completed
  }
}

function parseAssistantTurnStart(
  event: Record<string, unknown>,
): RealtimeAudioTurnStart | undefined {
  if (!isRecord(event.turn)) throw new Error('turn.created is missing its turn object')
  const role = event.turn.role
  if (typeof role !== 'string') throw new Error('turn.created is missing its role')
  if (role !== 'assistant') return undefined
  const turn = {
    id: requiredString(event.turn.id, 'turn.created turn id'),
    startMilliseconds: requiredMilliseconds(
      event.turn.start_ms,
      'turn.created start_ms',
    ),
  }
  validateTurnStart(turn)
  return turn
}

function parseAssistantTurnEnd(
  event: Record<string, unknown>,
): RealtimeAudioTurnEnd | undefined {
  if (!isRecord(event.turn)) throw new Error('turn.done is missing its turn object')
  const role = event.turn.role
  if (typeof role !== 'string') throw new Error('turn.done is missing its role')
  if (role !== 'assistant') return undefined
  const turn = {
    id: requiredString(event.turn.id, 'turn.done turn id'),
    startMilliseconds: requiredMilliseconds(
      event.turn.start_ms,
      'turn.done start_ms',
    ),
    endMilliseconds: requiredMilliseconds(
      event.turn.end_ms,
      'turn.done end_ms',
    ),
    transcript: requiredString(event.turn.transcript, 'turn.done transcript', true),
  }
  validateTurnEnd(turn)
  return turn
}

function validateTurnStart(turn: RealtimeAudioTurnStart): void {
  requiredString(turn.id, 'assistant audio turn id')
  requiredMilliseconds(turn.startMilliseconds, 'assistant audio turn start')
}

function validateTurnEnd(turn: RealtimeAudioTurnEnd): void {
  validateTurnStart(turn)
  requiredMilliseconds(turn.endMilliseconds, 'assistant audio turn end')
  if (turn.endMilliseconds < turn.startMilliseconds) {
    throw new RangeError('assistant audio turn ends before it starts')
  }
  if (typeof turn.transcript !== 'string') {
    throw new TypeError('assistant audio turn transcript must be a string')
  }
}

function requiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`)
  }
  return value
}

function requiredMilliseconds(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function requiredUint32(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer`)
  }
  return value as number
}

export class RealtimeWebRtcSession
  extends EventEmitter<RealtimeWebRtcSessionEvents>
  implements RealtimeAudioSession
{
  readonly closed: Promise<Error | undefined>
  readonly #appServer: CodexAppServer
  readonly #options: RealtimeWebRtcSessionOptions
  readonly #closedDeferred = new Deferred<Error | undefined>()
  readonly #connected = new Deferred<void>()
  readonly #dataChannelOpen = new Deferred<void>()
  readonly #sessionStarted = new Deferred<void>()
  readonly #remoteAudioTrack = new Deferred<void>()
  readonly #subscriptions: Array<() => void> = []
  #peer: RTCPeerConnection | undefined
  #dataChannel: RTCDataChannel | undefined
  #localTrack: MediaStreamTrack | undefined
  #opusEncoder: OpusEncoderHandle | undefined
  #opusDecoder: OpusRtpAudioDecoder | undefined
  #sender: OpusRtpAudioSender | undefined
  #remoteAudioAttached = false
  readonly #audioBoundary = new RealtimeAudioClockBoundaryTracker()
  #peerDisconnectedTimer: NodeJS.Timeout | undefined
  #starting = false
  #started = false
  #closing = false
  #finished = false
  #closeTask: Promise<void> | undefined

  constructor(appServer: CodexAppServer, options: RealtimeWebRtcSessionOptions = {}) {
    super()
    this.#appServer = appServer
    this.#options = options
    this.closed = this.#closedDeferred.promise
  }

  async start(): Promise<void> {
    if (this.#starting || this.#started) throw new Error('WebRTC realtime session is already started')
    if (this.#closing || this.#finished) throw new Error('WebRTC realtime session is closed')
    this.#starting = true
    let opusEncoder: OpusEncoderHandle
    try {
      opusEncoder = await createWebRtcOpusEncoder()
      this.#opusEncoder = opusEncoder
      this.#opusDecoder = await OpusRtpAudioDecoder.create()
      if (this.#closing) {
        throw new Error('WebRTC realtime session was closed during Opus initialization')
      }
    } catch (error) {
      this.#fail(error)
      this.#opusEncoder?.free()
      this.#opusEncoder = undefined
      this.#opusDecoder?.close()
      this.#opusDecoder = undefined
      await this.close()
      this.#starting = false
      throw normalizeError(error)
    }
    const peer = new RTCPeerConnection({
      bundlePolicy: 'max-bundle',
      codecs: {
        audio: [
          useOPUS({
            channels: 2,
            parameters: 'minptime=10;useinbandfec=1',
          }),
        ],
      },
    })
    this.#peer = peer
    this.#subscribe(peer.connectionStateChange, (state) => {
      if (state === 'connected') {
        this.#clearPeerDisconnectedTimer()
        this.#connected.resolve()
      } else if (state === 'disconnected') {
        this.#schedulePeerDisconnectedFailure(peer)
      } else if (state === 'failed') {
        this.#clearPeerDisconnectedTimer()
        this.#fail(new Error('WebRTC peer connection failed'))
      } else if (state === 'closed' && !this.#closing) {
        this.#clearPeerDisconnectedTimer()
        this.#fail(new Error('WebRTC peer connection closed unexpectedly'))
      }
    })
    this.#subscribe(peer.onTrack, (track) => this.#attachRemoteTrack(track))

    const localTrack = new MediaStreamTrack({ kind: 'audio' })
    this.#localTrack = localTrack
    peer.addTrack(localTrack)

    const dataChannel = peer.createDataChannel('oai-events')
    this.#dataChannel = dataChannel
    this.#subscribe(dataChannel.stateChanged, (state) => {
      if (state === 'open') this.#dataChannelOpen.resolve()
      else if (state === 'closed' && !this.#closing && !this.#started) {
        this.#fail(new Error('WebRTC realtime data channel closed unexpectedly'))
      }
    })
    this.#subscribe(dataChannel.onMessage, (message) => this.#handleDataChannelMessage(message))
    this.#subscribe(dataChannel.error, (error) => this.#fail(error))

    try {
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      const offerSdp = peer.localDescription?.sdp
      if (!offerSdp) throw new Error('werift did not produce a local offer SDP')
      const answerSdp = await this.#appServer.startRealtime({
        sdp: offerSdp,
        ...(this.#options.voice ? { voice: this.#options.voice } : {}),
        ...(this.#options.prompt ? { prompt: this.#options.prompt } : {}),
      })
      await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp })
      this.#sender = new OpusRtpAudioSender(localTrack, {
        encoder: opusEncoder,
        onError: (error) => this.#fail(error),
        payloadType: opusPayloadTypeFromSdp(answerSdp),
      })
      this.#sender.start()
      const ready = Promise.all([
        this.#connected.promise,
        this.#dataChannelOpen.promise,
        this.#sessionStarted.promise,
        this.#remoteAudioTrack.promise,
      ]).then(() => undefined)
      const closed = this.closed.then((error) => {
        throw error ?? new Error('WebRTC realtime session closed during startup')
      })
      await withTimeout(
        Promise.race([ready, closed]),
        this.#options.startTimeoutMilliseconds ?? WEBRTC_START_TIMEOUT_MS,
        'WebRTC realtime startup',
      )
      this.#started = true
    } catch (error) {
      this.#fail(error)
      await this.close()
      throw normalizeError(error)
    } finally {
      this.#starting = false
    }
  }

  sendMicrophoneAudio(chunk: PcmChunk): void {
    if (!this.#started || this.#closing) throw new Error('WebRTC realtime session is not ready')
    this.#sender?.push(chunk)
  }

  resetMicrophoneAudio(): void {
    this.#sender?.reset()
  }

  async close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask
    this.#closeTask = this.#close()
    return this.#closeTask
  }

  async #close(): Promise<void> {
    this.#closing = true
    this.#clearPeerDisconnectedTimer()
    this.#sender?.stop()
    this.#audioBoundary.reset()
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe()
    this.#opusEncoder?.free()
    this.#opusEncoder = undefined
    this.#opusDecoder?.close()
    this.#opusDecoder = undefined
    try {
      this.#dataChannel?.close()
    } catch {
      // A channel that never reached SCTP can already be effectively closed.
    }
    this.#localTrack?.stop()
    const peerClose = this.#peer?.close()
    await Promise.allSettled([peerClose, this.#appServer.stopRealtime()])
    this.#finish()
  }

  #attachRemoteTrack(track: MediaStreamTrack): void {
    if (track.kind !== 'audio' || this.#remoteAudioAttached) return
    const codec = track.codec?.mimeType.toLowerCase()
    if (codec !== undefined && codec !== 'audio/opus') {
      this.#fail(new Error(`WebRTC negotiated unsupported remote codec: ${track.codec?.mimeType}`))
      return
    }
    const decoder = this.#opusDecoder
    if (!decoder) {
      this.#fail(new Error('WebRTC remote audio arrived before the Opus decoder was initialized'))
      return
    }
    const receiver = new OpusRtpAudioReceiver({
      decoder,
      onAudio: (chunk, timing) => {
        const completed = this.#audioBoundary.advance(
          timing,
          chunk.data.byteLength / 2,
        )
        this.emit('audio', chunk)
        if (completed) {
          console.log(
            `WebRTC assistant media boundary reached: turn=${completed.id} end_ms=${completed.endMilliseconds}`,
          )
          this.emit('audioEnd', completed)
        }
      },
      ...(track.codec?.payloadType !== undefined
        ? { payloadType: track.codec.payloadType }
        : {}),
      onError: (error) => this.#fail(remoteAudioProcessingError(error)),
      onDecodeError: (error, packet) => console.warn(
        `WebRTC remote Opus packet concealed: sequence=${packet.header.sequenceNumber} payloadType=${packet.header.payloadType} bytes=${packet.payload.byteLength} reason=${error.message}`,
      ),
      onPacketLoss: (packets) => console.warn(`WebRTC remote audio packet loss: ${packets} packet(s)`),
      onPacketRepair: (method) => console.warn(
        `WebRTC remote audio repaired with Opus ${method.toUpperCase()}`,
      ),
    })
    this.#subscribe(track.onReceiveRtp, (packet) => {
      try {
        this.#audioBoundary.observePacket(
          packet.header.timestamp,
          packet.header.ssrc,
        )
        receiver.push(packet)
      } catch (error) {
        this.#fail(remoteAudioProcessingError(error))
      }
    })
    this.#subscriptions.push(() => receiver.stop())
    this.#remoteAudioAttached = true
    this.#remoteAudioTrack.resolve()
  }

  #handleDataChannelMessage(message: string | Buffer): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.isBuffer(message) ? message.toString('utf8') : message)
    } catch (error) {
      this.#fail(new Error('WebRTC realtime data channel returned invalid JSON', { cause: error }))
      return
    }
    if (!isRecord(parsed)) return
    try {
      if (parsed.type === 'session.started') this.#sessionStarted.resolve()
      if (parsed.type === 'error') {
        const details = isRecord(parsed.error) ? parsed.error : undefined
        this.#fail(
          new Error(
            typeof details?.message === 'string'
              ? details.message
              : 'WebRTC realtime data channel returned an error',
          ),
        )
        return
      }
      if (parsed.type === 'turn.created') {
        const turn = parseAssistantTurnStart(parsed)
        if (turn) {
          this.#audioBoundary.start(turn)
          console.log(
            `WebRTC assistant turn started: turn=${turn.id} start_ms=${turn.startMilliseconds}`,
          )
        }
      } else if (parsed.type === 'turn.done') {
        const turn = parseAssistantTurnEnd(parsed)
        if (turn) {
          console.log(
            `WebRTC assistant turn done: turn=${turn.id} start_ms=${turn.startMilliseconds} end_ms=${turn.endMilliseconds}`,
          )
          const completed = this.#audioBoundary.finish(turn)
          if (completed) {
            console.log(
              `WebRTC assistant media boundary reached: turn=${completed.id} end_ms=${completed.endMilliseconds}`,
            )
            this.emit('audioEnd', completed)
          }
        }
      }
      this.emit('event', parsed)
    } catch (error) {
      this.#fail(
        new Error('WebRTC realtime data channel returned an invalid audio turn boundary', {
          cause: error,
        }),
      )
    }
  }

  #subscribe<T extends unknown[]>(
    event: { subscribe(listener: (...args: T) => void): { unSubscribe(): void } },
    listener: (...args: T) => void,
  ): void {
    const subscription = event.subscribe(listener)
    this.#subscriptions.push(() => subscription.unSubscribe())
  }

  #schedulePeerDisconnectedFailure(peer: RTCPeerConnection): void {
    this.#clearPeerDisconnectedTimer()
    this.#peerDisconnectedTimer = setTimeout(() => {
      this.#peerDisconnectedTimer = undefined
      if (
        this.#peer === peer &&
        peer.connectionState === 'disconnected' &&
        !this.#closing
      ) {
        this.#fail(
          new Error(
            `WebRTC peer connection remained disconnected for ${WEBRTC_PEER_DISCONNECTED_GRACE_MS} ms`,
          ),
        )
      }
    }, WEBRTC_PEER_DISCONNECTED_GRACE_MS)
  }

  #clearPeerDisconnectedTimer(): void {
    if (!this.#peerDisconnectedTimer) return
    clearTimeout(this.#peerDisconnectedTimer)
    this.#peerDisconnectedTimer = undefined
  }

  #fail(error: unknown): void {
    if (this.#closing || this.#finished) return
    this.#finish(normalizeError(error))
  }

  #finish(error?: Error): void {
    if (this.#finished) return
    this.#finished = true
    this.#clearPeerDisconnectedTimer()
    this.#sender?.stop()
    this.#closedDeferred.resolve(error)
    this.emit('close', error)
  }
}

export function opusPayloadTypeFromSdp(sdp: string): number {
  const match = /^a=rtpmap:(\d+) opus\/48000(?:\/\d+)?\s*$/im.exec(sdp)
  if (!match) return RTP_PAYLOAD_TYPE_FALLBACK
  const payloadType = Number(match[1])
  return Number.isInteger(payloadType) && payloadType >= 0 && payloadType <= 127
    ? payloadType
    : RTP_PAYLOAD_TYPE_FALLBACK
}

function randomUint16(): number {
  return randomBytes(2).readUInt16BE(0)
}

function randomUint32(): number {
  return randomBytes(4).readUInt32BE(0)
}

function sequenceDistance(value: number, reference: number): number {
  const distance = (value - reference) & 0xffff
  return distance < 0x8000 ? distance : distance - 0x1_0000
}

function addSequence(value: number, increment: number): number {
  return (value + increment) & 0xffff
}

function timestampDistance(value: number, reference: number): number {
  const distance = (value - reference) >>> 0
  return distance < 0x8000_0000 ? distance : distance - 0x1_0000_0000
}

function addTimestamp(value: number, samples: number): number {
  return (value + samples) >>> 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function remoteAudioProcessingError(error: unknown): Error {
  const cause = normalizeError(error)
  return new Error(`WebRTC remote Opus/RTP audio processing failed: ${cause.message}`, {
    cause,
  })
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new RangeError(`${label} timeout must be a positive finite number`)
  }
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
