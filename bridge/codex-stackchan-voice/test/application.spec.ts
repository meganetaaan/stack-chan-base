import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliOptions } from '../src/cli-options.js'

const harness = vi.hoisted(() => ({
  abortController: undefined as AbortController | undefined,
  audioErrors: [] as Error[],
  audioRuns: 0,
  abortOnDelay: false,
  appServerFailures: 0,
  declineCalls: 0,
  delayCalls: [] as number[],
  deviceFailures: 0,
  suspendCalls: 0,
  usbCloses: 0,
  usbConnects: 0,
  voices: ['alloy'] as string[],
}))

vi.mock('../src/async.js', () => ({
  delay: vi.fn(async (milliseconds: number) => {
    harness.delayCalls.push(milliseconds)
    if (harness.abortOnDelay) {
      harness.abortController?.abort(new Error('test retry cutoff'))
    }
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
    const connection = {
      isClosed: false,
      closed: new Promise<Error | undefined>(() => undefined),
    }
    return {
      connection,
      socketPath: '/tmp/fake-app-server.sock',
      async close(): Promise<void> {
        connection.isClosed = true
      },
    }
  }),
}))

vi.mock('../src/codex/app-server.js', () => ({
  CodexAppServer: class {
    readonly rpc: {
      isClosed: boolean
      closed: Promise<Error | undefined>
    }
    readonly threadId = 'thread-test'

    constructor(rpc: { isClosed: boolean; closed: Promise<Error | undefined> }) {
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
    readonly closed = new Promise<Error | undefined>(() => undefined)

    async connect(): Promise<{
      maxPayload: number
      event: boolean
      statusIcon: boolean
    }> {
      harness.usbConnects += 1
      return { maxPayload: 4_096, event: true, statusIcon: true }
    }

    async close(): Promise<void> {
      harness.usbCloses += 1
      this.connected = false
    }
  },
}))

vi.mock('../src/audio/bridge.js', () => ({
  RealtimeAudioBridge: class {
    readonly appServer: {
      rpc: {
        isClosed: boolean
      }
    }
    readonly device: {
      connected: boolean
    }

    constructor(
      appServer: { rpc: { isClosed: boolean } },
      device: { connected: boolean },
    ) {
      this.appServer = appServer
      this.device = device
    }

    async run(): Promise<void> {
      harness.audioRuns += 1
      if (harness.appServerFailures > 0) {
        harness.appServerFailures -= 1
        this.appServer.rpc.isClosed = true
        throw new Error('codex app-server disconnected')
      }
      if (harness.deviceFailures > 0) {
        harness.deviceFailures -= 1
        this.device.connected = false
        throw new Error('CoreS3 USB disconnected')
      }
      const error = harness.audioErrors.shift()
      if (error) throw error
      harness.abortController?.abort(new Error('test scenario finished'))
      throw harness.abortController?.signal.reason
    }
  },
}))

import { runApplication } from '../src/application.js'

const OPTIONS: CliOptions = {
  cwd: '/workspace',
}

describe('application retry supervision', () => {
  beforeEach(() => {
    harness.abortController = new AbortController()
    harness.audioErrors = []
    harness.audioRuns = 0
    harness.abortOnDelay = false
    harness.appServerFailures = 0
    harness.declineCalls = 0
    harness.delayCalls = []
    harness.deviceFailures = 0
    harness.suspendCalls = 0
    harness.usbCloses = 0
    harness.usbConnects = 0
    harness.voices = ['alloy']
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('stops instead of reconnecting when app-server reports the Voice usage limit', async () => {
    harness.audioErrors = [new Error('You have reached your usage limit.')]
    harness.abortOnDelay = true

    await expect(
      runApplication(OPTIONS, harness.abortController!.signal),
    ).rejects.toThrow('You have reached your usage limit.')
    expect(harness.audioRuns).toBe(1)
    expect(harness.delayCalls).toEqual([])
    expect(harness.declineCalls).toBe(1)
    expect(harness.suspendCalls).toBe(0)
  })

  it('stops instead of reconnecting for a deterministic voice configuration error', async () => {
    harness.voices = ['alloy']
    harness.abortOnDelay = true

    await expect(
      runApplication(
        { ...OPTIONS, voice: 'missing-voice' },
        harness.abortController!.signal,
      ),
    ).rejects.toThrow('Realtime v3 voice "missing-voice"')
    expect(harness.audioRuns).toBe(0)
    expect(harness.delayCalls).toEqual([])
  })

  it('restarts only Realtime with backoff across fast sideband failures', async () => {
    harness.audioErrors = [
      new Error('WebSocket protocol error: connection reset'),
      new Error('WebSocket protocol error: connection reset'),
    ]

    await runApplication(OPTIONS, harness.abortController!.signal)

    expect(harness.audioRuns).toBe(3)
    expect(harness.delayCalls).toEqual([500, 1_000])
    expect(harness.usbConnects).toBe(1)
    expect(harness.usbCloses).toBe(1)
  })

  it('increases app-server backoff across repeated fast post-initialization disconnects', async () => {
    harness.appServerFailures = 2

    await runApplication(OPTIONS, harness.abortController!.signal)

    expect(harness.audioRuns).toBe(3)
    expect(harness.delayCalls).toEqual([500, 1_000])
  })

  it('reconnects USB only when the device itself disconnects', async () => {
    harness.deviceFailures = 1

    await runApplication(OPTIONS, harness.abortController!.signal)

    expect(harness.audioRuns).toBe(2)
    expect(harness.delayCalls).toEqual([500])
    expect(harness.usbConnects).toBe(2)
    expect(harness.usbCloses).toBe(2)
  })
})
