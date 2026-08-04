import {
  runCommand,
  SYSTEMCTL_TIMEOUT_MS,
} from '../node-utils.js'
import { validateSystemdUnitName } from './user-service.js'

export const DEFAULT_VOICE_UNIT_NAME = 'stackchan-codex-voice.service'

export type UserServiceStatus = {
  unitName: string
  loadState: string
  activeState: string
  subState: string
  installed: boolean
  active: boolean
}

export type SystemctlRunner = (args: string[]) => Promise<void>
export type SystemctlQueryRunner = (
  args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export async function queryUserServiceStatus(
  unitName: string,
  runSystemctl: SystemctlQueryRunner = runSystemctlQuery,
): Promise<UserServiceStatus> {
  const validated = validateSystemdUnitName(unitName)
  const result = await runSystemctl([
    '--user',
    'show',
    validated,
    '--property=LoadState',
    '--property=ActiveState',
    '--property=SubState',
  ])
  if (result.exitCode !== 0) {
    throw new Error(
      `systemctl --user show ${validated} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    )
  }
  return parseUserServiceStatus(validated, result.stdout)
}

export function parseUserServiceStatus(
  unitName: string,
  output: string,
): UserServiceStatus {
  const fields = new Map<string, string>()
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf('=')
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1))
  }
  const loadState = fields.get('LoadState')
  const activeState = fields.get('ActiveState')
  const subState = fields.get('SubState')
  if (loadState === undefined || activeState === undefined || subState === undefined) {
    throw new Error(`systemctl showの応答に必要な状態がありません: ${output.trim()}`)
  }
  return {
    unitName,
    loadState,
    activeState,
    subState,
    installed: loadState !== 'not-found',
    active: activeState === 'active',
  }
}

export async function startUserService(
  unitName: string,
  runSystemctl: SystemctlRunner = runSystemctlCommand,
): Promise<void> {
  const validated = validateSystemdUnitName(unitName)
  await runSystemctl(['--user', 'start', validated])
  await assertUserServiceActive(validated, runSystemctl)
}

export async function stopUserService(
  unitName: string,
  runSystemctl: SystemctlRunner = runSystemctlCommand,
): Promise<void> {
  await runSystemctl(['--user', 'stop', validateSystemdUnitName(unitName)])
}

export async function restartUserService(
  unitName: string,
  runSystemctl: SystemctlRunner = runSystemctlCommand,
): Promise<void> {
  const validated = validateSystemdUnitName(unitName)
  await runSystemctl(['--user', 'restart', validated])
  await assertUserServiceActive(validated, runSystemctl)
}

export async function tryRestartUserService(
  unitName: string,
  runSystemctl: SystemctlRunner = runSystemctlCommand,
): Promise<void> {
  await runSystemctl([
    '--user',
    'try-restart',
    validateSystemdUnitName(unitName),
  ])
}

export async function runSystemctlCommand(args: string[]): Promise<void> {
  const result = await runCommand('systemctl', args, {
    output: 'inherit',
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
  })
  if (result.exitCode === null) {
    throw new Error(
      `systemctl ${args.join(' ')} stopped by ${String(result.signal)}`,
    )
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `systemctl ${args.join(' ')} failed (exit ${result.exitCode})`,
    )
  }
}

async function assertUserServiceActive(
  unitName: string,
  runSystemctl: SystemctlRunner,
): Promise<void> {
  try {
    await runSystemctl(['--user', 'is-active', '--quiet', unitName])
  } catch (error) {
    throw new Error(
      `systemd user serviceがactiveになりませんでした: ${unitName}。systemctl --user status ${unitName} または journalctl --user-unit ${unitName} を確認してください`,
      { cause: error },
    )
  }
}

async function runSystemctlQuery(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await runCommand('systemctl', args, {
    output: 'capture',
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
  })
  if (result.exitCode === null) {
    throw new Error(
      `systemctl ${args.join(' ')} stopped by ${String(result.signal)}`,
    )
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}
