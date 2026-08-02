import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AppServerThreadActiveFlag,
  AppServerThreadStatus,
} from '../src/codex/thread-status.js'
import { TaskActivityManager } from '../src/task/activity-manager.js'
import type { StackChanDevice, TaskExecutionState } from '../src/types.js'

class RecordingDevice {
  readonly states: TaskExecutionState[] = []
  failures = 0

  async setTaskState(state: TaskExecutionState): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1
      throw new Error('transient task status failure')
    }
    this.states.push(state)
  }
}

test('task activity follows the complete thread active lifecycle', async () => {
  const device = new RecordingDevice()
  const manager = new TaskActivityManager(device as unknown as StackChanDevice)

  await manager.bindThread('thread-1', threadStatus('active'))
  assert.equal(manager.state, 'running')
  assert.deepEqual(device.states, ['running'])

  await manager.handleNotification(statusChanged('thread-1', 'active', ['waitingOnApproval']))
  assert.deepEqual(device.states, ['running'])

  await manager.handleNotification(statusChanged('thread-1', 'idle'))
  assert.equal(manager.state, 'idle')
  assert.deepEqual(device.states, ['running', 'idle'])
  await manager.close()
  assert.deepEqual(device.states, ['running', 'idle'])
})

test('a status notification observed before thread binding wins over the response snapshot', async () => {
  const device = new RecordingDevice()
  const manager = new TaskActivityManager(device as unknown as StackChanDevice)

  await manager.handleNotification(statusChanged('thread-1', 'active'))
  await manager.handleNotification(statusChanged('thread-2', 'idle'))
  await manager.bindThread('thread-1', threadStatus('idle'))

  assert.equal(manager.state, 'running')
  assert.deepEqual(device.states, ['running'])
  await manager.close()
  assert.deepEqual(device.states, ['running', 'idle'])
})

test('task activity ignores other threads and malformed notifications', async () => {
  const device = new RecordingDevice()
  const manager = new TaskActivityManager(device as unknown as StackChanDevice)
  await manager.bindThread('thread-1', threadStatus('idle'))

  await manager.handleNotification(statusChanged('thread-2', 'active'))
  await manager.handleNotification({
    method: 'thread/status/changed',
    params: { threadId: 'thread-1', status: { type: 'unknown' } },
  })
  await manager.handleNotification({ method: 'turn/started', params: {} })

  assert.equal(manager.state, 'idle')
  assert.deepEqual(device.states, ['idle'])
  await manager.close()
})

test('a failed snapshot is retried by the next authoritative notification', async () => {
  const device = new RecordingDevice()
  device.failures = 1
  const warnings: string[] = []
  const manager = new TaskActivityManager(device as unknown as StackChanDevice, {
    warn: (message) => warnings.push(message),
  })

  await manager.bindThread('thread-1', threadStatus('active'))
  assert.equal(manager.state, 'running')
  assert.deepEqual(device.states, [])
  assert.match(warnings[0] ?? '', /transient task status failure/)

  await manager.handleNotification(statusChanged('thread-1', 'active', ['waitingOnUserInput']))
  assert.deepEqual(device.states, ['running'])
  await manager.close()
  assert.deepEqual(device.states, ['running', 'idle'])
})

test('close retries an idle snapshot that could not be delivered', async () => {
  const device = new RecordingDevice()
  device.failures = 1
  const warnings: string[] = []
  const manager = new TaskActivityManager(device as unknown as StackChanDevice, {
    warn: (message) => warnings.push(message),
  })

  await manager.bindThread('thread-1', threadStatus('idle'))
  assert.equal(manager.state, 'idle')
  assert.deepEqual(device.states, [])
  assert.match(warnings[0] ?? '', /transient task status failure/)

  await manager.close()
  assert.deepEqual(device.states, ['idle'])
})

function statusChanged(
  threadId: string,
  type: 'notLoaded' | 'idle' | 'systemError' | 'active',
  activeFlags: AppServerThreadActiveFlag[] = [],
) {
  return {
    method: 'thread/status/changed',
    params: {
      threadId,
      status: threadStatus(type, activeFlags),
    },
  }
}

function threadStatus(
  type: 'notLoaded' | 'idle' | 'systemError' | 'active',
  activeFlags: AppServerThreadActiveFlag[] = [],
): AppServerThreadStatus {
  return type === 'active' ? { type, activeFlags } : { type }
}
