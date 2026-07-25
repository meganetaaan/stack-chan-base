#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { discoverStackChanDeviceId } from '../usb/device.js'
import {
  buildStackChanUserServiceUnit,
  enableAndStartUserService,
  GENERATED_UNIT_MARKER,
  validateSystemdUnitName,
} from './user-service.js'

const DEFAULT_UNIT_NAME = 'stackchan-codex-voice.service'

async function main(): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: false,
    strict: true,
    options: {
      cwd: { type: 'string' },
      port: { type: 'string' },
      socket: { type: 'string' },
      voice: { type: 'string' },
      'unit-name': { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (parsed.values.help) {
    process.stdout.write(HELP)
    return
  }

  const cwd = resolve(parsed.values.cwd ?? process.cwd())
  const portPath = parsed.values.port ?? '/dev/ttyACM0'
  const unitName = validateSystemdUnitName(
    parsed.values['unit-name'] ?? DEFAULT_UNIT_NAME,
  )
  const deviceId = await discoverStackChanDeviceId(portPath)
  const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url))
  await access(cliPath, constants.R_OK)
  const unit = buildStackChanUserServiceUnit({
    nodePath: process.execPath,
    cliPath,
    cwd,
    deviceId,
    ...(parsed.values.socket
      ? { socketPath: parsed.values.socket }
      : {}),
    ...(parsed.values.voice ? { voice: parsed.values.voice } : {}),
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
  await enableAndStartUserService(unitName, runSystemctl)
  console.log(
    `systemd user serviceを導入しました: ${unitName} deviceId=${deviceId}`,
  )
}

async function assertGeneratedOrMissing(path: string): Promise<void> {
  let current: string
  try {
    current = await readFile(path, 'utf8')
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return
    }
    throw error
  }
  if (!current.startsWith(GENERATED_UNIT_MARKER)) {
    throw new Error(
      `既存のunitはこのインストーラの生成物ではないため上書きしません: ${path}`,
    )
  }
}

async function runSystemctl(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('systemctl', args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
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

const HELP = `Usage: stackchan-codex-voice-install-service [options]

/dev/ttyACM0のUSB serial numberを取得し、Codex音声ブリッジを
systemd --userサービスとして導入します。unitは--device-idを使うため、
別のCoreS3へ自動接続しません。

Options:
  --cwd <path>       Codex threadの作業ディレクトリ
  --port <path>      ID取得元（既定: /dev/ttyACM0）
  --socket <path>    app-server daemonのUnix socket
  --voice <name>     Realtime voice
  --unit-name <name> systemd unit名
  --dry-run          unitを表示するだけで書き込まない
  -h, --help         このヘルプを表示
`

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
