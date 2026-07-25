import { performance } from 'node:perf_hooks'
import { Deferred, abortError, delay } from '../async.js'
import {
  RealtimeAudioBridge,
  type RealtimeAudioState,
  type RealtimeAudioStateSink,
} from '../audio/bridge.js'
import type { CodexAppServer } from '../codex/app-server.js'
import {
  ExponentialRetryBackoff,
  retryDisposition,
} from '../retry-policy.js'
import type {
  ConversationSessionState,
  ConversationState,
  StackChanDevice,
} from '../types.js'
import {
  conversationResultEvent,
  type ConversationRequestEvent,
  type ConversationResultEvent,
} from '../usb/events.js'

const RESULT_CACHE_SIZE = 64

export type ConversationAudioRuntime = {
  run(signal: AbortSignal): Promise<void>
}

export type ConversationAudioFactory = (
  appServer: CodexAppServer,
  device: StackChanDevice,
  voice: string | undefined,
  onStateChanged: RealtimeAudioStateSink,
) => ConversationAudioRuntime

export type ConversationSessionControllerOptions = {
  audioFactory?: ConversationAudioFactory
}

const defaultAudioFactory: ConversationAudioFactory = (
  appServer,
  device,
  voice,
  onStateChanged,
) => new RealtimeAudioBridge(appServer, device, voice, undefined, undefined, onStateChanged)

type Attachment = {
  active: boolean
  controller: AbortController
}

export class ConversationSessionController {
  readonly #device: StackChanDevice
  readonly #voice: string | undefined
  readonly #audioFactory: ConversationAudioFactory
  readonly #requestResults = new Map<string, Promise<ConversationResultEvent>>()
  readonly #unsubscribeRequest: () => void
  #state: ConversationSessionState = 'standby'
  #lastWireState: ConversationState | undefined
  #stateWrite: Promise<void> = Promise.resolve()
  #desired = false
  #blocked = false
  #closed = false
  #generation = 0
  #activeController: AbortController | undefined
  #attachment: Attachment | undefined
  #wake = new Deferred<void>()

  constructor(
    device: StackChanDevice,
    voice?: string,
    options: ConversationSessionControllerOptions = {},
  ) {
    this.#device = device
    this.#voice = voice
    this.#audioFactory = options.audioFactory ?? defaultAudioFactory
    this.#unsubscribeRequest = device.onConversationRequest((request) => {
      void this.handleRequest(request)
        .then((result) => device.sendConversationResult(result))
        .catch((error) => {
          console.warn(`会話操作への応答に失敗: ${errorMessage(error)}`)
        })
    })
    void this.#transition('standby').catch((error) => {
      console.warn(`初期会話状態の送信に失敗: ${errorMessage(error)}`)
    })
  }

  get state(): ConversationSessionState {
    return this.#state
  }

  get desired(): boolean {
    return this.#desired
  }

  async activate(): Promise<void> {
    if (this.#closed) throw new Error('conversation session controller is closed')
    this.#blocked = false
    this.#desired = true
    await this.#transition('connecting')
    this.#signalWake()
  }

  handleRequest(request: ConversationRequestEvent): Promise<ConversationResultEvent> {
    const cached = this.#requestResults.get(request.requestId)
    if (cached) return cached
    const pending = this.#applyRequest(request)
    this.#rememberResult(request.requestId, pending)
    void pending.catch(() => {
      if (this.#requestResults.get(request.requestId) === pending) {
        this.#requestResults.delete(request.requestId)
      }
    })
    return pending
  }

  async block(error: unknown): Promise<void> {
    if (this.#closed) return
    this.#desired = false
    this.#blocked = true
    this.#generation += 1
    this.#activeController?.abort(normalizeError(error))
    await this.#transition('blocked')
    this.#signalWake()
  }

  async runWithAppServer(appServer: CodexAppServer, signal: AbortSignal): Promise<void> {
    if (this.#closed) throw new Error('conversation session controller is closed')
    if (this.#attachment?.active) throw new Error('an app-server is already attached')
    const attachment: Attachment = {
      active: true,
      controller: new AbortController(),
    }
    this.#attachment = attachment
    const abortAttachment = (reason: unknown) => {
      if (!attachment.active || attachment.controller.signal.aborted) return
      attachment.controller.abort(reason)
      this.#activeController?.abort(reason)
      this.#signalWake()
    }
    const onProcessAbort = () => abortAttachment(signal.reason ?? abortError())
    if (signal.aborted) onProcessAbort()
    else signal.addEventListener('abort', onProcessAbort, { once: true })
    void appServer.rpc.closed.then((error) => {
      abortAttachment(error ?? new Error('codex app-server disconnected'))
    })
    void this.#device.closed.then((error) => {
      abortAttachment(error ?? new Error('CoreS3 USB disconnected'))
    })

    const backoff = new ExponentialRetryBackoff()
    try {
      while (!attachment.controller.signal.aborted && !this.#closed) {
        if (!this.#desired || this.#blocked) {
          await this.#waitForWake(attachment.controller.signal)
          continue
        }
        const generation = ++this.#generation
        const attempt = new AbortController()
        this.#activeController = attempt
        const onAttachmentAbort = () => {
          attempt.abort(attachment.controller.signal.reason ?? abortError())
        }
        attachment.controller.signal.addEventListener('abort', onAttachmentAbort, { once: true })
        await this.#transition('connecting')
        const startedAt = performance.now()
        try {
          const audio = this.#audioFactory(
            appServer,
            this.#device,
            this.#voice,
            (state) => this.#acceptAudioState(generation, state),
          )
          await audio.run(attempt.signal)
          if (this.#desired && !attempt.signal.aborted) {
            throw new Error('Codex realtime audio bridge stopped unexpectedly')
          }
        } catch (error) {
          if (attachment.controller.signal.aborted || this.#closed) break
          if (attempt.signal.aborted) continue
          if (retryDisposition(error) === 'stop') {
            await this.block(error)
            continue
          }
          if (!this.#desired) continue
          console.warn(`Codex realtimeセッション停止: ${errorMessage(error)}`)
          await this.#transition('connecting')
          const retryMilliseconds = backoff.afterFailure(performance.now() - startedAt)
          console.log(`Codex realtime再接続待ち: ${retryMilliseconds}ms`)
          const retry = new AbortController()
          this.#activeController = retry
          const onRetryAttachmentAbort = () => {
            retry.abort(attachment.controller.signal.reason ?? abortError())
          }
          attachment.controller.signal.addEventListener('abort', onRetryAttachmentAbort, { once: true })
          try {
            await delay(retryMilliseconds, retry.signal)
          } catch (retryError) {
            if (!retry.signal.aborted) throw retryError
          } finally {
            attachment.controller.signal.removeEventListener('abort', onRetryAttachmentAbort)
            if (this.#activeController === retry) this.#activeController = undefined
          }
        } finally {
          attachment.controller.signal.removeEventListener('abort', onAttachmentAbort)
          if (this.#activeController === attempt) this.#activeController = undefined
        }
      }
    } finally {
      attachment.active = false
      signal.removeEventListener('abort', onProcessAbort)
      this.#activeController?.abort(abortError('app-server attachment ended'))
      this.#activeController = undefined
      if (this.#attachment === attachment) this.#attachment = undefined
      if (this.#desired && !this.#blocked && !this.#closed) await this.#transition('connecting')
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#desired = false
    this.#blocked = false
    this.#generation += 1
    this.#unsubscribeRequest()
    this.#activeController?.abort(abortError('conversation controller closed'))
    this.#attachment?.controller.abort(abortError('conversation controller closed'))
    this.#signalWake()
    await this.#transition('standby', true)
    await this.#stateWrite.catch(() => undefined)
  }

  async #applyRequest(request: ConversationRequestEvent): Promise<ConversationResultEvent> {
    if (this.#closed) {
      return conversationResultEvent(
        request.requestId,
        false,
        'blocked',
        'conversation controller is closed',
      )
    }
    if (request.type === 'conversation.start') {
      const alreadyDesired = this.#desired && !this.#blocked
      this.#blocked = false
      this.#desired = true
      await this.#transition(alreadyDesired ? this.#state : 'connecting')
      this.#signalWake()
      return conversationResultEvent(
        request.requestId,
        true,
        alreadyDesired ? this.#state : 'connecting',
      )
    }

    this.#desired = false
    this.#blocked = false
    this.#generation += 1
    this.#activeController?.abort(abortError('conversation stopped by backward swipe'))
    await this.#transition('standby')
    this.#signalWake()
    return conversationResultEvent(request.requestId, true, 'standby')
  }

  async #acceptAudioState(generation: number, state: RealtimeAudioState): Promise<void> {
    if (
      generation !== this.#generation ||
      !this.#desired ||
      this.#blocked ||
      this.#closed
    ) {
      return
    }
    await this.#transition(state)
  }

  async #transition(state: ConversationSessionState, force = false): Promise<void> {
    if (this.#closed && !force) return
    this.#state = state
    const wireState = sessionStateToWire(state)
    if (!force && wireState === this.#lastWireState) return
    this.#stateWrite = this.#stateWrite
      .catch(() => undefined)
      .then(async () => {
        if (!this.#device.connected) return
        await this.#device.setConversationState(wireState)
        this.#lastWireState = wireState
      })
    await this.#stateWrite
  }

  #rememberResult(requestId: string, result: Promise<ConversationResultEvent>): void {
    this.#requestResults.set(requestId, result)
    while (this.#requestResults.size > RESULT_CACHE_SIZE) {
      const oldest = this.#requestResults.keys().next().value
      if (oldest === undefined) break
      this.#requestResults.delete(oldest)
    }
  }

  #signalWake(): void {
    const wake = this.#wake
    this.#wake = new Deferred<void>()
    wake.resolve()
  }

  async #waitForWake(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    const wake = this.#wake.promise
    let onAbort: (() => void) | undefined
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => resolve()
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([wake, aborted])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
}

function sessionStateToWire(state: ConversationSessionState): ConversationState {
  if (state === 'standby') return 'idle'
  if (state === 'blocked') return 'error'
  return state
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
