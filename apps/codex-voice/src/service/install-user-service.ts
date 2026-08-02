#!/usr/bin/env node

import { constants } from 'node:fs'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { assertVoiceEffectAvailable } from '../audio/voice-effect.js'
import {
  deviceSelectionPath,
  writeSelectedDeviceId,
} from '../device-selection.js'
import { isNodeError, runSystemctl } from '../node-utils.js'
import { NonRetryableError } from '../retry-policy.js'
import { discoverStackChanDeviceId } from '../usb/device.js'
import {
  buildStackChanUserServiceUnit,
  enableAndStartUserService,
  GENERATED_UNIT_MARKER,
  validateSystemdUnitName,
} from './user-service.js'
import { loadActiveWorkspace } from '../workspace.js'

const DEFAULT_UNIT_NAME = 'stackchan-codex-voice.service'

async function main(): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: false,
    strict: true,
    options: {
      port: { type: 'string' },
      socket: { type: 'string' },
      'unit-name': { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (parsed.values.help) {
    process.stdout.write(HELP)
    return
  }

  const workspace = await loadActiveWorkspace()
  await assertVoiceEffectAvailable(workspace.session.voiceEffect)
  const portPath = parsed.values.port ?? '/dev/ttyACM0'
  const unitName = validateSystemdUnitName(
    parsed.values['unit-name'] ?? DEFAULT_UNIT_NAME,
  )
  const deviceId = await discoverStackChanDeviceId(portPath)
  const selectionPath = deviceSelectionPath()
  const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url))
  await access(cliPath, constants.R_OK)
  const unit = buildStackChanUserServiceUnit({
    nodePath: process.execPath,
    cliPath,
    deviceSelectionPath: selectionPath,
    ...(parsed.values.socket
      ? { socketPath: parsed.values.socket }
      : {}),
  })

  if (parsed.values['dry-run']) {
    process.stdout.write(unit)
    return
  }

  const configHome =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), '.config')
  const unitPath = join(configHome, 'systemd', 'user', unitName)
  await assertGeneratedOrMissing(unitPath)
  await mkdir(dirname(unitPath), { recursive: true })
  const temporaryPath = `${unitPath}.tmp-${process.pid}`
  await writeFile(temporaryPath, unit, { encoding: 'utf8', mode: 0o644 })
  await rename(temporaryPath, unitPath)
  await writeSelectedDeviceId(deviceId, selectionPath)
  await enableAndStartUserService(unitName, runSystemctl)
  console.log(
    `systemd user serviceを導入しました: ${unitName} deviceId=${deviceId} workspace=${workspace.root}`,
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

const HELP = `Usage: stackchan-codex-voice-install-service [options]

/dev/ttyACM0のUSB serial numberを取得し、Codex音声ブリッジを
systemd --userサービスとして導入します。unitは選択ファイルのdevice IDを
起動時に読むため、別のCoreS3へ自動接続せず、アプレットから変更できます。

Options:
  --port <path>      ID取得元（既定: /dev/ttyACM0）
  --socket <path>    app-server daemonのUnix socket
  --unit-name <name> systemd unit名
  --dry-run          unitを表示するだけで書き込まない
  -h, --help         このヘルプを表示
`

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = error instanceof NonRetryableError ? 78 : 1
})
