#!/usr/bin/env node

import { runApplication } from './application.js'
import { CLI_HELP, parseCliCommand } from './cli-options.js'
import { CodexAppServer } from './codex/app-server.js'
import { connectCodexDaemon } from './codex/rpc.js'
import {
  readSelectedDeviceId,
  readSelectedDeviceIdIfPresent,
} from './device-selection.js'
import { selectDockDevice } from './device-manager.js'
import { NonRetryableError } from './retry-policy.js'
import {
  DEFAULT_VOICE_UNIT_NAME,
  queryUserServiceStatus,
  restartUserService,
  startUserService,
  stopUserService,
} from './service/control.js'
import { validateSystemdUnitName } from './service/user-service.js'
import { collectDockStatus, formatDockStatus } from './status.js'
import { discoverStackChanDevices } from './usb/device.js'
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
    if ((await queryUserServiceStatus(DEFAULT_VOICE_UNIT_NAME)).active) {
      await restartUserService(DEFAULT_VOICE_UNIT_NAME)
      console.log(`稼働中serviceへ反映しました: ${DEFAULT_VOICE_UNIT_NAME}`)
    } else {
      console.log('serviceは稼働していないため、workspaceの選択だけを保存しました')
    }
    return
  }
  if (command.kind === 'workspace-apply') {
    const workspace = await loadActiveWorkspace()
    await restartUserService(DEFAULT_VOICE_UNIT_NAME)
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
  if (command.kind === 'status') {
    const status = await collectDockStatus(
      validateSystemdUnitName(command.unitName ?? DEFAULT_VOICE_UNIT_NAME),
      command.deviceSelectionPath,
    )
    console.log(command.json ? JSON.stringify(status) : formatDockStatus(status))
    return
  }
  if (command.kind === 'service-start' || command.kind === 'service-stop') {
    const unitName = validateSystemdUnitName(
      command.unitName ?? DEFAULT_VOICE_UNIT_NAME,
    )
    if (command.kind === 'service-start') {
      await startUserService(unitName)
      console.log(`Codex voice serviceをONにしました: ${unitName}`)
    } else {
      await stopUserService(unitName)
      console.log(`Codex voice serviceをOFFにしました: ${unitName}`)
    }
    return
  }
  if (command.kind === 'device-list') {
    const [selectedDeviceId, devices] = await Promise.all([
      readSelectedDeviceIdIfPresent(command.deviceSelectionPath),
      discoverStackChanDevices(),
    ])
    const result = {
      selectedDeviceId: selectedDeviceId ?? null,
      devices: devices.map((device) => ({
        ...device,
        selected:
          device.deviceId !== undefined && device.deviceId === selectedDeviceId,
        selectable: device.deviceId !== undefined,
      })),
    }
    if (command.json) {
      console.log(JSON.stringify(result))
    } else if (result.devices.length === 0) {
      console.log('接続中のCoreS3はありません')
    } else {
      for (const device of result.devices) {
        console.log(
          `${device.selected ? '*' : '-'} ${device.path}  ${device.deviceId ?? '(USB serial numberなし)'}`,
        )
      }
    }
    return
  }
  if (command.kind === 'device-use') {
    const result = await selectDockDevice({
      deviceId: command.deviceId,
      unitName: validateSystemdUnitName(
        command.unitName ?? DEFAULT_VOICE_UNIT_NAME,
      ),
      ...(command.deviceSelectionPath
        ? { deviceSelectionPath: command.deviceSelectionPath }
        : {}),
    })
    if (result.serviceRestarted) {
      console.log(`接続先を変更してserviceへ反映しました: ${result.deviceId}`)
    } else {
      console.log(`接続先を変更しました（serviceはOFFのままです）: ${result.deviceId}`)
    }
    return
  }
  const workspace = await loadActiveWorkspace()
  const {
    deviceSelectionPath: selectedDevicePath,
    ...applicationOptions
  } = command.options
  let selectedDeviceId: string | undefined
  if (selectedDevicePath) {
    try {
      selectedDeviceId = await readSelectedDeviceId(selectedDevicePath)
    } catch (error) {
      throw new NonRetryableError(
        'configuration',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      )
    }
  }
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
      ...applicationOptions,
      ...(selectedDeviceId ? { deviceId: selectedDeviceId } : {}),
      workspace,
    },
    controller.signal,
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = error instanceof NonRetryableError ? 78 : 1
})
