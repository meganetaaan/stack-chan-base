import type { PcmChunk, StackChanDevice } from '../types.js'
import { encodePcm16Le, pcmChunk } from './pcm.js'

export const CONVERSATION_CHIME_SAMPLE_RATE = 24_000
export const CONVERSATION_CHIME_GAP_MILLISECONDS = 25

const CONVERSATION_CHIME_AMPLITUDE = 8_192
const CONVERSATION_CHIME_FADE_MILLISECONDS = 5

export type ConversationChimeKind = 'start' | 'stop'

export type ConversationChimeNote = {
  frequencyHz: number
  durationMilliseconds: number
}

export type ConversationChimePlayer = {
  play(kind: ConversationChimeKind, signal: AbortSignal): Promise<void>
}

const LOW_NOTE: ConversationChimeNote = {
  frequencyHz: 660,
  durationMilliseconds: 90,
}
const HIGH_NOTE: ConversationChimeNote = {
  frequencyHz: 990,
  durationMilliseconds: 150,
}
const START_NOTES: readonly ConversationChimeNote[] = [LOW_NOTE, HIGH_NOTE]
const STOP_NOTES: readonly ConversationChimeNote[] = [
  { ...HIGH_NOTE, durationMilliseconds: 90 },
  { ...LOW_NOTE, durationMilliseconds: 150 },
]

export function conversationChimeNotes(
  kind: ConversationChimeKind,
): readonly ConversationChimeNote[] {
  return kind === 'start' ? START_NOTES : STOP_NOTES
}

export function renderConversationChime(kind: ConversationChimeKind): PcmChunk {
  const notes = conversationChimeNotes(kind)
  const gapSamples = millisecondsToSamples(
    CONVERSATION_CHIME_GAP_MILLISECONDS,
  )
  const sampleCount =
    notes.reduce(
      (total, note) =>
        total + millisecondsToSamples(note.durationMilliseconds),
      0,
    ) + gapSamples
  const samples = new Int16Array(sampleCount)
  let offset = 0
  for (const [index, note] of notes.entries()) {
    const toneSamples = millisecondsToSamples(note.durationMilliseconds)
    renderTone(samples, offset, toneSamples, note.frequencyHz)
    offset += toneSamples
    if (index < notes.length - 1) offset += gapSamples
  }
  return pcmChunk(encodePcm16Le(samples), CONVERSATION_CHIME_SAMPLE_RATE)
}

export class UsbConversationChimePlayer implements ConversationChimePlayer {
  readonly #device: StackChanDevice

  constructor(device: StackChanDevice) {
    this.#device = device
  }

  async play(
    kind: ConversationChimeKind,
    signal: AbortSignal,
  ): Promise<void> {
    const chunk = renderConversationChime(kind)
    await this.#device.playAudio(oneChunk(chunk), signal)
  }
}

function renderTone(
  output: Int16Array,
  offset: number,
  sampleCount: number,
  frequencyHz: number,
): void {
  const fadeSamples = millisecondsToSamples(
    CONVERSATION_CHIME_FADE_MILLISECONDS,
  )
  for (let index = 0; index < sampleCount; index += 1) {
    const attack = Math.min(1, index / fadeSamples)
    const release = Math.min(1, (sampleCount - index - 1) / fadeSamples)
    const envelope = Math.min(attack, release)
    output[offset + index] = Math.round(
      Math.sin(
        (2 * Math.PI * frequencyHz * index) /
          CONVERSATION_CHIME_SAMPLE_RATE,
      ) *
        CONVERSATION_CHIME_AMPLITUDE *
        envelope,
    )
  }
}

function millisecondsToSamples(milliseconds: number): number {
  return (CONVERSATION_CHIME_SAMPLE_RATE * milliseconds) / 1_000
}

async function* oneChunk(chunk: PcmChunk): AsyncGenerator<PcmChunk> {
  yield chunk
}
