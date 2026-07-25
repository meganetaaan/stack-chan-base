export type PcmChunk = {
  data: Uint8Array
  sampleRate: number
  channels: 1
  format: 's16le'
}

import type {
  ConversationRequestEvent,
  ConversationResultEvent,
} from './usb/events.js'

export type ConversationState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'recognizing'
  | 'speaking'
  | 'error'

export type ConversationSessionState =
  | 'standby'
  | 'connecting'
  | 'listening'
  | 'recognizing'
  | 'speaking'
  | 'blocked'

export type ApprovalKind = 'command' | 'fileChange'

export type ApprovalRequest = {
  id: string
  kind: ApprovalKind
  title: string
  summary: string
  detail: string
  truncated: boolean
}

export type ApprovalDecision = 'approve' | 'decline'

export type DeviceCapabilities = {
  maxPayload: number
  microphonePcm: boolean
  speakerPcm: boolean
  speakerCredit: boolean
  speakerRate24000: boolean
  statusIcon: boolean
  statusExtended: boolean
  streamId: boolean
  event: boolean
}

export interface StackChanDevice {
  readonly connected: boolean
  readonly closed: Promise<Error | undefined>

  connect(signal: AbortSignal): Promise<DeviceCapabilities>
  microphone(signal: AbortSignal, onStarted?: () => void): AsyncIterable<PcmChunk>
  stopMicrophone(): Promise<void>
  playAudio(source: AsyncIterable<PcmChunk>, signal: AbortSignal): Promise<void>
  setConversationState(state: ConversationState): Promise<void>
  onConversationRequest(listener: (request: ConversationRequestEvent) => void): () => void
  sendConversationResult(result: ConversationResultEvent): Promise<void>
  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>
  notifyApprovalResolved(requestId: string, message?: string): Promise<void>
  notifyApprovalSuspended(requestId: string): Promise<void>
  close(): Promise<void>
}
