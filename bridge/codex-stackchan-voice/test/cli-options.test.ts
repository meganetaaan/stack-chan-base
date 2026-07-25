import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCliOptions } from '../src/cli-options.js'

test('CLI defaults to a new thread in the current directory', () => {
  const parsed = parseCliOptions([])
  assert.equal(parsed.kind, 'run')
  if (parsed.kind !== 'run') return
  assert.equal(parsed.options.cwd, process.cwd())
  assert.equal(parsed.options.threadId, undefined)
})

test('CLI accepts explicit thread, port, voice, socket, and immediate startup', () => {
  const parsed = parseCliOptions([
    '--cwd',
    '/tmp/project',
    '--thread',
    'thread-1',
    '--port',
    '/dev/ttyACM0',
    '--voice',
    'marin',
    '--socket',
    '/tmp/codex.sock',
    '--start-immediately',
  ])
  assert.deepEqual(parsed, {
    kind: 'run',
    options: {
      cwd: '/tmp/project',
      threadId: 'thread-1',
      portPath: '/dev/ttyACM0',
      voice: 'marin',
      socketPath: '/tmp/codex.sock',
      startImmediately: true,
    },
  })
})

test('CLI accepts a stable USB device ID', () => {
  const parsed = parseCliOptions(['--device-id', 'STACKCHAN-CORE-S3'])
  assert.equal(parsed.kind, 'run')
  if (parsed.kind !== 'run') return
  assert.equal(parsed.options.deviceId, 'STACKCHAN-CORE-S3')
  assert.equal(parsed.options.portPath, undefined)
})

test('CLI rejects ambiguous simultaneous port and device ID selectors', () => {
  assert.throws(
    () =>
      parseCliOptions([
        '--port',
        '/dev/ttyACM0',
        '--device-id',
        'STACKCHAN-CORE-S3',
      ]),
    /mutually exclusive/,
  )
})
