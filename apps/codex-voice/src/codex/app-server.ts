import { EventEmitter } from 'node:events'
import { Deferred } from '../async.js'
import { NonRetryableError } from '../retry-policy.js'
import type { RpcNotification, RpcServerRequest } from './rpc.js'
import { JsonLineRpcConnection } from './rpc.js'

const REALTIME_SDP_TIMEOUT_MS = 30_000

export type AppServerThreadOptions = {
  threadId?: string
  cwd: string
  dynamicTools?: DynamicToolSpec[]
}

export type RealtimeStartOptions = {
  sdp: string
  voice?: string
  prompt?: string
  sdpTimeoutMilliseconds?: number
}

export type DynamicToolSpec =
  | {
      type: 'function'
      name: string
      description: string
      inputSchema: unknown
      deferLoading?: boolean
    }
  | {
      type: 'namespace'
      name: string
      description: string
      tools: Array<{
        type: 'function'
        name: string
        description: string
        inputSchema: unknown
        deferLoading?: boolean
      }>
    }

type ThreadResponse = {
  thread: {
    id: string
  }
}

type InitializeResponse = {
  userAgent: string
  codexHome: string
  platformFamily: string
  platformOs: string
}

export class CodexAppServer extends EventEmitter {
  readonly rpc: JsonLineRpcConnection
  #initialized = false
  #threadId: string | undefined

  constructor(rpc: JsonLineRpcConnection) {
    super()
    this.rpc = rpc
    rpc.on('notification', (notification: RpcNotification) => this.emit('notification', notification))
    rpc.on('serverRequest', (request: RpcServerRequest) => this.emit('serverRequest', request))
    rpc.on('close', (error?: Error) => this.emit('close', error))
  }

  get threadId(): string {
    if (!this.#threadId) throw new Error('Codex thread has not been opened')
    return this.#threadId
  }

  async initialize(): Promise<InitializeResponse> {
    if (this.#initialized) throw new Error('app-server connection is already initialized')
    const response = await this.rpc.request<InitializeResponse>('initialize', {
      clientInfo: {
        name: 'stackchan_codex_voice',
        title: 'Stack-chan Codex Voice Bridge',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    })
    assertInitializeResponse(response)
    await this.rpc.notify('initialized', {})
    this.#initialized = true
    return response
  }

  async openThread(options: AppServerThreadOptions): Promise<string> {
    if (!this.#initialized) throw new Error('app-server must be initialized first')
    const common = {
      cwd: options.cwd,
      approvalPolicy: {
        granular: {
          sandbox_approval: true,
          rules: false,
          skill_approval: false,
          request_permissions: false,
          mcp_elicitations: false,
        },
      },
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      config: {
        features: {
          realtime_conversation: true,
        },
      },
    }
    const response = options.threadId
      ? await this.rpc.request<ThreadResponse>('thread/resume', {
          threadId: options.threadId,
          ...common,
          excludeTurns: true,
        })
      : await this.rpc.request<ThreadResponse>('thread/start', {
          ...common,
          ...(options.dynamicTools ? { dynamicTools: options.dynamicTools } : {}),
        })
    if (!isRecord(response) || !isRecord(response.thread) || typeof response.thread.id !== 'string') {
      throw new NonRetryableError('protocol', 'app-server returned an invalid thread response')
    }
    this.#threadId = response.thread.id
    return response.thread.id
  }

  async listRealtimeVoices(): Promise<{
    v1: string[]
    v2: string[]
    defaultV1: string
    defaultV2: string
  }> {
    const response = await this.rpc.request<unknown>('thread/realtime/listVoices', {})
    if (!isRecord(response) || !isRecord(response.voices)) {
      throw new NonRetryableError(
        'protocol',
        'app-server does not expose the required realtime API',
      )
    }
    const voices = response.voices
    if (
      !Array.isArray(voices.v1) ||
      !voices.v1.every((voice) => typeof voice === 'string') ||
      !Array.isArray(voices.v2) ||
      !voices.v2.every((voice) => typeof voice === 'string') ||
      typeof voices.defaultV1 !== 'string' ||
      typeof voices.defaultV2 !== 'string'
    ) {
      throw new NonRetryableError(
        'protocol',
        'app-server returned an invalid realtime voice list',
      )
    }
    return {
      v1: voices.v1,
      v2: voices.v2,
      defaultV1: voices.defaultV1,
      defaultV2: voices.defaultV2,
    }
  }

  async startRealtime(options: RealtimeStartOptions): Promise<string> {
    if (options.sdp.trim().length === 0) {
      throw new NonRetryableError('configuration', 'WebRTC offer SDP must not be empty')
    }
    const answer = new Deferred<string>()
    const threadId = this.threadId
    const onNotification = (notification: RpcNotification) => {
      if (!isRecord(notification.params) || notification.params.threadId !== threadId) return
      if (notification.method === 'thread/realtime/sdp') {
        if (typeof notification.params.sdp === 'string' && notification.params.sdp.trim().length > 0) {
          answer.resolve(notification.params.sdp)
        } else {
          answer.reject(
            new NonRetryableError(
              'protocol',
              'app-server returned an invalid WebRTC answer SDP',
            ),
          )
        }
      } else if (notification.method === 'thread/realtime/error') {
        answer.reject(
          new Error(
            typeof notification.params.message === 'string'
              ? notification.params.message
              : 'Codex realtime returned an error before WebRTC negotiation completed',
          ),
        )
      } else if (notification.method === 'thread/realtime/closed') {
        answer.reject(
          new Error(
            typeof notification.params.reason === 'string'
              ? `Codex realtime closed before WebRTC negotiation completed: ${notification.params.reason}`
              : 'Codex realtime closed before WebRTC negotiation completed',
          ),
        )
      }
    }
    this.on('notification', onNotification)
    const timeoutMilliseconds = options.sdpTimeoutMilliseconds ?? REALTIME_SDP_TIMEOUT_MS
    const timeout = setTimeout(
      () => answer.reject(new Error(`WebRTC answer SDP timed out after ${timeoutMilliseconds} ms`)),
      timeoutMilliseconds,
    )
    const params: Record<string, unknown> = {
      threadId,
      outputModality: 'audio',
      includeStartupContext: true,
      version: 'v3',
      transport: {
        type: 'webrtc',
        sdp: options.sdp,
      },
    }
    if (options.voice) params.voice = options.voice
    if (options.prompt) params.prompt = options.prompt
    try {
      const negotiation = Promise.all([
        this.rpc.request('thread/realtime/start', params),
        answer.promise,
      ]).then(([, sdp]) => sdp)
      const appServerClosed = this.rpc.closed.then((error) => {
        throw error ?? new Error('codex app-server disconnected during WebRTC negotiation')
      })
      return await Promise.race([negotiation, appServerClosed])
    } finally {
      clearTimeout(timeout)
      this.off('notification', onNotification)
    }
  }

  async stopRealtime(): Promise<void> {
    if (!this.#threadId || this.rpc.isClosed) return
    try {
      await this.rpc.request('thread/realtime/stop', { threadId: this.#threadId })
    } catch {
      // Closing or already-closed realtime sessions are idempotent for bridge shutdown.
    }
  }
}

function assertInitializeResponse(value: unknown): asserts value is InitializeResponse {
  if (
    !isRecord(value) ||
    typeof value.userAgent !== 'string' ||
    typeof value.codexHome !== 'string' ||
    typeof value.platformFamily !== 'string' ||
    typeof value.platformOs !== 'string'
  ) {
    throw new NonRetryableError(
      'protocol',
      'app-server returned an invalid initialize response',
    )
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
