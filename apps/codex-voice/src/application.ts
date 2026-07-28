import { performance } from 'node:perf_hooks'
import { delay } from './async.js'
import { ApprovalManager } from './approval/manager.js'
import { CodexAppServer } from './codex/app-server.js'
import {
  connectCodexDaemon,
  type CodexDaemonConnection,
  type RpcNotification,
  type RpcServerRequest,
} from './codex/rpc.js'
import type { RunOptions } from './cli-options.js'
import { ConversationSessionController } from './conversation/session-controller.js'
import {
  ExponentialRetryBackoff,
  NonRetryableError,
  retryDisposition,
} from './retry-policy.js'
import {
  STACKCHAN_DYNAMIC_TOOLS,
  StackChanToolHandler,
} from './tools/stackchan.js'
import { UsbStackChanDevice } from './usb/device.js'
import type { LoadedWorkspace } from './workspace.js'

export type ApplicationOptions = RunOptions & {
  workspace: LoadedWorkspace
}

export async function runApplication(options: ApplicationOptions, signal: AbortSignal): Promise<void> {
  let threadId: string | undefined
  const usbBackoff = new ExponentialRetryBackoff()

  while (!signal.aborted) {
    const usbAttemptStartedAt = performance.now()
    const device = new UsbStackChanDevice(
      options.portPath
        ? { portPath: options.portPath }
        : options.deviceId
          ? { deviceId: options.deviceId }
          : {},
    )
    let controller: ConversationSessionController | undefined
    try {
      const capabilities = await device.connect(signal)
      console.log(
        `CoreS3 USB接続: maxPayload=${capabilities.maxPayload} event=${capabilities.event} status=${capabilities.statusIcon} statusExtended=${capabilities.statusExtended}`,
      )
      controller = new ConversationSessionController(
        device,
        options.workspace.session.voice,
        { realtimePrompt: options.workspace.realtimePrompt },
      )
      if (options.startImmediately) await controller.activate()

      const appServerBackoff = new ExponentialRetryBackoff()
      while (!signal.aborted && device.connected) {
        const appServerAttemptStartedAt = performance.now()
        let daemon: CodexDaemonConnection | undefined
        let appServer: CodexAppServer | undefined
        let approvalManager: ApprovalManager | undefined
        let toolHandler: StackChanToolHandler | undefined
        let onServerRequest: ((request: RpcServerRequest) => void) | undefined
        let onNotification: ((notification: RpcNotification) => void) | undefined
        let terminalFailure = false
        try {
          daemon = await connectCodexDaemon(options.socketPath, signal)
          appServer = new CodexAppServer(daemon.connection)
          const initialized = await appServer.initialize()
          console.log(`Codex app-server接続: ${initialized.userAgent}`)
          const voices = await appServer.listRealtimeVoices()
          if (
            options.workspace.session.voice &&
            !voices.v1.includes(options.workspace.session.voice)
          ) {
            throw new NonRetryableError(
              'configuration',
              `Realtime v3 voice "${options.workspace.session.voice}" はapp-serverで利用できません`,
            )
          }
          threadId = await appServer.openThread({
            cwd: options.workspace.root,
            ...(threadId ? { threadId } : {}),
            ...(!threadId ? { dynamicTools: STACKCHAN_DYNAMIC_TOOLS } : {}),
          })
          console.log(`Codex thread: ${threadId}`)

          approvalManager = new ApprovalManager(daemon.connection, threadId)
          toolHandler = new StackChanToolHandler(
            daemon.connection,
            threadId,
            () => ({
              connected: device.connected,
              conversationState: controller!.state,
              desired: controller!.desired,
            }),
          )
          const manager = approvalManager
          const tools = toolHandler
          onServerRequest = (request) => {
            const task =
              request.method === 'item/tool/call'
                ? tools.handleServerRequest(request)
                : manager.handleServerRequest(request)
            void task.catch((error) => {
              console.error(`server requestの処理に失敗: ${errorMessage(error)}`)
            })
          }
          onNotification = (notification) => {
            void manager.handleNotification(notification).catch((error) => {
              console.error(`承認notificationの処理に失敗: ${errorMessage(error)}`)
            })
          }
          appServer.on('serverRequest', onServerRequest)
          appServer.on('notification', onNotification)
          manager.bindDevice(device)

          await controller.runWithAppServer(appServer, signal)
          if (!signal.aborted && device.connected) {
            const closeError = daemon.connection.isClosed
              ? await daemon.connection.closed
              : undefined
            console.warn(
              `Codex app-serverセッション停止: ${errorMessage(
                closeError ?? new Error('Codex app-server connection ended'),
              )}`,
            )
          }
        } catch (error) {
          if (!signal.aborted && device.connected) {
            if (retryDisposition(error) === 'stop') {
              terminalFailure = true
              throw error
            }
            console.warn(`Codex app-serverセッション停止: ${errorMessage(error)}`)
          }
        } finally {
          if (appServer && onServerRequest) {
            appServer.off('serverRequest', onServerRequest)
          }
          if (appServer && onNotification) {
            appServer.off('notification', onNotification)
          }
          if (approvalManager) {
            if (signal.aborted || terminalFailure) await approvalManager.declineAll()
            else await approvalManager.suspendDeviceViews()
            approvalManager.unbindDevice(device)
          }
          await daemon?.close()
        }

        if (signal.aborted || !device.connected) break
        const retryMilliseconds = appServerBackoff.afterFailure(
          performance.now() - appServerAttemptStartedAt,
        )
        console.log(`Codex app-server再接続待ち: ${retryMilliseconds}ms`)
        await waitForRetry(retryMilliseconds, signal)
      }
    } catch (error) {
      if (!signal.aborted) {
        if (retryDisposition(error) === 'stop') throw error
        console.warn(`CoreS3セッション停止: ${errorMessage(error)}`)
      }
    } finally {
      await controller?.close()
      await device.close()
    }

    if (signal.aborted) break
    const retryMilliseconds = usbBackoff.afterFailure(
      performance.now() - usbAttemptStartedAt,
    )
    console.log(`CoreS3 USB再接続待ち: ${retryMilliseconds}ms`)
    await waitForRetry(retryMilliseconds, signal)
  }
}

async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, signal)
  } catch (error) {
    if (!signal.aborted) throw error
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
