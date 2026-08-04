import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isNodeError } from './node-utils.js'

export const DEVICE_SELECTION_FILE = 'selected-device'

export function deviceSelectionPath(): string {
  const configHome =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), '.config')
  return join(configHome, 'stackchan-codex-voice', DEVICE_SELECTION_FILE)
}

export function validateDeviceId(value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error('USB device IDは空にできません')
  if (normalized.length > 256) throw new Error('USB device IDが長すぎます')
  if (/[\0\r\n]/u.test(normalized)) {
    throw new Error('USB device IDに改行またはNULは使用できません')
  }
  return normalized
}

export async function readSelectedDeviceId(
  path = deviceSelectionPath(),
): Promise<string> {
  const selected = await readSelectedDeviceIdIfPresent(path)
  if (selected === undefined) {
    throw new Error(
      `接続先デバイスが未設定です。service installerまたはdevice useを実行してください: ${path}`,
    )
  }
  return selected
}

export async function readSelectedDeviceIdIfPresent(
  path = deviceSelectionPath(),
): Promise<string | undefined> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }
  return validateDeviceId(contents)
}

export async function writeSelectedDeviceId(
  deviceId: string,
  path = deviceSelectionPath(),
): Promise<void> {
  const normalized = validateDeviceId(deviceId)
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  let renamed = false
  try {
    await writeFile(temporaryPath, `${normalized}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    await rename(temporaryPath, path)
    renamed = true
  } finally {
    if (!renamed) {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isNodeError(error, 'ENOENT')) throw error
      })
    }
  }
}
