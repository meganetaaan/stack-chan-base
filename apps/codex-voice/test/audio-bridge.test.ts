import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  isAudiblePcm16,
  RealtimeAudioBridge,
  type AudioBridgeLogger,
} from '../src/audio/bridge.js'
import type { PcmAudioTransform } from '../src/audio/voice-effect.js'
import type { RealtimeAudioSession } from '../src/audio/webrtc.js'
import type { CodexAppServer } from '../src/codex/app-server.js'
import type { PcmChunk, StackChanDevice } from '../src/types.js'
import {
  decodePcm16Le,
  encodePcm16Le,
  pcmChunk,
} from '../src/audio/pcm.js'
import { NonRetryableError } from '../src/retry-policy.js'

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

test('audio activity detection ignores low-level decoder noise', () => {
  assert.equal(
    isAudiblePcm16(encodePcm16Le(new Int16Array(960).fill(64))),
    false,
  )
  assert.equal(
    isAudiblePcm16(encodePcm16Le(new Int16Array(960).fill(256))),
    true,
  )
})

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

test('audio bridge drains the voice effect tail before ending speaker playback', async () => {
  const appServer = new FakeAppServer()
  const device = new RecordingDevice()
  const session = new FakeRealtimeSession()
  let sourceClosed = false
  const transform: PcmAudioTransform = async function* (source) {
    for await (const _chunk of source) {
      yield pcmChunk(
        encodePcm16Le(new Int16Array(480).fill(2_000)),
        24_000,
      )
    }
    sourceClosed = true
    yield pcmChunk(
      encodePcm16Le(new Int16Array(480).fill(7_000)),
      24_000,
    )
  }
  const bridge = new RealtimeAudioBridge(
    appServer as unknown as CodexAppServer,
    device as unknown as StackChanDevice,
    undefined,
    quietLogger,
    () => session,
    undefined,
    undefined,
    { transform },
  )
  const controller = new AbortController()
  const running = bridge.run(controller.signal)
  const frame = pcmChunk(
    encodePcm16Le(new Int16Array(960).fill(1_000)),
    48_000,
  )

  for (let index = 0; index < 12; index += 1) session.emit('audio', frame)
  session.emit('audioEnd', {
    id: 'turn-1',
    startMilliseconds: 0,
    endMilliseconds: 240,
    transcript: 'done',
  })

  await waitUntil(() => sourceClosed && device.playbackChunks.length === 13)
  assert.equal(
    decodePcm16Le(device.playbackChunks.at(-1)!.data)[0],
    7_000,
  )

  controller.abort(new Error('voice effect tail test finished'))
  await assert.rejects(running, /voice effect tail test finished/)
})

test('audio bridge never falls back to raw audio after a voice effect failure', async () => {
  const appServer = new FakeAppServer()
  const device = new RecordingDevice()
  const session = new FakeRealtimeSession()
  const transform: PcmAudioTransform = async function* (source) {
    for await (const _chunk of source) {
      yield pcmChunk(
        encodePcm16Le(new Int16Array(480).fill(2_222)),
        24_000,
      )
      throw new NonRetryableError(
        'configuration',
        'synthetic voice effect failure',
      )
    }
  }
  const bridge = new RealtimeAudioBridge(
    appServer as unknown as CodexAppServer,
    device as unknown as StackChanDevice,
    undefined,
    quietLogger,
    () => session,
    undefined,
    undefined,
    { transform },
  )
  const running = bridge.run(new AbortController().signal)
  session.emit(
    'audio',
    pcmChunk(
      encodePcm16Le(new Int16Array(960).fill(1_111)),
      48_000,
    ),
  )

  await assert.rejects(running, /synthetic voice effect failure/)
  assert.equal(device.playbackChunks.length, 1)
  assert.equal(decodePcm16Le(device.playbackChunks[0]!.data)[0], 2_222)
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}
