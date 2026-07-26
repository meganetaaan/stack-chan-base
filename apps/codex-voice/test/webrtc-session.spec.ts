import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodePcm16Le, encodePcm16Le } from '../src/audio/pcm.js'

const require = createRequire(import.meta.url)
const { OpusEncoder } = require('@discordjs/opus') as {
  OpusEncoder: new (sampleRate: number, channels: number) => {
    encode(buffer: Buffer): Buffer
  }
}

const mockWebRtc = vi.hoisted(() => ({
  peer: undefined as
    | {
        connectionState: 'connected' | 'disconnected' | 'failed' | 'closed'
        dataChannel: { setState(state: 'open' | 'closed'): void }
        setConnectionState(state: 'connected' | 'disconnected' | 'failed' | 'closed'): void
      }
    | undefined,
  remoteTrack: undefined as
    | {
        emitRtp(payload: Buffer): void
      }
    | undefined,
}))

vi.mock('werift', () => {
  class Signal<Arguments extends unknown[]> {
    readonly #listeners = new Set<(...args: Arguments) => void>()

    subscribe(listener: (...args: Arguments) => void) {
      this.#listeners.add(listener)
      return {
        unSubscribe: () => this.#listeners.delete(listener),
      }
    }

    emit(...args: Arguments): void {
      for (const listener of this.#listeners) listener(...args)
    }
  }

  class FakeDataChannel {
    readonly stateChanged = new Signal<['open' | 'closed']>()
    readonly onMessage = new Signal<[string | Buffer]>()
    readonly error = new Signal<[Error]>()

    setState(state: 'open' | 'closed'): void {
      this.stateChanged.emit(state)
    }

    close(): void {
      this.setState('closed')
    }
  }

  class FakeMediaStreamTrack {
    readonly kind: string
    readonly onReceiveRtp = new Signal<[{ payload: Buffer }]>()
    codec: { mimeType: string } | undefined

    constructor(options: { kind: string }) {
      this.kind = options.kind
    }

    writeRtp(): void {}

    stop(): void {}

    emitRtp(payload: Buffer): void {
      this.onReceiveRtp.emit({ payload })
    }
  }

  class FakePeerConnection {
    readonly connectionStateChange =
      new Signal<['connected' | 'disconnected' | 'failed' | 'closed']>()
    readonly onTrack = new Signal<[FakeMediaStreamTrack]>()
    readonly dataChannel = new FakeDataChannel()
    connectionState: 'connected' | 'disconnected' | 'failed' | 'closed' = 'disconnected'
    localDescription: { type: 'offer'; sdp: string } | undefined

    constructor() {
      mockWebRtc.peer = this
    }

    createDataChannel(): FakeDataChannel {
      return this.dataChannel
    }

    addTrack(): void {}

    async createOffer() {
      return { type: 'offer' as const, sdp: 'v=0\r\n' }
    }

    async setLocalDescription(description: { type: 'offer'; sdp: string }): Promise<void> {
      this.localDescription = description
    }

    async setRemoteDescription(): Promise<void> {
      this.setConnectionState('connected')
      this.dataChannel.setState('open')
      this.dataChannel.onMessage.emit(JSON.stringify({ type: 'session.started' }))
      const remoteTrack = new FakeMediaStreamTrack({ kind: 'audio' })
      remoteTrack.codec = { mimeType: 'audio/opus' }
      mockWebRtc.remoteTrack = remoteTrack
      this.onTrack.emit(remoteTrack)
    }

    setConnectionState(
      state: 'connected' | 'disconnected' | 'failed' | 'closed',
    ): void {
      this.connectionState = state
      this.connectionStateChange.emit(state)
    }

    async close(): Promise<void> {
      this.setConnectionState('closed')
    }
  }

  class FakeRtpHeader {
    constructor(initial: Record<string, unknown>) {
      Object.assign(this, initial)
    }
  }

  class FakeRtpPacket {
    constructor(
      readonly header: FakeRtpHeader,
      readonly payload: Buffer,
    ) {}
  }

  return {
    MediaStreamTrack: FakeMediaStreamTrack,
    RTCPeerConnection: FakePeerConnection,
    RtpHeader: FakeRtpHeader,
    RtpPacket: FakeRtpPacket,
    useOPUS: (options: unknown) => options,
  }
})

import { RealtimeWebRtcSession } from '../src/audio/webrtc.js'
import type { CodexAppServer } from '../src/codex/app-server.js'

describe('RealtimeWebRtcSession transport liveness', () => {
  const sessions: RealtimeWebRtcSession[] = []

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()))
    mockWebRtc.peer = undefined
    mockWebRtc.remoteTrack = undefined
  })

  it('decodes remote Opus RTP and emits PCM audio', async () => {
    const appServer = {
      startRealtime: vi.fn(async () => 'v=0\r\n'),
      stopRealtime: vi.fn(async () => undefined),
    } as unknown as CodexAppServer
    const session = new RealtimeWebRtcSession(appServer)
    sessions.push(session)
    const received = new Promise<import('../src/types.js').PcmChunk>((resolve) => {
      session.on('audio', resolve)
    })
    await session.start()
    const encoder = new OpusEncoder(48_000, 1)
    const samples = Int16Array.from({ length: 960 }, (_, index) =>
      Math.round(Math.sin(index / 8) * 4_000),
    )

    mockWebRtc.remoteTrack!.emitRtp(
      encoder.encode(Buffer.from(encodePcm16Le(samples))),
    )

    const chunk = await received
    expect(chunk.sampleRate).toBe(48_000)
    expect(chunk.channels).toBe(1)
    expect(Math.max(...decodePcm16Le(chunk.data).map(Math.abs))).toBeGreaterThan(100)
  })

  it('does not end an established media session on data-channel close alone', async () => {
    const appServer = {
      startRealtime: vi.fn(async () => 'v=0\r\n'),
      stopRealtime: vi.fn(async () => undefined),
    } as unknown as CodexAppServer
    const session = new RealtimeWebRtcSession(appServer)
    sessions.push(session)
    await session.start()

    let closed: Error | undefined | 'pending' = 'pending'
    void session.closed.then((error) => {
      closed = error
    })

    mockWebRtc.peer!.dataChannel.setState('closed')
    await Promise.resolve()

    expect(closed).toBe('pending')

    mockWebRtc.peer!.setConnectionState('failed')
    await expect(session.closed).resolves.toMatchObject({
      message: 'WebRTC peer connection failed',
    })
  })

  it('allows a transient peer disconnect but fails when it lasts five seconds', async () => {
    vi.useFakeTimers()
    const appServer = {
      startRealtime: vi.fn(async () => 'v=0\r\n'),
      stopRealtime: vi.fn(async () => undefined),
    } as unknown as CodexAppServer
    const session = new RealtimeWebRtcSession(appServer)
    sessions.push(session)

    try {
      await session.start()
      let closed: Error | undefined | 'pending' = 'pending'
      void session.closed.then((error) => {
        closed = error
      })

      mockWebRtc.peer!.setConnectionState('disconnected')
      await vi.advanceTimersByTimeAsync(4_999)
      expect(closed).toBe('pending')

      mockWebRtc.peer!.setConnectionState('connected')
      await vi.advanceTimersByTimeAsync(1)
      expect(closed).toBe('pending')

      mockWebRtc.peer!.setConnectionState('disconnected')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(closed).toMatchObject({
        message: 'WebRTC peer connection remained disconnected for 5000 ms',
      })
    } finally {
      if (mockWebRtc.peer?.connectionState !== 'failed') {
        mockWebRtc.peer?.setConnectionState('failed')
      }
      await session.close()
      vi.useRealTimers()
    }
  })
})
