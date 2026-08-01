#!/usr/bin/gjs

imports.gi.versions.Gtk = '3.0'
imports.gi.versions.AyatanaAppIndicator3 = '0.1'

const { AyatanaAppIndicator3, Gio, GLib, Gtk } = imports.gi
const System = imports.system

const HELP = `Usage: stackchan-codex-voice-applet [options]

Options:
  --node <path>       Node.js executable
  --cli <path>        stackchan-codex-voice CLI
  --unit-name <name>  操作対象のsystemd user unit
  --device-selection <path>
                      接続先デバイスの選択ファイル
  --check             GJSとAppIndicatorの依存関係だけを検査
  -h, --help          このヘルプを表示
`

if (ARGV.includes('--help') || ARGV.includes('-h')) {
  print(HELP)
  System.exit(0)
}
if (ARGV.includes('--check')) {
  print('GJS, GTK 3, and AyatanaAppIndicator3 are available')
  System.exit(0)
}

const options = parseOptions(ARGV)
Gtk.init(null)

const indicator = AyatanaAppIndicator3.Indicator.new(
  'stackchan-codex-voice',
  'microphone-sensitivity-muted-symbolic',
  AyatanaAppIndicator3.IndicatorCategory.APPLICATION_STATUS,
)
indicator.set_status(AyatanaAppIndicator3.IndicatorStatus.ACTIVE)

const menu = new Gtk.Menu()
const statusItem = Gtk.MenuItem.new_with_label('状態を確認しています…')
statusItem.set_sensitive(false)
menu.append(statusItem)

const serviceItem = Gtk.CheckMenuItem.new_with_label('Codex Voice を使用する')
serviceItem.set_sensitive(false)
menu.append(serviceItem)

menu.append(new Gtk.SeparatorMenuItem())
const deviceRootItem = Gtk.MenuItem.new_with_label('接続先デバイス')
const deviceMenu = new Gtk.Menu()
deviceRootItem.set_submenu(deviceMenu)
deviceRootItem.set_sensitive(false)
menu.append(deviceRootItem)

menu.append(new Gtk.SeparatorMenuItem())
const refreshItem = Gtk.MenuItem.new_with_label('状態を更新')
menu.append(refreshItem)
const quitItem = Gtk.MenuItem.new_with_label('アプレットを終了')
menu.append(quitItem)

let applyingStatus = false
let requestInFlight = false
let refreshInFlight = false
let latestStatus = null
let errorTimer = 0
let visibleError = null

serviceItem.connect('toggled', () => {
  if (applyingStatus || requestInFlight || !latestStatus?.service?.installed) return
  const action = serviceItem.get_active() ? 'start' : 'stop'
  runAction(['service', action, '--unit-name', options.unitName])
})
refreshItem.connect('activate', () => refreshStatus())
quitItem.connect('activate', () => Gtk.main_quit())
menu.connect('show', () => refreshStatus())

indicator.set_menu(menu)
menu.show_all()
refreshStatus()
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
  refreshStatus()
  return GLib.SOURCE_CONTINUE
})
Gtk.main()

function parseOptions(args) {
  let nodePath = GLib.find_program_in_path('node')
  const programPath = System.programPath
  let cliPath = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.path_get_dirname(programPath)),
    'cli.js',
  ])
  let unitName = 'stackchan-codex-voice.service'
  let deviceSelectionPath = null
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (
      option !== '--node' &&
      option !== '--cli' &&
      option !== '--unit-name' &&
      option !== '--device-selection'
    ) {
      printerr(`未知のoptionです: ${option}`)
      System.exit(2)
    }
    const value = args[index + 1]
    if (!value) {
      printerr(`${option}には値が必要です`)
      System.exit(2)
    }
    if (option === '--node') nodePath = value
    else if (option === '--cli') cliPath = value
    else if (option === '--unit-name') unitName = value
    else deviceSelectionPath = value
    index += 1
  }
  if (!nodePath) {
    printerr('node executableが見つかりません')
    System.exit(1)
  }
  return { nodePath, cliPath, unitName, deviceSelectionPath }
}

function refreshStatus() {
  if (refreshInFlight || requestInFlight) return
  refreshInFlight = true
  runCli(
    [
      'status',
      '--json',
      '--unit-name',
      options.unitName,
      ...deviceSelectionArgs(),
    ],
    (result) => {
      refreshInFlight = false
      if (!result.ok) {
        showError(result.error)
        return
      }
      try {
        const status = JSON.parse(result.stdout)
        validateStatus(status)
        latestStatus = status
        applyStatus(status)
      } catch (error) {
        showError(`状態JSONを解釈できません: ${error.message ?? String(error)}`)
      }
    },
  )
}

function runAction(args) {
  if (requestInFlight) return
  clearError()
  requestInFlight = true
  setControlsSensitive(false)
  runCli(args, (result) => {
    requestInFlight = false
    if (!result.ok) showError(result.error)
    setControlsSensitive(true)
    refreshStatus()
  })
}

function runCli(args, callback) {
  let process
  try {
    process = Gio.Subprocess.new(
      [options.nodePath, options.cliPath, ...args],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    )
  } catch (error) {
    callback({ ok: false, stdout: '', error: error.message ?? String(error) })
    return
  }
  process.communicate_utf8_async(null, null, (source, result) => {
    try {
      const [, stdout, stderr] = source.communicate_utf8_finish(result)
      if (source.get_successful()) {
        callback({ ok: true, stdout: stdout ?? '', error: '' })
      } else {
        callback({
          ok: false,
          stdout: stdout ?? '',
          error: conciseError(stderr || `CLI exited with ${source.get_exit_status()}`),
        })
      }
    } catch (error) {
      callback({ ok: false, stdout: '', error: error.message ?? String(error) })
    }
  })
}

function applyStatus(status) {
  applyingStatus = true
  try {
    serviceItem.set_active(status.service.active)
    setControlsSensitive(true)
    rebuildDeviceMenu(status)

    const selected = status.devices.find((device) => device.selected)
    const serviceText = !status.service.installed
      ? '未インストール'
      : status.service.active
        ? 'ON'
        : status.service.activeState === 'failed'
          ? 'エラー'
          : 'OFF'
    const deviceText = selected
      ? `${selected.path} (${selected.deviceId})`
      : status.selectedDeviceId
        ? `${status.selectedDeviceId}（未接続）`
        : '未選択'
    const icon = status.service.active
      ? 'microphone-sensitivity-high-symbolic'
      : status.service.activeState === 'failed'
        ? 'dialog-error-symbolic'
        : 'microphone-sensitivity-muted-symbolic'
    if (visibleError) {
      statusItem.set_label(`エラー: ${visibleError}`)
      indicator.set_icon_full('dialog-error-symbolic', 'Codex Voice: エラー')
    } else {
      statusItem.set_label(`${serviceText} · ${deviceText}`)
      indicator.set_icon_full(icon, `Codex Voice: ${serviceText}`)
    }
  } finally {
    applyingStatus = false
  }
}

function rebuildDeviceMenu(status) {
  for (const child of deviceMenu.get_children()) child.destroy()

  if (
    status.selectedDeviceId &&
    !status.devices.some((device) => device.selected)
  ) {
    const unavailable = Gtk.CheckMenuItem.new_with_label(
      `${safeLabel(status.selectedDeviceId)}（未接続）`,
    )
    unavailable.set_draw_as_radio(true)
    unavailable.set_active(true)
    unavailable.set_sensitive(false)
    unavailable._stackchanSelectable = false
    deviceMenu.append(unavailable)
    if (status.devices.length > 0) deviceMenu.append(new Gtk.SeparatorMenuItem())
  }

  if (status.devices.length === 0) {
    const empty = Gtk.MenuItem.new_with_label('接続中のCoreS3はありません')
    empty.set_sensitive(false)
    deviceMenu.append(empty)
  }
  for (const device of status.devices) {
    const deviceId = device.deviceId
    const label = deviceId
      ? `${safeLabel(device.path)} — ${safeLabel(deviceId)}`
      : `${safeLabel(device.path)} — USB serial numberなし`
    const item = Gtk.CheckMenuItem.new_with_label(label)
    item.set_draw_as_radio(true)
    item.set_active(device.selected)
    item.set_sensitive(device.selectable && !requestInFlight)
    item._stackchanSelectable = device.selectable
    if (deviceId) {
      item.connect('activate', () => {
        if (applyingStatus || requestInFlight || device.selected || !item.get_active()) return
        runAction([
          'device',
          'use',
          '--unit-name',
          options.unitName,
          ...deviceSelectionArgs(),
          '--',
          deviceId,
        ])
      })
    }
    deviceMenu.append(item)
  }
  deviceMenu.show_all()
}

function deviceSelectionArgs() {
  return options.deviceSelectionPath
    ? ['--device-selection', options.deviceSelectionPath]
    : []
}

function setControlsSensitive(sensitive) {
  const installed = latestStatus?.service?.installed ?? false
  serviceItem.set_sensitive(sensitive && installed)
  deviceRootItem.set_sensitive(sensitive)
  refreshItem.set_sensitive(sensitive)
  for (const item of deviceMenu.get_children()) {
    if (item instanceof Gtk.CheckMenuItem) {
      item.set_sensitive(sensitive && item._stackchanSelectable === true)
    }
  }
}

function validateStatus(status) {
  if (
    !status ||
    typeof status !== 'object' ||
    !status.service ||
    typeof status.service.active !== 'boolean' ||
    typeof status.service.installed !== 'boolean' ||
    !Array.isArray(status.devices)
  ) {
    throw new Error('必要なserviceまたはdevice状態がありません')
  }
}

function showError(message) {
  visibleError = conciseError(message)
  statusItem.set_label(`エラー: ${visibleError}`)
  indicator.set_icon_full('dialog-error-symbolic', 'Codex Voice: エラー')
  if (errorTimer) GLib.source_remove(errorTimer)
  errorTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
    errorTimer = 0
    visibleError = null
    if (latestStatus) applyStatus(latestStatus)
    return GLib.SOURCE_REMOVE
  })
}

function clearError() {
  if (errorTimer) GLib.source_remove(errorTimer)
  errorTimer = 0
  visibleError = null
}

function conciseError(value) {
  const firstLine = String(value ?? '不明なエラー')
    .replace(/\s+/gu, ' ')
    .trim()
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine
}

function safeLabel(value) {
  return String(value).replace(/[\0\r\n]/gu, ' ')
}
