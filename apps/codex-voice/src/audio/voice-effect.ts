import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { once } from 'node:events'
import type { Writable } from 'node:stream'
import { abortError, throwIfAborted } from '../async.js'
import { NonRetryableError } from '../retry-policy.js'
import type { PcmChunk } from '../types.js'
import {
  pcmChunk,
  resamplePcmChunks,
  StreamingPcm16ByteFramer,
} from './pcm.js'

export type VoiceEffect = 'cute'

export type PcmAudioTransform = (
  source: AsyncIterable<PcmChunk>,
  signal: AbortSignal,
) => AsyncIterable<PcmChunk>

export type VoiceEffectRuntimeOptions = {
  ffmpegBinary?: string
}

export const VOICE_EFFECT_SAMPLE_RATE = 48_000
export const SPEAKER_SAMPLE_RATE = 24_000
export const CUTE_PITCH_RATIO = 1.189207115

const DEFAULT_FFMPEG_BINARY = 'ffmpeg'
const MAX_FFMPEG_STDERR_CHARACTERS = 65_536
const FFMPEG_TERMINATE_TIMEOUT_MS = 1_000
const CUTE_FILTER = [
  `pitch=${CUTE_PITCH_RATIO}`,
  'tempo=1',
  'formant=shifted',
  'transients=smooth',
  'window=short',
  'pitchq=quality',
].join(':')

type ChildCloseResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

type PumpResult =
  | { ok: true }
  | { ok: false; error: unknown }

export function cuteVoiceEffectFfmpegArgs(): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-probesize',
    '32',
    '-analyzeduration',
    '0',
    '-f',
    's16le',
    '-ar',
    String(VOICE_EFFECT_SAMPLE_RATE),
    '-ac',
    '1',
    '-i',
    'pipe:0',
    '-af',
    `rubberband=${CUTE_FILTER}`,
    '-flush_packets',
    '1',
    '-f',
    's16le',
    '-ar',
    String(VOICE_EFFECT_SAMPLE_RATE),
    '-ac',
    '1',
    'pipe:1',
  ]
}

export function createVoiceOutputTransform(
  voiceEffect: VoiceEffect | undefined,
  runtimeOptions: VoiceEffectRuntimeOptions = {},
): PcmAudioTransform {
  if (voiceEffect === undefined) {
    return (source, signal) => resampleForSpeaker(source, signal)
  }
  if (voiceEffect !== 'cute') {
    throw new NonRetryableError(
      'configuration',
      `未対応のvoice effectです: ${String(voiceEffect)}`,
    )
  }
  return (source, signal) =>
    transformCuteVoice(
      source,
      signal,
      runtimeOptions.ffmpegBinary ?? DEFAULT_FFMPEG_BINARY,
    )
}

export async function assertVoiceEffectAvailable(
  voiceEffect: VoiceEffect | undefined,
  runtimeOptions: VoiceEffectRuntimeOptions = {},
): Promise<void> {
  if (voiceEffect === undefined) return
  const controller = new AbortController()
  let outputBytes = 0
  async function* probe(): AsyncGenerator<PcmChunk> {
    yield pcmChunk(
      new Uint8Array((VOICE_EFFECT_SAMPLE_RATE / 50) * 2),
      VOICE_EFFECT_SAMPLE_RATE,
    )
  }
  for await (const chunk of createVoiceOutputTransform(
    voiceEffect,
    runtimeOptions,
  )(
    probe(),
    controller.signal,
  )) {
    outputBytes += chunk.data.byteLength
  }
  if (outputBytes === 0) {
    throw new NonRetryableError(
      'configuration',
      'FFmpeg rubberbandの事前検査で音声が出力されませんでした',
    )
  }
}

async function* transformCuteVoice(
  source: AsyncIterable<PcmChunk>,
  signal: AbortSignal,
  ffmpegBinary: string,
): AsyncGenerator<PcmChunk> {
  const normalized = resamplePcmChunks(
    abortablePcmSource(source, signal),
    VOICE_EFFECT_SAMPLE_RATE,
  )
  const effected = ffmpegCuteVoiceEffect(normalized, signal, ffmpegBinary)
  yield* resampleForSpeaker(effected, signal)
}

async function* resampleForSpeaker(
  source: AsyncIterable<PcmChunk>,
  signal: AbortSignal,
): AsyncGenerator<PcmChunk> {
  for await (const chunk of resamplePcmChunks(
    abortablePcmSource(source, signal),
    SPEAKER_SAMPLE_RATE,
  )) {
    throwIfAborted(signal)
    if (chunk.data.byteLength > 0) yield chunk
  }
}

async function* ffmpegCuteVoiceEffect(
  source: AsyncIterable<PcmChunk>,
  signal: AbortSignal,
  ffmpegBinary: string,
): AsyncGenerator<PcmChunk> {
  throwIfAborted(signal)
  const child = spawn(ffmpegBinary, cuteVoiceEffectFfmpegArgs(), {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const processorController = new AbortController()
  let sourceFinished = false
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (value: string) => {
    stderr = `${stderr}${value}`.slice(-MAX_FFMPEG_STDERR_CHARACTERS)
  })

  const closed = childClose(child)
  const abortProcessor = (reason: unknown) => {
    if (!processorController.signal.aborted) processorController.abort(reason)
    if (isChildRunning(child)) child.kill('SIGTERM')
  }
  const onAbort = () => abortProcessor(signal.reason ?? abortError())
  const onInputError = (error: Error) => abortProcessor(error)
  signal.addEventListener('abort', onAbort, { once: true })
  child.stdin.on('error', onInputError)

  void closed.then(
    (result) => {
      if (!sourceFinished && !processorController.signal.aborted) {
        abortProcessor(ffmpegExitError(result, stderr))
      }
    },
    (error: unknown) => abortProcessor(error),
  )

  const inputResult: Promise<PumpResult> = pumpFfmpegInput(
    source,
    child.stdin,
    processorController.signal,
  ).then(
    () => {
      sourceFinished = true
      return { ok: true }
    },
    (error: unknown) => {
      abortProcessor(error)
      return { ok: false, error }
    },
  )

  const framer = new StreamingPcm16ByteFramer()
  try {
    for await (const raw of child.stdout) {
      throwIfAborted(signal)
      const incoming = raw instanceof Uint8Array ? raw : Uint8Array.from(raw)
      const framed = framer.push(incoming)
      if (framed.byteLength > 0) {
        yield pcmChunk(
          framed,
          VOICE_EFFECT_SAMPLE_RATE,
        )
      }
    }

    const closeResult = await closed
    const pumpResult = await inputResult
    throwIfAborted(signal)
    if (closeResult.code !== 0 || closeResult.signal !== null) {
      throw ffmpegExitError(closeResult, stderr)
    }
    if (!pumpResult.ok) throw pumpResult.error
    framer.finish()
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? abortError()
    if (error instanceof NonRetryableError) throw error
    throw new NonRetryableError(
      'configuration',
      ffmpegFailureMessage(error, stderr),
      { cause: error },
    )
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (!processorController.signal.aborted) {
      processorController.abort(abortError('voice effect stream closed'))
    }
    await terminateChild(child, closed)
    child.stdin.off('error', onInputError)
  }
}

async function pumpFfmpegInput(
  source: AsyncIterable<PcmChunk>,
  destination: Writable,
  signal: AbortSignal,
): Promise<void> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await nextWithAbort(iterator, signal)
      if (next.done) break
      const chunk = next.value
      if (
        chunk.sampleRate !== VOICE_EFFECT_SAMPLE_RATE ||
        chunk.channels !== 1 ||
        chunk.format !== 's16le' ||
        chunk.data.byteLength % 2 !== 0
      ) {
        throw new Error('FFmpeg voice effect expects complete 48 kHz PCM16LE mono')
      }
      if (
        chunk.data.byteLength > 0 &&
        !destination.write(
          Buffer.from(
            chunk.data.buffer,
            chunk.data.byteOffset,
            chunk.data.byteLength,
          ),
        )
      ) {
        await once(destination, 'drain', { signal })
      }
    }
    throwIfAborted(signal)
    destination.end()
  } finally {
    await iterator.return?.()
  }
}

async function* abortablePcmSource(
  source: AsyncIterable<PcmChunk>,
  signal: AbortSignal,
): AsyncGenerator<PcmChunk> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await nextWithAbort(iterator, signal)
      if (next.done) return
      yield next.value
    }
  } finally {
    await iterator.return?.()
  }
}

function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void iterator.next().then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function childClose(
  child: ChildProcessWithoutNullStreams,
): Promise<ChildCloseResult> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, childSignal) => {
      resolve({ code, signal: childSignal })
    })
  })
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<ChildCloseResult>,
): Promise<void> {
  if (isChildRunning(child)) child.kill('SIGTERM')
  const forceTimer = setTimeout(() => {
    if (isChildRunning(child)) child.kill('SIGKILL')
  }, FFMPEG_TERMINATE_TIMEOUT_MS)
  forceTimer.unref()
  try {
    await closed.catch(() => undefined)
  } finally {
    clearTimeout(forceTimer)
  }
}

function isChildRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null
}

function ffmpegExitError(
  result: ChildCloseResult,
  stderr: string,
): Error {
  const status = result.signal
    ? `signal ${result.signal}`
    : `exit ${String(result.code)}`
  const details = stderr.trim()
  return new Error(
    `FFmpeg rubberbandが異常終了しました（${status}）${details ? `: ${details}` : ''}`,
  )
}

function ffmpegFailureMessage(error: unknown, stderr: string): string {
  const message = error instanceof Error ? error.message : String(error)
  const details = stderr.trim()
  if (message.includes('ENOENT')) {
    return 'かわいい声加工にはFFmpegとrubberbandフィルタが必要です'
  }
  return `かわいい声加工に失敗しました: ${message}${details && !message.includes(details) ? `: ${details}` : ''}`
}
