import assert from 'node:assert/strict'
import test from 'node:test'
import {
  selectStackChanDeviceId,
  selectStackChanPort,
} from '../src/usb/device.js'

const PORTS = [
  {
    path: '/dev/ttyACM0',
    vendorId: '303A',
    productId: '1001',
    serialNumber: 'STACKCHAN-PRIMARY',
  },
  {
    path: '/dev/ttyACM1',
    vendorId: '303a',
    productId: '1001',
    serialNumber: 'STACKCHAN-SECONDARY',
  },
  {
    path: '/dev/ttyUSB0',
    vendorId: '1234',
    productId: '5678',
    serialNumber: 'NOT-STACKCHAN',
  },
]

test('USB device ID pins discovery to the requested CoreS3', () => {
  assert.equal(
    selectStackChanPort(PORTS, 'STACKCHAN-PRIMARY'),
    '/dev/ttyACM0',
  )
  assert.equal(
    selectStackChanPort(PORTS, 'STACKCHAN-SECONDARY'),
    '/dev/ttyACM1',
  )
})

test('USB auto-discovery fails closed when multiple CoreS3 devices exist', () => {
  assert.throws(
    () => selectStackChanPort(PORTS),
    /--device-idまたは--port/,
  )
})

test('USB device ID never falls back to another compatible CoreS3', () => {
  assert.throws(
    () => selectStackChanPort(PORTS, 'MISSING'),
    /MISSING/,
  )
})

test('service device ID resolves only from the explicitly selected port', () => {
  assert.equal(
    selectStackChanDeviceId(PORTS, '/dev/ttyACM0'),
    'STACKCHAN-PRIMARY',
  )
  assert.throws(
    () => selectStackChanDeviceId(PORTS, '/dev/ttyUSB0'),
    /CoreS3ではありません/,
  )
  assert.throws(
    () => selectStackChanDeviceId(PORTS, '/dev/ttyACM9'),
    /見つかりません/,
  )
})
