import assert from 'node:assert/strict'
import test from 'node:test'
import {
  selectDockDevice,
  type DeviceManagerDependencies,
} from '../src/device-manager.js'
import type { UserServiceStatus } from '../src/service/control.js'

const DEVICES = [
  { path: '/dev/ttyACM0', deviceId: 'STACKCHAN-PRIMARY' },
  { path: '/dev/ttyACM1', deviceId: 'STACKCHAN-SECONDARY' },
]

function serviceStatus(active: boolean): UserServiceStatus {
  return {
    unitName: 'stackchan-codex-voice.service',
    loadState: 'loaded',
    activeState: active ? 'active' : 'inactive',
    subState: active ? 'running' : 'dead',
    installed: true,
    active,
  }
}

function dependencies(active: boolean) {
  const writes: Array<{ deviceId: string; path: string | undefined }> = []
  const tryRestarts: string[] = []
  const value: DeviceManagerDependencies = {
    discoverDevices: async () => DEVICES,
    queryServiceStatus: async () => serviceStatus(active),
    writeSelection: async (deviceId, path) => {
      writes.push({ deviceId, path })
    },
    restartServiceIfActive: async (unitName) => {
      tryRestarts.push(unitName)
    },
  }
  return { value, writes, tryRestarts }
}

test('selecting a device while the service is OFF persists it without starting', async () => {
  const observed = dependencies(false)
  const result = await selectDockDevice(
    {
      deviceId: 'STACKCHAN-SECONDARY',
      unitName: 'stackchan-codex-voice.service',
      deviceSelectionPath: '/tmp/selected-device',
    },
    observed.value,
  )

  assert.deepEqual(result, {
    deviceId: 'STACKCHAN-SECONDARY',
    path: '/dev/ttyACM1',
    serviceRestarted: false,
  })
  assert.deepEqual(observed.writes, [{
    deviceId: 'STACKCHAN-SECONDARY',
    path: '/tmp/selected-device',
  }])
  assert.deepEqual(observed.tryRestarts, ['stackchan-codex-voice.service'])
})

test('selecting a device while the service is ON restarts the same unit once', async () => {
  const observed = dependencies(true)
  const result = await selectDockDevice(
    {
      deviceId: 'STACKCHAN-PRIMARY',
      unitName: 'custom.service',
    },
    observed.value,
  )

  assert.equal(result.serviceRestarted, true)
  assert.deepEqual(observed.tryRestarts, ['custom.service'])
})

test('selecting a device before service installation only persists the choice', async () => {
  const observed = dependencies(false)
  observed.value.queryServiceStatus = async () => ({
    ...serviceStatus(false),
    loadState: 'not-found',
    installed: false,
  })
  const result = await selectDockDevice(
    {
      deviceId: 'STACKCHAN-PRIMARY',
      unitName: 'stackchan-codex-voice.service',
    },
    observed.value,
  )

  assert.equal(result.serviceRestarted, false)
  assert.equal(observed.writes.length, 1)
  assert.deepEqual(observed.tryRestarts, [])
})

test('missing and duplicate device IDs fail before changing persistent state', async () => {
  const missing = dependencies(true)
  await assert.rejects(
    selectDockDevice(
      { deviceId: 'MISSING', unitName: 'stackchan-codex-voice.service' },
      missing.value,
    ),
    /MISSING/,
  )
  assert.deepEqual(missing.writes, [])
  assert.deepEqual(missing.tryRestarts, [])

  const duplicate = dependencies(true)
  duplicate.value.discoverDevices = async () => [DEVICES[0]!, DEVICES[0]!]
  await assert.rejects(
    selectDockDevice(
      { deviceId: 'STACKCHAN-PRIMARY', unitName: 'stackchan-codex-voice.service' },
      duplicate.value,
    ),
    /複数/,
  )
  assert.deepEqual(duplicate.writes, [])
  assert.deepEqual(duplicate.tryRestarts, [])
})
