import { isRecord } from '../codex/app-server.js'
import { NonRetryableError } from '../retry-policy.js'
import type { PcmChunk } from '../types.js'

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Decodes the ordered PCM notification emitted by codex app-server.
 *
 * Realtime V3 sends the same assistant output over the WebRTC media track and
 * the thread/realtime/outputAudio/delta notification. The notification is the
 * bridge contract: it shares one ordered stream with transcript/done, while
 * raw RTP has no cross-transport ordering with that terminal notification.
 */
export function parseAppServerOutputAudio(
  params: unknown,
  expectedThreadId: string,
): PcmChunk | undefined {
  if (!isRecord(params) || params.threadId !== expectedThreadId) return undefined
  if (!isRecord(params.audio)) {
    throw protocolError('app-server realtime output audio is missing')
  }
  const audio = params.audio
  if (typeof audio.data !== 'string' || !isCanonicalBase64(audio.data)) {
    throw protocolError('app-server realtime output audio is not canonical base64')
  }
  if (!Number.isInteger(audio.sampleRate) || (audio.sampleRate as number) <= 0) {
    throw protocolError('app-server realtime output audio has an invalid sample rate')
  }
  if (audio.numChannels !== 1) {
    throw protocolError('app-server realtime output audio must be mono')
  }
  if (
    audio.samplesPerChannel !== null &&
    audio.samplesPerChannel !== undefined &&
    (!Number.isInteger(audio.samplesPerChannel) || (audio.samplesPerChannel as number) < 0)
  ) {
    throw protocolError('app-server realtime output audio has an invalid sample count')
  }
  if (
    audio.itemId !== null &&
    audio.itemId !== undefined &&
    typeof audio.itemId !== 'string'
  ) {
    throw protocolError('app-server realtime output audio has an invalid item ID')
  }

  const data = Uint8Array.from(Buffer.from(audio.data, 'base64'))
  if (data.byteLength % 2 !== 0) {
    throw protocolError('app-server realtime output audio contains an incomplete PCM16 sample')
  }
  if (
    typeof audio.samplesPerChannel === 'number' &&
    audio.samplesPerChannel * 2 !== data.byteLength
  ) {
    throw protocolError('app-server realtime output audio sample count does not match its data')
  }
  return {
    data,
    sampleRate: audio.sampleRate as number,
    channels: 1,
    format: 's16le',
  }
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return false
  return Buffer.from(value, 'base64').toString('base64') === value
}

function protocolError(message: string): NonRetryableError {
  return new NonRetryableError('protocol', message)
}
