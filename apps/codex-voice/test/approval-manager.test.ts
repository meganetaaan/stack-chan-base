import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { ApprovalManager } from '../src/approval/manager.js'
import { JsonLineRpcConnection } from '../src/codex/rpc.js'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ConversationState,
  DeviceCapabilities,
  PcmChunk,
  StackChanDevice,
} from '../src/types.js'
import { Deferred } from '../src/async.js'
import type {
  ConversationRequestEvent,
  ConversationResultEvent,
} from '../src/usb/events.js'

class FakeDevice implements StackChanDevice {
  connected = true
  closed = new Promise<Error | undefined>(() => {})
  requests: ApprovalRequest[] = []
  resolved: string[] = []
  decision = new Deferred<ApprovalDecision>()

  async connect(_signal: AbortSignal): Promise<DeviceCapabilities> {
    throw new Error('not used')
  }

  async *microphone(_signal: AbortSignal): AsyncIterable<PcmChunk> {}

  async stopMicrophone(): Promise<void> {}

  async playAudio(_source: AsyncIterable<PcmChunk>, _signal: AbortSignal): Promise<void> {}

  async setConversationState(_state: ConversationState): Promise<void> {}

  async setTaskState(): Promise<void> {}

  onConversationRequest(
    _listener: (request: ConversationRequestEvent) => void,
  ): () => void {
    return () => undefined
  }

  async sendConversationResult(_result: ConversationResultEvent): Promise<void> {}

  async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    this.requests.push(request)
    return await Promise.race([
      this.decision.promise,
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
    ])
  }

  async notifyApprovalResolved(requestId: string): Promise<void> {
    this.resolved.push(requestId)
  }

  async notifyApprovalSuspended(_requestId: string): Promise<void> {}

  async close(): Promise<void> {}
}

test('approval manager maps Stack-chan OK to one-shot app-server accept', async () => {
  const fromServer = new PassThrough()
  const toServer = new PassThrough()
  const rpc = new JsonLineRpcConnection(fromServer, toServer)
  const manager = new ApprovalManager(rpc, 'thread-1', silentLogger)
  const device = new FakeDevice()
  manager.bindDevice(device)
  await manager.handleServerRequest({
    id: 42,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-1',
      command: 'npm test',
      cwd: '/workspace',
    },
  })
  assert.equal(device.requests.length, 1)
  const responseData = once(toServer, 'data')
  device.decision.resolve('approve')
  const [line] = await responseData
  assert.deepEqual(JSON.parse(String(line)), { id: 42, result: { decision: 'accept' } })
  await waitFor(() => device.resolved.length === 1)
  assert.deepEqual(device.resolved, [device.requests[0]?.id])
  assert.equal(manager.pendingCount, 0)
})

test('external resolution closes the Stack-chan approval without a second response', async () => {
  const fromServer = new PassThrough()
  const toServer = new PassThrough()
  const rpc = new JsonLineRpcConnection(fromServer, toServer)
  const manager = new ApprovalManager(rpc, 'thread-1', silentLogger)
  const device = new FakeDevice()
  manager.bindDevice(device)
  await manager.handleServerRequest({
    id: 'approval-1',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread-1', reason: 'workspace外へ書き込みます' },
  })
  const requestId = device.requests[0]?.id
  await manager.handleNotification({
    method: 'serverRequest/resolved',
    params: { threadId: 'thread-1', requestId: 'approval-1' },
  })
  assert.deepEqual(device.resolved, [requestId])
  assert.equal(manager.pendingCount, 0)
})

test('unsupported server requests fail explicitly', async () => {
  const fromServer = new PassThrough()
  const toServer = new PassThrough()
  const rpc = new JsonLineRpcConnection(fromServer, toServer)
  const manager = new ApprovalManager(rpc, 'thread-1', silentLogger)
  const responseData = once(toServer, 'data')
  await manager.handleServerRequest({
    id: 9,
    method: 'item/tool/requestUserInput',
    params: {},
  })
  const [line] = await responseData
  const response = JSON.parse(String(line)) as { error: { code: number } }
  assert.equal(response.error.code, -32_601)
})

test('approval display IDs are stable across app-server reconnects', async () => {
  const firstRpc = new JsonLineRpcConnection(new PassThrough(), new PassThrough())
  const secondRpc = new JsonLineRpcConnection(new PassThrough(), new PassThrough())
  const firstManager = new ApprovalManager(firstRpc, 'thread-1', silentLogger)
  const secondManager = new ApprovalManager(secondRpc, 'thread-1', silentLogger)
  const firstDevice = new FakeDevice()
  const secondDevice = new FakeDevice()
  firstManager.bindDevice(firstDevice)
  secondManager.bindDevice(secondDevice)
  const request = {
    id: 'approval-1',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread-1', reason: 'workspace外へ書き込みます' },
  } as const

  await firstManager.handleServerRequest(request)
  await secondManager.handleServerRequest(request)

  assert.equal(firstDevice.requests[0]?.id, secondDevice.requests[0]?.id)
  assert.match(firstDevice.requests[0]?.id ?? '', /^codex-[0-9a-f]{32}$/)
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.fail('condition was not met')
}

const silentLogger = {
  info() {},
  warn() {},
  error() {},
}
