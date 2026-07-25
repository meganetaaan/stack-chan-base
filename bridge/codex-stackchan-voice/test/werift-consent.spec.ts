import { createRequire, syncBuiltinESMExports } from 'node:module'
import timersPromises from 'node:timers/promises'

import {
  CONSENT_FAILURES,
  Candidate,
  CandidatePair,
  Connection,
  classes,
} from 'werift'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const realPromiseTimeout = timersPromises.setTimeout
const require = createRequire(import.meta.url)

type StunTransaction = {
  responseReceived(message: { messageClass: number }, address: [string, number]): void
  run(): Promise<unknown>
}

const { Transaction } = require(
  `${process.cwd()}/node_modules/werift/lib/ice/src/stun/transaction.js`,
) as {
  Transaction: new (
    request: unknown,
    address: [string, number],
    protocol: { sendStun(): Promise<void> },
    retransmissions: number,
  ) => StunTransaction
}

const fakeablePromiseTimeout = (
    delay: number,
    value?: unknown,
    options?: { signal?: AbortSignal },
  ) =>
  new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => resolve(value), delay)
    options?.signal?.addEventListener(
      'abort',
      () => {
        globalThis.clearTimeout(timer)
        reject(new DOMException('The operation was aborted', 'AbortError'))
      },
      { once: true },
    )
  })

type ConsentConnection = {
  remoteUsername: string
  remotePassword: string
  remoteIsLite: boolean
  nominated?: CandidatePair
  state: Connection['state']
  queryConsent(): void
  close(): Promise<void>
}

function candidate(host: string, port: number, ufrag?: string): Candidate {
  return new Candidate(
    'foundation',
    1,
    'udp',
    2_130_706_431,
    host,
    port,
    'host',
    undefined,
    undefined,
    undefined,
    0,
    ufrag,
  )
}

function consentHarness(
  outcomes: Array<'success' | 'timeout'>,
  responseDelayMilliseconds = 0,
) {
  const requestTimes: number[] = []
  const request = vi.fn(async (_message: { attributesKeys: string[] }) => {
    requestTimes.push(Date.now())
    const outcome = outcomes.shift()
    if (responseDelayMilliseconds > 0) {
      await timersPromises.setTimeout(responseDelayMilliseconds)
    }
    if (outcome === 'timeout') {
      throw new Error('simulated STUN timeout')
    }
    return [undefined, ['192.0.2.2', 5000]] as const
  })
  const localCandidate = candidate('192.0.2.1', 4000, 'local')
  const remoteCandidate = candidate('192.0.2.2', 5000, 'remote')
  const protocol = {
    type: 'udp',
    localCandidate,
    request,
    close: vi.fn(async () => undefined),
  }
  const nominated = new CandidatePair(
    protocol as unknown as ConstructorParameters<typeof CandidatePair>[0],
    remoteCandidate,
    true,
  )
  const connection = new Connection(true) as unknown as ConsentConnection
  connection.remoteUsername = 'remote'
  connection.remotePassword = 'remote-password'
  connection.remoteIsLite = true
  connection.nominated = nominated
  connection.state = 'connected'
  connection.queryConsent()

  return { connection, nominated, request, requestTimes }
}

describe('werift ICE consent freshness regression', () => {
  const connections: ConsentConnection[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    timersPromises.setTimeout =
      fakeablePromiseTimeout as typeof timersPromises.setTimeout
    syncBuiltinESMExports()
  })

  afterEach(async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.close()))
    timersPromises.setTimeout = realPromiseTimeout
    syncBuiltinESMExports()
    vi.useRealTimers()
  })

  it('continues checking after one lost response and accepts a later response', async () => {
    const harness = consentHarness(['timeout', 'success'])
    connections.push(harness.connection)

    await vi.advanceTimersByTimeAsync(10_000)

    expect(harness.request).toHaveBeenCalledTimes(2)
    expect(harness.nominated.consentRequestsSent).toBe(2)
    expect(harness.connection.state).toBe('connected')
  })

  it('keeps nominating the selected pair when checking an ICE-lite peer', async () => {
    const harness = consentHarness(['success'])
    connections.push(harness.connection)

    await vi.advanceTimersByTimeAsync(5_000)

    const request = harness.request.mock.calls[0]?.[0]
    expect(request?.attributesKeys).toContain('USE-CANDIDATE')
  })

  it('waits for a delayed consent response without retransmitting', async () => {
    const sendStun = vi.fn(async () => undefined)
    const transaction = new Transaction(
      {},
      ['192.0.2.2', 5000],
      { sendStun },
      0,
    )
    const result = transaction.run().then(
      () => 'fulfilled',
      () => 'rejected',
    )
    globalThis.setTimeout(() => {
      transaction.responseReceived(
        { messageClass: classes.RESPONSE },
        ['192.0.2.2', 5000],
      )
    }, 200)

    await vi.advanceTimersByTimeAsync(200)

    expect(await result).toBe('fulfilled')
    expect(sendStun).toHaveBeenCalledTimes(1)
  })

  it('does not expire before 30 seconds at the minimum check interval', async () => {
    vi.mocked(Math.random).mockReturnValue(0)
    const harness = consentHarness(Array.from({ length: 10 }, () => 'timeout'))
    connections.push(harness.connection)

    await vi.advanceTimersByTimeAsync(CONSENT_FAILURES * 4_000)
    expect(harness.request).toHaveBeenCalledTimes(CONSENT_FAILURES)
    expect(harness.connection.state).toBe('connected')

    await vi.advanceTimersByTimeAsync(5_999)
    expect(harness.connection.state).toBe('connected')

    await vi.advanceTimersByTimeAsync(1)
    expect(harness.connection.state).toBe('closed')
  })

  it('expires at 30 seconds at the maximum check interval', async () => {
    vi.mocked(Math.random).mockReturnValue(1)
    const harness = consentHarness(Array.from({ length: 10 }, () => 'timeout'))
    connections.push(harness.connection)

    await vi.advanceTimersByTimeAsync(29_999)
    expect(harness.request).toHaveBeenCalledTimes(4)
    expect(harness.connection.state).toBe('connected')

    await vi.advanceTimersByTimeAsync(1)
    expect(harness.connection.state).toBe('closed')
  })

  it('renews the 30 second deadline after a valid response', async () => {
    const harness = consentHarness([
      'timeout',
      'timeout',
      'timeout',
      'timeout',
      'success',
      ...Array.from({ length: 10 }, () => 'timeout' as const),
    ])
    connections.push(harness.connection)

    await vi.advanceTimersByTimeAsync(29_999)
    expect(harness.request).toHaveBeenCalledTimes(5)
    expect(harness.connection.state).toBe('connected')

    await vi.advanceTimersByTimeAsync(25_000)
    expect(harness.connection.state).toBe('connected')

    await vi.advanceTimersByTimeAsync(1)
    expect(harness.connection.state).toBe('closed')
  })

  it('keeps request starts within the selected interval while awaiting responses', async () => {
    vi.mocked(Math.random).mockReturnValue(1)
    const harness = consentHarness(
      Array.from({ length: 10 }, () => 'timeout'),
      1_000,
    )
    connections.push(harness.connection)

    await vi.advanceTimersByTimeAsync(24_000)

    expect(
      harness.requestTimes.map((timestamp) => timestamp - harness.requestTimes[0]!),
    ).toEqual([0, 6_000, 12_000, 18_000])
  })
})
