export type AppServerThreadActiveFlag =
  | 'waitingOnApproval'
  | 'waitingOnUserInput'

export type AppServerThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: AppServerThreadActiveFlag[] }

export function isAppServerThreadStatus(
  value: unknown,
): value is AppServerThreadStatus {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (
    value.type === 'notLoaded' ||
    value.type === 'idle' ||
    value.type === 'systemError'
  ) {
    return true
  }
  return (
    value.type === 'active' &&
    Array.isArray(value.activeFlags) &&
    value.activeFlags.every(isAppServerThreadActiveFlag)
  )
}

function isAppServerThreadActiveFlag(
  value: unknown,
): value is AppServerThreadActiveFlag {
  return value === 'waitingOnApproval' || value === 'waitingOnUserInput'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
