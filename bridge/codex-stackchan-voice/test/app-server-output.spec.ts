import { describe, expect, it } from 'vitest'
import { parseAppServerOutputAudio } from '../src/audio/app-server-output.js'

type ExpectedResult = 'accept' | 'ignore' | 'reject'

const DATA_CASES = [
  { data: 'AAA=', kind: 'even' },
  { data: 'AA==', kind: 'odd' },
  { data: 'A===', kind: 'invalid' },
] as const

describe('app-server realtime output contract', () => {
  it('classifies all 72 metadata boundary states', () => {
    let states = 0
    for (const matchingThread of [false, true]) {
      for (const sampleRate of [0, 24_000]) {
        for (const numChannels of [1, 2]) {
          for (const dataCase of DATA_CASES) {
            for (const samplesPerChannel of [null, 1, 2]) {
              states += 1
              const params = {
                threadId: matchingThread ? 'thread-1' : 'thread-other',
                audio: {
                  data: dataCase.data,
                  sampleRate,
                  numChannels,
                  samplesPerChannel,
                  itemId: null,
                },
              }
              const expected: ExpectedResult = !matchingThread
                ? 'ignore'
                : sampleRate === 24_000 &&
                    numChannels === 1 &&
                    dataCase.kind === 'even' &&
                    (samplesPerChannel === null || samplesPerChannel === 1)
                  ? 'accept'
                  : 'reject'
              expect(classify(() => parseAppServerOutputAudio(params, 'thread-1'))).toBe(expected)
            }
          }
        }
      }
    }
    expect(states).toBe(72)
  })

  it('detects a negative control that trusts malformed audio metadata', () => {
    const malformed = {
      threadId: 'thread-1',
      audio: {
        data: 'AAA=',
        sampleRate: 24_000,
        numChannels: 2,
        samplesPerChannel: 1,
        itemId: null,
      },
    }
    const expected = classify(() => parseAppServerOutputAudio(malformed, 'thread-1'))
    const broken = classify(() => ({
      data: Uint8Array.from(Buffer.from(malformed.audio.data, 'base64')),
      sampleRate: malformed.audio.sampleRate,
      channels: 1 as const,
      format: 's16le' as const,
    }))

    expect(expected).toBe('reject')
    expect(broken).toBe('accept')
  })
})

function classify(action: () => unknown): ExpectedResult {
  try {
    return action() === undefined ? 'ignore' : 'accept'
  } catch {
    return 'reject'
  }
}
