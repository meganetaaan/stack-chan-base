import {
  validateDeviceId,
  writeSelectedDeviceId,
} from './device-selection.js'
import {
  queryUserServiceStatus,
  tryRestartUserService,
  type UserServiceStatus,
} from './service/control.js'
import {
  discoverStackChanDevices,
  type StackChanDeviceInfo,
} from './usb/device.js'

export type SelectDockDeviceOptions = {
  deviceId: string
  unitName: string
  deviceSelectionPath?: string
}

export type SelectDockDeviceResult = {
  deviceId: string
  path: string
  serviceRestarted: boolean
}

export type DeviceManagerDependencies = {
  discoverDevices: () => Promise<StackChanDeviceInfo[]>
  queryServiceStatus: (unitName: string) => Promise<UserServiceStatus>
  writeSelection: (deviceId: string, path?: string) => Promise<void>
  restartServiceIfActive: (unitName: string) => Promise<void>
}

const DEFAULT_DEPENDENCIES: DeviceManagerDependencies = {
  discoverDevices: discoverStackChanDevices,
  queryServiceStatus: queryUserServiceStatus,
  writeSelection: writeSelectedDeviceId,
  restartServiceIfActive: tryRestartUserService,
}

export async function selectDockDevice(
  options: SelectDockDeviceOptions,
  dependencies: DeviceManagerDependencies = DEFAULT_DEPENDENCIES,
): Promise<SelectDockDeviceResult> {
  const deviceId = validateDeviceId(options.deviceId)
  const matches = (await dependencies.discoverDevices()).filter(
    (device) => device.deviceId === deviceId,
  )
  if (matches.length === 0) {
    throw new Error(`接続中のCoreS3にUSB device ID "${deviceId}" はありません`)
  }
  if (matches.length > 1) {
    throw new Error(
      `USB device ID "${deviceId}" を持つCoreS3が複数あります: ${matches.map((device) => device.path).join(', ')}`,
    )
  }

  const service = await dependencies.queryServiceStatus(options.unitName)
  await dependencies.writeSelection(deviceId, options.deviceSelectionPath)
  let serviceRestarted = false
  if (service.installed) {
    await dependencies.restartServiceIfActive(options.unitName)
    serviceRestarted = (
      await dependencies.queryServiceStatus(options.unitName)
    ).active
  }
  return {
    deviceId,
    path: matches[0]!.path,
    serviceRestarted,
  }
}
