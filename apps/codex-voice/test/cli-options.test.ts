import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseCliCommand } from '../src/cli-options.js'

test('CLI shows help without a command', () => {
  assert.deepEqual(parseCliCommand([]), { kind: 'help' })
})

test('run accepts only device, socket, and diagnostic options', () => {
  assert.deepEqual(
    parseCliCommand([
      'run',
      '--device-id',
      'STACKCHAN-CORE-S3',
      '--socket',
      '/tmp/codex.sock',
      '--start-immediately',
    ]),
    {
      kind: 'run',
      options: {
        deviceId: 'STACKCHAN-CORE-S3',
        socketPath: '/tmp/codex.sock',
        startImmediately: true,
      },
    },
  )
})

test('run rejects removed conversation-setting flags', () => {
  for (const args of [
    ['run', '--cwd', '/tmp/project'],
    ['run', '--voice', 'juniper'],
    ['run', '--thread', 'thread-1'],
  ]) {
    assert.throws(() => parseCliCommand(args), /Unknown option/)
  }
})

test('run rejects ambiguous simultaneous port and device ID selectors', () => {
  assert.throws(
    () =>
      parseCliCommand([
        'run',
        '--port',
        '/dev/ttyACM0',
        '--device-id',
        'STACKCHAN-CORE-S3',
      ]),
    /mutually exclusive/,
  )
  assert.throws(
    () =>
      parseCliCommand([
        'run',
        '--device-id',
        'STACKCHAN-PRIMARY',
        '--device-selection',
        '/tmp/selected-device',
      ]),
    /mutually exclusive/,
  )
  assert.throws(
    () =>
      parseCliCommand([
        'run',
        '--port',
        '/dev/ttyACM0',
        '--device-selection',
        '/tmp/selected-device',
      ]),
    /mutually exclusive/,
  )
})

test('run resolves a relative service-managed device selection file', () => {
  assert.deepEqual(
    parseCliCommand([
      'run',
      '--device-selection',
      'config/selected-device',
    ]),
    {
      kind: 'run',
      options: { deviceSelectionPath: resolve('config/selected-device') },
    },
  )
})

test('config commands resolve workspace paths and support voice changes', () => {
  assert.deepEqual(parseCliCommand(['config', 'init', '/tmp/session']), {
    kind: 'config-init',
    workspacePath: '/tmp/session',
  })
  assert.deepEqual(
    parseCliCommand([
      'config',
      'set',
      'voice',
      'juniper',
      '--workspace',
      '/tmp/session',
    ]),
    {
      kind: 'config-set-voice',
      workspacePath: '/tmp/session',
      voice: 'juniper',
    },
  )
  assert.deepEqual(
    parseCliCommand([
      'config',
      'unset',
      'voice',
      '--workspace',
      '/tmp/session',
    ]),
    {
      kind: 'config-unset-voice',
      workspacePath: '/tmp/session',
    },
  )
})

test('workspace and voice commands parse stable public shapes', () => {
  assert.deepEqual(parseCliCommand(['workspace', 'use', '/tmp/session']), {
    kind: 'workspace-use',
    workspacePath: '/tmp/session',
  })
  assert.deepEqual(parseCliCommand(['workspace', 'current']), {
    kind: 'workspace-current',
  })
  assert.deepEqual(parseCliCommand(['voice', 'list', '--socket', '/tmp/codex.sock']), {
    kind: 'voice-list',
    socketPath: '/tmp/codex.sock',
  })
})

test('status, service, and device management commands parse applet operations', () => {
  assert.deepEqual(
    parseCliCommand([
      'status',
      '--json',
      '--unit-name',
      'custom.service',
      '--device-selection',
      '/tmp/selected-device',
    ]),
    {
      kind: 'status',
      json: true,
      unitName: 'custom.service',
      deviceSelectionPath: '/tmp/selected-device',
    },
  )
  assert.deepEqual(parseCliCommand(['service', 'start']), {
    kind: 'service-start',
  })
  assert.deepEqual(parseCliCommand(['service', 'stop']), {
    kind: 'service-stop',
  })
  assert.deepEqual(parseCliCommand(['device', 'list', '--json']), {
    kind: 'device-list',
    json: true,
  })
  assert.deepEqual(
    parseCliCommand([
      'device',
      'use',
      '--unit-name',
      'custom.service',
      '--device-selection',
      '/tmp/selected-device',
      '--',
      'STACKCHAN-PRIMARY',
    ]),
    {
      kind: 'device-use',
      deviceId: 'STACKCHAN-PRIMARY',
      unitName: 'custom.service',
      deviceSelectionPath: '/tmp/selected-device',
    },
  )
})
