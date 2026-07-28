export const MIN_RETRY_MILLISECONDS = 500
export const MAX_RETRY_MILLISECONDS = 30_000

export type RetryDisposition = 'retry' | 'stop'

export type NonRetryableReason =
  | 'configuration'
  | 'protocol'

export class NonRetryableError extends Error {
  readonly reason: NonRetryableReason

  constructor(reason: NonRetryableReason, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'NonRetryableError'
    this.reason = reason
  }
}

export function retryDisposition(error: unknown, aborted = false): RetryDisposition {
  if (aborted) return 'stop'
  if (error instanceof NonRetryableError) return 'stop'
  if (isNonRetryableRpcError(error)) return 'stop'
  if (isNonRetryableRealtimeMessage(errorMessage(error))) return 'stop'
  return 'retry'
}

export function isNonRetryableRealtimeMessage(message: string): boolean {
  // app-server 0.145 exposes thread/realtime/error as { threadId, message }
  // without a structured error code or retry-after value. Keep backend text
  // matching isolated here so a future protocol field can replace it.
  const normalized = message.trim().replace(/\s+/g, ' ').toLowerCase()
  return (
    normalized.includes('you have reached your usage limit') ||
    normalized.includes('realtime conversation requires api key auth')
  )
}

export class ExponentialRetryBackoff {
  readonly #minimumMilliseconds: number
  readonly #maximumMilliseconds: number
  #nextMilliseconds: number

  constructor(
    minimumMilliseconds = MIN_RETRY_MILLISECONDS,
    maximumMilliseconds = MAX_RETRY_MILLISECONDS,
  ) {
    if (
      !Number.isFinite(minimumMilliseconds) ||
      !Number.isFinite(maximumMilliseconds) ||
      minimumMilliseconds <= 0 ||
      maximumMilliseconds < minimumMilliseconds
    ) {
      throw new RangeError('retry backoff bounds must be positive and ordered')
    }
    this.#minimumMilliseconds = minimumMilliseconds
    this.#maximumMilliseconds = maximumMilliseconds
    this.#nextMilliseconds = minimumMilliseconds
  }

  afterFailure(attemptDurationMilliseconds: number): number {
    if (!Number.isFinite(attemptDurationMilliseconds) || attemptDurationMilliseconds < 0) {
      throw new RangeError('attempt duration must be a non-negative finite number')
    }
    if (attemptDurationMilliseconds >= this.#maximumMilliseconds) {
      this.#nextMilliseconds = this.#minimumMilliseconds
    }
    const delay = this.#nextMilliseconds
    this.#nextMilliseconds = Math.min(
      this.#maximumMilliseconds,
      this.#nextMilliseconds * 2,
    )
    return delay
  }
}

function isNonRetryableRpcError(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    error.name !== 'RpcError' ||
    !('code' in error) ||
    typeof error.code !== 'number'
  ) {
    return false
  }
  return error.code === -32_600 || error.code === -32_601 || error.code === -32_602
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
