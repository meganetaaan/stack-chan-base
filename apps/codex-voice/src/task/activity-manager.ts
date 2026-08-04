import type { RpcNotification } from '../codex/rpc.js'
import {
  isAppServerThreadStatus,
  type AppServerThreadStatus,
} from '../codex/thread-status.js'
import type { StackChanDevice, TaskExecutionState } from '../types.js'

export type TaskActivityLogger = {
  info?(message: string): void
  warn(message: string): void
}

const defaultLogger: TaskActivityLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
}

export class TaskActivityManager {
  readonly #device: StackChanDevice
  readonly #logger: TaskActivityLogger
  readonly #pendingByThread = new Map<string, TaskExecutionState>()
  #threadId: string | undefined
  #state: TaskExecutionState = 'idle'
  #lastSent: TaskExecutionState | undefined
  #sendTail: Promise<void> = Promise.resolve()
  #closed = false

  constructor(device: StackChanDevice, logger: TaskActivityLogger = defaultLogger) {
    this.#device = device
    this.#logger = logger
  }

  get state(): TaskExecutionState {
    return this.#state
  }

  async bindThread(threadId: string, initialStatus: AppServerThreadStatus): Promise<void> {
    if (this.#closed) throw new Error('task activity manager is closed')
    if (this.#threadId) throw new Error('task activity manager is already bound')
    this.#threadId = threadId
    const pending = this.#pendingByThread.get(threadId)
    this.#pendingByThread.clear()
    this.#state = pending ?? taskStateFromThreadStatus(initialStatus)
    await this.#send(this.#state)
  }

  async handleNotification(notification: RpcNotification): Promise<void> {
    if (this.#closed || notification.method !== 'thread/status/changed') return
    if (!isRecord(notification.params)) return
    const threadId = notification.params.threadId
    const status = notification.params.status
    if (
      typeof threadId !== 'string' ||
      !isAppServerThreadStatus(status)
    ) {
      return
    }
    const next = taskStateFromThreadStatus(status)
    if (!this.#threadId) {
      this.#pendingByThread.set(threadId, next)
      return
    }
    if (threadId !== this.#threadId) return
    if (next === this.#state) {
      if (this.#lastSent !== next) await this.#send(next)
      return
    }
    this.#state = next
    await this.#send(next)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#pendingByThread.clear()
    if (this.#threadId && (this.#state !== 'idle' || this.#lastSent !== 'idle')) {
      this.#state = 'idle'
      await this.#send('idle')
    } else {
      await this.#sendTail
    }
    this.#threadId = undefined
  }

  #send(state: TaskExecutionState): Promise<void> {
    const send = this.#sendTail.then(async () => {
      if (this.#lastSent === state) return
      try {
        await this.#device.setTaskState(state)
        this.#lastSent = state
        this.#logger.info?.(`Codexタスク状態: ${state}`)
      } catch (error) {
        this.#logger.warn(`タスク状態の送信に失敗: ${errorMessage(error)}`)
      }
    })
    this.#sendTail = send
    return send
  }
}

function taskStateFromThreadStatus(status: AppServerThreadStatus): TaskExecutionState {
  return status.type === 'active' ? 'running' : 'idle'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
