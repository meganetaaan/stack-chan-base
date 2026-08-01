import { spawn } from 'node:child_process'

export const SYSTEMCTL_TIMEOUT_MS = 10_000

export type CommandOutput = 'inherit' | 'capture'

export type CommandResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export type RunCommandOptions = {
  output: CommandOutput
  timeoutMs: number
  timeoutMessage?: string
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio:
        options.output === 'inherit'
          ? 'inherit'
          : ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    if (options.output === 'capture') {
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk
      })
    }

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(
          new Error(
            options.timeoutMessage ??
              `${command} ${args.join(' ')} timed out after ${options.timeoutMs} ms`,
          ),
        )
        return
      }
      resolve({ exitCode, signal, stdout, stderr })
    })
  })
}

export async function runSystemctl(args: string[]): Promise<void> {
  const result = await runCommand('systemctl', args, {
    output: 'inherit',
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
  })
  if (result.exitCode === 0) return
  throw new Error(
    `systemctl ${args.join(' ')} failed (${formatCommandTermination(result)})`,
  )
}

export function formatCommandTermination(result: CommandResult): string {
  return result.signal
    ? `signal ${result.signal}`
    : `exit ${String(result.exitCode)}`
}

export function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
