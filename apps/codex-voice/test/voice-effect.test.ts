import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertVoiceEffectAvailable,
  CUTE_PITCH_RATIO,
  createVoiceOutputTransform,
  cuteVoiceEffectFfmpegArgs,
} from '../src/audio/voice-effect.js'
import {
  decodePcm16Le,
  encodePcm16Le,
  pcmChunk,
} from '../src/audio/pcm.js'
import { NonRetryableError } from '../src/retry-policy.js'
import type { PcmChunk } from '../src/types.js'

test('cute voice effect uses low-latency rubberband arguments without nobuffer truncation', () => {
  const args = cuteVoiceEffectFfmpegArgs()
  const filterIndex = args.indexOf('-af')
  assert.notEqual(filterIndex, -1)
  assert.equal(args[args.indexOf('-probesize') + 1], '32')
  assert.equal(args[args.indexOf('-analyzeduration') + 1], '0')
  assert.doesNotMatch(args.join(' '), /-fflags\s+nobuffer/)
  assert.ok(args[filterIndex + 1]!.includes(`pitch=${CUTE_PITCH_RATIO}`))
  assert.match(args[filterIndex + 1]!, /tempo=1/)
  assert.match(args[filterIndex + 1]!, /formant=shifted/)
  assert.match(args[filterIndex + 1]!, /window=short/)
  assert.match(args[filterIndex + 1]!, /pitchq=quality/)
})

test('disabled voice effect keeps the in-process 24 kHz resampling path', async () => {
  async function* source(): AsyncGenerator<PcmChunk> {
    yield pcmChunk(
      encodePcm16Le(
        Int16Array.from({ length: 960 }, (_, index) => index - 480),
      ),
      48_000,
    )
  }
  const output: PcmChunk[] = []
  for await (const chunk of createVoiceOutputTransform(undefined)(
    source(),
    new AbortController().signal,
  )) {
    output.push(chunk)
  }
  assert.equal(output.length, 1)
  assert.equal(output[0]!.sampleRate, 24_000)
  assert.equal(output[0]!.channels, 1)
  assert.equal(output[0]!.format, 's16le')
  assert.equal(decodePcm16Le(output[0]!.data).length, 480)
})

test('voice effect preflight reports a missing FFmpeg as a configuration error', async () => {
  await assert.rejects(
    assertVoiceEffectAvailable('cute', {
      ffmpegBinary: '/definitely/missing/stackchan-ffmpeg',
    }),
    (error: unknown) => {
      assert.ok(error instanceof NonRetryableError)
      assert.equal(error.reason, 'configuration')
      assert.match(error.message, /FFmpeg/)
      return true
    },
  )
})

test('voice effect preflight rejects an invalid timeout as a configuration error', async () => {
  await assert.rejects(
    assertVoiceEffectAvailable('cute', { probeTimeoutMilliseconds: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof NonRetryableError)
      assert.equal(error.reason, 'configuration')
      assert.match(error.message, /greater than 0/)
      return true
    },
  )
})

test('voice effect preflight rejects a timeout above the Node timer limit', async () => {
  await assert.rejects(
    assertVoiceEffectAvailable('cute', { probeTimeoutMilliseconds: 2_147_483_648 }),
    (error: unknown) => {
      assert.ok(error instanceof NonRetryableError)
      assert.equal(error.reason, 'configuration')
      assert.match(error.message, /at most 2147483647 milliseconds/)
      return true
    },
  )
})

test('voice effect preflight terminates a hung FFmpeg probe', async (context) => {
  if (process.platform === 'win32') {
    context.skip('the voice service is POSIX-only')
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-voice-probe-'))
  const hangingFfmpeg = join(directory, 'ffmpeg-hang')
  try {
    await writeFile(
      hangingFfmpeg,
      '#!/usr/bin/env node\nprocess.stdin.resume()\nsetInterval(() => undefined, 1_000)\n',
    )
    await chmod(hangingFfmpeg, 0o755)

    await assert.rejects(
      assertVoiceEffectAvailable('cute', {
        ffmpegBinary: hangingFfmpeg,
        probeTimeoutMilliseconds: 100,
      }),
      (error: unknown) => {
        assert.ok(error instanceof NonRetryableError)
        assert.equal(error.reason, 'configuration')
        assert.match(error.message, /100 ms.*タイムアウト/)
        return true
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('real rubberband keeps duration and raises a 440 Hz tone by three semitones', async (context) => {
  if (!hasFfmpegRubberband()) {
    context.skip('FFmpeg rubberband filter is unavailable')
    return
  }
  await assertVoiceEffectAvailable('cute')

  async function* source(): AsyncGenerator<PcmChunk> {
    for (let frame = 0; frame < 50; frame += 1) {
      const samples = new Int16Array(960)
      for (let index = 0; index < samples.length; index += 1) {
        const sourceIndex = frame * samples.length + index
        samples[index] = Math.round(
          Math.sin((sourceIndex * 2 * Math.PI * 440) / 48_000) * 12_000,
        )
      }
      yield pcmChunk(encodePcm16Le(samples), 48_000)
    }
  }

  const chunks: Int16Array[] = []
  let sampleCount = 0
  for await (const chunk of createVoiceOutputTransform('cute')(
    source(),
    new AbortController().signal,
  )) {
    assert.equal(chunk.sampleRate, 24_000)
    const samples = decodePcm16Le(chunk.data)
    chunks.push(samples)
    sampleCount += samples.length
  }
  const output = new Int16Array(sampleCount)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }

  assert.ok(
    Math.abs(output.length - 24_000) <= 480,
    `unexpected output length: ${output.length}`,
  )
  const start = Math.floor(output.length * 0.2)
  const end = Math.floor(output.length * 0.8)
  let positiveCrossings = 0
  for (let index = start + 1; index < end; index += 1) {
    if (output[index - 1]! <= 0 && output[index]! > 0) positiveCrossings += 1
  }
  const measuredFrequency = positiveCrossings / ((end - start) / 24_000)
  const expectedFrequency = 440 * CUTE_PITCH_RATIO
  assert.ok(
    Math.abs(measuredFrequency - expectedFrequency) < 8,
    `expected ${expectedFrequency.toFixed(1)} Hz, measured ${measuredFrequency.toFixed(1)} Hz`,
  )
})

function hasFfmpegRubberband(): boolean {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-filters'], {
    encoding: 'utf8',
  })
  if (result.error || result.status !== 0) return false
  return `${result.stdout}${result.stderr}`.includes('rubberband')
}
