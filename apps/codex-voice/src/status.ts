import {
  deviceSelectionPath,
  readSelectedDeviceIdIfPresent,
} from './device-selection.js'
import {
  DEFAULT_VOICE_UNIT_NAME,
  queryUserServiceStatus,
  type UserServiceStatus,
} from './service/control.js'
import {
  discoverStackChanDevices,
  type StackChanDeviceInfo,
} from './usb/device.js'

export type DockDeviceStatus = StackChanDeviceInfo & {
  selected: boolean
  selectable: boolean
}

export type DockStatus = {
  service: UserServiceStatus
  selectedDeviceId: string | null
  devices: DockDeviceStatus[]
}

export async function collectDockStatus(
  unitName = DEFAULT_VOICE_UNIT_NAME,
  selectionPath = deviceSelectionPath(),
): Promise<DockStatus> {
  const [service, selectedDeviceId, devices] = await Promise.all([
    queryUserServiceStatus(unitName),
    readSelectedDeviceIdIfPresent(selectionPath),
    discoverStackChanDevices(),
  ])
  return buildDockStatus(service, devices, selectedDeviceId)
}

export function buildDockStatus(
  service: UserServiceStatus,
  devices: StackChanDeviceInfo[],
  selectedDeviceId: string | undefined,
): DockStatus {
  return {
    service,
    selectedDeviceId: selectedDeviceId ?? null,
    devices: buildDockDevices(devices, selectedDeviceId),
  }
}

export function buildDockDevices(
  devices: StackChanDeviceInfo[],
  selectedDeviceId: string | undefined,
): DockDeviceStatus[] {
  return devices.map((device) => ({
    ...device,
    selected:
      device.deviceId !== undefined && device.deviceId === selectedDeviceId,
    selectable: device.deviceId !== undefined,
  }))
}

export function formatDockStatus(status: DockStatus): string {
  const lines = [
    `サービス: ${status.service.activeState} (${status.service.subState})`,
    `選択中のデバイス: ${status.selectedDeviceId ?? '未選択'}`,
    '接続中のデバイス:',
  ]
  if (status.devices.length === 0) lines.push('  （なし）')
  for (const device of status.devices) {
    lines.push(
      `  ${device.selected ? '*' : '-'} ${device.path}  ${device.deviceId ?? '(USB serial numberなし)'}`,
    )
  }
  return lines.join('\n')
}
