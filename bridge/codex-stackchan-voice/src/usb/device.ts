import { SerialPort } from 'serialport'
import { AsyncQueue, Deferred, abortError, delay, throwIfAborted } from '../async.js'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ConversationState,
  DeviceCapabilities,
  PcmChunk,
  StackChanDevice,
} from '../types.js'
import {
  approvalRequestEvent,
  parseStackChanApplicationEvent,
  STACKCHAN_EVENT_SCHEMA,
  type ApprovalResolvedEvent,
  type ApprovalSuspendedEvent,
} from './events.js'
import {
  encodeStackChanFrame,
  helloPayload,
  parseHelloPayload,
  parseUint32Payload,
  StackChanCapability,
  StackChanControl,
  StackChanEventDecoder,
  StackChanEventEncoder,
  type StackChanFrame,
  StackChanFrameParser,
  StackChanFrameType,
  STACKCHAN_HEADER_BYTES,
  STACKCHAN_CRC_BYTES,
  STACKCHAN_MAX_PAYLOAD_BYTES,
  STACKCHAN_REQUIRED_CAPABILITIES,
  STACKCHAN_HOST_CAPABILITIES,
  uint32Payload,
} from './protocol.js'

const CORES3_USB_VENDOR_ID = '303a'
const CORES3_USB_PRODUCT_ID = '1001'
const MICROPHONE_SAMPLE_RATE = 16_000
const MICROPHONE_FRAME_BYTES = 640
const MAX_MICROPHONE_GAP_FRAMES = 10
const MAX_MICROPHONE_QUEUE_FRAMES = 50
const SPEAKER_FRAME_BYTES_24KHZ = 3_840
const MAX_UNUSED_SPEAKER_CREDIT = 8 * 1024
const CONTROL_TIMEOUT_MS = 5_000
const HELLO_TIMEOUT_MS = 8_000
const HELLO_RETRY_MS = 500
const USB_OPEN_SETTLE_MS = 3_000
const CREDIT_TIMEOUT_MS = 15_000
const EVENT_RETRY_MS = 2_000

type SerialPortLike = {
  readonly isOpen: boolean
  on(event: 'data', listener: (data: Buffer) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: () => void): unknown
  open(callback: (error?: Error | null) => void): void
  set?(options: { dtr: boolean; rts: boolean }, callback: (error?: Error | null) => void): void
  write(data: Uint8Array, callback: (error?: Error | null) => void): void
  flush?(callback: (error?: Error | null) => void): void
  close(callback: (error?: Error | null) => void): void
  destroy?(): void
}

type FrameWaiter = {
  predicate: (frame: StackChanFrame) => boolean
  deferred: Deferred<StackChanFrame>
  timer: NodeJS.Timeout
}

type MicrophoneSession = {
  streamId: number
  expectedSequence: number
  queue: AsyncQueue<PcmChunk>
  stopping: boolean
  stopTask?: Promise<void>
  failed: boolean
}

type SpeakerSession = {
  streamId: number
  credit: number
  sequence: number
  creditWaiters: Set<Deferred<void>>
}

type PendingApproval = {
  response: Deferred<ApprovalDecision>
  presented: boolean
  retryTimer: NodeJS.Timeout
}

export type UsbStackChanDeviceOptions = {
  portPath?: string
  portFactory?: (path: string) => SerialPortLike
  openSettleMilliseconds?: number
  controlTimeoutMilliseconds?: number
}

export class UsbStackChanDevice implements StackChanDevice {
  readonly closed: Promise<Error | undefined>
  readonly #options: UsbStackChanDeviceOptions
  readonly #closedDeferred = new Deferred<Error | undefined>()
  readonly #parser = new StackChanFrameParser()
  readonly #eventEncoder = new StackChanEventEncoder()
  readonly #eventDecoder = new StackChanEventDecoder()
  readonly #waiters = new Set<FrameWaiter>()
  readonly #pendingApprovals = new Map<string, PendingApproval>()
  #port: SerialPortLike | undefined
  #connected = false
  #closing = false
  #nextStreamId = 0
  #maxPayload = STACKCHAN_MAX_PAYLOAD_BYTES
  #peerCapabilities = 0
  #microphone: MicrophoneSession | undefined
  #speaker: SpeakerSession | undefined

  constructor(options: UsbStackChanDeviceOptions = {}) {
    if (
      options.openSettleMilliseconds !== undefined &&
      (!Number.isFinite(options.openSettleMilliseconds) || options.openSettleMilliseconds < 0)
    ) {
      throw new RangeError('USB open settle time must be a non-negative finite number')
    }
    if (
      options.controlTimeoutMilliseconds !== undefined &&
      (!Number.isFinite(options.controlTimeoutMilliseconds) || options.controlTimeoutMilliseconds <= 0)
    ) {
      throw new RangeError('USB control timeout must be a positive finite number')
    }
    this.#options = options
    this.closed = this.#closedDeferred.promise
  }

  get connected(): boolean {
    return this.#connected
  }

  async connect(signal: AbortSignal): Promise<DeviceCapabilities> {
    throwIfAborted(signal)
    if (this.#port) throw new Error('USB device is already opening or connected')
    const portPath = this.#options.portPath ?? (await discoverStackChanPort())
    const port =
      this.#options.portFactory?.(portPath) ??
      (new SerialPort({ path: portPath, baudRate: 115_200, autoOpen: false }) as unknown as SerialPortLike)
    this.#port = port
    port.on('data', (data) => this.#handleData(data))
    port.on('error', (error) => this.#finish(error))
    port.on('close', () => this.#finish())
    await openPort(port, signal)
    await clearSerialControlLines(port)
    await delay(this.#options.openSettleMilliseconds ?? USB_OPEN_SETTLE_MS, signal)
    const frame = await this.#exchangeHello(signal)
    const peer = parseHelloPayload(frame.payload ?? new Uint8Array())
    if (peer.maxPayload < SPEAKER_FRAME_BYTES_24KHZ) {
      throw new Error(`CoreS3 max payload ${peer.maxPayload} is smaller than the required 3840 bytes`)
    }
    const missing = STACKCHAN_REQUIRED_CAPABILITIES & ~peer.capabilities
    if (missing !== 0) throw new Error(`CoreS3 is missing required USB capabilities: 0x${missing.toString(16)}`)
    this.#maxPayload = Math.min(STACKCHAN_MAX_PAYLOAD_BYTES, peer.maxPayload)
    this.#peerCapabilities = peer.capabilities
    this.#connected = true
    return capabilitiesFrom(peer.maxPayload, peer.capabilities)
  }

  async #exchangeHello(signal: AbortSignal): Promise<StackChanFrame> {
    throwIfAborted(signal)
    const helloAck = this.#waitForFrame(
      (frame) =>
        frame.type === StackChanFrameType.CONTROL &&
        frame.flags === StackChanControl.HELLO_ACK &&
        frame.streamId === 0,
      HELLO_TIMEOUT_MS,
      'HELLO_ACK',
    )
    const sendFailure = new Deferred<never>()
    const aborted = new Deferred<never>()
    let sending = false
    const sendHello = () => {
      if (sending) return
      sending = true
      void this.#sendFrame({
        type: StackChanFrameType.CONTROL,
        flags: StackChanControl.HELLO,
        streamId: 0,
        payload: helloPayload(STACKCHAN_MAX_PAYLOAD_BYTES, STACKCHAN_HOST_CAPABILITIES),
      })
        .catch((error) => sendFailure.reject(error))
        .finally(() => {
          sending = false
        })
    }
    const onAbort = () => aborted.reject(signal.reason ?? abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    sendHello()
    const retryTimer = setInterval(sendHello, HELLO_RETRY_MS)
    try {
      return await Promise.race([helloAck, sendFailure.promise, aborted.promise])
    } finally {
      clearInterval(retryTimer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  async *microphone(signal: AbortSignal): AsyncIterable<PcmChunk> {
    throwIfAborted(signal)
    this.#assertConnected()
    if (this.#microphone) throw new Error('microphone session is already active')
    if (this.#speaker) throw new Error('speaker session is active')
    const streamId = this.#allocateStreamId()
    const session: MicrophoneSession = {
      streamId,
      expectedSequence: 0,
      queue: new AsyncQueue<PcmChunk>(),
      stopping: false,
      failed: false,
    }
    this.#microphone = session
    const started = this.#waitForControl(StackChanControl.MIC_STARTED, streamId)
    await this.#sendControl(StackChanControl.MIC_START, MICROPHONE_SAMPLE_RATE, undefined, streamId)
    await started
    const onAbort = () => {
      void this.stopMicrophone().catch(() => {
        // The generator or device close path observes the shared stop task.
      })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      for await (const chunk of session.queue) {
        throwIfAborted(signal)
        yield chunk
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (this.#microphone === session) await this.stopMicrophone()
    }
  }

  stopMicrophone(): Promise<void> {
    const session = this.#microphone
    if (!session) return Promise.resolve()
    if (session.stopTask) return session.stopTask
    session.stopping = true
    session.stopTask = this.#stopMicrophoneSession(session)
    return session.stopTask
  }

  async #stopMicrophoneSession(session: MicrophoneSession): Promise<void> {
    if (!this.#connected) {
      session.queue.close()
      if (this.#microphone === session) this.#microphone = undefined
      return
    }
    try {
      const stopped = this.#waitForControl(StackChanControl.MIC_STOPPED, session.streamId)
      await this.#sendControl(StackChanControl.MIC_STOP, MICROPHONE_SAMPLE_RATE, undefined, session.streamId)
      await stopped
    } finally {
      session.queue.close()
      if (this.#microphone === session) this.#microphone = undefined
    }
  }

  async playAudio(source: AsyncIterable<PcmChunk>, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    this.#assertConnected()
    if (this.#microphone) throw new Error('microphone must be stopped before speaker playback')
    if (this.#speaker) throw new Error('speaker session is already active')
    const iterator = source[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done) return
    validateSpeakerChunk(first.value)
    const session: SpeakerSession = {
      streamId: this.#allocateStreamId(),
      credit: 0,
      sequence: 0,
      creditWaiters: new Set(),
    }
    this.#speaker = session
    const onAbort = () => void this.#abortSpeaker(session)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await this.#sendControl(StackChanControl.SPEAKER_START, first.value.sampleRate, undefined, session.streamId)
      let buffered = new Uint8Array()
      const append = async (chunk: PcmChunk): Promise<void> => {
        validateSpeakerChunk(chunk)
        if (chunk.sampleRate !== first.value.sampleRate) throw new Error('speaker sample rate changed during playback')
        const combined = new Uint8Array(buffered.byteLength + chunk.data.byteLength)
        combined.set(buffered)
        combined.set(chunk.data, buffered.byteLength)
        buffered = combined
        while (buffered.byteLength >= SPEAKER_FRAME_BYTES_24KHZ) {
          await this.#sendSpeakerPcm(session, buffered.slice(0, SPEAKER_FRAME_BYTES_24KHZ), first.value.sampleRate, signal)
          buffered = buffered.slice(SPEAKER_FRAME_BYTES_24KHZ)
        }
      }
      await append(first.value)
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        await append(next.value)
      }
      if (buffered.byteLength > 0) await this.#sendSpeakerPcm(session, buffered, first.value.sampleRate, signal)
      const done = this.#waitForControl(
        StackChanControl.SPEAKER_DONE,
        session.streamId,
        30_000,
        signal,
      )
      await Promise.all([
        this.#sendControl(StackChanControl.SPEAKER_END, first.value.sampleRate, undefined, session.streamId),
        done,
      ])
    } catch (error) {
      await this.#abortSpeaker(session)
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (this.#speaker === session) this.#speaker = undefined
      for (const waiter of session.creditWaiters) waiter.reject(abortError('speaker session ended'))
      session.creditWaiters.clear()
    }
  }

  async setConversationState(state: ConversationState): Promise<void> {
    this.#assertConnected()
    if ((this.#peerCapabilities & StackChanCapability.STATUS_ICON) === 0) return
    const wireValue = state === 'recognizing' ? 1 : state === 'speaking' ? 2 : 0
    await this.#sendControl(StackChanControl.STATUS, 0, Uint8Array.of(wireValue), 0)
  }

  async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    throwIfAborted(signal)
    this.#assertConnected()
    if ((this.#peerCapabilities & StackChanCapability.EVENT) === 0) {
      throw new Error('CoreS3 does not support approval EVENT messages')
    }
    if (this.#pendingApprovals.has(request.id)) throw new Error(`approval ${request.id} is already displayed`)
    const serialized = JSON.stringify(approvalRequestEvent(request))
    const response = new Deferred<ApprovalDecision>()
    const pending: PendingApproval = {
      response,
      presented: false,
      retryTimer: setInterval(() => {
        if (!pending.presented && this.#connected) void this.#sendSerializedEvent(serialized)
      }, EVENT_RETRY_MS),
    }
    this.#pendingApprovals.set(request.id, pending)
    const onAbort = () => response.reject(signal.reason ?? abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await this.#sendSerializedEvent(serialized)
      return await response.promise
    } finally {
      signal.removeEventListener('abort', onAbort)
      clearInterval(pending.retryTimer)
      this.#pendingApprovals.delete(request.id)
    }
  }

  async notifyApprovalResolved(requestId: string, message?: string): Promise<void> {
    if (!this.#connected) return
    const event: ApprovalResolvedEvent = {
      schema: STACKCHAN_EVENT_SCHEMA,
      type: 'approval.resolved',
      requestId,
      ...(message === undefined ? {} : { message }),
    }
    await this.#sendSerializedEvent(JSON.stringify(event))
  }

  async notifyApprovalSuspended(requestId: string): Promise<void> {
    if (!this.#connected) return
    const event: ApprovalSuspendedEvent = {
      schema: STACKCHAN_EVENT_SCHEMA,
      type: 'approval.suspended',
      requestId,
    }
    await this.#sendSerializedEvent(JSON.stringify(event))
  }

  async close(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    const port = this.#port
    try {
      try {
        await this.stopMicrophone()
      } catch {
        // Closing the transport is the final fallback when the device cannot
        // acknowledge a terminal microphone control.
      }
      if (this.#speaker) {
        try {
          await this.#abortSpeaker(this.#speaker)
        } catch {
          // The serial port still has to be released after an abort failure.
        }
      }
    } finally {
      try {
        if (port) await closeSerialPort(port)
      } finally {
        this.#finish()
      }
    }
  }

  async #sendSpeakerPcm(
    session: SpeakerSession,
    payload: Uint8Array,
    sampleRate: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (payload.byteLength % 2 !== 0 || payload.byteLength > this.#maxPayload) {
      throw new RangeError('invalid speaker PCM frame size')
    }
    await this.#waitForCredit(session, payload.byteLength, signal)
    session.credit -= payload.byteLength
    await this.#sendFrame({
      type: StackChanFrameType.SPEAKER_PCM,
      streamId: session.streamId,
      sequence: session.sequence,
      sampleRate,
      payload,
    })
    session.sequence = (session.sequence + 1) >>> 0
  }

  async #waitForCredit(session: SpeakerSession, bytes: number, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + CREDIT_TIMEOUT_MS
    while (session.credit < bytes) {
      throwIfAborted(signal)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`speaker credit did not advance for ${CREDIT_TIMEOUT_MS} ms`)
      const waiter = new Deferred<void>()
      session.creditWaiters.add(waiter)
      const timeout = setTimeout(() => waiter.reject(new Error('speaker credit timeout')), remaining)
      const onAbort = () => waiter.reject(signal.reason ?? abortError())
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        await waiter.promise
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        session.creditWaiters.delete(waiter)
      }
    }
  }

  async #abortSpeaker(session: SpeakerSession): Promise<void> {
    if (this.#speaker !== session) return
    if (this.#connected) {
      try {
        await this.#sendControl(StackChanControl.SPEAKER_ABORT, 24_000, undefined, session.streamId)
      } catch {
        // The disconnect path will release the session locally.
      }
    }
    for (const waiter of session.creditWaiters) waiter.reject(abortError('speaker playback aborted'))
    session.creditWaiters.clear()
    if (this.#speaker === session) this.#speaker = undefined
  }

  #handleData(data: Buffer): void {
    for (const frame of this.#parser.push(data)) this.#handleFrame(frame)
  }

  #handleFrame(frame: StackChanFrame): void {
    for (const waiter of [...this.#waiters]) {
      if (!waiter.predicate(frame)) continue
      clearTimeout(waiter.timer)
      this.#waiters.delete(waiter)
      waiter.deferred.resolve(frame)
    }
    if (frame.type === StackChanFrameType.MICROPHONE_PCM) {
      this.#handleMicrophonePcm(frame)
      return
    }
    if (frame.type === StackChanFrameType.EVENT) {
      try {
        const payload = this.#eventDecoder.push(frame)
        if (payload) this.#handleEvent(new TextDecoder('utf-8', { fatal: true }).decode(payload))
      } catch (error) {
        console.warn(`USB EVENT decode failed: ${errorMessage(error)}`)
      }
      return
    }
    if (frame.type !== StackChanFrameType.CONTROL) return
    if (frame.flags === StackChanControl.SPEAKER_CREDIT) {
      const speaker = this.#speaker
      if (!speaker || frame.streamId !== speaker.streamId) return
      const increment = parseUint32Payload(frame.payload ?? new Uint8Array())
      speaker.credit = Math.min(MAX_UNUSED_SPEAKER_CREDIT, speaker.credit + increment)
      for (const waiter of speaker.creditWaiters) waiter.resolve()
      speaker.creditWaiters.clear()
      return
    }
    if (frame.flags === StackChanControl.ERROR) {
      const code = parseUint32Payload(frame.payload ?? new Uint8Array())
      this.#failActiveStreams(new Error(`CoreS3 returned error code ${code} for stream ${frame.streamId ?? 0}`))
    }
  }

  #handleMicrophonePcm(frame: StackChanFrame): void {
    const session = this.#microphone
    if (!session || session.failed || session.stopping || frame.streamId !== session.streamId) return
    if (frame.sampleRate !== MICROPHONE_SAMPLE_RATE || frame.payload?.byteLength !== MICROPHONE_FRAME_BYTES) {
      session.failed = true
      session.queue.fail(new Error('CoreS3 returned an invalid microphone PCM frame'))
      return
    }
    const sequence = frame.sequence ?? 0
    const gap = (sequence - session.expectedSequence) >>> 0
    if (gap > MAX_MICROPHONE_GAP_FRAMES) {
      session.failed = true
      session.queue.fail(new Error(`microphone sequence gap is too large: ${gap}`))
      return
    }
    if (session.queue.length + gap + 1 > MAX_MICROPHONE_QUEUE_FRAMES) {
      session.failed = true
      session.queue.fail(new Error('CoreS3 microphone consumer fell more than one second behind'))
      return
    }
    for (let missing = 0; missing < gap; missing += 1) {
      session.queue.push({
        data: new Uint8Array(MICROPHONE_FRAME_BYTES),
        sampleRate: MICROPHONE_SAMPLE_RATE,
        channels: 1,
        format: 's16le',
      })
    }
    session.queue.push({
      data: frame.payload,
      sampleRate: MICROPHONE_SAMPLE_RATE,
      channels: 1,
      format: 's16le',
    })
    session.expectedSequence = (sequence + 1) >>> 0
  }

  #handleEvent(serialized: string): void {
    const event = parseStackChanApplicationEvent(serialized)
    if (!event) return
    const pending = this.#pendingApprovals.get(event.requestId)
    if (!pending) return
    if (event.type === 'approval.presented') {
      pending.presented = true
      return
    }
    if (event.type === 'approval.response') pending.response.resolve(event.decision)
  }

  async #sendSerializedEvent(serialized: string): Promise<void> {
    const payload = new TextEncoder().encode(serialized)
    for (const frame of this.#eventEncoder.encode(payload, this.#maxPayload)) await this.#sendFrame(frame)
  }

  #waitForControl(
    control: StackChanControl,
    streamId: number,
    timeoutMilliseconds = this.#options.controlTimeoutMilliseconds ?? CONTROL_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<StackChanFrame> {
    return this.#waitForFrame(
      (frame) =>
        frame.type === StackChanFrameType.CONTROL && frame.flags === control && frame.streamId === streamId,
      timeoutMilliseconds,
      StackChanControl[control],
      signal,
    )
  }

  #waitForFrame(
    predicate: (frame: StackChanFrame) => boolean,
    timeoutMilliseconds: number,
    description: string,
    signal?: AbortSignal,
  ): Promise<StackChanFrame> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError())
    const deferred = new Deferred<StackChanFrame>()
    const waiter: FrameWaiter = {
      predicate,
      deferred,
      timer: setTimeout(() => {
        this.#waiters.delete(waiter)
        deferred.reject(new Error(`timed out waiting for ${description}`))
      }, timeoutMilliseconds),
    }
    this.#waiters.add(waiter)
    const onAbort = () => {
      clearTimeout(waiter.timer)
      this.#waiters.delete(waiter)
      deferred.reject(signal?.reason ?? abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    return deferred.promise.finally(() => signal?.removeEventListener('abort', onAbort))
  }

  async #sendControl(
    control: StackChanControl,
    sampleRate = 0,
    payload?: Uint8Array,
    streamId = 0,
  ): Promise<void> {
    await this.#sendFrame({
      type: StackChanFrameType.CONTROL,
      flags: control,
      streamId,
      sampleRate,
      ...(payload === undefined ? {} : { payload }),
    })
  }

  async #sendFrame(frame: StackChanFrame): Promise<void> {
    const port = this.#port
    if (!port?.isOpen) throw new Error('USB serial port is not open')
    const bytes = encodeStackChanFrame(frame)
    await new Promise<void>((resolve, reject) => {
      port.write(bytes, (writeError) => {
        if (writeError) reject(writeError)
        else resolve()
      })
    })
  }

  #allocateStreamId(): number {
    this.#nextStreamId = this.#nextStreamId >= 0xffff ? 1 : this.#nextStreamId + 1
    return this.#nextStreamId
  }

  #assertConnected(): void {
    if (!this.#connected || !this.#port?.isOpen) throw new Error('CoreS3 USB is not connected')
  }

  #failActiveStreams(error: Error): void {
    this.#microphone?.queue.fail(error)
    for (const waiter of this.#speaker?.creditWaiters ?? []) waiter.reject(error)
  }

  #finish(error?: Error): void {
    if (this.#closing && !this.#connected && !this.#port) return
    const port = this.#port
    this.#connected = false
    this.#parser.reset()
    this.#eventDecoder.reset()
    const reason = error ?? new Error('CoreS3 USB disconnected')
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer)
      waiter.deferred.reject(reason)
    }
    this.#waiters.clear()
    this.#failActiveStreams(reason)
    this.#microphone?.queue.close()
    this.#microphone = undefined
    this.#speaker = undefined
    for (const approval of this.#pendingApprovals.values()) {
      clearInterval(approval.retryTimer)
      approval.response.reject(reason)
    }
    this.#pendingApprovals.clear()
    this.#port = undefined
    if (!this.#closing && port) void closeSerialPort(port)
    this.#closedDeferred.resolve(error)
  }
}

export async function discoverStackChanPort(): Promise<string> {
  const matches = (await SerialPort.list()).filter(
    (port) =>
      port.vendorId?.toLowerCase() === CORES3_USB_VENDOR_ID &&
      port.productId?.toLowerCase() === CORES3_USB_PRODUCT_ID,
  )
  if (matches.length === 0) {
    throw new Error('VID 303A / PID 1001 のCoreS3 USBポートが見つかりません')
  }
  if (matches.length > 1) {
    throw new Error(`CoreS3 USBポートが複数あります。--portで指定してください: ${matches.map((port) => port.path).join(', ')}`)
  }
  const path = matches[0]?.path
  if (!path) throw new Error('CoreS3 USBポートのpathを取得できません')
  return path
}

function openPort(port: SerialPortLike, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let aborted = false
    const onAbort = () => {
      aborted = true
      reject(signal.reason ?? abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    port.open((error) => {
      signal.removeEventListener('abort', onAbort)
      if (aborted) {
        void closeSerialPort(port)
        return
      }
      if (error) reject(error)
      else resolve()
    })
  })
}

async function closeSerialPort(port: SerialPortLike): Promise<void> {
  if (port.isOpen && port.flush) {
    await new Promise<void>((resolve) => port.flush!(() => resolve()))
  }
  port.destroy?.()
  if (port.isOpen) {
    await new Promise<void>((resolve) => port.close(() => resolve()))
  }
}

async function clearSerialControlLines(port: SerialPortLike): Promise<void> {
  if (!port.set) return
  await new Promise<void>((resolve) => {
    port.set!({ dtr: false, rts: false }, () => {
      // ESP32-S3 USB Serial/JTAG rejects modem-control ioctls on some Linux
      // drivers. HELLO retrying remains the portable recovery mechanism.
      resolve()
    })
  })
}

function validateSpeakerChunk(chunk: PcmChunk): void {
  if (chunk.format !== 's16le' || chunk.channels !== 1) throw new Error('speaker accepts PCM16LE mono only')
  if (chunk.sampleRate !== 24_000) throw new Error(`speaker bridge expects 24 kHz PCM, received ${chunk.sampleRate}`)
  if (chunk.data.byteLength % 2 !== 0) throw new RangeError('speaker PCM contains a partial sample')
}

function capabilitiesFrom(maxPayload: number, capabilities: number): DeviceCapabilities {
  return {
    maxPayload,
    microphonePcm: (capabilities & StackChanCapability.MICROPHONE_PCM) !== 0,
    speakerPcm: (capabilities & StackChanCapability.SPEAKER_PCM) !== 0,
    speakerCredit: (capabilities & StackChanCapability.SPEAKER_CREDIT) !== 0,
    speakerRate24000: (capabilities & StackChanCapability.SPEAKER_RATE_24000) !== 0,
    statusIcon: (capabilities & StackChanCapability.STATUS_ICON) !== 0,
    streamId: (capabilities & StackChanCapability.STREAM_ID) !== 0,
    event: (capabilities & StackChanCapability.EVENT) !== 0,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const STACKCHAN_USB_FRAME_OVERHEAD_BYTES = STACKCHAN_HEADER_BYTES + STACKCHAN_CRC_BYTES
export { uint32Payload }
