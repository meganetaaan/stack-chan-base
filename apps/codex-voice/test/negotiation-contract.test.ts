import assert from 'node:assert/strict'
import test from 'node:test'
import {
  helloPayload,
  StackChanCapability,
  STACKCHAN_HOST_CAPABILITIES,
} from '../src/usb/protocol.js'
import { loadContractFixture } from './contract-fixtures.js'

type HelloPayloadVector = {
  name: string
  maxPayload: number
  capabilities: number
  payloadHex: string
}

type EventNegotiationVector = {
  dockAdvertisesEvent: boolean
  firmwareAdvertisesEvent: boolean
  expected: {
    dockMaySendEvent: boolean
    firmwareMaySendEvent: boolean
    conversationControlAvailable: boolean
  }
}

type ExtendedStatusVector = {
  firmwareAdvertisesStatusExtended: boolean
  expectedDockMaySendExtendedStatus: boolean
}

type NegotiationFixture = {
  schema: string
  protocolVersion: number
  capabilityBits: {
    event: number
    statusExtended: number
  }
  helloPayloads: HelloPayloadVector[]
  eventNegotiation: EventNegotiationVector[]
  extendedStatusNegotiation: ExtendedStatusVector[]
}

const fixture = loadContractFixture<NegotiationFixture>('negotiation-vectors.json')

test('shared negotiation fixture matches the Codex capability layout and HELLO encoding', () => {
  assert.equal(fixture.schema, 'stackchan.usb-cdc.negotiation-vectors.v1')
  assert.equal(fixture.protocolVersion, 2)
  assert.equal(fixture.capabilityBits.event, StackChanCapability.EVENT)
  assert.equal(fixture.capabilityBits.statusExtended, StackChanCapability.STATUS_EXTENDED)
  for (const vector of fixture.helloPayloads) {
    assert.equal(
      Buffer.from(helloPayload(vector.maxPayload, vector.capabilities)).toString('hex'),
      vector.payloadHex,
      vector.name,
    )
    if (vector.name === 'codex-dock-host') {
      assert.equal(vector.capabilities, STACKCHAN_HOST_CAPABILITIES)
      assert.equal(Buffer.from(helloPayload()).toString('hex'), vector.payloadHex)
    }
  }
})

test('shared negotiation fixture exhausts all bidirectional EVENT outcomes', () => {
  assert.deepEqual(
    new Set(fixture.eventNegotiation.map((vector) =>
      `${vector.dockAdvertisesEvent}:${vector.firmwareAdvertisesEvent}`)),
    new Set(['false:false', 'false:true', 'true:false', 'true:true']),
  )
  for (const vector of fixture.eventNegotiation) {
    assert.equal(vector.firmwareAdvertisesEvent, vector.expected.dockMaySendEvent)
    assert.equal(vector.dockAdvertisesEvent, vector.expected.firmwareMaySendEvent)
    assert.equal(
      vector.dockAdvertisesEvent && vector.firmwareAdvertisesEvent,
      vector.expected.conversationControlAvailable,
    )
  }
  assert.ok(fixture.eventNegotiation.some((vector) =>
    (vector.dockAdvertisesEvent || vector.firmwareAdvertisesEvent) !==
      vector.expected.conversationControlAvailable))
})

test('shared negotiation fixture covers both extended status outcomes', () => {
  assert.deepEqual(
    new Set(fixture.extendedStatusNegotiation.map((vector) =>
      vector.firmwareAdvertisesStatusExtended)),
    new Set([false, true]),
  )
  for (const vector of fixture.extendedStatusNegotiation) {
    assert.equal(
      vector.firmwareAdvertisesStatusExtended,
      vector.expectedDockMaySendExtendedStatus,
    )
  }
})
