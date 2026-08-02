import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodePcm16Le } from '../src/audio/pcm.js'

const mockWebRtc = vi.hoisted(() => ({
  peer: undefined as
    | {
        connectionState: 'connected' | 'disconnected' | 'failed' | 'closed'
        dataChannel: {
          setState(state: 'open' | 'closed'): void
          emitMessage(event: Record<string, unknown>): void
        }
        setConnectionState(state: 'connected' | 'disconnected' | 'failed' | 'closed'): void
      }
    | undefined,
  remoteTrack: undefined as
    | {
        emitRtp(payload: Buffer): void
        skipSequence(packets: number): void
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

    emitMessage(event: Record<string, unknown>): void {
      this.onMessage.emit(JSON.stringify(event))
    }

    close(): void {
      this.setState('closed')
    }
  }

  class FakeMediaStreamTrack {
    readonly kind: string
    readonly onReceiveRtp = new Signal<[
      {
        header: { sequenceNumber: number; timestamp: number; ssrc: number }
        payload: Buffer
      },
    ]>()
    codec: { mimeType: string } | undefined
    #sequenceNumber = 0
    #timestamp = 0

    constructor(options: { kind: string }) {
      this.kind = options.kind
    }

    writeRtp(): void {}

    stop(): void {}

    emitRtp(payload: Buffer): void {
      this.onReceiveRtp.emit({
        header: {
          sequenceNumber: this.#sequenceNumber,
          timestamp: this.#timestamp,
          ssrc: 1,
        },
        payload,
      })
      this.#sequenceNumber = (this.#sequenceNumber + 1) & 0xffff
      this.#timestamp = (this.#timestamp + 960) >>> 0
    }

    skipSequence(packets: number): void {
      this.#sequenceNumber = (this.#sequenceNumber + packets) & 0xffff
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

import {
  RealtimeWebRtcSession,
  createWebRtcOpusEncoder,
  REMOTE_AUDIO_PLAYOUT_DELAY_MS,
  REMOTE_AUDIO_WARNING_INTERVAL_MS,
  WEBRTC_AUDIO_FRAME_MILLISECONDS,
} from '../src/audio/webrtc.js'
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
    const session = new RealtimeWebRtcSession(appServer, {
      voice: 'juniper',
      prompt: '日本語で話してください。',
    })
    sessions.push(session)
    const received = new Promise<import('../src/types.js').PcmChunk>((resolve) => {
      session.on('audio', resolve)
    })
    await session.start()
    expect(appServer.startRealtime).toHaveBeenCalledWith({
      sdp: 'v=0\r\n',
      voice: 'juniper',
      prompt: '日本語で話してください。',
    })
    const encoder = await createWebRtcOpusEncoder()
    try {
      const samples = Int16Array.from({ length: 960 }, (_, index) =>
        Math.round(Math.sin(index / 8) * 4_000),
      )

      mockWebRtc.remoteTrack!.emitRtp(
        Buffer.from(encoder.encode(samples)),
      )

      const chunk = await received
      expect(chunk.sampleRate).toBe(48_000)
      expect(chunk.channels).toBe(1)
      expect(Math.max(...decodePcm16Le(chunk.data).map(Math.abs))).toBeGreaterThan(100)
    } finally {
      encoder.free()
    }
  })

  it('aggregates sustained packet-loss diagnostics into one warning per interval', async () => {
    vi.useFakeTimers()
    const appServer = {
      startRealtime: vi.fn(async () => 'v=0\r\n'),
      stopRealtime: vi.fn(async () => undefined),
    } as unknown as CodexAppServer
    const session = new RealtimeWebRtcSession(appServer)
    sessions.push(session)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let encoder: Awaited<ReturnType<typeof createWebRtcOpusEncoder>> | undefined

    try {
      await session.start()
      encoder = await createWebRtcOpusEncoder()
      const encoded = Buffer.from(encoder.encode(
        Int16Array.from({ length: 960 }, (_, index) =>
          Math.round(Math.sin(index / 8) * 4_000),
        ),
      ))
      mockWebRtc.remoteTrack!.emitRtp(encoded)
      for (let index = 0; index < 10; index += 1) {
        mockWebRtc.remoteTrack!.skipSequence(1)
        mockWebRtc.remoteTrack!.emitRtp(encoded)
      }

      await vi.advanceTimersByTimeAsync(
        REMOTE_AUDIO_PLAYOUT_DELAY_MS + WEBRTC_AUDIO_FRAME_MILLISECONDS * 10,
      )
      expect(warn).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(REMOTE_AUDIO_WARNING_INTERVAL_MS)

      expect(warn).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledWith(
        'WebRTC remote audio diagnostics: 10 lost packet(s)',
      )
    } finally {
      encoder?.free()
      await session.close()
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('emits audioEnd only after RTP playout reaches turn.done end_ms', async () => {
    vi.useFakeTimers()
    const appServer = {
      startRealtime: vi.fn(async () => 'v=0\r\n'),
      stopRealtime: vi.fn(async () => undefined),
    } as unknown as CodexAppServer
    const session = new RealtimeWebRtcSession(appServer)
    sessions.push(session)
    let encoder: Awaited<ReturnType<typeof createWebRtcOpusEncoder>> | undefined

    try {
      await session.start()
      const audioEndDeclared = vi.fn()
      const audioEnd = vi.fn()
      session.on('audioEndDeclared', audioEndDeclared)
      session.on('audioEnd', audioEnd)
      mockWebRtc.peer!.dataChannel.emitMessage({
        type: 'turn.created',
        turn: { id: 'assistant-1', role: 'assistant', start_ms: 0 },
      })

      encoder = await createWebRtcOpusEncoder()
      const encoded = Buffer.from(encoder.encode(
        Int16Array.from({ length: 960 }, (_, index) =>
          Math.round(Math.sin(index / 8) * 4_000),
        ),
      ))
      mockWebRtc.peer!.dataChannel.emitMessage({
        type: 'turn.done',
        turn: {
          id: 'assistant-1',
          role: 'assistant',
          start_ms: 0,
          end_ms: 40,
          transcript: 'テストです',
        },
      })
      expect(audioEndDeclared).toHaveBeenCalledOnce()
      expect(audioEndDeclared).toHaveBeenCalledWith({
        id: 'assistant-1',
        startMilliseconds: 0,
        endMilliseconds: 40,
        transcript: 'テストです',
      })
      expect(audioEnd).not.toHaveBeenCalled()
      mockWebRtc.remoteTrack!.emitRtp(encoded)
      mockWebRtc.remoteTrack!.emitRtp(encoded)

      await vi.advanceTimersByTimeAsync(
        REMOTE_AUDIO_PLAYOUT_DELAY_MS + WEBRTC_AUDIO_FRAME_MILLISECONDS - 1,
      )
      expect(audioEnd).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(audioEnd).toHaveBeenCalledOnce()
      expect(audioEnd).toHaveBeenCalledWith({
        id: 'assistant-1',
        startMilliseconds: 0,
        endMilliseconds: 40,
        transcript: 'テストです',
      })
    } finally {
      encoder?.free()
      await session.close()
      vi.useRealTimers()
    }
  })

  it('keeps a declared boundary alive while the RTP media clock advances', async () => {
    vi.useFakeTimers()
    const appServer = {
      startRealtime: vi.fn(async () => 'v=0\r\n'),
      stopRealtime: vi.fn(async () => undefined),
    } as unknown as CodexAppServer
    const session = new RealtimeWebRtcSession(appServer)
    sessions.push(session)
    let encoder: Awaited<ReturnType<typeof createWebRtcOpusEncoder>> | undefined

    try {
      await session.start()
      const audioEnd = vi.fn()
      session.on('audioEnd', audioEnd)
      let closed: Error | undefined | 'pending' = 'pending'
      void session.closed.then((error) => {
        closed = error
      })
      mockWebRtc.peer!.dataChannel.emitMessage({
        type: 'turn.created',
        turn: { id: 'assistant-long', role: 'assistant', start_ms: 0 },
      })
      mockWebRtc.peer!.dataChannel.emitMessage({
        type: 'turn.done',
        turn: {
          id: 'assistant-long',
          role: 'assistant',
          start_ms: 0,
          end_ms: 6_000,
          transcript: '長い応答です',
        },
      })

      encoder = await createWebRtcOpusEncoder()
      const encoded = Buffer.from(encoder.encode(
        Int16Array.from({ length: 960 }, (_, index) =>
          Math.round(Math.sin(index / 8) * 4_000),
        ),
      ))
      for (let index = 0; index < 300; index += 1) {
        mockWebRtc.remoteTrack!.emitRtp(encoded)
      }

      await vi.advanceTimersByTimeAsync(6_200)
      expect(audioEnd).toHaveBeenCalledOnce()
      expect(closed).toBe('pending')
    } finally {
      encoder?.free()
      await session.close()
      vi.useRealTimers()
    }
  })

  it('fails when a declared boundary receives no RTP media progress', async () => {
    vi.useFakeTimers()
    const appServer = {
      startRealtime: vi.fn(async () => 'v=0\r\n'),
      stopRealtime: vi.fn(async () => undefined),
    } as unknown as CodexAppServer
    const session = new RealtimeWebRtcSession(appServer)
    sessions.push(session)

    try {
      await session.start()
      mockWebRtc.peer!.dataChannel.emitMessage({
        type: 'turn.created',
        turn: { id: 'assistant-stalled', role: 'assistant', start_ms: 0 },
      })
      mockWebRtc.peer!.dataChannel.emitMessage({
        type: 'turn.done',
        turn: {
          id: 'assistant-stalled',
          role: 'assistant',
          start_ms: 0,
          end_ms: 40,
          transcript: 'stalled',
        },
      })

      await vi.advanceTimersByTimeAsync(4_999)
      let settled = false
      void session.closed.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(session.closed).resolves.toMatchObject({
        message: 'WebRTC assistant RTP media clock stalled before turn=assistant-stalled end_ms=40',
      })
    } finally {
      await session.close()
      vi.useRealTimers()
    }
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
