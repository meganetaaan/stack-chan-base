import type { PcmChunk } from '../types.js'

export function decodePcm16Le(bytes: Uint8Array): Int16Array {
  if (bytes.byteLength % 2 !== 0) throw new RangeError('PCM16 payload must contain complete samples')
  const samples = new Int16Array(bytes.byteLength / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true)
  return samples
}

export function encodePcm16Le(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < samples.length; index += 1) view.setInt16(index * 2, samples[index] ?? 0, true)
  return bytes
}

export function pcmChunk(data: Uint8Array, sampleRate: number): PcmChunk {
  return { data, sampleRate, channels: 1, format: 's16le' }
}

export class StreamingPcm16Resampler {
  readonly #sourceSampleRate: number
  readonly #targetSampleRate: number
  #phase = 0
  #previousSample: number | undefined

  constructor(sourceSampleRate: number, targetSampleRate: number) {
    if (!Number.isInteger(sourceSampleRate) || sourceSampleRate <= 0) {
      throw new RangeError('source sample rate must be a positive integer')
    }
    if (!Number.isInteger(targetSampleRate) || targetSampleRate <= 0) {
      throw new RangeError('target sample rate must be a positive integer')
    }
    this.#sourceSampleRate = sourceSampleRate
    this.#targetSampleRate = targetSampleRate
  }

  processBytes(input: Uint8Array): Uint8Array {
    return encodePcm16Le(this.process(decodePcm16Le(input)))
  }

  process(input: Int16Array): Int16Array {
    if (input.length === 0) return new Int16Array()
    if (this.#sourceSampleRate === this.#targetSampleRate) return input.slice()

    let inputStart = 0
    let previous = this.#previousSample
    if (previous === undefined) {
      previous = input[0] ?? 0
      inputStart = 1
    }
    const available = input.length - inputStart
    const inputEnd = available * this.#targetSampleRate
    const capacity = Math.ceil((available * this.#targetSampleRate) / this.#sourceSampleRate)
    const output = new Int16Array(capacity)
    let outputCount = 0
    while (this.#phase < inputEnd) {
      const inputIndex = Math.floor(this.#phase / this.#targetSampleRate)
      const fraction = this.#phase % this.#targetSampleRate
      const first = inputIndex === 0 ? previous : (input[inputStart + inputIndex - 1] ?? previous)
      const second = input[inputStart + inputIndex] ?? first
      const weighted = first * (this.#targetSampleRate - fraction) + second * fraction
      const rounded = weighted >= 0 ? weighted + this.#targetSampleRate / 2 : weighted - this.#targetSampleRate / 2
      output[outputCount] = Math.max(-32768, Math.min(32767, Math.trunc(rounded / this.#targetSampleRate)))
      outputCount += 1
      this.#phase += this.#sourceSampleRate
    }
    this.#phase -= inputEnd
    this.#previousSample = input[input.length - 1] ?? previous
    return output.slice(0, outputCount)
  }

  reset(): void {
    this.#phase = 0
    this.#previousSample = undefined
  }
}

export async function* resamplePcmChunks(
  source: AsyncIterable<PcmChunk>,
  targetSampleRate: number,
): AsyncGenerator<PcmChunk> {
  let resampler: StreamingPcm16Resampler | undefined
  let sourceRate = 0
  for await (const chunk of source) {
    if (chunk.channels !== 1 || chunk.format !== 's16le') throw new Error('only PCM16LE mono is supported')
    if (chunk.sampleRate !== sourceRate) {
      sourceRate = chunk.sampleRate
      resampler = new StreamingPcm16Resampler(sourceRate, targetSampleRate)
    }
    yield pcmChunk(resampler!.processBytes(chunk.data), targetSampleRate)
  }
}
