import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_CHIME_GAP_MILLISECONDS,
  CONVERSATION_CHIME_SAMPLE_RATE,
  conversationChimeNotes,
  renderConversationChime,
  UsbConversationChimePlayer,
} from '../src/audio/conversation-chime.js'
import { decodePcm16Le } from '../src/audio/pcm.js'
import type { PcmChunk, StackChanDevice } from '../src/types.js'

describe('conversation chimes', () => {
  it('uses ascending notes for start and descending notes for stop', () => {
    const start = conversationChimeNotes('start')
    const stop = conversationChimeNotes('stop')

    expect(start[0]!.frequencyHz).toBeLessThan(start[1]!.frequencyHz)
    expect(stop[0]!.frequencyHz).toBeGreaterThan(stop[1]!.frequencyHz)
    expect(stop.map((note) => note.frequencyHz)).toEqual(
      start.map((note) => note.frequencyHz).reverse(),
    )
  })

  it('renders bounded 24 kHz mono PCM with the documented note and gap duration', () => {
    for (const kind of ['start', 'stop'] as const) {
      const notes = conversationChimeNotes(kind)
      const chunk = renderConversationChime(kind)
      const samples = decodePcm16Le(chunk.data)
      const expectedMilliseconds =
        notes.reduce((total, note) => total + note.durationMilliseconds, 0) +
        CONVERSATION_CHIME_GAP_MILLISECONDS

      expect(chunk).toMatchObject({
        sampleRate: CONVERSATION_CHIME_SAMPLE_RATE,
        channels: 1,
        format: 's16le',
      })
      expect(samples).toHaveLength(
        (CONVERSATION_CHIME_SAMPLE_RATE * expectedMilliseconds) / 1_000,
      )
      expect(Math.max(...samples.map((sample) => Math.abs(sample)))).toBeLessThanOrEqual(
        8_192,
      )
      expect(samples.some((sample) => sample !== 0)).toBe(true)
    }
  })

  it('plays one complete chime through the existing USB speaker session', async () => {
    const played: PcmChunk[] = []
    let receivedSignal: AbortSignal | undefined
    const device = {
      async playAudio(source: AsyncIterable<PcmChunk>, signal: AbortSignal) {
        receivedSignal = signal
        for await (const chunk of source) played.push(chunk)
      },
    } as StackChanDevice
    const player = new UsbConversationChimePlayer(device)
    const controller = new AbortController()

    await player.play('start', controller.signal)

    expect(receivedSignal).toBe(controller.signal)
    expect(played).toEqual([renderConversationChime('start')])
  })
})
