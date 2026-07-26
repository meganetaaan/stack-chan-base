import { describe, expect, it } from 'vitest'
import {
  ExponentialRetryBackoff,
  NonRetryableError,
  retryDisposition,
  type RetryDisposition,
} from '../src/retry-policy.js'

type ErrorCase = {
  name: string
  error: unknown
  expectedWhileActive: RetryDisposition
}

const errorCases: ErrorCase[] = [
  {
    name: 'observed Voice usage-limit message',
    error: new Error('You have reached your usage limit.'),
    expectedWhileActive: 'stop',
  },
  {
    name: 'usage-limit message with transport prefix and whitespace variation',
    error: new Error(' Realtime backend: YOU  HAVE REACHED YOUR USAGE LIMIT. '),
    expectedWhileActive: 'stop',
  },
  {
    name: 'legacy authentication incompatibility',
    error: new Error('realtime conversation requires API key auth'),
    expectedWhileActive: 'stop',
  },
  {
    name: 'non-Error usage-limit payload',
    error: 'You have reached your usage limit.',
    expectedWhileActive: 'stop',
  },
  {
    name: 'typed local configuration failure',
    error: new NonRetryableError('configuration', 'voice is unavailable'),
    expectedWhileActive: 'stop',
  },
  {
    name: 'JSON-RPC method mismatch',
    error: rpcError(-32_601, 'Method not found'),
    expectedWhileActive: 'stop',
  },
  {
    name: 'JSON-RPC invalid parameters',
    error: rpcError(-32_602, 'Invalid params'),
    expectedWhileActive: 'stop',
  },
  {
    name: 'JSON-RPC internal error',
    error: rpcError(-32_603, 'Internal error'),
    expectedWhileActive: 'retry',
  },
  {
    name: 'negated usage-limit sentence',
    error: new Error('You have not reached your usage limit.'),
    expectedWhileActive: 'retry',
  },
  {
    name: 'transient WebSocket reset',
    error: new Error('WebSocket protocol error: connection reset'),
    expectedWhileActive: 'retry',
  },
  {
    name: 'transient USB disconnect',
    error: new Error('CoreS3 USB disconnected'),
    expectedWhileActive: 'retry',
  },
  {
    name: 'malformed null error',
    error: null,
    expectedWhileActive: 'retry',
  },
]

describe('retry disposition finite model', () => {
  it('satisfies StopAfterTerminal and RetryAfterTransient for every bounded error state', () => {
    const counterexamples = findDispositionCounterexamples(retryDisposition)

    expect(counterexamples).toEqual([])
    expect(errorCases.length * 2).toBe(24)
  })

  it('detects the missing-terminal-guard negative control', () => {
    const faultyGuard = (_error: unknown, aborted = false): RetryDisposition =>
      aborted ? 'stop' : 'retry'

    expect(findDispositionCounterexamples(faultyGuard)[0]).toEqual({
      aborted: false,
      actual: 'retry',
      errorCase: 'observed Voice usage-limit message',
      expected: 'stop',
    })
  })
})

describe('retry backoff finite state machine', () => {
  it('matches the independent model for all stable/fast traces through length five', () => {
    const traces = enumerateTraces(5)
    for (const trace of traces) {
      const actual = new ExponentialRetryBackoff()
      const actualDelays = trace.map((duration) => actual.afterFailure(duration))
      expect(actualDelays, JSON.stringify(trace)).toEqual(modelBackoff(trace))
    }

    expect(traces.length).toBe(63)
  })

  it('detects the reset-on-every-connect negative control', () => {
    const trace = [0, 0]
    const faultyDelays = trace.map(() => 500)

    expect(faultyDelays).not.toEqual(modelBackoff(trace))
    expect(modelBackoff(trace)).toEqual([500, 1_000])
  })

  it('resets at the exact stable-session boundary and rejects invalid durations', () => {
    const belowBoundary = new ExponentialRetryBackoff()
    belowBoundary.afterFailure(0)
    belowBoundary.afterFailure(0)
    expect(belowBoundary.afterFailure(29_999)).toBe(2_000)

    const atBoundary = new ExponentialRetryBackoff()
    atBoundary.afterFailure(0)
    atBoundary.afterFailure(0)
    expect(atBoundary.afterFailure(30_000)).toBe(500)

    const backoff = new ExponentialRetryBackoff()
    expect(() => backoff.afterFailure(-1)).toThrow(RangeError)
    expect(() => backoff.afterFailure(Number.NaN)).toThrow(RangeError)
    expect(() => new ExponentialRetryBackoff(0, 30_000)).toThrow(RangeError)
    expect(() => new ExponentialRetryBackoff(1_000, 500)).toThrow(RangeError)
  })
})

function findDispositionCounterexamples(
  classify: (error: unknown, aborted?: boolean) => RetryDisposition,
): Array<{
  aborted: boolean
  actual: RetryDisposition
  errorCase: string
  expected: RetryDisposition
}> {
  const counterexamples = []
  for (const aborted of [false, true]) {
    for (const errorCase of errorCases) {
      const expected = aborted ? 'stop' : errorCase.expectedWhileActive
      const actual = classify(errorCase.error, aborted)
      if (actual !== expected) {
        counterexamples.push({
          aborted,
          actual,
          errorCase: errorCase.name,
          expected,
        })
      }
    }
  }
  return counterexamples
}

function enumerateTraces(maxLength: number): number[][] {
  const traces: number[][] = []
  for (let length = 0; length <= maxLength; length += 1) {
    for (let mask = 0; mask < 2 ** length; mask += 1) {
      traces.push(
        Array.from(
          { length },
          (_, index) => ((mask >> index) & 1) === 0 ? 0 : 30_000,
        ),
      )
    }
  }
  return traces
}

function modelBackoff(attemptDurations: number[]): number[] {
  let next = 500
  return attemptDurations.map((duration) => {
    if (duration >= 30_000) next = 500
    const delay = next
    next = Math.min(30_000, next * 2)
    return delay
  })
}

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), {
    name: 'RpcError',
    code,
  })
}
