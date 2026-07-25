import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { pcmChunk } from '../src/audio/pcm.js'
import { UsbStackChanDevice } from '../src/usb/device.js'
import {
  encodeStackChanFrame,
  helloPayload,
  STACKCHAN_HOST_CAPABILITIES,
  STACKCHAN_MAX_PAYLOAD_BYTES,
  StackChanControl,
  StackChanFrameParser,
  StackChanFrameType,
  uint32Payload,
} from '../src/usb/protocol.js'

class BootingSerialPort extends EventEmitter {
  isOpen = false
  helloCount = 0
  microphoneStopCount = 0
  speakerEndCount = 0
  speakerAbortCount = 0
  destroyed = false
  flushed = false
  controlLines: { dtr: boolean; rts: boolean } | undefined
  readonly #parser = new StackChanFrameParser()
  readonly #streamMicrophone: boolean
  readonly #acknowledgeMicrophoneStop: boolean
  readonly #streamSpeaker: boolean

  constructor(
    streamMicrophone = false,
    acknowledgeMicrophoneStop = false,
    streamSpeaker = false,
  ) {
    super()
    this.#streamMicrophone = streamMicrophone
    this.#acknowledgeMicrophoneStop = acknowledgeMicrophoneStop
    this.#streamSpeaker = streamSpeaker
  }

  open(callback: (error?: Error | null) => void): void {
    this.isOpen = true
    callback()
  }

  set(
    options: { dtr: boolean; rts: boolean },
    callback: (error?: Error | null) => void,
  ): void {
    this.controlLines = options
    callback()
  }

  write(data: Uint8Array, callback: (error?: Error | null) => void): void {
    for (const frame of this.#parser.push(data)) {
      if (frame.type !== StackChanFrameType.CONTROL) continue
      if (frame.flags === StackChanControl.HELLO) {
        this.helloCount += 1
        if (this.helloCount !== 2) continue
        const response = encodeStackChanFrame({
          type: StackChanFrameType.CONTROL,
          flags: StackChanControl.HELLO_ACK,
          streamId: 0,
          payload: helloPayload(STACKCHAN_MAX_PAYLOAD_BYTES, STACKCHAN_HOST_CAPABILITIES),
        })
        setImmediate(() => this.emit('data', Buffer.from(response)))
        continue
      }
      if (this.#streamMicrophone && frame.flags === StackChanControl.MIC_START) {
        const streamId = frame.streamId ?? 0
        const started = encodeStackChanFrame({
          type: StackChanFrameType.CONTROL,
          flags: StackChanControl.MIC_STARTED,
          streamId,
          sampleRate: 16_000,
        })
        const pcm = encodeStackChanFrame({
          type: StackChanFrameType.MICROPHONE_PCM,
          streamId,
          sequence: 0,
          sampleRate: 16_000,
          payload: new Uint8Array(640),
        })
        setImmediate(() => this.emit('data', Buffer.concat([Buffer.from(started), Buffer.from(pcm)])))
        continue
      }
      if (frame.flags === StackChanControl.MIC_STOP) {
        this.microphoneStopCount += 1
        if (!this.#acknowledgeMicrophoneStop) continue
        const stopped = encodeStackChanFrame({
          type: StackChanFrameType.CONTROL,
          flags: StackChanControl.MIC_STOPPED,
          streamId: frame.streamId ?? 0,
          sampleRate: 16_000,
        })
        setTimeout(() => this.emit('data', Buffer.from(stopped)), 10)
        continue
      }
      if (this.#streamSpeaker && frame.flags === StackChanControl.SPEAKER_START) {
        const credit = encodeStackChanFrame({
          type: StackChanFrameType.CONTROL,
          flags: StackChanControl.SPEAKER_CREDIT,
          streamId: frame.streamId ?? 0,
          payload: uint32Payload(8 * 1024),
        })
        setImmediate(() => this.emit('data', Buffer.from(credit)))
        continue
      }
      if (frame.flags === StackChanControl.SPEAKER_END) {
        this.speakerEndCount += 1
        continue
      }
      if (frame.flags === StackChanControl.SPEAKER_ABORT) {
        this.speakerAbortCount += 1
      }
    }
    callback()
  }

  drain(callback: (error?: Error | null) => void): void {
    callback()
  }

  flush(callback: (error?: Error | null) => void): void {
    this.flushed = true
    callback()
  }

  close(callback: (error?: Error | null) => void): void {
    this.isOpen = false
    callback()
    this.emit('close')
  }

  destroy(): void {
    this.destroyed = true
  }
}

test('USB handshake clears reset lines and retries HELLO while CoreS3 boots', async () => {
  const port = new BootingSerialPort()
  const device = new UsbStackChanDevice({
    portPath: '/dev/fake-stackchan',
    portFactory: () => port,
    openSettleMilliseconds: 0,
  })
  const capabilities = await device.connect(new AbortController().signal)

  assert.deepEqual(port.controlLines, { dtr: false, rts: false })
  assert.equal(port.helloCount, 2)
  assert.equal(capabilities.event, true)
  assert.equal(capabilities.maxPayload, STACKCHAN_MAX_PAYLOAD_BYTES)
  await device.close()
  assert.equal(port.flushed, true)
  assert.equal(port.destroyed, true)
})

test('USB speaker abort does not wait for SPEAKER_DONE timeout', async () => {
  const port = new BootingSerialPort(false, false, true)
  const device = new UsbStackChanDevice({
    portPath: '/dev/fake-stackchan',
    portFactory: () => port,
    openSettleMilliseconds: 0,
  })
  await device.connect(new AbortController().signal)
  const controller = new AbortController()
  const source = (async function* () {
    yield pcmChunk(new Uint8Array(3_840), 24_000)
  })()
  const playback = device.playAudio(source, controller.signal)
  await waitUntil(() => port.speakerEndCount === 1)

  const started = Date.now()
  controller.abort(new Error('test speaker shutdown'))
  await assert.rejects(playback, /test speaker shutdown/)
  assert.ok(Date.now() - started < 1_000)
  assert.equal(port.speakerAbortCount, 1)
  await device.close()
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

test('USB close releases the serial port when MIC_STOP is not acknowledged', async () => {
  const port = new BootingSerialPort(true)
  const device = new UsbStackChanDevice({
    portPath: '/dev/fake-stackchan',
    portFactory: () => port,
    openSettleMilliseconds: 0,
    controlTimeoutMilliseconds: 20,
  })
  await device.connect(new AbortController().signal)
  const microphone = device.microphone(new AbortController().signal)[Symbol.asyncIterator]()
  const first = await microphone.next()

  assert.equal(first.done, false)
  assert.equal(first.value?.data.byteLength, 640)
  await device.close()
  await microphone.return?.()

  assert.equal(port.isOpen, false)
  assert.equal(port.flushed, true)
  assert.equal(port.destroyed, true)
})

test('USB abort and close share the pending MIC_STOP task', async () => {
  const port = new BootingSerialPort(true, true)
  const device = new UsbStackChanDevice({
    portPath: '/dev/fake-stackchan',
    portFactory: () => port,
    openSettleMilliseconds: 0,
    controlTimeoutMilliseconds: 100,
  })
  await device.connect(new AbortController().signal)
  const controller = new AbortController()
  const microphone = device.microphone(controller.signal)[Symbol.asyncIterator]()
  const first = await microphone.next()

  assert.equal(first.done, false)
  controller.abort()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await device.close()
  await microphone.return?.()

  assert.equal(port.microphoneStopCount, 1)
  assert.equal(port.isOpen, false)
  assert.equal(port.flushed, true)
  assert.equal(port.destroyed, true)
})
