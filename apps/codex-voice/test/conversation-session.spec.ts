import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Deferred } from '../src/async.js'
import {
  ConversationSessionController,
  type ConversationAudioFactory,
} from '../src/conversation/session-controller.js'
import type {
  ConversationChimeKind,
  ConversationChimePlayer,
} from '../src/audio/conversation-chime.js'
import type { CodexAppServer } from '../src/codex/app-server.js'
import type {
  ConversationRequestEvent,
  ConversationResultEvent,
} from '../src/usb/events.js'
import type {
  ConversationState,
  DeviceCapabilities,
  PcmChunk,
  StackChanDevice,
} from '../src/types.js'

class FakeDevice implements StackChanDevice {
  connected = true
  readonly closedDeferred = new Deferred<Error | undefined>()
  readonly closed = this.closedDeferred.promise
  readonly states: ConversationState[] = []
  readonly results: ConversationResultEvent[] = []
  readonly requestListeners = new Set<(request: ConversationRequestEvent) => void>()
  stateFailures = 0

  async connect(): Promise<DeviceCapabilities> {
    throw new Error('already connected')
  }

  async *microphone(): AsyncIterable<PcmChunk> {}

  async stopMicrophone(): Promise<void> {}

  async playAudio(): Promise<void> {}

  async setConversationState(state: ConversationState): Promise<void> {
    if (this.stateFailures > 0) {
      this.stateFailures -= 1
      throw new Error('transient STATUS write failure')
    }
    this.states.push(state)
  }

  onConversationRequest(listener: (request: ConversationRequestEvent) => void): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  async sendConversationResult(result: ConversationResultEvent): Promise<void> {
    this.results.push(result)
  }

  async requestApproval(): Promise<'approve'> {
    return 'approve'
  }

  async notifyApprovalResolved(): Promise<void> {}

  async notifyApprovalSuspended(): Promise<void> {}

  async close(): Promise<void> {
    this.connected = false
    this.closedDeferred.resolve(undefined)
  }

  emitRequest(request: ConversationRequestEvent): void {
    for (const listener of this.requestListeners) listener(request)
  }
}

class FakeAppServer extends EventEmitter {
  readonly threadId = 'thread-test'
  readonly closedDeferred = new Deferred<Error | undefined>()
  readonly rpc = {
    isClosed: false,
    closed: this.closedDeferred.promise,
  }
}

type AudioRun = {
  deferred: Deferred<void>
  signal?: AbortSignal
}

function request(
  type: 'conversation.start' | 'conversation.stop',
  requestId: string,
): ConversationRequestEvent {
  if (type === 'conversation.start') {
    return {
      schema: 'stackchan.event.v1',
      type,
      requestId,
      source: 'headTouch',
      gesture: 'forwardSwipe',
    }
  }
  return {
    schema: 'stackchan.event.v1',
    type,
    requestId,
    source: 'headTouch',
    gesture: 'backwardSwipe',
  }
}

describe('ConversationSessionController', () => {
  let device: FakeDevice
  let appServer: FakeAppServer
  let runs: AudioRun[]
  let audioFactory: ConversationAudioFactory

  beforeEach(() => {
    device = new FakeDevice()
    appServer = new FakeAppServer()
    runs = []
    audioFactory = vi.fn((_server, _device, _voice, onStateChanged) => {
      const run: AudioRun = {
        deferred: new Deferred<void>(),
      }
      runs.push(run)
      return {
        async run(signal: AbortSignal) {
          run.signal = signal
          await onStateChanged('listening')
          await Promise.race([
            run.deferred.promise,
            new Promise<never>((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason)
              else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            }),
          ])
        },
      }
    })
  })

  it('stays silent in standby until an explicit forward swipe', async () => {
    const controller = new ConversationSessionController(device, undefined, { audioFactory })
    const process = new AbortController()
    const attached = controller.runWithAppServer(
      appServer as unknown as CodexAppServer,
      process.signal,
    )

    await tick()
    expect(runs).toHaveLength(0)
    expect(device.states).toEqual(['idle'])

    device.emitRequest(request('conversation.start', 'touch-1'))
    await waitUntil(() => runs.length === 1 && device.results.length === 1)

    expect(device.results[0]).toMatchObject({
      requestId: 'touch-1',
      success: true,
      state: 'connecting',
    })
    expect(device.states).toContain('connecting')
    expect(device.states).toContain('listening')

    process.abort(new Error('test finished'))
    await expect(attached).resolves.toBeUndefined()
    await controller.close()
  })

  it('uses explicit idempotent start and stop requests without double transitions', async () => {
    const controller = new ConversationSessionController(device, undefined, { audioFactory })
    const process = new AbortController()
    const attached = controller.runWithAppServer(
      appServer as unknown as CodexAppServer,
      process.signal,
    )
    const start = request('conversation.start', 'same-start')

    device.emitRequest(start)
    device.emitRequest(start)
    await waitUntil(() => device.results.length === 2 && runs.length === 1)

    expect(device.results[0]).toEqual(device.results[1])
    expect(runs).toHaveLength(1)

    const stop = request('conversation.stop', 'same-stop')
    device.emitRequest(stop)
    device.emitRequest(stop)
    await waitUntil(() => device.results.length === 4 && runs[0]?.signal?.aborted === true)

    expect(device.results[2]).toEqual(device.results[3])
    expect(device.results[2]).toMatchObject({ state: 'standby', success: true })
    expect(device.states.at(-1)).toBe('idle')

    process.abort(new Error('test finished'))
    await expect(attached).resolves.toBeUndefined()
    await controller.close()
  })

  it('finishes the start chime before opening realtime audio', async () => {
    const events: string[] = []
    const startChime = new Deferred<void>()
    const feedback: ConversationChimePlayer = {
      async play(kind) {
        events.push(`${kind}-chime-started`)
        await startChime.promise
        events.push(`${kind}-chime-finished`)
      },
    }
    audioFactory = vi.fn(() => ({
      async run(signal: AbortSignal) {
        events.push('realtime-started')
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    }))
    const controller = new ConversationSessionController(device, undefined, {
      audioFactory,
      feedback,
    })
    const process = new AbortController()
    const attached = controller.runWithAppServer(
      appServer as unknown as CodexAppServer,
      process.signal,
    )

    device.emitRequest(request('conversation.start', 'start-with-chime'))
    await waitUntil(() => events.includes('start-chime-started'))
    expect(events).toEqual(['start-chime-started'])

    startChime.resolve()
    await waitUntil(() => events.includes('realtime-started'))
    expect(events).toEqual([
      'start-chime-started',
      'start-chime-finished',
      'realtime-started',
    ])

    process.abort(new Error('test finished'))
    await expect(attached).resolves.toBeUndefined()
    await controller.close()
  })

  it('plays one stop chime only after realtime audio has released the speaker', async () => {
    const events: string[] = []
    const feedback: ConversationChimePlayer = {
      async play(kind: ConversationChimeKind) {
        events.push(`${kind}-chime`)
      },
    }
    audioFactory = vi.fn(() => ({
      async run(signal: AbortSignal) {
        events.push('realtime-started')
        try {
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        } finally {
          events.push('realtime-released')
        }
      },
    }))
    const controller = new ConversationSessionController(device, undefined, {
      audioFactory,
      feedback,
    })
    const process = new AbortController()
    const attached = controller.runWithAppServer(
      appServer as unknown as CodexAppServer,
      process.signal,
    )

    device.emitRequest(request('conversation.start', 'start-before-stop-chime'))
    await waitUntil(() => events.includes('realtime-started'))
    const stop = request('conversation.stop', 'same-stop-chime')
    device.emitRequest(stop)
    device.emitRequest(stop)
    await waitUntil(() => device.results.length === 3)

    expect(events).toEqual([
      'start-chime',
      'realtime-started',
      'realtime-released',
      'stop-chime',
    ])

    process.abort(new Error('test finished'))
    await expect(attached).resolves.toBeUndefined()
    await controller.close()
  })

  it('lets a backward swipe cancel an unfinished start chime', async () => {
    const events: string[] = []
    const feedback: ConversationChimePlayer = {
      async play(kind, signal) {
        events.push(`${kind}-chime-started`)
        if (kind === 'stop') return
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason)
          else {
            signal.addEventListener(
              'abort',
              () => {
                events.push('start-chime-aborted')
                reject(signal.reason)
              },
              { once: true },
            )
          }
        })
      },
    }
    const controller = new ConversationSessionController(device, undefined, {
      audioFactory,
      feedback,
    })
    const process = new AbortController()
    const attached = controller.runWithAppServer(
      appServer as unknown as CodexAppServer,
      process.signal,
    )

    device.emitRequest(request('conversation.start', 'cancelled-start'))
    await waitUntil(() => events.includes('start-chime-started'))
    device.emitRequest(request('conversation.stop', 'superseding-stop'))
    await waitUntil(
      () =>
        device.results.some(
          (result) => result.requestId === 'superseding-stop',
        ),
    )

    expect(events).toEqual([
      'start-chime-started',
      'start-chime-aborted',
      'stop-chime-started',
    ])
    expect(runs).toHaveLength(0)
    expect(controller.desired).toBe(false)
    expect(controller.state).toBe('standby')

    process.abort(new Error('test finished'))
    await expect(attached).resolves.toBeUndefined()
    await controller.close()
  })

  it('ignores stale audio state after stop and starts at most one realtime session', async () => {
    let staleState:
      | ((state: 'listening' | 'recognizing' | 'speaking') => Promise<void>)
      | undefined
    audioFactory = vi.fn((_server, _device, _voice, onStateChanged) => {
      staleState = onStateChanged
      const run: AudioRun = { deferred: new Deferred<void>() }
      runs.push(run)
      return {
        async run(signal: AbortSignal) {
          run.signal = signal
          await onStateChanged('listening')
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        },
      }
    })
    const controller = new ConversationSessionController(device, undefined, { audioFactory })
    const process = new AbortController()
    const attached = controller.runWithAppServer(
      appServer as unknown as CodexAppServer,
      process.signal,
    )

    device.emitRequest(request('conversation.start', 'start-1'))
    await waitUntil(() => runs.length === 1)
    device.emitRequest(request('conversation.stop', 'stop-1'))
    await waitUntil(
      () =>
        runs[0]?.signal?.aborted === true &&
        device.results.some((result) => result.requestId === 'stop-1'),
    )
    await staleState?.('speaking')

    expect(device.states.at(-1)).toBe('idle')

    device.emitRequest(request('conversation.start', 'start-2'))
    await waitUntil(() => runs.length === 2)
    expect(runs.filter((run) => !run.signal?.aborted)).toHaveLength(1)

    process.abort(new Error('test finished'))
    await expect(attached).resolves.toBeUndefined()
    await controller.close()
  })

  it('latches a usage limit without reconnecting until the next forward swipe', async () => {
    audioFactory = vi.fn((_server, _device, _voice, onStateChanged) => {
      const index = runs.length
      const run: AudioRun = { deferred: new Deferred<void>() }
      runs.push(run)
      return {
        async run(signal: AbortSignal) {
          await onStateChanged('listening')
          if (index === 0) throw new Error('You have reached your usage limit.')
          await Promise.race([
            run.deferred.promise,
            new Promise<never>((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason)
              else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            }),
          ])
        },
      }
    })
    const controller = new ConversationSessionController(device, undefined, { audioFactory })
    const process = new AbortController()
    const attached = controller.runWithAppServer(
      appServer as unknown as CodexAppServer,
      process.signal,
    )

    device.emitRequest(request('conversation.start', 'start-1'))
    await waitUntil(() => controller.state === 'blocked')
    await tick()

    expect(runs).toHaveLength(1)
    expect(device.states.at(-1)).toBe('error')

    device.emitRequest(request('conversation.start', 'start-2'))
    await waitUntil(() => runs.length === 2)
    expect(controller.state).toBe('listening')

    process.abort(new Error('test finished'))
    await expect(attached).resolves.toBeUndefined()
    await controller.close()
  })

  it('preserves desired start across app-server replacement but clears it on close', async () => {
    const controller = new ConversationSessionController(device, undefined, { audioFactory })
    const firstProcess = new AbortController()
    const firstAttach = controller.runWithAppServer(
      appServer as unknown as CodexAppServer,
      firstProcess.signal,
    )

    device.emitRequest(request('conversation.start', 'start-1'))
    await waitUntil(() => runs.length === 1)
    appServer.rpc.isClosed = true
    appServer.closedDeferred.resolve(new Error('app-server disconnected'))
    await expect(firstAttach).resolves.toBeUndefined()
    expect(controller.desired).toBe(true)
    expect(controller.state).toBe('connecting')

    appServer = new FakeAppServer()
    const secondProcess = new AbortController()
    const secondAttach = controller.runWithAppServer(
      appServer as unknown as CodexAppServer,
      secondProcess.signal,
    )
    await waitUntil(() => runs.length === 2)

    await controller.close()
    expect(controller.desired).toBe(false)
    expect(device.states.at(-1)).toBe('idle')
    secondProcess.abort(new Error('test finished'))
    await expect(secondAttach).resolves.toBeUndefined()
  })

  it('reapplies a request after a transient status write failure', async () => {
    const controller = new ConversationSessionController(device, undefined, {
      audioFactory,
    })
    await tick()
    device.stateFailures = 1
    const start = request('conversation.start', 'retry-start')

    await expect(controller.handleRequest(start)).rejects.toThrow(
      'transient STATUS write failure',
    )
    await expect(controller.handleRequest(start)).resolves.toMatchObject({
      requestId: 'retry-start',
      success: true,
      state: 'connecting',
    })

    expect(device.states.filter((state) => state === 'connecting')).toHaveLength(
      1,
    )
    await controller.close()
  })

  it('preserves start/stop idempotency for every operation sequence through length four', async () => {
    const operations = [
      'start',
      'stop',
      'repeat',
      'block',
    ] as const
    let checkedSequences = 0

    for (const sequence of enumerateSequences(operations, 4)) {
      const sequenceDevice = new FakeDevice()
      const controller = new ConversationSessionController(sequenceDevice, undefined, {
        audioFactory,
      })
      await tick()
      let nextRequest = 0
      let expectedState:
        | 'standby'
        | 'connecting'
        | 'blocked' = 'standby'
      let expectedDesired = false
      let lastRequest: ConversationRequestEvent | undefined
      let lastResult: ConversationResultEvent | undefined

      for (const operation of sequence) {
        if (operation === 'block') {
          await controller.block(new Error('modelled terminal failure'))
          expectedState = 'blocked'
          expectedDesired = false
        } else if (operation === 'repeat') {
          if (lastRequest && lastResult) {
            expect(await controller.handleRequest(lastRequest)).toEqual(lastResult)
          }
        } else {
          nextRequest += 1
          lastRequest = request(
            operation === 'start' ? 'conversation.start' : 'conversation.stop',
            `sequence-${nextRequest}`,
          )
          lastResult = await controller.handleRequest(lastRequest)
          expectedState = operation === 'start' ? 'connecting' : 'standby'
          expectedDesired = operation === 'start'
        }

        expect(controller.state, sequence.join(',')).toBe(expectedState)
        expect(controller.desired, sequence.join(',')).toBe(expectedDesired)
      }
      await controller.close()
      checkedSequences += 1
    }

    expect(checkedSequences).toBe(341)
  })

  it('finite enumeration detects a toggle-on-duplicate negative control', () => {
    const counterexample = enumerateSequences(
      ['start', 'stop', 'repeat'] as const,
      3,
    ).find((sequence) => {
      let expected = false
      let broken = false
      let last: 'start' | 'stop' | undefined
      for (const operation of sequence) {
        if (operation === 'start' || operation === 'stop') {
          last = operation
          expected = operation === 'start'
          broken = expected
        } else if (last) {
          broken = !broken
        }
      }
      return expected !== broken
    })

    expect(counterexample).toEqual(['start', 'repeat'])
  })
})

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

function enumerateSequences<const T extends readonly string[]>(
  alphabet: T,
  maximumLength: number,
): Array<Array<T[number]>> {
  const sequences: Array<Array<T[number]>> = [[]]
  let frontier: Array<Array<T[number]>> = [[]]
  for (let length = 1; length <= maximumLength; length += 1) {
    frontier = frontier.flatMap((prefix) =>
      alphabet.map((operation) => [...prefix, operation]),
    )
    sequences.push(...frontier)
  }
  return sequences
}
