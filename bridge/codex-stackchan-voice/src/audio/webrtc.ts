import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
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
const WEBRTC_SILENCE_FRAME = new Int16Array(WEBRTC_AUDIO_FRAME_SAMPLES)

type OpusEncoderInstance = {
  encode(buffer: Buffer): Buffer
  decode(buffer: Buffer): Buffer
  setBitrate(bitrate: number): void
}

type OpusModule = {
  OpusEncoder: new (sampleRate: number, channels: number) => OpusEncoderInstance
}

const require = createRequire(import.meta.url)
const { OpusEncoder } = require('@discordjs/opus') as OpusModule

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
  scheduler?: OpusRtpAudioSenderScheduler
  onError?: (error: Error) => void
}

const defaultAudioSenderScheduler: OpusRtpAudioSenderScheduler = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout | number),
}

type RealtimeWebRtcSessionEvents = {
  event: [event: Record<string, unknown>]
  audio: [chunk: PcmChunk]
  close: [error?: Error]
}

export interface RealtimeAudioSession {
  readonly closed: Promise<Error | undefined>
  start(): Promise<void>
  sendMicrophoneAudio(chunk: PcmChunk): void
  resetMicrophoneAudio(): void
  close(): Promise<void>
  on(event: 'event', listener: (event: Record<string, unknown>) => void): this
  on(event: 'audio', listener: (chunk: PcmChunk) => void): this
  off(event: 'event', listener: (event: Record<string, unknown>) => void): this
  off(event: 'audio', listener: (chunk: PcmChunk) => void): this
}

export type RealtimeWebRtcSessionOptions = {
  voice?: string
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
  readonly #encoder = new OpusEncoder(WEBRTC_AUDIO_SAMPLE_RATE, 1)
  readonly #frames = new Pcm16FrameBuffer()
  readonly #queuedFrames: Int16Array[] = []
  readonly #ssrc = randomUint32()
  readonly #scheduler: OpusRtpAudioSenderScheduler
  readonly #onError: ((error: Error) => void) | undefined
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

  constructor(track: WritableRtpTrack, options: OpusRtpAudioSenderOptions = {}) {
    this.#track = track
    this.#scheduler = options.scheduler ?? defaultAudioSenderScheduler
    this.#onError = options.onError
    this.#encoder.setBitrate(WEBRTC_OPUS_BITRATE)
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
    const encoded = this.#encoder.encode(Buffer.from(encodePcm16Le(samples)))
    this.#track.writeRtp(
      new RtpPacket(
        new RtpHeader({
          version: 2,
          payloadType: RTP_PAYLOAD_TYPE_FALLBACK,
          sequenceNumber: this.#sequenceNumber,
          timestamp: this.#timestamp,
          ssrc: this.#ssrc,
          marker,
        }),
        encoded,
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
  readonly #decoder = new OpusEncoder(WEBRTC_AUDIO_SAMPLE_RATE, 1)

  decode(packet: RtpPacket): PcmChunk {
    const decoded = this.#decoder.decode(packet.payload)
    if (decoded.byteLength === 0 || decoded.byteLength % 2 !== 0) {
      throw new Error('WebRTC Opus decoder returned an invalid PCM frame')
    }
    return pcmChunk(Uint8Array.from(decoded), WEBRTC_AUDIO_SAMPLE_RATE)
  }
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
  #sender: OpusRtpAudioSender | undefined
  #remoteAudioAttached = false
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
    this.#sender = new OpusRtpAudioSender(localTrack, {
      onError: (error) => this.#fail(error),
    })
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
      })
      await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp })
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
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe()
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
    const decoder = new OpusRtpAudioDecoder()
    this.#subscribe(track.onReceiveRtp, (packet) => {
      try {
        this.emit('audio', decoder.decode(packet))
      } catch (error) {
        this.#fail(new Error('WebRTC remote Opus audio could not be decoded', {
          cause: error,
        }))
      }
    })
    this.#remoteAudioAttached = true
    this.#remoteAudioTrack.resolve()
  }

  #handleDataChannelMessage(message: string | Buffer): void {
    try {
      const parsed: unknown = JSON.parse(Buffer.isBuffer(message) ? message.toString('utf8') : message)
      if (!isRecord(parsed)) return
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
      this.emit('event', parsed)
    } catch (error) {
      this.#fail(new Error('WebRTC realtime data channel returned invalid JSON', { cause: error }))
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

function randomUint16(): number {
  return randomBytes(2).readUInt16BE(0)
}

function randomUint32(): number {
  return randomBytes(4).readUInt32BE(0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
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
