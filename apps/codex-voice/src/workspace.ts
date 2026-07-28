import { constants } from 'node:fs'
import {
  access,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parse, stringify } from 'smol-toml'

export const WORKSPACE_SCHEMA_VERSION = 1
export const STACKCHAN_DIRECTORY = '.stackchan'
export const SESSION_CONFIG_FILE = 'session.toml'
export const REALTIME_PROMPT_FILE = 'realtime-prompt.md'
export const STACKCHAN_SKILL_FILE = join(
  '.agents',
  'skills',
  'stackchan',
  'SKILL.md',
)
export const ACTIVE_WORKSPACE_FILE = 'active-workspace'

const SESSION_KEYS = new Set(['schema_version', 'voice'])

export type WorkspaceSessionConfig = {
  schemaVersion: 1
  voice?: string
}

export type LoadedWorkspace = {
  root: string
  configPath: string
  realtimePromptPath: string
  realtimePrompt: string
  session: WorkspaceSessionConfig
}

export type WorkspaceInitializationResult = {
  root: string
  created: string[]
  existing: string[]
}

export function workspaceConfigPath(root: string): string {
  return join(resolve(root), STACKCHAN_DIRECTORY, SESSION_CONFIG_FILE)
}

export function workspaceRealtimePromptPath(root: string): string {
  return join(resolve(root), STACKCHAN_DIRECTORY, REALTIME_PROMPT_FILE)
}

export function activeWorkspacePath(): string {
  const configHome =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), '.config')
  return join(configHome, 'stackchan-codex-voice', ACTIVE_WORKSPACE_FILE)
}

export async function initializeWorkspace(
  requestedRoot: string,
): Promise<WorkspaceInitializationResult> {
  const root = resolve(requestedRoot)
  const rootStat = await stat(root).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  })
  if (!rootStat) await mkdir(root, { recursive: true })
  else if (!rootStat.isDirectory()) throw new Error(`workspaceはディレクトリではありません: ${root}`)

  const files = new Map<string, string>([
    [
      workspaceConfigPath(root),
      stringify({
        schema_version: WORKSPACE_SCHEMA_VERSION,
      }),
    ],
    [
      workspaceRealtimePromptPath(root),
      `日本語で自然に会話してください。
音声で聞き取りやすい、簡潔な文を使ってください。
`,
    ],
    [
      join(root, STACKCHAN_SKILL_FILE),
      `---
name: stackchan
description: ｽﾀｯｸﾁｬﾝのUSB接続状態や会話状態を確認するときに使用する。
---

# Stack-chan

- 状態確認には \`stackchan.get_status\` を使用する。
- 状態を推測せず、ツールが返した接続状態と会話状態をそのまま扱う。
- 状態変更やモーションは、対応する安全なツールが提供されるまで実行しない。
`,
    ],
    [
      join(root, 'AGENTS.md'),
      `# AGENTS.md

- このリポジトリを会話セッションの作業ディレクトリとして扱う。
- リポジトリ内の情報を参照するときは、事実と推測を区別する。
`,
    ],
  ])
  const created: string[] = []
  const existing: string[] = []
  for (const [path, contents] of files) {
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, contents, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o644,
      })
      created.push(path)
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error
      existing.push(path)
    }
  }
  return { root, created, existing }
}

export async function loadWorkspace(requestedRoot: string): Promise<LoadedWorkspace> {
  const root = resolve(requestedRoot)
  const rootStat = await stat(root).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  })
  if (!rootStat?.isDirectory()) throw new Error(`workspaceが存在しません: ${root}`)

  const configPath = workspaceConfigPath(root)
  let parsed: unknown
  try {
    parsed = parse(await readFile(configPath, 'utf8'))
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      throw new Error(`workspace設定がありません: ${configPath}`)
    }
    throw new Error(`workspace設定を読めません: ${configPath}`, { cause: error })
  }
  const session = validateSessionConfig(parsed, configPath)
  const realtimePromptPath = workspaceRealtimePromptPath(root)
  let realtimePrompt: string
  try {
    realtimePrompt = await readFile(realtimePromptPath, 'utf8')
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      throw new Error(`Realtime promptがありません: ${realtimePromptPath}`)
    }
    throw error
  }
  if (realtimePrompt.trim().length === 0) {
    throw new Error(`Realtime promptが空です: ${realtimePromptPath}`)
  }
  return {
    root,
    configPath,
    realtimePromptPath,
    realtimePrompt,
    session,
  }
}

export async function setWorkspaceVoice(
  requestedRoot: string,
  voice: string | undefined,
): Promise<LoadedWorkspace> {
  const workspace = await loadWorkspace(requestedRoot)
  const normalized = voice?.trim()
  if (voice !== undefined && !normalized) {
    throw new Error('voiceは空にできません')
  }
  await atomicWrite(
    workspace.configPath,
    stringify({
      schema_version: WORKSPACE_SCHEMA_VERSION,
      ...(normalized ? { voice: normalized } : {}),
    }),
  )
  return loadWorkspace(workspace.root)
}

export async function setActiveWorkspace(requestedRoot: string): Promise<LoadedWorkspace> {
  const workspace = await loadWorkspace(requestedRoot)
  await atomicWrite(activeWorkspacePath(), `${workspace.root}\n`)
  return workspace
}

export async function readActiveWorkspace(): Promise<string> {
  const path = activeWorkspacePath()
  let value: string
  try {
    value = (await readFile(path, 'utf8')).trim()
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      throw new Error(
        `アクティブworkspaceが未設定です。workspace use <DIR>を実行してください: ${path}`,
      )
    }
    throw error
  }
  if (!value || !isAbsolute(value)) {
    throw new Error(`アクティブworkspace設定が不正です: ${path}`)
  }
  return value
}

export async function loadActiveWorkspace(): Promise<LoadedWorkspace> {
  return loadWorkspace(await readActiveWorkspace())
}

export async function assertReadableWorkspaceSkill(root: string): Promise<boolean> {
  try {
    await access(join(resolve(root), STACKCHAN_SKILL_FILE), constants.R_OK)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

export function workspaceSummary(workspace: LoadedWorkspace): string {
  return [
    `workspace: ${workspace.root}`,
    `name: ${basename(workspace.root)}`,
    `voice: ${workspace.session.voice ?? '(app-server default)'}`,
    `realtime prompt: ${workspace.realtimePromptPath}`,
    `skill: ${join(workspace.root, STACKCHAN_SKILL_FILE)}`,
  ].join('\n')
}

function validateSessionConfig(
  value: unknown,
  path: string,
): WorkspaceSessionConfig {
  if (!isRecord(value)) throw new Error(`workspace設定はTOML tableである必要があります: ${path}`)
  const unknown = Object.keys(value).filter((key) => !SESSION_KEYS.has(key))
  if (unknown.length > 0) {
    throw new Error(`workspace設定に未知のキーがあります: ${unknown.join(', ')}`)
  }
  if (value.schema_version !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(
      `workspace schema_versionは${WORKSPACE_SCHEMA_VERSION}である必要があります`,
    )
  }
  if ('voice' in value && (typeof value.voice !== 'string' || value.voice.trim().length === 0)) {
    throw new Error('workspace voiceは空でない文字列である必要があります')
  }
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    ...(typeof value.voice === 'string' ? { voice: value.voice.trim() } : {}),
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o644 })
  await rename(temporaryPath, path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
