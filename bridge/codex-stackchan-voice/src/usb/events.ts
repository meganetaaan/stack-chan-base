import type { ApprovalDecision, ApprovalRequest } from '../types.js'

export const STACKCHAN_EVENT_SCHEMA = 'stackchan.event.v1'
export const STACKCHAN_APPROVAL_DETAIL_MAX_BYTES = 16 * 1024

export type ApprovalRequestEvent = {
  schema: typeof STACKCHAN_EVENT_SCHEMA
  type: 'approval.request'
  requestId: string
  kind: ApprovalRequest['kind']
  title: string
  summary: string
  detail: string
  truncated: boolean
}

export type ApprovalPresentedEvent = {
  schema: typeof STACKCHAN_EVENT_SCHEMA
  type: 'approval.presented'
  requestId: string
}

export type ApprovalResponseEvent = {
  schema: typeof STACKCHAN_EVENT_SCHEMA
  type: 'approval.response'
  requestId: string
  decision: ApprovalDecision
}

export type ApprovalResolvedEvent = {
  schema: typeof STACKCHAN_EVENT_SCHEMA
  type: 'approval.resolved'
  requestId: string
  message?: string
}

export type ApprovalSuspendedEvent = {
  schema: typeof STACKCHAN_EVENT_SCHEMA
  type: 'approval.suspended'
  requestId: string
}

export type StackChanApplicationEvent =
  | ApprovalRequestEvent
  | ApprovalPresentedEvent
  | ApprovalResponseEvent
  | ApprovalResolvedEvent
  | ApprovalSuspendedEvent

export function approvalRequestEvent(request: ApprovalRequest): ApprovalRequestEvent {
  return {
    schema: STACKCHAN_EVENT_SCHEMA,
    type: 'approval.request',
    requestId: request.id,
    kind: request.kind,
    title: request.title,
    summary: request.summary,
    detail: request.detail,
    truncated: request.truncated,
  }
}

export function parseStackChanApplicationEvent(serialized: string): StackChanApplicationEvent | undefined {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.schema !== STACKCHAN_EVENT_SCHEMA || typeof value.type !== 'string') {
    return undefined
  }
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) return undefined
  switch (value.type) {
    case 'approval.request':
      if (
        (value.kind !== 'command' && value.kind !== 'fileChange') ||
        typeof value.title !== 'string' ||
        typeof value.summary !== 'string' ||
        typeof value.detail !== 'string' ||
        typeof value.truncated !== 'boolean'
      ) {
        return undefined
      }
      return value as ApprovalRequestEvent
    case 'approval.presented':
      return value as ApprovalPresentedEvent
    case 'approval.response':
      if (value.decision !== 'approve' && value.decision !== 'decline') return undefined
      return value as ApprovalResponseEvent
    case 'approval.resolved':
      if (value.message !== undefined && typeof value.message !== 'string') return undefined
      return value as ApprovalResolvedEvent
    case 'approval.suspended':
      return value as ApprovalSuspendedEvent
    default:
      return undefined
  }
}

export function truncateUtf8(value: string, maxBytes = STACKCHAN_APPROVAL_DETAIL_MAX_BYTES): {
  value: string
  truncated: boolean
} {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(value)
  if (bytes.byteLength <= maxBytes) return { value, truncated: false }
  let end = maxBytes
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) end -= 1
  return {
    value: new TextDecoder().decode(bytes.slice(0, end)),
    truncated: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
