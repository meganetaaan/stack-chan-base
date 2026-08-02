import { AsyncQueue, Deferred, abortError } from '../async.js'
import type { CodexAppServer } from '../codex/app-server.js'
import { isRecord } from '../codex/app-server.js'
import type { RpcNotification } from '../codex/rpc.js'
import type { PcmChunk, StackChanDevice } from '../types.js'
import {
  createVoiceOutputTransform,
  type PcmAudioTransform,
  type VoiceEffect,
  VOICE_EFFECT_SAMPLE_RATE,
} from './voice-effect.js'
import {
  RealtimeWebRtcSession,
  type RealtimeAudioSession,
  type RealtimeAudioTurnEnd,
} from './webrtc.js'

const REALTIME_SAMPLE_RATE = 24_000
const MAX_OUTPUT_QUEUE_BYTES = REALTIME_SAMPLE_RATE * 2 * 5
const MAX_SOURCE_QUEUE_BYTES = VOICE_EFFECT_SAMPLE_RATE * 2 * 5
const OUTPUT_PREBUFFER_MILLISECONDS = 240
const OUTPUT_PREBUFFER_BYTES =
  (REALTIME_SAMPLE_RATE * 2 * OUTPUT_PREBUFFER_MILLISECONDS) / 1_000
const MIN_AUDIBLE_PCM_RMS = 128
const OUTPUT_AUDIO_LIFECYCLE_WATCHDOG_MS = 5_000

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
  prompt: string | undefined,
) => RealtimeAudioSession

export type RealtimeAudioState = 'listening' | 'recognizing' | 'speaking'
export type RealtimeAudioStateSink = (state: RealtimeAudioState) => Promise<void>

export type RealtimeAudioOutputOptions = {
  voiceEffect?: VoiceEffect
  transform?: PcmAudioTransform
}

const defaultSessionFactory: RealtimeAudioSessionFactory = (appServer, voice, prompt) =>
  new RealtimeWebRtcSession(appServer, {
    ...(voice ? { voice } : {}),
    ...(prompt ? { prompt } : {}),
  })

export class RealtimeAudioBridge {
  readonly #appServer: CodexAppServer
  readonly #device: StackChanDevice
  readonly #voice: string | undefined
  readonly #prompt: string | undefined
  readonly #logger: AudioBridgeLogger
  readonly #sessionFactory: RealtimeAudioSessionFactory
  readonly #stateSink: RealtimeAudioStateSink
  readonly #outputTransform: PcmAudioTransform
  readonly #failure = new Deferred<never>()
  #session: RealtimeAudioSession | undefined
  #running = false
  #micController: AbortController | undefined
  #micTask: Promise<void> | undefined
  #playbackController: AbortController | undefined
  #playbackSourceQueue: AsyncQueue<PcmChunk> | undefined
  #playbackQueue: AsyncQueue<PcmChunk> | undefined
  #playbackReady: Deferred<void> | undefined
  #playbackTask: Promise<void> | undefined
  #sourceQueuedBytes = 0
  #playbackQueuedBytes = 0
  #playbackClosing = false
  #assistantTranscriptCompleted = false
  #assistantAudioBoundaryDeclared = false
  #assistantAudioBoundaryCompleted = false
  #assistantAudioBoundaryTurnId: string | undefined
  #outputLifecycleWatchdog: NodeJS.Timeout | undefined
  #terminalError: Error | undefined

  constructor(
    appServer: CodexAppServer,
    device: StackChanDevice,
    voice?: string,
    logger: AudioBridgeLogger = defaultLogger,
    sessionFactory: RealtimeAudioSessionFactory = defaultSessionFactory,
    stateSink: RealtimeAudioStateSink = (state) => device.setConversationState(state),
    prompt?: string,
    outputOptions: RealtimeAudioOutputOptions = {},
  ) {
    this.#appServer = appServer
    this.#device = device
    this.#voice = voice
    this.#prompt = prompt
    this.#logger = logger
    this.#sessionFactory = sessionFactory
    this.#stateSink = stateSink
    this.#outputTransform =
      outputOptions.transform ??
      createVoiceOutputTransform(outputOptions.voiceEffect)
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#running) throw new Error('realtime audio bridge is already running')
    this.#running = true
    const session = this.#sessionFactory(this.#appServer, this.#voice, this.#prompt)
    this.#session = session
    const onNotification = (notification: RpcNotification) => this.#handleNotification(notification)
    const onSessionAudio = (chunk: PcmChunk) => this.#handleOutputAudio(chunk)
    const onSessionAudioEndDeclared = (turn: RealtimeAudioTurnEnd) =>
      this.#handleOutputAudioEndDeclared(turn)
    const onSessionAudioEnd = (turn: RealtimeAudioTurnEnd) => this.#handleOutputAudioEnd(turn)
    this.#appServer.on('notification', onNotification)
    session.on('audio', onSessionAudio)
    session.on('audioEndDeclared', onSessionAudioEndDeclared)
    session.on('audioEnd', onSessionAudioEnd)
    const abortDeferred = new Deferred<never>()
    const onAbort = () => abortDeferred.reject(signal.reason ?? abortError())
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    try {
      await Promise.race([session.start(), abortDeferred.promise, this.#failure.promise])
      this.#logger.info(`Codex realtime WebRTC v3開始: thread=${this.#appServer.threadId}`)
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
      session.off('audio', onSessionAudio)
      session.off('audioEndDeclared', onSessionAudioEndDeclared)
      session.off('audioEnd', onSessionAudioEnd)
      signal.removeEventListener('abort', onAbort)
      this.#micController?.abort(abortError('audio bridge stopped'))
      this.#playbackController?.abort(abortError('audio bridge stopped'))
      this.#clearOutputLifecycleWatchdog()
      this.#playbackReady?.resolve()
      this.#playbackSourceQueue?.close()
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
    for await (const chunk of this.#device.microphone(signal, () => {
      this.#logger.info('CoreS3音声認識開始')
      void this.#setState('listening')
    })) {
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
      void this.#setState('listening')
    } else if (item.type === 'input_audio_buffer.speech_stopped' || item.type === 'input_audio_buffer.committed') {
      void this.#setState('recognizing')
    }
  }

  #handleOutputAudio(chunk: PcmChunk): void {
    try {
      this.#validateOutputAudio(chunk)
      const audible = isAudiblePcm16(chunk.data)
      if (!audible && !this.#playbackSourceQueue) return
      if (this.#playbackClosing) return
      if (!this.#playbackSourceQueue) this.#beginPlayback()
      const queue = this.#playbackSourceQueue
      if (!queue) {
        this.#fail(new Error('audio source queue could not be created'))
        return
      }
      if (this.#sourceQueuedBytes + chunk.data.byteLength > MAX_SOURCE_QUEUE_BYTES) {
        const error = new Error('Codex output audio exceeded the five-second processing queue')
        queue.fail(error)
        this.#fail(error)
        return
      }
      this.#sourceQueuedBytes += chunk.data.byteLength
      queue.push(chunk)
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
    this.#playbackClosing = false
    this.#sourceQueuedBytes = 0
    this.#playbackQueuedBytes = 0
    const sourceQueue = new AsyncQueue<PcmChunk>()
    const playbackQueue = new AsyncQueue<PcmChunk>()
    const controller = new AbortController()
    const ready = new Deferred<void>()
    this.#playbackSourceQueue = sourceQueue
    this.#playbackQueue = playbackQueue
    this.#playbackController = controller
    this.#playbackReady = ready
    this.#scheduleOutputLifecycleWatchdog()
    this.#micController?.abort(abortError('switching to speaker playback'))
    this.#session?.resetMicrophoneAudio()
    const outputOutcome = this.#pumpOutputAudio(
      sourceQueue,
      playbackQueue,
      ready,
      controller.signal,
    ).then(
      () => ({ ok: true }) as const,
      (error: unknown) => {
        playbackQueue.fail(error)
        ready.resolve()
        return { ok: false, error } as const
      },
    )
    this.#playbackTask = (async () => {
      let playbackOutcome:
        | { ok: true }
        | { ok: false; error: unknown } = { ok: true }
      try {
        await this.#device.stopMicrophone()
        if (this.#micTask) await this.#micTask.catch(() => undefined)
        await waitForPlaybackReady(ready.promise, controller.signal)
        await this.#stateSink('speaking')
        this.#logger.info('CoreS3音声再生開始')
        await this.#device.playAudio(
          this.#consumePlaybackQueue(playbackQueue),
          controller.signal,
        )
        this.#logger.info('CoreS3音声再生終了')
      } catch (error) {
        playbackOutcome = { ok: false, error }
        sourceQueue.fail(error)
        playbackQueue.fail(error)
        ready.resolve()
      }
      const output = await outputOutcome
      if (!playbackOutcome.ok) throw playbackOutcome.error
      if (!output.ok) throw output.error
    })()
      .catch((error) => {
        if (!controller.signal.aborted) this.#fail(error)
      })
      .finally(() => {
        if (this.#playbackController === controller) this.#playbackController = undefined
        if (this.#playbackSourceQueue === sourceQueue) this.#playbackSourceQueue = undefined
        if (this.#playbackQueue === playbackQueue) this.#playbackQueue = undefined
        if (this.#playbackReady === ready) this.#playbackReady = undefined
        this.#playbackTask = undefined
        this.#playbackClosing = false
        this.#resetAssistantOutputLifecycle()
        this.#sourceQueuedBytes = 0
        this.#playbackQueuedBytes = 0
        if (this.#running && !this.#terminalError) this.#startMicrophone()
      })
  }

  async #pumpOutputAudio(
    sourceQueue: AsyncQueue<PcmChunk>,
    playbackQueue: AsyncQueue<PcmChunk>,
    ready: Deferred<void>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for await (const chunk of this.#outputTransform(
        this.#consumeSourceQueue(sourceQueue),
        signal,
      )) {
        this.#validateTransformedAudio(chunk)
        if (chunk.data.byteLength === 0) continue
        if (this.#playbackQueuedBytes + chunk.data.byteLength > MAX_OUTPUT_QUEUE_BYTES) {
          throw new Error('Codex output audio exceeded the five-second speaker queue')
        }
        this.#playbackQueuedBytes += chunk.data.byteLength
        playbackQueue.push(chunk)
        if (this.#playbackQueuedBytes >= OUTPUT_PREBUFFER_BYTES) ready.resolve()
      }
      playbackQueue.close()
    } finally {
      ready.resolve()
    }
  }

  async *#consumeSourceQueue(queue: AsyncQueue<PcmChunk>): AsyncGenerator<PcmChunk> {
    for await (const chunk of queue) {
      this.#sourceQueuedBytes = Math.max(
        0,
        this.#sourceQueuedBytes - chunk.data.byteLength,
      )
      yield chunk
    }
  }

  async *#consumePlaybackQueue(queue: AsyncQueue<PcmChunk>): AsyncGenerator<PcmChunk> {
    for await (const chunk of queue) {
      this.#playbackQueuedBytes = Math.max(0, this.#playbackQueuedBytes - chunk.data.byteLength)
      yield chunk
    }
  }

  #validateTransformedAudio(chunk: PcmChunk): void {
    if (
      !chunk ||
      typeof chunk !== 'object' ||
      !(chunk.data instanceof Uint8Array) ||
      chunk.sampleRate !== REALTIME_SAMPLE_RATE ||
      chunk.channels !== 1 ||
      chunk.format !== 's16le' ||
      chunk.data.byteLength % 2 !== 0
    ) {
      throw new Error('audio output transform must return complete 24 kHz PCM16LE mono')
    }
  }

  #handleTranscriptDone(params: Record<string, unknown>): void {
    const role = typeof params.role === 'string' ? params.role : ''
    if (role === 'user') {
      this.#resetAssistantOutputLifecycle()
      void this.#setState('recognizing')
      return
    }
    if (role === 'assistant') {
      this.#assistantTranscriptCompleted = true
      if (this.#finishSilentOutputLifecycle()) return
      this.#scheduleOutputLifecycleWatchdog()
    }
  }

  #handleOutputAudioEndDeclared(turn: RealtimeAudioTurnEnd): void {
    this.#recordAssistantAudioBoundary(turn)
    this.#assistantAudioBoundaryDeclared = true
    this.#clearOutputLifecycleWatchdog()
  }

  #handleOutputAudioEnd(turn: RealtimeAudioTurnEnd): void {
    this.#recordAssistantAudioBoundary(turn)
    this.#assistantAudioBoundaryDeclared = true
    this.#assistantAudioBoundaryCompleted = true
    this.#clearOutputLifecycleWatchdog()
    if (!this.#playbackSourceQueue) {
      this.#finishSilentOutputLifecycle()
      return
    }
    if (this.#playbackClosing) return
    this.#playbackClosing = true
    this.#playbackReady?.resolve()
    this.#playbackSourceQueue.close()
  }

  #recordAssistantAudioBoundary(turn: RealtimeAudioTurnEnd): void {
    if (
      this.#assistantAudioBoundaryTurnId !== undefined &&
      this.#assistantAudioBoundaryTurnId !== turn.id
    ) {
      this.#fail(
        new Error(
          `Codex v3 overlapped output audio boundaries: ${this.#assistantAudioBoundaryTurnId} and ${turn.id}`,
        ),
      )
      return
    }
    this.#assistantAudioBoundaryTurnId = turn.id
  }

  #finishSilentOutputLifecycle(): boolean {
    if (
      this.#playbackSourceQueue ||
      !this.#assistantTranscriptCompleted ||
      !this.#assistantAudioBoundaryCompleted
    ) return false
    this.#resetAssistantOutputLifecycle()
    return true
  }

  #resetAssistantOutputLifecycle(): void {
    this.#assistantTranscriptCompleted = false
    this.#assistantAudioBoundaryDeclared = false
    this.#assistantAudioBoundaryCompleted = false
    this.#assistantAudioBoundaryTurnId = undefined
    this.#clearOutputLifecycleWatchdog()
  }

  #fail(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error))
    if (this.#terminalError) return
    this.#terminalError = normalized
    this.#logger.error(`音声ブリッジエラー: ${normalized.message}`)
    if (this.#playbackQueue && this.#playbackTask) {
      this.#playbackClosing = true
      this.#playbackReady?.resolve()
      this.#playbackSourceQueue?.close()
      void this.#playbackTask.finally(() => this.#failure.reject(normalized))
      return
    }
    this.#failure.reject(normalized)
  }

  #clearOutputLifecycleWatchdog(): void {
    if (this.#outputLifecycleWatchdog) {
      clearTimeout(this.#outputLifecycleWatchdog)
      this.#outputLifecycleWatchdog = undefined
    }
  }

  #scheduleOutputLifecycleWatchdog(): void {
    if (
      !this.#assistantTranscriptCompleted ||
      this.#assistantAudioBoundaryDeclared ||
      this.#playbackClosing
    ) return
    this.#clearOutputLifecycleWatchdog()
    this.#outputLifecycleWatchdog = setTimeout(() => {
      this.#outputLifecycleWatchdog = undefined
      if (
        !this.#assistantTranscriptCompleted ||
        this.#assistantAudioBoundaryDeclared
      ) return
      this.#fail(
        new Error(
          'Codex v3 completed the assistant transcript without declaring its RTP media boundary',
        ),
      )
    }, OUTPUT_AUDIO_LIFECYCLE_WATCHDOG_MS)
  }

  async #setState(state: RealtimeAudioState): Promise<void> {
    try {
      await this.#stateSink(state)
    } catch (error) {
      this.#fail(error)
    }
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

export function isAudiblePcm16(data: Uint8Array): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const sampleCount = data.byteLength / 2
  if (sampleCount === 0) return false
  let sumSquares = 0
  for (let offset = 0; offset < data.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true)
    sumSquares += sample * sample
  }
  return sumSquares >= MIN_AUDIBLE_PCM_RMS * MIN_AUDIBLE_PCM_RMS * sampleCount
}
