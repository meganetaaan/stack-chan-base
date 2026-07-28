import assert from 'node:assert/strict'
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
