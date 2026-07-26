import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { RealtimeAudioBridge, type AudioBridgeLogger } from '../src/audio/bridge.js'
import type { RealtimeAudioSession } from '../src/audio/webrtc.js'
import type { CodexAppServer } from '../src/codex/app-server.js'
import type { PcmChunk, StackChanDevice } from '../src/types.js'
import { encodePcm16Le, pcmChunk } from '../src/audio/pcm.js'

class FakeAppServer extends EventEmitter {
  readonly threadId = 'thread-1'
  readonly rpc = {
    closed: new Promise<Error | undefined>(() => undefined),
  }
}

class FakeDevice {
  readonly connected = true
  readonly closed = new Promise<Error | undefined>(() => undefined)

  async setConversationState(): Promise<void> {}

  async stopMicrophone(): Promise<void> {}

  async *microphone(signal: AbortSignal): AsyncIterable<PcmChunk> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  async playAudio(_source: AsyncIterable<PcmChunk>, _signal: AbortSignal): Promise<void> {}
}

class RecordingDevice extends FakeDevice {
  playbackStarted = false
  playbackChunks: PcmChunk[] = []

  override async playAudio(source: AsyncIterable<PcmChunk>, _signal: AbortSignal): Promise<void> {
    this.playbackStarted = true
    for await (const chunk of source) this.playbackChunks.push(chunk)
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

class SlowRealtimeSession extends FakeRealtimeSession {
  override async start(): Promise<void> {
    await new Promise<void>(() => undefined)
  }
}

const quietLogger: AudioBridgeLogger = {
  info() {},
  warn() {},
  error() {},
}

for (const testCase of [
  {
    name: 'non-positive sample rate',
    audio: { data: new Uint8Array([0, 0]), sampleRate: 0, channels: 1, format: 's16le' },
    expected: /invalid sample rate/,
  },
  {
    name: 'non-mono audio',
    audio: { data: new Uint8Array([0, 0]), sampleRate: 48_000, channels: 2, format: 's16le' },
    expected: /mono/,
  },
  {
    name: 'partial PCM16 sample',
    audio: { data: new Uint8Array([0]), sampleRate: 48_000, channels: 1, format: 's16le' },
    expected: /incomplete PCM16 sample/,
  },
] as const) {
  test(`audio bridge rejects ${testCase.name} without throwing from the WebRTC emitter`, async () => {
    const appServer = new FakeAppServer()
    const device = new FakeDevice()
    const session = new FakeRealtimeSession()
    const bridge = new RealtimeAudioBridge(
      appServer as unknown as CodexAppServer,
      device as unknown as StackChanDevice,
      undefined,
      quietLogger,
      () => session,
    )

    const running = bridge.run(new AbortController().signal)
    assert.doesNotThrow(() => {
      session.emit('audio', testCase.audio)
    })
    await assert.rejects(running, testCase.expected)
  })
}

test('audio bridge prebuffers WebRTC output and drains received audio after a terminal error', async () => {
  const appServer = new FakeAppServer()
  const device = new RecordingDevice()
  const session = new FakeRealtimeSession()
  const bridge = new RealtimeAudioBridge(
    appServer as unknown as CodexAppServer,
    device as unknown as StackChanDevice,
    undefined,
    quietLogger,
    () => session,
  )
  const running = bridge.run(new AbortController().signal)
  const frame = pcmChunk(encodePcm16Le(new Int16Array(960).fill(1_000)), 48_000)

  for (let index = 0; index < 11; index += 1) session.emit('audio', frame)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(device.playbackStarted, false)

  session.emit('audio', frame)
  await waitUntil(() => device.playbackStarted)
  appServer.emit('notification', {
    method: 'thread/realtime/error',
    params: {
      threadId: appServer.threadId,
      message: 'usage limit',
    },
  })

  await assert.rejects(running, /usage limit/)
  assert.equal(device.playbackChunks.length, 12)
})

test('audio bridge ignores idle WebRTC frames containing only silence', async () => {
  const appServer = new FakeAppServer()
  const device = new RecordingDevice()
  const session = new FakeRealtimeSession()
  const bridge = new RealtimeAudioBridge(
    appServer as unknown as CodexAppServer,
    device as unknown as StackChanDevice,
    undefined,
    quietLogger,
    () => session,
  )
  const controller = new AbortController()
  const running = bridge.run(controller.signal)
  const silence = pcmChunk(new Uint8Array(960 * 2), 48_000)

  for (let index = 0; index < 20; index += 1) session.emit('audio', silence)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(device.playbackStarted, false)

  controller.abort(new Error('silence test finished'))
  await assert.rejects(running, /silence test finished/)
})

test('audio bridge aborts cleanly while WebRTC startup is still pending', async () => {
  const appServer = new FakeAppServer()
  const device = new FakeDevice()
  const session = new SlowRealtimeSession()
  const bridge = new RealtimeAudioBridge(
    appServer as unknown as CodexAppServer,
    device as unknown as StackChanDevice,
    undefined,
    quietLogger,
    () => session,
  )
  const controller = new AbortController()
  const running = bridge.run(controller.signal)
  controller.abort(new Error('test shutdown'))

  await assert.rejects(running, /test shutdown/)
  assert.equal(session.closeCalled, true)
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}
