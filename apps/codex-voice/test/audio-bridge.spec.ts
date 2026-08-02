import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Deferred } from '../src/async.js'
import { RealtimeAudioBridge, type AudioBridgeLogger } from '../src/audio/bridge.js'
import { decodePcm16Le, encodePcm16Le, pcmChunk } from '../src/audio/pcm.js'
import type { RealtimeAudioSession } from '../src/audio/webrtc.js'
import type { CodexAppServer } from '../src/codex/app-server.js'
import type { PcmChunk, StackChanDevice } from '../src/types.js'

class FakeAppServer extends EventEmitter {
  readonly threadId = 'thread-1'
  readonly rpc = {
    closed: new Promise<Error | undefined>(() => undefined),
  }
}

class FakeRealtimeSession extends EventEmitter implements RealtimeAudioSession {
  readonly closed = new Promise<Error | undefined>(() => undefined)
  closeCalled = false

  async start(): Promise<void> {}

  sendMicrophoneAudio(): void {}

  resetMicrophoneAudio(): void {}

  async close(): Promise<void> {
    this.closeCalled = true
  }
}

class HoldingPlaybackDevice {
  readonly connected = true
  readonly closed = new Promise<Error | undefined>(() => undefined)
  readonly playbackDrained = new Deferred<void>()
  readonly playbackChunks: PcmChunk[] = []
  playbackCount = 0

  async setConversationState(): Promise<void> {}

  async stopMicrophone(): Promise<void> {}

  async *microphone(signal: AbortSignal): AsyncIterable<PcmChunk> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  async playAudio(source: AsyncIterable<PcmChunk>): Promise<void> {
    this.playbackCount += 1
    for await (const chunk of source) this.playbackChunks.push(chunk)
    await this.playbackDrained.promise
  }
}

function recordingLogger() {
  const errors: string[] = []
  const logger: AudioBridgeLogger = {
    info() {},
    warn() {},
    error(message) {
      errors.push(message)
    },
  }
  return { errors, logger }
}

function outputFrame(sample: number): PcmChunk {
  return pcmChunk(encodePcm16Le(new Int16Array(480).fill(sample)), 24_000)
}

function mirroredRtpFrame(sample: number): PcmChunk {
  return pcmChunk(encodePcm16Le(new Int16Array(960).fill(sample)), 48_000)
}

function emitAppServerAudio(appServer: FakeAppServer, chunk: PcmChunk): void {
  appServer.emit('notification', {
    method: 'thread/realtime/outputAudio/delta',
    params: {
      threadId: appServer.threadId,
      audio: {
        data: Buffer.from(chunk.data).toString('base64'),
        sampleRate: chunk.sampleRate,
        numChannels: chunk.channels,
        samplesPerChannel: chunk.data.byteLength / 2,
        itemId: null,
      },
    },
  })
}

function emitAssistantTranscriptDone(appServer: FakeAppServer): void {
  appServer.emit('notification', {
    method: 'thread/realtime/transcript/done',
    params: {
      threadId: appServer.threadId,
      role: 'assistant',
      text: 'done',
    },
  })
}

describe('RealtimeAudioBridge WebRTC output source', () => {
  const controllers: AbortController[] = []
  const devices: HoldingPlaybackDevice[] = []

  afterEach(() => {
    for (const controller of controllers) controller.abort(new Error('test cleanup'))
    for (const device of devices) device.playbackDrained.resolve()
  })

  it('plays remote RTP audio when app-server does not mirror output PCM', async () => {
    const appServer = new FakeAppServer()
    const device = new HoldingPlaybackDevice()
    const session = new FakeRealtimeSession()
    const controller = new AbortController()
    const { logger } = recordingLogger()
    controllers.push(controller)
    devices.push(device)
    const bridge = new RealtimeAudioBridge(
      appServer as unknown as CodexAppServer,
      device as unknown as StackChanDevice,
      undefined,
      logger,
      () => session,
    )
    const running = bridge.run(controller.signal)

    for (let index = 0; index < 12; index += 1) {
      session.emit('audio', mirroredRtpFrame(2_000))
    }

    await waitUntil(() => device.playbackChunks.length >= 12)
    expect(decodePcm16Le(device.playbackChunks[0]!.data)[0]).toBe(2_000)

    controller.abort(new Error('RTP source test finished'))
    device.playbackDrained.resolve()
    await expect(running).rejects.toThrow('RTP source test finished')
  })

  it('does not duplicate app-server PCM mirrored from the RTP media track', async () => {
    const appServer = new FakeAppServer()
    const device = new HoldingPlaybackDevice()
    const session = new FakeRealtimeSession()
    const controller = new AbortController()
    const { logger } = recordingLogger()
    controllers.push(controller)
    devices.push(device)
    const bridge = new RealtimeAudioBridge(
      appServer as unknown as CodexAppServer,
      device as unknown as StackChanDevice,
      undefined,
      logger,
      () => session,
    )
    const running = bridge.run(controller.signal)

    for (let index = 0; index < 12; index += 1) {
      emitAppServerAudio(appServer, outputFrame(1_000))
      session.emit('audio', mirroredRtpFrame(2_000))
    }

    await waitUntil(() => device.playbackChunks.length >= 12)
    expect(decodePcm16Le(device.playbackChunks[0]!.data)[0]).toBe(2_000)

    controller.abort(new Error('source test finished'))
    device.playbackDrained.resolve()
    await expect(running).rejects.toThrow('source test finished')
  })

  it('plays RTP arriving after transcript completion until the media boundary', async () => {
    const appServer = new FakeAppServer()
    const device = new HoldingPlaybackDevice()
    const session = new FakeRealtimeSession()
    const controller = new AbortController()
    const { errors, logger } = recordingLogger()
    controllers.push(controller)
    devices.push(device)
    const bridge = new RealtimeAudioBridge(
      appServer as unknown as CodexAppServer,
      device as unknown as StackChanDevice,
      undefined,
      logger,
      () => session,
    )
    const running = bridge.run(controller.signal)

    for (let index = 0; index < 12; index += 1) {
      emitAppServerAudio(appServer, outputFrame(1_000))
      session.emit('audio', mirroredRtpFrame(2_000))
    }
    await waitUntil(() => device.playbackChunks.length >= 12)

    emitAssistantTranscriptDone(appServer)
    const turn = {
      id: 'turn-1',
      startMilliseconds: 0,
      endMilliseconds: 260,
      transcript: 'done',
    }
    session.emit('audioEndDeclared', turn)
    await new Promise((resolve) => setTimeout(resolve, 550))
    session.emit('audio', mirroredRtpFrame(2_000))
    await waitUntil(() => device.playbackChunks.length >= 13)
    session.emit('audioEnd', turn)

    expect(errors).toEqual([])
    expect(device.playbackChunks).toHaveLength(13)

    controller.abort(new Error('late RTP test finished'))
    device.playbackDrained.resolve()
    await expect(running).rejects.toThrow('late RTP test finished')
  })

  it('does not time out long playout after the RTP boundary is declared', async () => {
    vi.useFakeTimers()
    const appServer = new FakeAppServer()
    const device = new HoldingPlaybackDevice()
    const session = new FakeRealtimeSession()
    const controller = new AbortController()
    const { errors, logger } = recordingLogger()
    controllers.push(controller)
    devices.push(device)
    const bridge = new RealtimeAudioBridge(
      appServer as unknown as CodexAppServer,
      device as unknown as StackChanDevice,
      undefined,
      logger,
      () => session,
    )
    const running = bridge.run(controller.signal)

    try {
      for (let index = 0; index < 12; index += 1) {
        session.emit('audio', mirroredRtpFrame(2_000))
      }
      emitAssistantTranscriptDone(appServer)
      const turn = {
        id: 'turn-long',
        startMilliseconds: 0,
        endMilliseconds: 12_000,
        transcript: 'long response',
      }
      session.emit('audioEndDeclared', turn)

      await vi.advanceTimersByTimeAsync(12_000)
      expect(errors).toEqual([])

      session.emit('audioEnd', turn)
      controller.abort(new Error('long playout test finished'))
      device.playbackDrained.resolve()
      await expect(running).rejects.toThrow('long playout test finished')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails instead of waiting forever when v3 omits the output media boundary', async () => {
    vi.useFakeTimers()
    const appServer = new FakeAppServer()
    const device = new HoldingPlaybackDevice()
    const session = new FakeRealtimeSession()
    const controller = new AbortController()
    const { errors, logger } = recordingLogger()
    controllers.push(controller)
    devices.push(device)
    const bridge = new RealtimeAudioBridge(
      appServer as unknown as CodexAppServer,
      device as unknown as StackChanDevice,
      undefined,
      logger,
      () => session,
    )
    const running = bridge.run(controller.signal)

    try {
      session.emit('audio', mirroredRtpFrame(2_000))
      emitAssistantTranscriptDone(appServer)

      await vi.advanceTimersByTimeAsync(4_999)
      expect(errors).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(errors).toEqual([
        '音声ブリッジエラー: Codex v3 completed the assistant transcript without declaring its RTP media boundary',
      ])

      device.playbackDrained.resolve()
      await expect(running).rejects.toThrow(
        'without declaring its RTP media boundary',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects malformed remote RTP PCM at the session boundary', async () => {
    const appServer = new FakeAppServer()
    const device = new HoldingPlaybackDevice()
    const session = new FakeRealtimeSession()
    const controller = new AbortController()
    const { errors, logger } = recordingLogger()
    controllers.push(controller)
    devices.push(device)
    const bridge = new RealtimeAudioBridge(
      appServer as unknown as CodexAppServer,
      device as unknown as StackChanDevice,
      undefined,
      logger,
      () => session,
    )
    const running = bridge.run(controller.signal)

    session.emit('audio', {
      data: new Uint8Array([0, 0]),
      sampleRate: 48_000,
      channels: 2,
      format: 's16le',
    })
    await waitUntil(() => errors.length > 0)

    expect(errors[0]).toContain('mono')
    await expect(running).rejects.toThrow('mono')
  })

  it('turns an asynchronous conversation status failure into a bridge failure', async () => {
    const appServer = new FakeAppServer()
    const device = new HoldingPlaybackDevice()
    const session = new FakeRealtimeSession()
    const controller = new AbortController()
    const { logger } = recordingLogger()
    controllers.push(controller)
    devices.push(device)
    const bridge = new RealtimeAudioBridge(
      appServer as unknown as CodexAppServer,
      device as unknown as StackChanDevice,
      undefined,
      logger,
      () => session,
      async (state) => {
        if (state === 'listening') {
          throw new Error('STATUS transport failed')
        }
      },
    )
    const running = bridge.run(controller.signal)
    await new Promise<void>((resolve) => setImmediate(resolve))

    appServer.emit('notification', {
      method: 'thread/realtime/itemAdded',
      params: {
        threadId: appServer.threadId,
        item: { type: 'input_audio_buffer.speech_started' },
      },
    })

    await expect(running).rejects.toThrow('STATUS transport failed')
  })
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}
