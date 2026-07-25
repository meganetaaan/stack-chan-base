import { createHash } from 'node:crypto'
import type { RpcId, RpcNotification, RpcServerRequest } from '../codex/rpc.js'
import type { JsonLineRpcConnection } from '../codex/rpc.js'
import { isRecord } from '../codex/app-server.js'
import type { ApprovalRequest, StackChanDevice } from '../types.js'
import { truncateUtf8 } from '../usb/events.js'

type SupportedApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'

type PendingApproval = {
  key: string
  rpcId: RpcId
  method: SupportedApprovalMethod
  request: ApprovalRequest
  displayController: AbortController | undefined
  presenting: boolean
}

export type ApprovalManagerLogger = {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

const defaultLogger: ApprovalManagerLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
}

export class ApprovalManager {
  readonly #rpc: JsonLineRpcConnection
  readonly #threadId: string
  readonly #logger: ApprovalManagerLogger
  readonly #pending = new Map<string, PendingApproval>()
  readonly #queue: string[] = []
  #device: StackChanDevice | undefined

  constructor(
    rpc: JsonLineRpcConnection,
    threadId: string,
    logger: ApprovalManagerLogger = defaultLogger,
  ) {
    this.#rpc = rpc
    this.#threadId = threadId
    this.#logger = logger
  }

  get pendingCount(): number {
    return this.#pending.size
  }

  bindDevice(device: StackChanDevice): void {
    this.#device = device
    void this.#presentNext()
  }

  unbindDevice(device: StackChanDevice): void {
    if (this.#device !== device) return
    this.#device = undefined
    for (const pending of this.#pending.values()) {
      pending.displayController?.abort(new Error('Stack-chan disconnected'))
      pending.displayController = undefined
      pending.presenting = false
    }
  }

  async handleServerRequest(serverRequest: RpcServerRequest): Promise<void> {
    if (!isSupportedMethod(serverRequest.method)) {
      await this.#rpc.respondError(
        serverRequest.id,
        -32_601,
        `Stack-chan bridge does not support server request ${serverRequest.method}`,
      )
      return
    }
    const params = isRecord(serverRequest.params) ? serverRequest.params : {}
    if (typeof params.threadId === 'string' && params.threadId !== this.#threadId) {
      await this.#rpc.respondError(serverRequest.id, -32_602, 'approval belongs to another thread')
      return
    }
    const key = rpcKey(serverRequest.id)
    if (this.#pending.has(key)) return
    const pending: PendingApproval = {
      key,
      rpcId: serverRequest.id,
      method: serverRequest.method,
      request: normalizeApproval(
        serverRequest.method,
        params,
        stableApprovalRequestId(this.#threadId, serverRequest.id),
      ),
      displayController: undefined,
      presenting: false,
    }
    this.#pending.set(key, pending)
    this.#queue.push(key)
    this.#logger.info(`承認待ち: ${pending.request.kind} request=${pending.request.id}`)
    void this.#presentNext()
  }

  async handleNotification(notification: RpcNotification): Promise<void> {
    if (notification.method !== 'serverRequest/resolved' || !isRecord(notification.params)) return
    if (notification.params.threadId !== this.#threadId) return
    const requestId = notification.params.requestId
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return
    const key = rpcKey(requestId)
    const pending = this.#pending.get(key)
    if (!pending) return
    pending.displayController?.abort(new Error('approval resolved by app-server'))
    try {
      if (this.#device?.connected) {
        await this.#device.notifyApprovalResolved(pending.request.id, '別のクライアントで処理されました')
      }
    } catch (error) {
      this.#logger.warn(`承認解決画面の更新に失敗: ${errorMessage(error)}`)
    }
    this.#remove(key)
    this.#logger.info(`承認解決: request=${pending.request.id}`)
    void this.#presentNext()
  }

  async suspendDeviceViews(): Promise<void> {
    if (!this.#device?.connected) return
    for (const pending of this.#pending.values()) {
      await this.#device.notifyApprovalSuspended(pending.request.id)
    }
  }

  async declineAll(): Promise<void> {
    for (const key of [...this.#queue]) {
      const pending = this.#pending.get(key)
      if (!pending) continue
      try {
        await this.#rpc.respond(pending.rpcId, responseFor(pending.method, 'decline'))
      } catch (error) {
        this.#logger.error(`承認拒否の送信に失敗: ${errorMessage(error)}`)
      }
      pending.displayController?.abort(new Error('bridge shutting down'))
      try {
        if (this.#device?.connected) {
          await this.#device.notifyApprovalResolved(pending.request.id, 'ブリッジを終了します')
        }
      } catch (error) {
        this.#logger.warn(`終了時の承認画面更新に失敗: ${errorMessage(error)}`)
      }
      this.#remove(key)
    }
  }

  async #presentNext(): Promise<void> {
    const device = this.#device
    if (!device?.connected) return
    const current = this.#queue
      .map((key) => this.#pending.get(key))
      .find((pending): pending is PendingApproval => pending !== undefined)
    if (!current || current.presenting) return
    current.presenting = true
    const controller = new AbortController()
    current.displayController = controller
    try {
      const decision = await device.requestApproval(current.request, controller.signal)
      if (!this.#pending.has(current.key)) return
      this.#logger.info(`承認応答: ${decision} request=${current.request.id}`)
      await this.#rpc.respond(current.rpcId, responseFor(current.method, decision))
      if (!this.#pending.has(current.key)) return
      try {
        if (this.#device?.connected) {
          await this.#device.notifyApprovalResolved(
            current.request.id,
            decision === 'approve' ? '承認しました' : '拒否しました',
          )
        }
      } catch (error) {
        this.#logger.warn(`承認解決画面の更新に失敗: ${errorMessage(error)}`)
      }
      this.#remove(current.key)
      void this.#presentNext()
    } catch (error) {
      if (!controller.signal.aborted) this.#logger.warn(`承認画面を中断: ${errorMessage(error)}`)
      current.presenting = false
      current.displayController = undefined
      return
    }
  }

  #remove(key: string): void {
    this.#pending.delete(key)
    const index = this.#queue.indexOf(key)
    if (index >= 0) this.#queue.splice(index, 1)
  }
}

function isSupportedMethod(method: string): method is SupportedApprovalMethod {
  return method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval'
}

function normalizeApproval(
  method: SupportedApprovalMethod,
  params: Record<string, unknown>,
  id: string,
): ApprovalRequest {
  if (method === 'item/commandExecution/requestApproval') {
    const command = stringOr(params.command, 'コマンドの詳細はCLIで確認してください')
    const cwd = stringOr(params.cwd, '')
    const reason = stringOr(params.reason, '')
    const detailSource = [
      `コマンド:\n${command}`,
      cwd ? `作業ディレクトリ:\n${cwd}` : '',
      reason ? `理由:\n${reason}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const detail = truncateUtf8(detailSource)
    return {
      id,
      kind: 'command',
      title: 'コマンド実行の承認',
      summary: oneLine(command, 96),
      detail: detail.value,
      truncated: detail.truncated,
    }
  }
  const reason = stringOr(params.reason, '')
  const grantRoot = stringOr(params.grantRoot, '')
  const summary = grantRoot ? `変更先: ${grantRoot}` : reason || 'ファイル変更の詳細はCLIで確認してください'
  const detailSource = [
    reason ? `理由:\n${reason}` : '',
    grantRoot ? `変更先:\n${grantRoot}` : '',
    '変更内容の完全な差分はCLIで確認してください。',
  ]
    .filter(Boolean)
    .join('\n\n')
  const detail = truncateUtf8(detailSource)
  return {
    id,
    kind: 'fileChange',
    title: 'ファイル変更の承認',
    summary: oneLine(summary, 96),
    detail: detail.value,
    truncated: detail.truncated,
  }
}

function stableApprovalRequestId(threadId: string, rpcId: RpcId): string {
  const digest = createHash('sha256')
    .update(threadId)
    .update('\0')
    .update(typeof rpcId)
    .update('\0')
    .update(String(rpcId))
    .digest('hex')
    .slice(0, 32)
  return `codex-${digest}`
}

function responseFor(method: SupportedApprovalMethod, decision: 'approve' | 'decline'): {
  decision: 'accept' | 'decline'
} {
  void method
  return { decision: decision === 'approve' ? 'accept' : 'decline' }
}

function rpcKey(id: RpcId): string {
  return `${typeof id}:${id}`
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function oneLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
