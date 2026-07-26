import assert from 'node:assert/strict'
import test from 'node:test'
import {
  approvalRequestEvent,
  conversationResultEvent,
  parseStackChanApplicationEvent,
  STACKCHAN_EVENT_SCHEMA,
  truncateUtf8,
} from '../src/usb/events.js'
import { loadContractFixture } from './contract-fixtures.js'

type ApplicationEventVector = {
  name: string
  codexParserAccepted: boolean
  value: Record<string, unknown>
}

type ApplicationEventFixture = {
  schema: string
  applicationSchema: string
  vectors: ApplicationEventVector[]
}

const applicationEventFixture =
  loadContractFixture<ApplicationEventFixture>('application-event-vectors.json')

test('shared application event vectors match the Codex parser', () => {
  assert.equal(applicationEventFixture.schema, 'stackchan.application-event.vectors.v1')
  assert.equal(applicationEventFixture.applicationSchema, STACKCHAN_EVENT_SCHEMA)
  for (const vector of applicationEventFixture.vectors) {
    assert.equal(
      parseStackChanApplicationEvent(JSON.stringify(vector.value)) !== undefined,
      vector.codexParserAccepted,
      vector.name,
    )
  }
})

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

test('explicit conversation start and stop requests round-trip without toggle semantics', () => {
  const start = {
    schema: STACKCHAN_EVENT_SCHEMA,
    type: 'conversation.start',
    requestId: 'touch-1',
    source: 'headTouch',
    gesture: 'forwardSwipe',
  } as const
  const stop = {
    schema: STACKCHAN_EVENT_SCHEMA,
    type: 'conversation.stop',
    requestId: 'touch-2',
    source: 'headTouch',
    gesture: 'backwardSwipe',
  } as const

  assert.deepEqual(parseStackChanApplicationEvent(JSON.stringify(start)), start)
  assert.deepEqual(parseStackChanApplicationEvent(JSON.stringify(stop)), stop)
  assert.equal(
    parseStackChanApplicationEvent(JSON.stringify({ ...start, gesture: 'backwardSwipe' })),
    undefined,
  )
})

test('conversation result validates state and optional error', () => {
  const accepted = conversationResultEvent('touch-1', true, 'connecting')
  const rejected = conversationResultEvent('touch-2', false, 'blocked', 'Voice usage limit')

  assert.deepEqual(parseStackChanApplicationEvent(JSON.stringify(accepted)), accepted)
  assert.deepEqual(parseStackChanApplicationEvent(JSON.stringify(rejected)), rejected)
  assert.equal(
    parseStackChanApplicationEvent(JSON.stringify({ ...accepted, state: 'unknown' })),
    undefined,
  )
})

test('UTF-8 truncation never splits a multibyte character', () => {
  const result = truncateUtf8('あいうえお', 7)
  assert.equal(result.value, 'あい')
  assert.equal(result.truncated, true)
})
