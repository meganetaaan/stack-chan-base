import assert from 'node:assert/strict'
import test from 'node:test'
import {
  approvalRequestEvent,
  parseStackChanApplicationEvent,
  STACKCHAN_EVENT_SCHEMA,
  truncateUtf8,
} from '../src/usb/events.js'

test('approval request event round-trips through JSON', () => {
  const event = approvalRequestEvent({
    id: 'request-1',
    kind: 'command',
    title: 'コマンド実行',
    summary: 'npm test',
    detail: '/workspace',
    truncated: false,
  })
  assert.deepEqual(parseStackChanApplicationEvent(JSON.stringify(event)), event)
})

test('raw Realtime events are ignored by Stack-chan event parser', () => {
  assert.equal(parseStackChanApplicationEvent('{"type":"session.created"}'), undefined)
  assert.equal(
    parseStackChanApplicationEvent(JSON.stringify({ schema: STACKCHAN_EVENT_SCHEMA, type: 'unknown', requestId: '1' })),
    undefined,
  )
})

test('UTF-8 truncation never splits a multibyte character', () => {
  const result = truncateUtf8('あいうえお', 7)
  assert.equal(result.value, 'あい')
  assert.equal(result.truncated, true)
})
