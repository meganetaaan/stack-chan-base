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

test('CLI accepts explicit thread, port, voice, and socket', () => {
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
  ])
  assert.deepEqual(parsed, {
    kind: 'run',
    options: {
      cwd: '/tmp/project',
      threadId: 'thread-1',
      portPath: '/dev/ttyACM0',
      voice: 'marin',
      socketPath: '/tmp/codex.sock',
    },
  })
})
