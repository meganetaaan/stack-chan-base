import assert from 'node:assert/strict'
import test from 'node:test'
import { isAppServerThreadStatus } from '../src/codex/thread-status.js'

test('Codex thread status matches the generated v2 discriminated union', () => {
  for (const status of [
    { type: 'notLoaded' },
    { type: 'idle' },
    { type: 'systemError' },
    { type: 'active', activeFlags: [] },
    { type: 'active', activeFlags: ['waitingOnApproval'] },
    { type: 'active', activeFlags: ['waitingOnUserInput'] },
  ]) {
    assert.equal(isAppServerThreadStatus(status), true)
  }

  for (const status of [
    'idle',
    { type: 'active' },
    { type: 'active', activeFlags: ['unknown'] },
    { type: 'unknown' },
  ]) {
    assert.equal(isAppServerThreadStatus(status), false)
  }
})
