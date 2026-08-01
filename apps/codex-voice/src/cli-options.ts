import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

export type ApplicationRunOptions = {
  portPath?: string
  deviceId?: string
  socketPath?: string
  startImmediately?: boolean
}

export type RunOptions = ApplicationRunOptions & {
  deviceSelectionPath?: string
}

export type CliCommand =
  | { kind: 'run'; options: RunOptions }
  | { kind: 'config-init'; workspacePath: string }
  | { kind: 'config-show'; workspacePath: string }
  | { kind: 'config-validate'; workspacePath: string }
  | { kind: 'config-set-voice'; workspacePath: string; voice: string }
  | { kind: 'config-unset-voice'; workspacePath: string }
  | { kind: 'workspace-use'; workspacePath: string }
  | { kind: 'workspace-current' }
  | { kind: 'workspace-apply' }
  | { kind: 'voice-list'; socketPath?: string }
  | { kind: 'status'; json: boolean; unitName?: string; deviceSelectionPath?: string }
  | { kind: 'service-start'; unitName?: string }
  | { kind: 'service-stop'; unitName?: string }
  | { kind: 'device-list'; json: boolean; deviceSelectionPath?: string }
  | { kind: 'device-use'; deviceId: string; unitName?: string; deviceSelectionPath?: string }
  | { kind: 'help' }
  | { kind: 'version' }

export function parseCliCommand(args: string[]): CliCommand {
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    return { kind: 'help' }
  }
  if (args[0] === '--version' || args[0] === '-v') return { kind: 'version' }
  const [command, ...rest] = args
  switch (command) {
    case 'run':
      return parseRun(rest)
    case 'config':
      return parseConfig(rest)
    case 'workspace':
      return parseWorkspace(rest)
    case 'voice':
      return parseVoice(rest)
    case 'status':
      return parseStatus(rest)
    case 'service':
      return parseService(rest)
    case 'device':
      return parseDevice(rest)
    default:
      throw new Error(`未知のcommandです: ${command ?? ''}`)
  }
}

function parseRun(args: string[]): CliCommand {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      port: { type: 'string' },
      'device-id': { type: 'string' },
      'device-selection': { type: 'string' },
      socket: { type: 'string' },
      'start-immediately': { type: 'boolean' },
    },
  })
  const selectors = [
    parsed.values.port,
    parsed.values['device-id'],
    parsed.values['device-selection'],
  ].filter((value) => value !== undefined)
  if (selectors.length > 1) {
    throw new Error('--port, --device-id, and --device-selection are mutually exclusive')
  }
  return {
    kind: 'run',
    options: {
      ...(parsed.values.port ? { portPath: parsed.values.port } : {}),
      ...(parsed.values['device-id'] ? { deviceId: parsed.values['device-id'] } : {}),
      ...(parsed.values['device-selection']
        ? { deviceSelectionPath: resolve(parsed.values['device-selection']) }
        : {}),
      ...(parsed.values.socket ? { socketPath: parsed.values.socket } : {}),
      ...(parsed.values['start-immediately'] ? { startImmediately: true } : {}),
    },
  }
}

function parseConfig(args: string[]): CliCommand {
  const [action, ...rest] = args
  switch (action) {
    case 'init':
    case 'show':
    case 'validate': {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: {},
      })
      assertAtMostOnePath(parsed.positionals)
      const workspacePath = resolve(parsed.positionals[0] ?? process.cwd())
      return {
        kind:
          action === 'init'
            ? 'config-init'
            : action === 'show'
              ? 'config-show'
              : 'config-validate',
        workspacePath,
      }
    }
    case 'set': {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: {
          workspace: { type: 'string' },
        },
      })
      if (parsed.positionals.length !== 2 || parsed.positionals[0] !== 'voice') {
        throw new Error('Usage: stackchan-codex-voice config set voice <name> [--workspace DIR]')
      }
      return {
        kind: 'config-set-voice',
        workspacePath: resolve(parsed.values.workspace ?? process.cwd()),
        voice: parsed.positionals[1]!,
      }
    }
    case 'unset': {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: {
          workspace: { type: 'string' },
        },
      })
      if (parsed.positionals.length !== 1 || parsed.positionals[0] !== 'voice') {
        throw new Error('Usage: stackchan-codex-voice config unset voice [--workspace DIR]')
      }
      return {
        kind: 'config-unset-voice',
        workspacePath: resolve(parsed.values.workspace ?? process.cwd()),
      }
    }
    default:
      throw new Error(`未知のconfig commandです: ${action ?? ''}`)
  }
}

function parseWorkspace(args: string[]): CliCommand {
  const [action, ...rest] = args
  switch (action) {
    case 'use':
      if (rest.length !== 1) {
        throw new Error('Usage: stackchan-codex-voice workspace use <DIR>')
      }
      return { kind: 'workspace-use', workspacePath: resolve(rest[0]!) }
    case 'current':
      if (rest.length !== 0) throw new Error('workspace currentは引数を取りません')
      return { kind: 'workspace-current' }
    case 'apply':
      if (rest.length !== 0) throw new Error('workspace applyは引数を取りません')
      return { kind: 'workspace-apply' }
    default:
      throw new Error(`未知のworkspace commandです: ${action ?? ''}`)
  }
}

function parseVoice(args: string[]): CliCommand {
  const [action, ...rest] = args
  if (action !== 'list') throw new Error(`未知のvoice commandです: ${action ?? ''}`)
  const parsed = parseArgs({
    args: rest,
    allowPositionals: false,
    strict: true,
    options: {
      socket: { type: 'string' },
    },
  })
  return {
    kind: 'voice-list',
    ...(parsed.values.socket ? { socketPath: parsed.values.socket } : {}),
  }
}

function parseStatus(args: string[]): CliCommand {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      json: { type: 'boolean' },
      'unit-name': { type: 'string' },
      'device-selection': { type: 'string' },
    },
  })
  return {
    kind: 'status',
    json: parsed.values.json ?? false,
    ...(parsed.values['unit-name'] ? { unitName: parsed.values['unit-name'] } : {}),
    ...(parsed.values['device-selection']
      ? { deviceSelectionPath: resolve(parsed.values['device-selection']) }
      : {}),
  }
}

function parseService(args: string[]): CliCommand {
  const [action, ...rest] = args
  if (action !== 'start' && action !== 'stop') {
    throw new Error(`未知のservice commandです: ${action ?? ''}`)
  }
  const parsed = parseArgs({
    args: rest,
    allowPositionals: false,
    strict: true,
    options: {
      'unit-name': { type: 'string' },
    },
  })
  return {
    kind: action === 'start' ? 'service-start' : 'service-stop',
    ...(parsed.values['unit-name'] ? { unitName: parsed.values['unit-name'] } : {}),
  }
}

function parseDevice(args: string[]): CliCommand {
  const [action, ...rest] = args
  if (action === 'list') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        json: { type: 'boolean' },
        'device-selection': { type: 'string' },
      },
    })
    return {
      kind: 'device-list',
      json: parsed.values.json ?? false,
      ...(parsed.values['device-selection']
        ? { deviceSelectionPath: resolve(parsed.values['device-selection']) }
        : {}),
    }
  }
  if (action === 'use') {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        'unit-name': { type: 'string' },
        'device-selection': { type: 'string' },
      },
    })
    if (parsed.positionals.length !== 1) {
      throw new Error('Usage: stackchan-codex-voice device use <device-id>')
    }
    return {
      kind: 'device-use',
      deviceId: parsed.positionals[0]!,
      ...(parsed.values['unit-name'] ? { unitName: parsed.values['unit-name'] } : {}),
      ...(parsed.values['device-selection']
        ? { deviceSelectionPath: resolve(parsed.values['device-selection']) }
        : {}),
    }
  }
  throw new Error(`未知のdevice commandです: ${action ?? ''}`)
}

function assertAtMostOnePath(positionals: string[]): void {
  if (positionals.length > 1) throw new Error('workspace pathは一つだけ指定できます')
}

export const CLI_HELP = `Usage: stackchan-codex-voice <command> [options]

CoreS3のUSB音声と承認UIを、既存のCodex app-server daemonへ接続します。
会話設定はアクティブworkspaceの.stackchan/session.tomlから読み込みます。

Commands:
  run [options]                    音声ブリッジを起動
  config init [DIR]               workspace設定を初期化
  config show [DIR]               workspace設定を表示
  config validate [DIR]           workspace設定を検証
  config set voice <name>         Realtime voiceを設定
  config unset voice              app-server既定voiceへ戻す
  workspace use <DIR>             workspaceを選択して稼働中serviceへ反映
  workspace current               選択中workspaceを表示
  workspace apply                 選択中workspaceをserviceへ再反映
  voice list [--socket <path>]     利用可能なRealtime voiceを表示
  status [--json]                  serviceとUSBデバイスの状態を表示
  service start                    Codex voice serviceをON
  service stop                     Codex voice serviceをOFF
  device list [--json]             接続中のCoreS3を表示
  device use <device-id>           接続先CoreS3を選択

Run options:
  --port <path>       CoreS3 USB serial port（--device-idと排他）
  --device-id <id>   USB serial numberでCoreS3を固定（常駐運用向け）
  --device-selection <path>
                      選択ファイルからUSB serial numberを読む（service用）
  --socket <path>    app-server daemonのUnix socket
  --start-immediately
                      タッチを待たず接続（互換・診断用途）
  -h, --help         このヘルプを表示
  -v, --version      バージョンを表示
`
