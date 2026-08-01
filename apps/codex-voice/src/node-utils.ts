import { spawn } from 'node:child_process'

const SYSTEMCTL_TIMEOUT_MS = 10_000

export async function runSystemctl(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('systemctl', args, { stdio: 'inherit' })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, SYSTEMCTL_TIMEOUT_MS)
    const clearTimer = () => clearTimeout(timer)

    child.once('error', (error) => {
      clearTimer()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimer()
      if (timedOut) {
        reject(
          new Error(
            `systemctl ${args.join(' ')} timed out after ${SYSTEMCTL_TIMEOUT_MS} ms`,
          ),
        )
        return
      }
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(
        new Error(
          `systemctl ${args.join(' ')} failed (${
            signal ? `signal ${signal}` : `exit ${String(code)}`
          })`,
        ),
      )
    })
  })
}

export function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
