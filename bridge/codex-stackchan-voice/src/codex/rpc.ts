import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough, Writable, type Readable } from 'node:stream'
import WebSocket from 'ws'
import { Deferred } from '../async.js'

export type RpcId = string | number

export type RpcNotification = {
  method: string
  params?: unknown
}

export type RpcServerRequest = {
  id: RpcId
  method: string
  params?: unknown
}

export class RpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

type PendingRequest = {
  method: string
  deferred: Deferred<unknown>
  timer: NodeJS.Timeout
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class JsonLineRpcConnection extends EventEmitter {
  readonly closed: Promise<Error | undefined>
  readonly #input: Readable
  readonly #output: Writable
  readonly #closedDeferred = new Deferred<Error | undefined>()
  readonly #pending = new Map<RpcId, PendingRequest>()
  #nextId = 1
  #isClosed = false

  constructor(input: Readable, output: Writable) {
    super()
    this.#input = input
    this.#output = output
    this.closed = this.#closedDeferred.promise
    const lines = createInterface({ input, crlfDelay: Infinity })
    lines.on('line', (line) => this.#handleLine(line))
    lines.on('close', () => this.#finish())
    lines.on('error', (error) => this.#finish(error))
    input.on('error', (error) => this.#finish(error))
    output.on('error', (error) => this.#finish(error))
  }

  get isClosed(): boolean {
    return this.#isClosed
  }

  async request<T>(
    method: string,
    params?: unknown,
    timeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.#isClosed) throw new Error('app-server connection is closed')
    if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
      throw new RangeError('request timeout must be a positive finite number')
    }
    const id = this.#nextId
    this.#nextId += 1
    const deferred = new Deferred<unknown>()
    const timer = setTimeout(() => {
      this.#pending.delete(id)
      deferred.reject(new Error(`${method} timed out after ${timeoutMilliseconds} ms`))
    }, timeoutMilliseconds)
    this.#pending.set(id, { method, deferred, timer })
    try {
      await this.#write({ method, id, ...(params === undefined ? {} : { params }) })
    } catch (error) {
      this.#pending.delete(id)
      clearTimeout(timer)
      throw error
    }
    try {
      return (await deferred.promise) as T
    } finally {
      clearTimeout(timer)
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.#write({ method, ...(params === undefined ? {} : { params }) })
  }

  async respond(id: RpcId, result: unknown): Promise<void> {
    await this.#write({ id, result })
  }

  async respondError(id: RpcId, code: number, message: string, data?: unknown): Promise<void> {
    await this.#write({ id, error: { code, message, ...(data === undefined ? {} : { data }) } })
  }

  close(error?: Error): void {
    this.#finish(error)
    this.#input.destroy()
    this.#output.destroy()
  }

  async #write(message: unknown): Promise<void> {
    if (this.#isClosed) throw new Error('app-server connection is closed')
    const line = `${JSON.stringify(message)}\n`
    await new Promise<void>((resolve, reject) => {
      this.#output.write(line, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  #handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch (error) {
      this.#finish(new Error(`invalid JSON from app-server: ${line}`, { cause: error }))
      return
    }
    if (!isRecord(message)) return
    if ((typeof message.id === 'number' || typeof message.id === 'string') && 'result' in message) {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      pending.deferred.resolve(message.result)
      return
    }
    if ((typeof message.id === 'number' || typeof message.id === 'string') && isRecord(message.error)) {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      pending.deferred.reject(
        new RpcError(
          typeof message.error.code === 'number' ? message.error.code : -32_603,
          typeof message.error.message === 'string' ? message.error.message : `${pending.method} failed`,
          message.error.data,
        ),
      )
      return
    }
    if (typeof message.method !== 'string') return
    if (typeof message.id === 'number' || typeof message.id === 'string') {
      this.emit('serverRequest', {
        id: message.id,
        method: message.method,
        ...('params' in message ? { params: message.params } : {}),
      } satisfies RpcServerRequest)
      return
    }
    this.emit('notification', {
      method: message.method,
      ...('params' in message ? { params: message.params } : {}),
    } satisfies RpcNotification)
  }

  #finish(error?: Error): void {
    if (this.#isClosed) return
    this.#isClosed = true
    const reason = error ?? new Error('app-server connection closed')
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.deferred.reject(reason)
    }
    this.#pending.clear()
    this.#closedDeferred.resolve(error)
    this.emit('close', error)
  }
}

export type CodexDaemonConnection = {
  connection: JsonLineRpcConnection
  socketPath: string
  close(): Promise<void>
}

export async function connectCodexDaemon(
  requestedSocketPath?: string,
  signal?: AbortSignal,
): Promise<CodexDaemonConnection> {
  if (signal?.aborted) throw signal.reason ?? new Error('app-server connection aborted')
  const socketPath = requestedSocketPath ?? defaultCodexDaemonSocketPath()
  const input = new PassThrough()
  let websocket: WebSocket
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (websocket.readyState !== WebSocket.OPEN) {
        callback(new Error('codex app-server WebSocket is not open'))
        return
      }
      const serialized = String(chunk)
      const message = serialized.endsWith('\n') ? serialized.slice(0, -1) : serialized
      websocket.send(message, callback)
    },
  })
  websocket = new WebSocket('ws://localhost/rpc', {
    createConnection: () => createConnection({ path: socketPath }),
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
  })
  try {
    await waitForWebSocketOpen(websocket, signal)
  } catch (error) {
    websocket.terminate()
    throw error
  }
  const connection = new JsonLineRpcConnection(input, output)
  websocket.on('message', (data, isBinary) => {
    if (isBinary) {
      const error = new Error('codex app-server sent an unexpected binary WebSocket message')
      connection.close(error)
      websocket.close(1003, 'text messages required')
      return
    }
    input.write(`${String(data)}\n`)
  })
  websocket.on('error', (error) => connection.close(error))
  websocket.on('close', (code, reason) => {
    if (code === 1000) {
      connection.close()
      return
    }
    const error = new Error(
      `codex app-server WebSocket closed (${code}${reason.byteLength > 0 ? `: ${String(reason)}` : ''})`,
    )
    connection.close(error)
  })
  return {
    connection,
    socketPath,
    async close() {
      if (websocket.readyState === WebSocket.CLOSED) return
      const closed = new Promise<void>((resolve) => websocket.once('close', () => resolve()))
      if (websocket.readyState === WebSocket.CONNECTING) websocket.terminate()
      else websocket.close(1000, 'Stack-chan bridge closing')
      const timeout = setTimeout(() => websocket.terminate(), 2_000)
      await closed
      clearTimeout(timeout)
    },
  }
}

function defaultCodexDaemonSocketPath(): string {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
  return join(codexHome, 'app-server-control', 'app-server-control.sock')
}

async function waitForWebSocketOpen(websocket: WebSocket, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      websocket.off('open', onOpen)
      websocket.off('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      cleanup()
      websocket.terminate()
      reject(signal?.reason ?? new Error('app-server connection aborted'))
    }
    websocket.once('open', onOpen)
    websocket.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
