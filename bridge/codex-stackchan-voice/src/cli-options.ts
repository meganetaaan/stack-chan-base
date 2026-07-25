import { parseArgs } from 'node:util'
import { resolve } from 'node:path'

export type CliOptions = {
  cwd: string
  threadId?: string
  portPath?: string
  voice?: string
  socketPath?: string
}

export type ParsedCliOptions =
  | { kind: 'run'; options: CliOptions }
  | { kind: 'help' }
  | { kind: 'version' }

export function parseCliOptions(args: string[]): ParsedCliOptions {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      cwd: { type: 'string' },
      thread: { type: 'string' },
      port: { type: 'string' },
      voice: { type: 'string' },
      socket: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })
  if (parsed.values.help) return { kind: 'help' }
  if (parsed.values.version) return { kind: 'version' }
  return {
    kind: 'run',
    options: {
      cwd: resolve(parsed.values.cwd ?? process.cwd()),
      ...(parsed.values.thread ? { threadId: parsed.values.thread } : {}),
      ...(parsed.values.port ? { portPath: parsed.values.port } : {}),
      ...(parsed.values.voice ? { voice: parsed.values.voice } : {}),
      ...(parsed.values.socket ? { socketPath: parsed.values.socket } : {}),
    },
  }
}

export const CLI_HELP = `Usage: stackchan-codex-voice [options]

CoreS3のUSB音声と承認UIを、既存のCodex app-server daemonへ接続します。

Options:
  --cwd <path>       Codex threadの作業ディレクトリ（既定: 現在のディレクトリ）
  --thread <id>      既存threadを再開（省略時は新規thread）
  --port <path>      CoreS3 USB serial port（省略時はVID/PIDで自動検出）
  --voice <name>     Realtime voice（省略時はapp-server既定値）
  --socket <path>    app-server daemonのUnix socket
  -h, --help         このヘルプを表示
  -v, --version      バージョンを表示
`
