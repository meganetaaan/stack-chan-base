import type { DynamicToolSpec } from '../codex/app-server.js'
import type {
  JsonLineRpcConnection,
  RpcServerRequest,
} from '../codex/rpc.js'
import type { ConversationSessionState } from '../types.js'
import type { TaskExecutionState } from '../types.js'

export const STACKCHAN_DYNAMIC_TOOLS: DynamicToolSpec[] = [
  {
    type: 'namespace',
    name: 'stackchan',
    description: 'ｽﾀｯｸﾁｬﾝ本体の安全な状態確認ツール',
    tools: [
      {
        type: 'function',
        name: 'get_status',
        description: 'USB接続状態、会話状態、タスク実行状態を取得する。状態は変更しない。',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  },
]

export type StackChanStatus = {
  connected: boolean
  conversationState: ConversationSessionState
  taskState: TaskExecutionState
  desired: boolean
}

export class StackChanToolHandler {
  readonly #rpc: JsonLineRpcConnection
  readonly #threadId: string
  readonly #getStatus: () => StackChanStatus

  constructor(
    rpc: JsonLineRpcConnection,
    threadId: string,
    getStatus: () => StackChanStatus,
  ) {
    this.#rpc = rpc
    this.#threadId = threadId
    this.#getStatus = getStatus
  }

  async handleServerRequest(request: RpcServerRequest): Promise<void> {
    if (request.method !== 'item/tool/call') {
      await this.#rpc.respondError(
        request.id,
        -32_601,
        `Stack-chan tools do not support server request ${request.method}`,
      )
      return
    }
    const params = isRecord(request.params) ? request.params : {}
    if (params.threadId !== this.#threadId) {
      await this.#respondFailure(request, 'tool call belongs to another thread')
      return
    }
    if (params.namespace !== 'stackchan' || params.tool !== 'get_status') {
      await this.#respondFailure(
        request,
        `unknown Stack-chan tool: ${String(params.namespace)}.${String(params.tool)}`,
      )
      return
    }
    if (!isRecord(params.arguments) || Object.keys(params.arguments).length !== 0) {
      await this.#respondFailure(request, 'stackchan.get_status does not accept arguments')
      return
    }
    let status: StackChanStatus
    try {
      status = this.#getStatus()
    } catch (error) {
      await this.#respondFailure(
        request,
        error instanceof Error ? error.message : String(error),
      )
      return
    }
    await this.#rpc.respond(request.id, {
      success: true,
      contentItems: [
        {
          type: 'inputText',
          text: JSON.stringify(status),
        },
      ],
    })
  }

  async #respondFailure(request: RpcServerRequest, message: string): Promise<void> {
    await this.#rpc.respond(request.id, {
      success: false,
      contentItems: [
        {
          type: 'inputText',
          text: message,
        },
      ],
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
