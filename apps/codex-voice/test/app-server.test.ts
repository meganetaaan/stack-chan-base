import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { CodexAppServer } from '../src/codex/app-server.js'
import { JsonLineRpcConnection } from '../src/codex/rpc.js'

test('app-server initialization opts into experimental APIs without attestation requests', async () => {
  const fromServer = new PassThrough()
  const toServer = new PassThrough()
  const rpc = new JsonLineRpcConnection(fromServer, toServer)
  const appServer = new CodexAppServer(rpc)

  const requestData = once(toServer, 'data')
  const initialization = appServer.initialize()
  const [requestLine] = await requestData
  assert.deepEqual(JSON.parse(String(requestLine)), {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'stackchan_codex_voice',
        title: 'Stack-chan Codex Voice Bridge',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    },
  })

  const initializedData = once(toServer, 'data')
  fromServer.write(
    `${JSON.stringify({
      id: 1,
      result: {
        userAgent: 'stackchan_codex_voice/0.145.0',
        codexHome: '/tmp/codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    })}\n`,
  )
  assert.equal((await initialization).platformOs, 'linux')
  const [initializedLine] = await initializedData
  assert.deepEqual(JSON.parse(String(initializedLine)), {
    method: 'initialized',
    params: {},
  })

  const threadData = once(toServer, 'data')
  const dynamicTools = [
    {
      type: 'function' as const,
      name: 'status',
      description: 'status',
      inputSchema: { type: 'object' },
    },
  ]
  const opened = appServer.openThread({ cwd: '/workspace', dynamicTools })
  const [threadLine] = await threadData
  const threadRequest = JSON.parse(String(threadLine)) as {
    id: number
    method: string
    params: Record<string, unknown>
  }
  assert.equal(threadRequest.method, 'thread/start')
  assert.deepEqual(threadRequest.params.config, {
    features: {
      realtime_conversation: true,
    },
  })
  assert.equal(threadRequest.params.approvalPolicy, 'on-request')
  assert.equal(threadRequest.params.approvalsReviewer, 'user')
  assert.deepEqual(threadRequest.params.dynamicTools, dynamicTools)
  fromServer.write(`${JSON.stringify({ id: threadRequest.id, result: { thread: { id: 'thread-1' } } })}\n`)
  assert.equal(await opened, 'thread-1')

  const realtimeData = once(toServer, 'data')
  const realtimeStarted = appServer.startRealtime({
    sdp: 'v=0\r\no=stackchan-offer\r\n',
    voice: 'juniper',
    prompt: '日本語で話してください。',
  })
  const [realtimeLine] = await realtimeData
  const realtimeRequest = JSON.parse(String(realtimeLine)) as {
    id: number
    method: string
    params: Record<string, unknown>
  }
  assert.equal(realtimeRequest.method, 'thread/realtime/start')
  assert.equal(realtimeRequest.params.version, 'v3')
  assert.equal(realtimeRequest.params.outputModality, 'audio')
  assert.equal(realtimeRequest.params.includeStartupContext, true)
  assert.equal(realtimeRequest.params.voice, 'juniper')
  assert.equal(realtimeRequest.params.prompt, '日本語で話してください。')
  assert.deepEqual(realtimeRequest.params.transport, {
    type: 'webrtc',
    sdp: 'v=0\r\no=stackchan-offer\r\n',
  })
  fromServer.write(`${JSON.stringify({ id: realtimeRequest.id, result: {} })}\n`)
  fromServer.write(
    `${JSON.stringify({
      method: 'thread/realtime/sdp',
      params: {
        threadId: 'thread-1',
        sdp: 'v=0\r\no=codex-answer\r\n',
      },
    })}\n`,
  )
  assert.equal(await realtimeStarted, 'v=0\r\no=codex-answer\r\n')
})

test('realtime startup without an open thread does not register negotiation resources', async () => {
  const rpc = new JsonLineRpcConnection(new PassThrough(), new PassThrough())
  const appServer = new CodexAppServer(rpc)

  await assert.rejects(
    appServer.startRealtime({ sdp: 'v=0\r\n', sdpTimeoutMilliseconds: 10 }),
    /thread has not been opened/,
  )
  assert.equal(appServer.listenerCount('notification'), 0)
})
