import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliOptions } from '../src/cli-options.js'

const harness = vi.hoisted(() => ({
  abortController: undefined as AbortController | undefined,
  appServerConnects: 0,
  controllerActivations: 0,
  controllerAttachments: 0,
  controllerCloses: 0,
  controllerOutcomes: [] as Array<
    'app-server-disconnect' | 'usb-disconnect' | 'finish'
  >,
  declineCalls: 0,
  delayCalls: [] as number[],
  suspendCalls: 0,
  usbCloses: 0,
  usbConnects: 0,
  voices: ['alloy'] as string[],
}))

vi.mock('../src/async.js', () => ({
  delay: vi.fn(async (milliseconds: number) => {
    harness.delayCalls.push(milliseconds)
  }),
}))

vi.mock('../src/approval/manager.js', () => ({
  ApprovalManager: class {
    bindDevice(): void {}
    unbindDevice(): void {}
    async declineAll(): Promise<void> {
      harness.declineCalls += 1
    }
    async suspendDeviceViews(): Promise<void> {
      harness.suspendCalls += 1
    }
    async handleServerRequest(): Promise<void> {}
    async handleNotification(): Promise<void> {}
  },
}))

vi.mock('../src/codex/rpc.js', () => ({
  connectCodexDaemon: vi.fn(async () => {
    harness.appServerConnects += 1
    let resolveClosed: ((error: Error | undefined) => void) | undefined
    const connection = {
      isClosed: false,
      closed: new Promise<Error | undefined>((resolve) => {
        resolveClosed = resolve
      }),
      disconnect(error?: Error): void {
        if (this.isClosed) return
        this.isClosed = true
        resolveClosed?.(error)
      },
    }
    return {
      connection,
      socketPath: '/tmp/fake-app-server.sock',
      async close(): Promise<void> {
        connection.disconnect()
      },
    }
  }),
}))

vi.mock('../src/codex/app-server.js', () => ({
  CodexAppServer: class {
    readonly rpc: {
      isClosed: boolean
      closed: Promise<Error | undefined>
      disconnect(error?: Error): void
    }
    readonly threadId = 'thread-test'

    constructor(rpc: {
      isClosed: boolean
      closed: Promise<Error | undefined>
      disconnect(error?: Error): void
    }) {
      this.rpc = rpc
    }

    async initialize(): Promise<{
      userAgent: string
      codexHome: string
      platformFamily: string
      platformOs: string
    }> {
      return {
        userAgent: 'test/0.145.0',
        codexHome: '/tmp/codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      }
    }

    async listRealtimeVoices(): Promise<{
      v1: string[]
      v2: string[]
      defaultV1: string
      defaultV2: string
    }> {
      return {
        v1: harness.voices,
        v2: [],
        defaultV1: harness.voices[0] ?? 'alloy',
        defaultV2: 'verse',
      }
    }

    async openThread(): Promise<string> {
      return this.threadId
    }

    on(): this {
      return this
    }

    off(): this {
      return this
    }
  },
}))

vi.mock('../src/usb/device.js', () => ({
  UsbStackChanDevice: class {
    connected = true
    readonly closed: Promise<Error | undefined>
    #resolveClosed: ((error: Error | undefined) => void) | undefined
    #closed = false

    constructor() {
      this.closed = new Promise<Error | undefined>((resolve) => {
        this.#resolveClosed = resolve
      })
    }

    async connect(): Promise<{
      maxPayload: number
      event: boolean
      statusIcon: boolean
      statusExtended: boolean
    }> {
      harness.usbConnects += 1
      return {
        maxPayload: 4_096,
        event: true,
        statusIcon: true,
        statusExtended: true,
      }
    }

    disconnect(error = new Error('CoreS3 USB disconnected')): void {
      if (this.#closed) return
      this.#closed = true
      this.connected = false
      this.#resolveClosed?.(error)
    }

    async close(): Promise<void> {
      if (!this.#closed) this.disconnect()
      harness.usbCloses += 1
    }
  },
}))

vi.mock('../src/conversation/session-controller.js', () => ({
  ConversationSessionController: class {
    readonly device: {
      disconnect(error?: Error): void
    }

    constructor(device: { disconnect(error?: Error): void }) {
      this.device = device
    }

    async activate(): Promise<void> {
      harness.controllerActivations += 1
    }

    async runWithAppServer(
      appServer: {
        rpc: {
          disconnect(error?: Error): void
        }
      },
    ): Promise<void> {
      harness.controllerAttachments += 1
      const outcome = harness.controllerOutcomes.shift() ?? 'finish'
      if (outcome === 'app-server-disconnect') {
        appServer.rpc.disconnect(new Error('codex app-server disconnected'))
        return
      }
      if (outcome === 'usb-disconnect') {
        this.device.disconnect()
        return
      }
      harness.abortController?.abort(new Error('test scenario finished'))
    }

    async close(): Promise<void> {
      harness.controllerCloses += 1
    }
  },
}))

import { runApplication } from '../src/application.js'

const OPTIONS: CliOptions = {
  cwd: '/workspace',
}

describe('application connection supervision', () => {
  beforeEach(() => {
    harness.abortController = new AbortController()
    harness.appServerConnects = 0
    harness.controllerActivations = 0
    harness.controllerAttachments = 0
    harness.controllerCloses = 0
    harness.controllerOutcomes = []
    harness.declineCalls = 0
    harness.delayCalls = []
    harness.suspendCalls = 0
    harness.usbCloses = 0
    harness.usbConnects = 0
    harness.voices = ['alloy']
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('keeps Realtime stopped until an explicit conversation start request', async () => {
    harness.controllerOutcomes = ['finish']

    await runApplication(OPTIONS, harness.abortController!.signal)

    expect(harness.controllerActivations).toBe(0)
    expect(harness.controllerAttachments).toBe(1)
  })

  it('supports explicit compatibility startup without changing the default', async () => {
    harness.controllerOutcomes = ['finish']

    await runApplication(
      { ...OPTIONS, startImmediately: true },
      harness.abortController!.signal,
    )

    expect(harness.controllerActivations).toBe(1)
    expect(harness.controllerAttachments).toBe(1)
  })

  it('stops for a deterministic voice configuration error', async () => {
    harness.voices = ['alloy']

    await expect(
      runApplication(
        { ...OPTIONS, voice: 'missing-voice' },
        harness.abortController!.signal,
      ),
    ).rejects.toThrow('Realtime v3 voice "missing-voice"')

    expect(harness.controllerAttachments).toBe(0)
    expect(harness.delayCalls).toEqual([])
    expect(harness.usbCloses).toBe(1)
  })

  it('reconnects app-server without reopening USB', async () => {
    harness.controllerOutcomes = [
      'app-server-disconnect',
      'app-server-disconnect',
      'finish',
    ]

    await runApplication(OPTIONS, harness.abortController!.signal)

    expect(harness.controllerAttachments).toBe(3)
    expect(harness.appServerConnects).toBe(3)
    expect(harness.usbConnects).toBe(1)
    expect(harness.delayCalls).toEqual([500, 1_000])
    expect(harness.suspendCalls).toBe(2)
    expect(harness.declineCalls).toBe(1)
  })

  it('recreates the conversation controller only when USB disconnects', async () => {
    harness.controllerOutcomes = ['usb-disconnect', 'finish']

    await runApplication(OPTIONS, harness.abortController!.signal)

    expect(harness.usbConnects).toBe(2)
    expect(harness.usbCloses).toBe(2)
    expect(harness.controllerCloses).toBe(2)
    expect(harness.delayCalls).toEqual([500])
  })
})
