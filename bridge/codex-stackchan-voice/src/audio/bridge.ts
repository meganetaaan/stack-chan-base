import { AsyncQueue, Deferred, abortError } from '../async.js'
import type { CodexAppServer } from '../codex/app-server.js'
import { isRecord } from '../codex/app-server.js'
import type { RpcNotification } from '../codex/rpc.js'
import type { PcmChunk, StackChanDevice } from '../types.js'
import { pcmChunk, StreamingPcm16Resampler } from './pcm.js'
import {
  RealtimeWebRtcSession,
  type RealtimeAudioSession,
} from './webrtc.js'
import { parseAppServerOutputAudio } from './app-server-output.js'

const REALTIME_SAMPLE_RATE = 24_000
const ASSISTANT_AUDIO_GRACE_MS = 500
const OUTPUT_AUDIO_IDLE_FALLBACK_MS = 2_000
const MAX_OUTPUT_QUEUE_BYTES = REALTIME_SAMPLE_RATE * 2 * 5
const OUTPUT_PREBUFFER_MILLISECONDS = 240
const OUTPUT_PREBUFFER_BYTES =
  (REALTIME_SAMPLE_RATE * 2 * OUTPUT_PREBUFFER_MILLISECONDS) / 1_000
const MIN_AUDIBLE_PCM_PEAK = 32

export type AudioBridgeLogger = {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

const defaultLogger: AudioBridgeLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
}

export type RealtimeAudioSessionFactory = (
  appServer: CodexAppServer,
  voice: string | undefined,
) => RealtimeAudioSession

const defaultSessionFactory: RealtimeAudioSessionFactory = (appServer, voice) =>
  new RealtimeWebRtcSession(appServer, voice ? { voice } : {})

export class RealtimeAudioBridge {
  readonly #appServer: CodexAppServer
  readonly #device: StackChanDevice
  readonly #voice: string | undefined
  readonly #logger: AudioBridgeLogger
  readonly #sessionFactory: RealtimeAudioSessionFactory
  readonly #failure = new Deferred<never>()
  #session: RealtimeAudioSession | undefined
  #running = false
  #micController: AbortController | undefined
  #micTask: Promise<void> | undefined
  #playbackController: AbortController | undefined
  #playbackQueue: AsyncQueue<PcmChunk> | undefined
  #playbackReady: Deferred<void> | undefined
  #playbackTask: Promise<void> | undefined
  #playbackQueuedBytes = 0
  #playbackClosing = false
  #outputResampler: StreamingPcm16Resampler | undefined
  #outputSourceRate = 0
  #assistantTranscriptDone = false
  #lastOutputAudioAt = 0
  #playbackEndTimer: NodeJS.Timeout | undefined
  #terminalError: Error | undefined

  constructor(
    appServer: CodexAppServer,
    device: StackChanDevice,
    voice?: string,
    logger: AudioBridgeLogger = defaultLogger,
    sessionFactory: RealtimeAudioSessionFactory = defaultSessionFactory,
  ) {
    this.#appServer = appServer
    this.#device = device
    this.#voice = voice
    this.#logger = logger
    this.#sessionFactory = sessionFactory
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#running) throw new Error('realtime audio bridge is already running')
    this.#running = true
    const session = this.#sessionFactory(this.#appServer, this.#voice)
    this.#session = session
    const onNotification = (notification: RpcNotification) => this.#handleNotification(notification)
    this.#appServer.on('notification', onNotification)
    const abortDeferred = new Deferred<never>()
    const onAbort = () => abortDeferred.reject(signal.reason ?? abortError())
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    try {
      await Promise.race([session.start(), abortDeferred.promise, this.#failure.promise])
      this.#logger.info(`Codex realtime WebRTC v3開始: thread=${this.#appServer.threadId}`)
      await this.#device.setConversationState('idle')
      this.#startMicrophone()
      const deviceClosed = this.#device.closed.then((error) => {
        throw error ?? new Error('CoreS3 USB disconnected')
      })
      const appServerClosed = this.#appServer.rpc.closed.then((error) => {
        throw error ?? new Error('codex app-server disconnected')
      })
      void session.closed.then((error) => {
        if (this.#running) {
          this.#fail(error ?? new Error('WebRTC realtime session closed unexpectedly'))
        }
      })
      await Promise.race([
        abortDeferred.promise,
        this.#failure.promise,
        deviceClosed,
        appServerClosed,
      ])
    } finally {
      this.#running = false
      this.#appServer.off('notification', onNotification)
      signal.removeEventListener('abort', onAbort)
      if (this.#playbackEndTimer) clearTimeout(this.#playbackEndTimer)
      this.#playbackEndTimer = undefined
      this.#micController?.abort(abortError('audio bridge stopped'))
      this.#playbackController?.abort(abortError('audio bridge stopped'))
      this.#playbackReady?.resolve()
      this.#playbackQueue?.close()
      await Promise.allSettled([
        this.#device.stopMicrophone(),
        this.#micTask,
        this.#playbackTask,
        session.close(),
      ])
      if (this.#session === session) this.#session = undefined
    }
  }

  #startMicrophone(): void {
    if (!this.#running || this.#terminalError || this.#micTask || this.#playbackTask) return
    this.#session?.resetMicrophoneAudio()
    const controller = new AbortController()
    this.#micController = controller
    this.#micTask = this.#pumpMicrophone(controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) this.#fail(error)
      })
      .finally(() => {
        if (this.#micController === controller) this.#micController = undefined
        this.#micTask = undefined
      })
  }

  async #pumpMicrophone(signal: AbortSignal): Promise<void> {
    for await (const chunk of this.#device.microphone(signal)) {
      if (chunk.sampleRate !== 16_000 || chunk.channels !== 1 || chunk.format !== 's16le') {
        throw new Error('CoreS3 microphone format changed unexpectedly')
      }
      this.#session?.sendMicrophoneAudio(chunk)
    }
  }

  #handleNotification(notification: RpcNotification): void {
    if (!isRecord(notification.params) || notification.params.threadId !== this.#appServer.threadId) return
    try {
      switch (notification.method) {
        case 'thread/realtime/itemAdded':
          this.#handleRealtimeItem(notification.params.item)
          break
        case 'thread/realtime/transcript/done':
          this.#handleTranscriptDone(notification.params)
          break
        case 'thread/realtime/outputAudio/delta': {
          const chunk = parseAppServerOutputAudio(notification.params, this.#appServer.threadId)
          if (chunk) this.#handleOutputAudio(chunk)
          break
        }
        case 'thread/realtime/error':
          this.#fail(
            new Error(
              typeof notification.params.message === 'string'
                ? notification.params.message
                : 'Codex realtime returned an error',
            ),
          )
          break
        case 'thread/realtime/closed':
          this.#fail(
            new Error(
              typeof notification.params.reason === 'string'
                ? `Codex realtime closed: ${notification.params.reason}`
                : 'Codex realtime closed',
            ),
          )
          break
      }
    } catch (error) {
      this.#fail(error)
    }
  }

  #handleRealtimeItem(item: unknown): void {
    if (!isRecord(item) || typeof item.type !== 'string') return
    if (item.type === 'input_audio_buffer.speech_started') {
      void this.#device.setConversationState('idle').catch((error) => this.#fail(error))
    } else if (item.type === 'input_audio_buffer.speech_stopped' || item.type === 'input_audio_buffer.committed') {
      void this.#device.setConversationState('recognizing').catch((error) => this.#fail(error))
    }
  }

  #handleOutputAudio(chunk: PcmChunk): void {
    try {
      this.#validateOutputAudio(chunk)
      const audible = hasAudiblePcm16(chunk.data)
      if (!audible && !this.#playbackQueue) return
      if (this.#playbackClosing) {
        if (!audible) return
        this.#fail(new Error('Codex emitted audible audio after the current playback stream was closed'))
        return
      }
      if (chunk.sampleRate !== this.#outputSourceRate) {
        this.#outputSourceRate = chunk.sampleRate
        this.#outputResampler = new StreamingPcm16Resampler(chunk.sampleRate, REALTIME_SAMPLE_RATE)
      }
      const output = this.#outputResampler?.processBytes(chunk.data) ?? chunk.data
      if (output.byteLength === 0) return
      if (!this.#playbackQueue) this.#beginPlayback()
      const queue = this.#playbackQueue
      if (!queue) {
        this.#fail(new Error('speaker queue could not be created'))
        return
      }
      if (this.#playbackQueuedBytes + output.byteLength > MAX_OUTPUT_QUEUE_BYTES) {
        const error = new Error('Codex output audio exceeded the five-second speaker queue')
        queue.fail(error)
        this.#fail(error)
        return
      }
      this.#playbackQueuedBytes += output.byteLength
      queue.push(pcmChunk(output, REALTIME_SAMPLE_RATE))
      if (this.#playbackQueuedBytes >= OUTPUT_PREBUFFER_BYTES) this.#playbackReady?.resolve()
      if (audible) {
        this.#lastOutputAudioAt = Date.now()
        this.#schedulePlaybackEnd()
      }
    } catch (error) {
      this.#fail(error)
    }
  }

  #validateOutputAudio(chunk: PcmChunk): void {
    if (!chunk || typeof chunk !== 'object' || !(chunk.data instanceof Uint8Array)) {
      throw new Error('app-server returned an invalid audio chunk')
    }
    if (!Number.isInteger(chunk.sampleRate) || chunk.sampleRate <= 0) {
      throw new Error(`app-server returned invalid sample rate: ${chunk.sampleRate}`)
    }
    if (chunk.channels !== 1) {
      throw new Error(`app-server returned ${String(chunk.channels)}-channel audio; mono is required`)
    }
    if (chunk.format !== 's16le') {
      throw new Error(`app-server returned unsupported audio format: ${String(chunk.format)}`)
    }
    if (chunk.data.byteLength % 2 !== 0) {
      throw new Error('app-server audio contains an incomplete PCM16 sample')
    }
  }

  #beginPlayback(): void {
    if (this.#playbackTask) {
      this.#fail(new Error('Codex emitted a second audio response before the previous playback finished'))
      return
    }
    this.#assistantTranscriptDone = false
    this.#playbackClosing = false
    this.#playbackQueuedBytes = 0
    const queue = new AsyncQueue<PcmChunk>()
    const controller = new AbortController()
    const ready = new Deferred<void>()
    this.#playbackQueue = queue
    this.#playbackController = controller
    this.#playbackReady = ready
    this.#micController?.abort(abortError('switching to speaker playback'))
    this.#playbackTask = (async () => {
      await this.#device.stopMicrophone()
      if (this.#micTask) await this.#micTask.catch(() => undefined)
      await waitForPlaybackReady(ready.promise, controller.signal)
      await this.#device.setConversationState('speaking')
      this.#logger.info('CoreS3音声再生開始')
      await this.#device.playAudio(this.#consumePlaybackQueue(queue), controller.signal)
      this.#logger.info('CoreS3音声再生終了')
      await this.#device.setConversationState('idle')
    })()
      .catch((error) => {
        if (!controller.signal.aborted) this.#fail(error)
      })
      .finally(() => {
        if (this.#playbackController === controller) this.#playbackController = undefined
        if (this.#playbackQueue === queue) this.#playbackQueue = undefined
        if (this.#playbackReady === ready) this.#playbackReady = undefined
        this.#playbackTask = undefined
        this.#playbackClosing = false
        this.#outputResampler = undefined
        this.#outputSourceRate = 0
        if (this.#running && !this.#terminalError) this.#startMicrophone()
      })
  }

  async *#consumePlaybackQueue(queue: AsyncQueue<PcmChunk>): AsyncGenerator<PcmChunk> {
    for await (const chunk of queue) {
      this.#playbackQueuedBytes = Math.max(0, this.#playbackQueuedBytes - chunk.data.byteLength)
      yield chunk
    }
  }

  #handleTranscriptDone(params: Record<string, unknown>): void {
    const role = typeof params.role === 'string' ? params.role : ''
    if (role === 'user') {
      void this.#device.setConversationState('recognizing').catch((error) => this.#fail(error))
      return
    }
    if (role !== 'assistant') return
    this.#assistantTranscriptDone = true
    this.#playbackReady?.resolve()
    this.#schedulePlaybackEnd()
  }

  #schedulePlaybackEnd(): void {
    if (!this.#playbackQueue || this.#playbackClosing) return
    if (this.#playbackEndTimer) clearTimeout(this.#playbackEndTimer)
    const elapsed = Date.now() - this.#lastOutputAudioAt
    const delay = this.#assistantTranscriptDone
      ? Math.max(0, ASSISTANT_AUDIO_GRACE_MS - elapsed)
      : OUTPUT_AUDIO_IDLE_FALLBACK_MS
    this.#playbackEndTimer = setTimeout(() => {
      this.#playbackEndTimer = undefined
      this.#playbackClosing = true
      this.#playbackReady?.resolve()
      this.#playbackQueue?.close()
    }, delay)
  }

  #fail(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error))
    if (this.#terminalError) return
    this.#terminalError = normalized
    this.#logger.error(`音声ブリッジエラー: ${normalized.message}`)
    if (this.#playbackQueue && this.#playbackTask) {
      if (this.#playbackEndTimer) clearTimeout(this.#playbackEndTimer)
      this.#playbackEndTimer = undefined
      this.#playbackClosing = true
      this.#playbackReady?.resolve()
      this.#playbackQueue.close()
      void this.#playbackTask.finally(() => this.#failure.reject(normalized))
      return
    }
    this.#failure.reject(normalized)
  }
}

async function waitForPlaybackReady(ready: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? abortError()
  const aborted = new Deferred<never>()
  const onAbort = () => aborted.reject(signal.reason ?? abortError())
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.race([ready, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function hasAudiblePcm16(data: Uint8Array): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let offset = 0; offset < data.byteLength; offset += 2) {
    if (Math.abs(view.getInt16(offset, true)) >= MIN_AUDIBLE_PCM_PEAK) return true
  }
  return false
}
