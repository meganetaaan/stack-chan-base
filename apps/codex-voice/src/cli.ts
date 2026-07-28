#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { runApplication } from './application.js'
import { CLI_HELP, parseCliCommand } from './cli-options.js'
import { CodexAppServer } from './codex/app-server.js'
import { connectCodexDaemon } from './codex/rpc.js'
import {
  assertReadableWorkspaceSkill,
  initializeWorkspace,
  loadActiveWorkspace,
  loadWorkspace,
  readActiveWorkspace,
  setActiveWorkspace,
  setWorkspaceVoice,
  workspaceSummary,
} from './workspace.js'

const VERSION = '0.1.0'
const DEFAULT_UNIT_NAME = 'stackchan-codex-voice.service'

async function main(): Promise<void> {
  const command = parseCliCommand(process.argv.slice(2))
  if (command.kind === 'help') {
    process.stdout.write(CLI_HELP)
    return
  }
  if (command.kind === 'version') {
    console.log(VERSION)
    return
  }
  if (command.kind === 'config-init') {
    const initialized = await initializeWorkspace(command.workspacePath)
    console.log(`workspaceを初期化しました: ${initialized.root}`)
    for (const path of initialized.created) console.log(`  create: ${path}`)
    for (const path of initialized.existing) console.log(`  keep:   ${path}`)
    return
  }
  if (command.kind === 'config-show' || command.kind === 'config-validate') {
    const workspace = await loadWorkspace(command.workspacePath)
    console.log(workspaceSummary(workspace))
    const hasSkill = await assertReadableWorkspaceSkill(workspace.root)
    if (!hasSkill) {
      console.warn(`警告: workspace skillがありません: .agents/skills/stackchan/SKILL.md`)
    }
    if (command.kind === 'config-validate') console.log('workspace設定は有効です')
    return
  }
  if (command.kind === 'config-set-voice' || command.kind === 'config-unset-voice') {
    const workspace = await setWorkspaceVoice(
      command.workspacePath,
      command.kind === 'config-set-voice' ? command.voice : undefined,
    )
    console.log(workspaceSummary(workspace))
    console.log('設定を保存しました。稼働中serviceへの反映にはworkspace applyを実行してください。')
    return
  }
  if (command.kind === 'workspace-current') {
    const workspace = await loadWorkspace(await readActiveWorkspace())
    console.log(workspaceSummary(workspace))
    return
  }
  if (command.kind === 'workspace-use') {
    const workspace = await setActiveWorkspace(command.workspacePath)
    console.log(`アクティブworkspaceを変更しました: ${workspace.root}`)
    if (await isUserServiceActive(DEFAULT_UNIT_NAME)) {
      await restartUserService(DEFAULT_UNIT_NAME)
      console.log(`稼働中serviceへ反映しました: ${DEFAULT_UNIT_NAME}`)
    } else {
      console.log('serviceは稼働していないため、workspaceの選択だけを保存しました')
    }
    return
  }
  if (command.kind === 'workspace-apply') {
    const workspace = await loadActiveWorkspace()
    await restartUserService(DEFAULT_UNIT_NAME)
    console.log(`workspaceをserviceへ反映しました: ${workspace.root}`)
    return
  }
  if (command.kind === 'voice-list') {
    const daemon = await connectCodexDaemon(command.socketPath)
    try {
      const appServer = new CodexAppServer(daemon.connection)
      await appServer.initialize()
      const voices = await appServer.listRealtimeVoices()
      console.log(`Realtime v3 voices: ${voices.v1.join(', ')}`)
      console.log(`default: ${voices.defaultV1}`)
    } finally {
      await daemon.close()
    }
    return
  }
  const workspace = await loadActiveWorkspace()
  const controller = new AbortController()
  let signalCount = 0
  const shutdown = (signal: NodeJS.Signals) => {
    signalCount += 1
    if (signalCount > 1) {
      process.exitCode = 130
      process.exit()
    }
    console.log(`${signal}を受信しました。音声と未解決承認を安全に停止します。`)
    controller.abort(new Error(`received ${signal}`))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await runApplication(
    {
      ...command.options,
      workspace,
    },
    controller.signal,
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})

async function isUserServiceActive(unitName: string): Promise<boolean> {
  return (await systemctl(['--user', 'is-active', '--quiet', unitName], true)) === 0
}

async function restartUserService(unitName: string): Promise<void> {
  await systemctl(['--user', 'restart', unitName])
  await systemctl(['--user', 'is-active', '--quiet', unitName])
}

async function systemctl(args: string[], allowFailure = false): Promise<number> {
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise, reject) => {
      const child = spawn('systemctl', args, { stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code, signal) => resolvePromise({ code, signal }))
    },
  )
  if (result.code !== null && (result.code === 0 || allowFailure)) return result.code
  throw new Error(
    `systemctl ${args.join(' ')} failed (${
      result.signal ? `signal ${result.signal}` : `exit ${String(result.code)}`
    })`,
  )
}
