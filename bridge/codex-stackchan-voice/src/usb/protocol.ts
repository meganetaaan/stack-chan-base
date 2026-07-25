const MAGIC_LOW = 0x43
const MAGIC_HIGH = 0x53

export const STACKCHAN_MAGIC = 0x5343
export const STACKCHAN_PROTOCOL_VERSION = 2
export const STACKCHAN_HEADER_BYTES = 20
export const STACKCHAN_CRC_BYTES = 4
export const STACKCHAN_MAX_PAYLOAD_BYTES = 4096
export const STACKCHAN_MAX_EVENT_BYTES = 64 * 1024

export enum StackChanFrameType {
  CONTROL = 0,
  MICROPHONE_PCM = 1,
  SPEAKER_PCM = 2,
  EXPRESSION = 3,
  MOTION = 4,
  DIAGNOSTICS = 5,
  EVENT = 6,
}

export enum StackChanControl {
  HELLO = 1,
  HELLO_ACK = 2,
  ERROR = 3,
  MIC_START = 16,
  MIC_STARTED = 17,
  MIC_STOP = 18,
  MIC_STOPPED = 19,
  SPEAKER_START = 32,
  SPEAKER_CREDIT = 33,
  SPEAKER_END = 34,
  SPEAKER_DONE = 35,
  SPEAKER_ABORT = 36,
  SPEAKER_TEXT = 37,
  STATUS = 48,
}

export const StackChanCapability = {
  MICROPHONE_PCM: 1 << 0,
  SPEAKER_PCM: 1 << 1,
  SPEAKER_CREDIT: 1 << 2,
  SPEAKER_RATE_8000: 1 << 3,
  SPEAKER_RATE_16000: 1 << 4,
  SPEAKER_RATE_24000: 1 << 5,
  SPEAKER_TEXT: 1 << 6,
  DIAGNOSTICS: 1 << 7,
  STATUS_ICON: 1 << 8,
  STREAM_ID: 1 << 9,
  EVENT: 1 << 10,
} as const

export const STACKCHAN_HOST_CAPABILITIES =
  StackChanCapability.MICROPHONE_PCM |
  StackChanCapability.SPEAKER_PCM |
  StackChanCapability.SPEAKER_CREDIT |
  StackChanCapability.SPEAKER_RATE_24000 |
  StackChanCapability.STATUS_ICON |
  StackChanCapability.STREAM_ID |
  StackChanCapability.EVENT

export const STACKCHAN_REQUIRED_CAPABILITIES =
  StackChanCapability.MICROPHONE_PCM |
  StackChanCapability.SPEAKER_PCM |
  StackChanCapability.SPEAKER_CREDIT |
  StackChanCapability.SPEAKER_RATE_24000 |
  StackChanCapability.STREAM_ID |
  StackChanCapability.EVENT

export const StackChanEventFlag = {
  START: 1,
  END: 1 << 1,
} as const

export type StackChanFrame = {
  type: StackChanFrameType
  flags?: number
  streamId?: number
  sequence?: number
  sampleRate?: number
  payload?: Uint8Array
}

const crcTable = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  crcTable[index] = value >>> 0
}

export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value = (crcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

export function encodeStackChanFrame(frame: StackChanFrame): Uint8Array {
  const payload = frame.payload ?? new Uint8Array()
  if (payload.byteLength > STACKCHAN_MAX_PAYLOAD_BYTES) throw new RangeError('payload is too large')
  const streamId = frame.streamId ?? 0
  if (streamId < 0 || streamId > 0xffff) throw new RangeError('stream ID is out of range')
  const output = new Uint8Array(STACKCHAN_HEADER_BYTES + payload.byteLength + STACKCHAN_CRC_BYTES)
  const view = new DataView(output.buffer)
  view.setUint16(0, STACKCHAN_MAGIC, true)
  view.setUint8(2, STACKCHAN_PROTOCOL_VERSION)
  view.setUint8(3, frame.type)
  view.setUint16(4, frame.flags ?? 0, true)
  view.setUint16(6, streamId, true)
  view.setUint32(8, frame.sequence ?? 0, true)
  view.setUint32(12, frame.sampleRate ?? 0, true)
  view.setUint32(16, payload.byteLength, true)
  output.set(payload, STACKCHAN_HEADER_BYTES)
  view.setUint32(STACKCHAN_HEADER_BYTES + payload.byteLength, crc32(output.subarray(0, -STACKCHAN_CRC_BYTES)), true)
  return output
}

export function decodeStackChanFrame(bytes: Uint8Array): StackChanFrame {
  if (bytes.byteLength < STACKCHAN_HEADER_BYTES + STACKCHAN_CRC_BYTES) throw new RangeError('frame is too short')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(0, true) !== STACKCHAN_MAGIC) throw new Error('invalid magic')
  if (view.getUint8(2) !== STACKCHAN_PROTOCOL_VERSION) throw new Error('unsupported protocol version')
  const type = view.getUint8(3)
  if (type > StackChanFrameType.EVENT) throw new Error('unknown frame type')
  const payloadLength = view.getUint32(16, true)
  if (payloadLength > STACKCHAN_MAX_PAYLOAD_BYTES) throw new RangeError('payload is too large')
  const expectedLength = STACKCHAN_HEADER_BYTES + payloadLength + STACKCHAN_CRC_BYTES
  if (bytes.byteLength !== expectedLength) throw new RangeError('frame length mismatch')
  const expectedCrc = view.getUint32(STACKCHAN_HEADER_BYTES + payloadLength, true)
  const actualCrc = crc32(bytes.subarray(0, STACKCHAN_HEADER_BYTES + payloadLength))
  if (actualCrc !== expectedCrc) throw new Error('CRC mismatch')
  return {
    type: type as StackChanFrameType,
    flags: view.getUint16(4, true),
    streamId: view.getUint16(6, true),
    sequence: view.getUint32(8, true),
    sampleRate: view.getUint32(12, true),
    payload: bytes.slice(STACKCHAN_HEADER_BYTES, STACKCHAN_HEADER_BYTES + payloadLength),
  }
}

export class StackChanFrameParser {
  #pending = new Uint8Array()

  push(chunk: Uint8Array): StackChanFrame[] {
    if (chunk.byteLength === 0) return []
    const combined = new Uint8Array(this.#pending.byteLength + chunk.byteLength)
    combined.set(this.#pending)
    combined.set(chunk, this.#pending.byteLength)
    this.#pending = combined
    const frames: StackChanFrame[] = []
    const minimum = STACKCHAN_HEADER_BYTES + STACKCHAN_CRC_BYTES
    while (this.#pending.byteLength >= minimum) {
      const magicOffset = findMagic(this.#pending)
      if (magicOffset < 0) {
        this.#pending = this.#pending.slice(-1)
        break
      }
      if (magicOffset > 0) this.#pending = this.#pending.slice(magicOffset)
      if (this.#pending.byteLength < minimum) break
      const view = new DataView(this.#pending.buffer, this.#pending.byteOffset, this.#pending.byteLength)
      if (view.getUint8(2) !== STACKCHAN_PROTOCOL_VERSION || view.getUint8(3) > StackChanFrameType.EVENT) {
        this.#pending = this.#pending.slice(1)
        continue
      }
      const payloadLength = view.getUint32(16, true)
      if (payloadLength > STACKCHAN_MAX_PAYLOAD_BYTES) {
        this.#pending = this.#pending.slice(1)
        continue
      }
      const frameLength = STACKCHAN_HEADER_BYTES + payloadLength + STACKCHAN_CRC_BYTES
      if (this.#pending.byteLength < frameLength) break
      const candidate = this.#pending.slice(0, frameLength)
      try {
        frames.push(decodeStackChanFrame(candidate))
        this.#pending = this.#pending.slice(frameLength)
      } catch {
        this.#pending = this.#pending.slice(1)
      }
    }
    return frames
  }

  reset(): void {
    this.#pending = new Uint8Array()
  }
}

function findMagic(bytes: Uint8Array): number {
  for (let index = 0; index + 1 < bytes.byteLength; index += 1) {
    if (bytes[index] === MAGIC_LOW && bytes[index + 1] === MAGIC_HIGH) return index
  }
  return -1
}

export class StackChanEventEncoder {
  #messageId = 0

  encode(payload: Uint8Array, maxPayload = STACKCHAN_MAX_PAYLOAD_BYTES): StackChanFrame[] {
    if (maxPayload < 1 || maxPayload > STACKCHAN_MAX_PAYLOAD_BYTES) throw new RangeError('invalid event chunk size')
    if (payload.byteLength > STACKCHAN_MAX_EVENT_BYTES) throw new RangeError('event is too large')
    this.#messageId = this.#messageId >= 0xffff ? 1 : this.#messageId + 1
    const frameCount = Math.max(1, Math.ceil(payload.byteLength / maxPayload))
    return Array.from({ length: frameCount }, (_, sequence) => {
      const start = sequence * maxPayload
      const end = Math.min(payload.byteLength, start + maxPayload)
      return {
        type: StackChanFrameType.EVENT,
        streamId: this.#messageId,
        sequence,
        flags:
          (sequence === 0 ? StackChanEventFlag.START : 0) |
          (sequence === frameCount - 1 ? StackChanEventFlag.END : 0),
        payload: payload.slice(start, end),
      }
    })
  }
}

type PendingEvent = {
  nextSequence: number
  chunks: Uint8Array[]
  size: number
}

export class StackChanEventDecoder {
  #pending = new Map<number, PendingEvent>()

  push(frame: StackChanFrame): Uint8Array | undefined {
    if (frame.type !== StackChanFrameType.EVENT) throw new TypeError('event frame is required')
    const streamId = frame.streamId ?? 0
    if (streamId === 0) throw new RangeError('event stream ID must not be zero')
    const starts = ((frame.flags ?? 0) & StackChanEventFlag.START) !== 0
    const ends = ((frame.flags ?? 0) & StackChanEventFlag.END) !== 0
    let pending = this.#pending.get(streamId)
    if (starts) {
      if ((frame.sequence ?? 0) !== 0) throw new RangeError('first event sequence must be zero')
      pending = { nextSequence: 0, chunks: [], size: 0 }
      this.#pending.set(streamId, pending)
    }
    if (!pending) throw new Error('event continuation has no start chunk')
    if ((frame.sequence ?? 0) !== pending.nextSequence) {
      this.#pending.delete(streamId)
      throw new RangeError('event sequence mismatch')
    }
    const payload = frame.payload ?? new Uint8Array()
    if (pending.size + payload.byteLength > STACKCHAN_MAX_EVENT_BYTES) {
      this.#pending.delete(streamId)
      throw new RangeError('event is too large')
    }
    pending.chunks.push(payload)
    pending.size += payload.byteLength
    pending.nextSequence += 1
    if (!ends) return undefined
    this.#pending.delete(streamId)
    const output = new Uint8Array(pending.size)
    let offset = 0
    for (const chunk of pending.chunks) {
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
    return output
  }

  reset(): void {
    this.#pending.clear()
  }
}

export function helloPayload(maxPayload = STACKCHAN_MAX_PAYLOAD_BYTES, capabilities = STACKCHAN_HOST_CAPABILITIES): Uint8Array {
  const payload = new Uint8Array(8)
  const view = new DataView(payload.buffer)
  view.setUint32(0, maxPayload, true)
  view.setUint32(4, capabilities, true)
  return payload
}

export function parseHelloPayload(payload: Uint8Array): { maxPayload: number; capabilities: number } {
  if (payload.byteLength !== 8) throw new RangeError('invalid HELLO payload')
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  return {
    maxPayload: view.getUint32(0, true),
    capabilities: view.getUint32(4, true),
  }
}

export function uint32Payload(value: number): Uint8Array {
  const payload = new Uint8Array(4)
  new DataView(payload.buffer).setUint32(0, value >>> 0, true)
  return payload
}

export function parseUint32Payload(payload: Uint8Array): number {
  if (payload.byteLength !== 4) throw new RangeError('expected a four-byte payload')
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true)
}
