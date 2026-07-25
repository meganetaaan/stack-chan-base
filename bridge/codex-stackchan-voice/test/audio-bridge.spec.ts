import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
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

describe('RealtimeAudioBridge ordered output source', () => {
  const controllers: AbortController[] = []
  const devices: HoldingPlaybackDevice[] = []

  afterEach(() => {
    for (const controller of controllers) controller.abort(new Error('test cleanup'))
    for (const device of devices) device.playbackDrained.resolve()
  })

  it('plays ordered app-server audio instead of the mirrored RTP media track', async () => {
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
    expect(decodePcm16Le(device.playbackChunks[0]!.data)[0]).toBe(1_000)

    controller.abort(new Error('source test finished'))
    device.playbackDrained.resolve()
    await expect(running).rejects.toThrow('source test finished')
  })

  it('does not fail when delayed mirrored RTP arrives after transcript completion', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 550))
    session.emit('audio', mirroredRtpFrame(2_000))

    expect(errors).toEqual([])

    controller.abort(new Error('late RTP test finished'))
    device.playbackDrained.resolve()
    await expect(running).rejects.toThrow('late RTP test finished')
  })

  it('rejects malformed app-server PCM metadata at the trust boundary', async () => {
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

    appServer.emit('notification', {
      method: 'thread/realtime/outputAudio/delta',
      params: {
        threadId: appServer.threadId,
        audio: {
          data: 'AA==',
          sampleRate: 24_000,
          numChannels: 2,
          samplesPerChannel: 1,
          itemId: null,
        },
      },
    })
    await waitUntil(() => errors.length > 0)

    expect(errors[0]).toContain('mono')
    await expect(running).rejects.toThrow('mono')
  })
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}
