import { performance } from 'node:perf_hooks'
import { delay } from './async.js'
import { ApprovalManager } from './approval/manager.js'
import { RealtimeAudioBridge } from './audio/bridge.js'
import { CodexAppServer } from './codex/app-server.js'
import {
  connectCodexDaemon,
  type CodexDaemonConnection,
  type RpcNotification,
  type RpcServerRequest,
} from './codex/rpc.js'
import type { CliOptions } from './cli-options.js'
import {
  ExponentialRetryBackoff,
  NonRetryableError,
  retryDisposition,
} from './retry-policy.js'
import { UsbStackChanDevice } from './usb/device.js'

export async function runApplication(options: CliOptions, signal: AbortSignal): Promise<void> {
  let threadId = options.threadId
  const appServerBackoff = new ExponentialRetryBackoff()
  while (!signal.aborted) {
    const appServerAttemptStartedAt = performance.now()
    let daemon: CodexDaemonConnection | undefined
    let approvalManager: ApprovalManager | undefined
    let activeDevice: UsbStackChanDevice | undefined
    let terminalFailure = false
    try {
      daemon = await connectCodexDaemon(options.socketPath, signal)
      const appServer = new CodexAppServer(daemon.connection)
      const initialized = await appServer.initialize()
      console.log(`Codex app-server接続: ${initialized.userAgent}`)
      const voices = await appServer.listRealtimeVoices()
      if (options.voice && !voices.v1.includes(options.voice)) {
        throw new NonRetryableError(
          'configuration',
          `Realtime v3 voice "${options.voice}" はapp-serverで利用できません`,
        )
      }
      threadId = await appServer.openThread({
        cwd: options.cwd,
        ...(threadId ? { threadId } : {}),
      })
      console.log(`Codex thread: ${threadId}`)
      approvalManager = new ApprovalManager(daemon.connection, threadId)
      const manager = approvalManager
      const onServerRequest = (request: RpcServerRequest) => {
        void manager.handleServerRequest(request).catch((error) => {
          console.error(`承認server requestの処理に失敗: ${errorMessage(error)}`)
        })
      }
      const onNotification = (notification: RpcNotification) => {
        void manager.handleNotification(notification).catch((error) => {
          console.error(`承認notificationの処理に失敗: ${errorMessage(error)}`)
        })
      }
      appServer.on('serverRequest', onServerRequest)
      appServer.on('notification', onNotification)

      try {
        const usbBackoff = new ExponentialRetryBackoff()
        while (!signal.aborted && !daemon.connection.isClosed) {
          const usbAttemptStartedAt = performance.now()
          const device = new UsbStackChanDevice(options.portPath ? { portPath: options.portPath } : {})
          activeDevice = device
          try {
            const capabilities = await device.connect(signal)
            console.log(
              `CoreS3 USB接続: maxPayload=${capabilities.maxPayload} event=${capabilities.event} status=${capabilities.statusIcon}`,
            )
            manager.bindDevice(device)
            const realtimeBackoff = new ExponentialRetryBackoff()
            while (!signal.aborted && !daemon.connection.isClosed && device.connected) {
              const realtimeAttemptStartedAt = performance.now()
              try {
                const audio = new RealtimeAudioBridge(appServer, device, options.voice)
                await audio.run(signal)
                if (!signal.aborted) {
                  throw new Error('Codex realtime audio bridge stopped unexpectedly')
                }
              } catch (error) {
                if (signal.aborted || daemon.connection.isClosed) break
                if (retryDisposition(error) === 'stop') throw error
                if (!device.connected) {
                  console.warn(`CoreS3セッション停止: ${errorMessage(error)}`)
                  break
                }
                console.warn(`Codex realtimeセッション停止: ${errorMessage(error)}`)
              }
              if (signal.aborted || daemon.connection.isClosed || !device.connected) break
              const retryMilliseconds = realtimeBackoff.afterFailure(
                performance.now() - realtimeAttemptStartedAt,
              )
              console.log(`Codex realtime再接続待ち: ${retryMilliseconds}ms`)
              await waitForRetry(retryMilliseconds, signal)
            }
          } catch (error) {
            if (!signal.aborted && !daemon.connection.isClosed) {
              if (retryDisposition(error) === 'stop') throw error
              console.warn(`CoreS3セッション停止: ${errorMessage(error)}`)
            }
          } finally {
            if (signal.aborted) await manager.declineAll()
            else if (daemon.connection.isClosed) await manager.suspendDeviceViews()
            manager.unbindDevice(device)
            await device.close()
            activeDevice = undefined
          }
          if (signal.aborted || daemon.connection.isClosed) break
          const retryMilliseconds = usbBackoff.afterFailure(
            performance.now() - usbAttemptStartedAt,
          )
          console.log(`CoreS3 USB再接続待ち: ${retryMilliseconds}ms`)
          await waitForRetry(retryMilliseconds, signal)
        }
      } finally {
        appServer.off('serverRequest', onServerRequest)
        appServer.off('notification', onNotification)
      }
    } catch (error) {
      if (!signal.aborted) {
        if (retryDisposition(error) === 'stop') {
          terminalFailure = true
          throw error
        }
        console.warn(`Codex app-serverセッション停止: ${errorMessage(error)}`)
      }
    } finally {
      if (approvalManager) {
        if (signal.aborted || terminalFailure) await approvalManager.declineAll()
        else await approvalManager.suspendDeviceViews()
      }
      await activeDevice?.close()
      await daemon?.close()
    }
    if (signal.aborted) break
    const retryMilliseconds = appServerBackoff.afterFailure(
      performance.now() - appServerAttemptStartedAt,
    )
    console.log(`Codex app-server再接続待ち: ${retryMilliseconds}ms`)
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
