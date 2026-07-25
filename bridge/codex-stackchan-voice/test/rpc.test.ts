import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import {
  connectCodexDaemon,
  JsonLineRpcConnection,
  type CodexDaemonConnection,
  type RpcServerRequest,
} from '../src/codex/rpc.js'

test('JSONL RPC correlates responses and emits notifications', async () => {
  const fromServer = new PassThrough()
  const toServer = new PassThrough()
  const connection = new JsonLineRpcConnection(fromServer, toServer)
  const request = connection.request<{ ok: boolean }>('thread/start', { cwd: '/tmp' })
  const written = await once(toServer, 'data')
  const sent = JSON.parse(String(written[0])) as { id: number }
  fromServer.write(`${JSON.stringify({ id: sent.id, result: { ok: true } })}\n`)
  assert.deepEqual(await request, { ok: true })

  const notificationPromise = once(connection, 'notification')
  fromServer.write('{"method":"thread/realtime/started","params":{"threadId":"t"}}\n')
  const [notification] = await notificationPromise
  assert.deepEqual(notification, {
    method: 'thread/realtime/started',
    params: { threadId: 't' },
  })
})

test('JSONL RPC emits app-server initiated requests and writes responses', async () => {
  const fromServer = new PassThrough()
  const toServer = new PassThrough()
  const connection = new JsonLineRpcConnection(fromServer, toServer)
  const serverRequestPromise = once(connection, 'serverRequest')
  fromServer.write('{"method":"item/commandExecution/requestApproval","id":"approval-7","params":{}}\n')
  const [serverRequest] = (await serverRequestPromise) as [RpcServerRequest]
  assert.equal(serverRequest.id, 'approval-7')
  await connection.respond(serverRequest.id, { decision: 'accept' })
  const [written] = await once(toServer, 'data')
  assert.deepEqual(JSON.parse(String(written)), {
    id: 'approval-7',
    result: { decision: 'accept' },
  })
})

test('JSONL RPC bounds unanswered requests with a timeout', async () => {
  const connection = new JsonLineRpcConnection(new PassThrough(), new PassThrough())
  await assert.rejects(connection.request('thread/realtime/start', {}, 5), /timed out after 5 ms/)
})

test('daemon transport carries JSON-RPC as WebSocket text frames over the Unix socket /rpc path', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'stackchan-codex-rpc-'))
  const socketPath = join(temporaryDirectory, 'daemon.sock')
  const server = createServer()
  const websocketServer = new WebSocketServer({ noServer: true })
  let upgradedPath: string | undefined
  server.on('upgrade', (request, socket, head) => {
    upgradedPath = request.url
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket, request)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })

  let daemon: CodexDaemonConnection | undefined
  try {
    const connected = once(websocketServer, 'connection')
    daemon = await connectCodexDaemon(socketPath)
    const [websocket] = await connected
    const received = once(websocket, 'message')
    const result = daemon.connection.request<{ ok: boolean }>('thread/start', { cwd: '/workspace' })
    const [rawRequest, isBinary] = await received
    assert.equal(isBinary, false)
    const request = JSON.parse(String(rawRequest)) as {
      id: number
      method: string
      params: unknown
    }
    assert.equal(upgradedPath, '/rpc')
    assert.deepEqual(request, {
      id: 1,
      method: 'thread/start',
      params: { cwd: '/workspace' },
    })
    websocket.send(JSON.stringify({ id: request.id, result: { ok: true } }))
    assert.deepEqual(await result, { ok: true })
  } finally {
    await daemon?.close()
    for (const client of websocketServer.clients) client.terminate()
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()))
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})
