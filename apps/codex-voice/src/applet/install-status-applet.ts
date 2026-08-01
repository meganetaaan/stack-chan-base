#!/usr/bin/env node

import { constants } from 'node:fs'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { deviceSelectionPath } from '../device-selection.js'
import {
  formatCommandTermination,
  isNodeError,
  runCommand,
  runSystemctl,
  SYSTEMCTL_TIMEOUT_MS,
} from '../node-utils.js'
import { DEFAULT_VOICE_UNIT_NAME } from '../service/control.js'
import {
  buildStackChanStatusAppletServiceUnit,
  enableAndStartUserService,
  GENERATED_UNIT_MARKER,
  stackChanUserServiceUsesDeviceSelection,
  validateSystemdUnitName,
} from '../service/user-service.js'

const DEFAULT_APPLET_UNIT_NAME = 'stackchan-codex-voice-applet.service'

async function main(): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: false,
    strict: true,
    options: {
      gjs: { type: 'string' },
      'unit-name': { type: 'string' },
      'voice-unit-name': { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (parsed.values.help) {
    process.stdout.write(HELP)
    return
  }

  const dryRun = parsed.values['dry-run'] ?? false
  const unitName = validateSystemdUnitName(
    parsed.values['unit-name'] ?? DEFAULT_APPLET_UNIT_NAME,
  )
  const voiceUnitName = validateSystemdUnitName(
    parsed.values['voice-unit-name'] ?? DEFAULT_VOICE_UNIT_NAME,
  )
  if (unitName === voiceUnitName) {
    throw new Error('アプレットunitとCodex voice unitには別の名前を指定してください')
  }
  const gjsPath = parsed.values.gjs
    ? resolve(parsed.values.gjs)
    : await findExecutable('gjs', dryRun)
  const appletPath = fileURLToPath(new URL('./status-applet.js', import.meta.url))
  const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url))
  await Promise.all([
    ...(dryRun ? [] : [access(gjsPath, constants.X_OK)]),
    access(appletPath, constants.R_OK),
    access(cliPath, constants.R_OK),
  ])

  const unit = buildStackChanStatusAppletServiceUnit({
    gjsPath,
    appletPath,
    nodePath: process.execPath,
    cliPath,
    voiceUnitName,
    deviceSelectionPath: deviceSelectionPath(),
  })
  if (dryRun) {
    process.stdout.write(unit)
    return
  }
  await checkAppletRuntime(gjsPath, appletPath)

  const configHome =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), '.config')
  await assertVoiceServiceSupportsDeviceSelection(
    join(configHome, 'systemd', 'user', voiceUnitName),
    deviceSelectionPath(),
  )
  const unitPath = join(configHome, 'systemd', 'user', unitName)
  await assertGeneratedOrMissing(unitPath)
  await mkdir(dirname(unitPath), { recursive: true })
  const temporaryPath = `${unitPath}.tmp-${process.pid}`
  await writeFile(temporaryPath, unit, { encoding: 'utf8', mode: 0o644 })
  await rename(temporaryPath, unitPath)
  await enableAndStartUserService(unitName, runSystemctl)
  console.log(`メニューバーアプレットを導入しました: ${unitName}`)
}

async function assertVoiceServiceSupportsDeviceSelection(
  path: string,
  selectionPath: string,
): Promise<void> {
  let unit: string
  try {
    unit = await readFile(path, 'utf8')
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      throw new Error(
        `Codex voice unitがありません。先にinstall:user-serviceを実行してください: ${path}`,
      )
    }
    throw error
  }
  if (!stackChanUserServiceUsesDeviceSelection(unit, selectionPath)) {
    throw new Error(
      'Codex voice unitが接続先選択に対応していません。先にinstall:user-serviceを再実行してください',
    )
  }
}

async function findExecutable(
  name: string,
  allowMissing = false,
): Promise<string> {
  if (isAbsolute(name)) {
    await access(name, constants.X_OK)
    return name
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through PATH.
    }
  }
  if (allowMissing) return join('/usr/bin', name)
  throw new Error(
    'gjsが見つかりません。GJS、GTK 3、AyatanaAppIndicator3を導入してください',
  )
}

async function checkAppletRuntime(gjsPath: string, appletPath: string): Promise<void> {
  const result = await runCommand(gjsPath, [appletPath, '--check'], {
    output: 'capture',
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
    timeoutMessage:
      `アプレット実行環境の確認が${SYSTEMCTL_TIMEOUT_MS} msでタイムアウトしました`,
  })
  if (result.exitCode === 0) return
  throw new Error(
    `アプレット実行環境を利用できません（${formatCommandTermination(result)}）: ${result.stderr.trim()}`,
  )
}

async function assertGeneratedOrMissing(path: string): Promise<void> {
  let current: string
  try {
    current = await readFile(path, 'utf8')
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  if (!current.startsWith(GENERATED_UNIT_MARKER)) {
    throw new Error(
      `既存のunitはこのインストーラの生成物ではないため上書きしません: ${path}`,
    )
  }
}

const HELP = `Usage: stackchan-codex-voice-install-applet [options]

Codex voice serviceのON/OFFと接続先CoreS3を操作する
Ayatana AppIndicatorをsystemd --userサービスとして導入します。

Options:
  --gjs <path>             GJS executable（通常は自動検出）
  --unit-name <name>       アプレットのsystemd unit名
  --voice-unit-name <name> 操作対象のCodex voice unit名
  --dry-run                unitを表示するだけで書き込まない
  -h, --help               このヘルプを表示
`

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
