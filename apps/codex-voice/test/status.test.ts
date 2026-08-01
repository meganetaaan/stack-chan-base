import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDockStatus, formatDockStatus } from '../src/status.js'
import type { UserServiceStatus } from '../src/service/control.js'

const SERVICE: UserServiceStatus = {
  unitName: 'stackchan-codex-voice.service',
  loadState: 'loaded',
  activeState: 'active',
  subState: 'running',
  installed: true,
  active: true,
}

test('dock status marks only the connected selected device', () => {
  const status = buildDockStatus(
    SERVICE,
    [
      { path: '/dev/ttyACM0', deviceId: 'STACKCHAN-PRIMARY' },
      { path: '/dev/ttyACM1', deviceId: undefined },
    ],
    'STACKCHAN-PRIMARY',
  )
  assert.equal(status.selectedDeviceId, 'STACKCHAN-PRIMARY')
  assert.deepEqual(status.devices.map((device) => ({
    selected: device.selected,
    selectable: device.selectable,
  })), [
    { selected: true, selectable: true },
    { selected: false, selectable: false },
  ])
  assert.match(formatDockStatus(status), /サービス: active \(running\)/)
  assert.match(formatDockStatus(status), /\* \/dev\/ttyACM0/)
})

test('dock status preserves an unavailable selected device for the UI', () => {
  const status = buildDockStatus(SERVICE, [], 'STACKCHAN-OFFLINE')
  assert.equal(status.selectedDeviceId, 'STACKCHAN-OFFLINE')
  assert.deepEqual(status.devices, [])
  assert.match(formatDockStatus(status), /STACKCHAN-OFFLINE/)
  assert.match(formatDockStatus(status), /（なし）/)
})

test('dock status represents the first-run state without a persisted selection', () => {
  const status = buildDockStatus(
    SERVICE,
    [{ path: '/dev/ttyACM0', deviceId: 'STACKCHAN-PRIMARY' }],
    undefined,
  )

  assert.equal(status.selectedDeviceId, null)
  assert.equal(status.devices[0]?.selected, false)
  assert.match(formatDockStatus(status), /選択中のデバイス: 未選択/)
})
