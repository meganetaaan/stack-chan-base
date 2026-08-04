import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildStackChanStatusAppletServiceUnit,
  buildStackChanUserServiceUnit,
  enableAndStartUserService,
  GENERATED_UNIT_MARKER,
  stackChanUserServiceUsesDeviceSelection,
  validateSystemdUnitName,
} from '../src/service/user-service.js'

test('systemd unit reads the explicitly selected USB device and keeps Realtime gesture-triggered', () => {
  const unit = buildStackChanUserServiceUnit({
    nodePath: '/opt/node/bin/node',
    cliPath: '/opt/stack chan/dist/src/cli.js',
    deviceSelectionPath: '/home/user/.config/stackchan-codex-voice/selected-device',
  })

  assert.ok(unit.startsWith(GENERATED_UNIT_MARKER))
  assert.match(unit, /--device-selection" "\/home\/user\/\.config/)
  assert.doesNotMatch(unit, /ttyACM/)
  assert.doesNotMatch(unit, /start-immediately/)
  assert.doesNotMatch(unit, /WorkingDirectory/)
  assert.doesNotMatch(unit, /--cwd|--voice|--thread/)
  assert.match(unit, /cli\.js" "run" "--device-selection"/)
  assert.match(unit, /Restart=on-failure/)
  assert.match(unit, /RestartPreventExitStatus=78/)
  assert.match(unit, /TimeoutStopSec=15/)
})

test('systemd unit quotes paths and escapes specifier expansion', () => {
  const unit = buildStackChanUserServiceUnit({
    nodePath: '/opt/node $current/bin/node',
    cliPath: '/opt/stack%20chan/cli.js',
    deviceSelectionPath: '/home/user/$current/selected%"',
  })

  assert.match(unit, /\$\$current/)
  assert.match(unit, /stack%%20chan/)
  assert.match(unit, /selected%%\\"/)
})

test('status applet unit launches GJS against the managed voice unit', () => {
  const unit = buildStackChanStatusAppletServiceUnit({
    gjsPath: '/usr/bin/gjs',
    appletPath: '/opt/stack chan/status-applet.js',
    nodePath: '/opt/node/bin/node',
    cliPath: '/opt/stack chan/cli.js',
    voiceUnitName: 'stackchan-codex-voice.service',
    deviceSelectionPath: '/home/user/.config/stackchan-codex-voice/selected-device',
  })

  assert.ok(unit.startsWith(GENERATED_UNIT_MARKER))
  assert.match(unit, /ExecStart="\/usr\/bin\/gjs"/)
  assert.match(unit, /"--unit-name" "stackchan-codex-voice\.service"/)
  assert.match(unit, /"--device-selection" "\/home\/user\/\.config/)
  assert.match(unit, /Restart=on-failure/)
  assert.match(unit, /After=graphical-session\.target/)
  assert.match(unit, /PartOf=graphical-session\.target/)
  assert.match(unit, /WantedBy=graphical-session\.target/)
})

test('applet installation can identify the exact managed device selection file', () => {
  const selectionPath = '/home/user/.config/stackchan-codex-voice/selected-device'
  const unit = buildStackChanUserServiceUnit({
    nodePath: '/usr/bin/node',
    cliPath: '/opt/stackchan/cli.js',
    deviceSelectionPath: selectionPath,
  })

  assert.equal(
    stackChanUserServiceUsesDeviceSelection(unit, selectionPath),
    true,
  )
  assert.equal(
    stackChanUserServiceUsesDeviceSelection(
      unit,
      '/home/user/.config/stackchan-codex-voice/other-device',
    ),
    false,
  )
  assert.equal(
    stackChanUserServiceUsesDeviceSelection(
      `${GENERATED_UNIT_MARKER}\nExecStart="node" "cli" "run" "--device-id" "OLD"\n`,
      selectionPath,
    ),
    false,
  )
  assert.equal(
    stackChanUserServiceUsesDeviceSelection(
      unit.replace(`${GENERATED_UNIT_MARKER}\n`, ''),
      selectionPath,
    ),
    false,
  )
})

test('generated systemd unit passes the installed systemd parser', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('systemd is Linux-specific')
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-user-service-'))
  try {
    const unitPath = join(directory, 'stackchan-codex-voice.service')
    const appletUnitPath = join(directory, 'stackchan-codex-voice-applet.service')
    await writeFile(
      unitPath,
      buildStackChanUserServiceUnit({
        nodePath: process.execPath,
        cliPath: process.execPath,
        deviceSelectionPath: join(directory, 'selected-device'),
      }),
    )
    await writeFile(
      appletUnitPath,
      buildStackChanStatusAppletServiceUnit({
        gjsPath: process.execPath,
        appletPath: process.execPath,
        nodePath: process.execPath,
        cliPath: process.execPath,
        voiceUnitName: 'stackchan-codex-voice.service',
        deviceSelectionPath: join(directory, 'selected-device'),
      }),
    )
    const result = spawnSync('systemd-analyze', ['verify', unitPath, appletUnitPath], {
      encoding: 'utf8',
    })
    if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
      context.skip('systemd-analyze is unavailable')
      return
    }
    assert.equal(
      result.status,
      0,
      `${result.stdout}${result.stderr}`,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('service activation restarts an existing process and verifies it is active', async () => {
  const calls: string[][] = []
  await enableAndStartUserService(
    'stackchan-codex-voice.service',
    async (args) => {
      calls.push([...args])
    },
  )

  assert.deepEqual(calls, [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', 'stackchan-codex-voice.service'],
    ['--user', 'restart', 'stackchan-codex-voice.service'],
    ['--user', 'is-active', '--quiet', 'stackchan-codex-voice.service'],
  ])

  await assert.rejects(
    enableAndStartUserService(
      'stackchan-codex-voice.service',
      async (args) => {
        if (args.includes('is-active')) throw new Error('service is inactive')
      },
    ),
    /service is inactive/,
  )
})

test('systemd unit names are narrowly validated', () => {
  assert.equal(
    validateSystemdUnitName('stackchan-codex-voice.service'),
    'stackchan-codex-voice.service',
  )
  assert.throws(
    () => validateSystemdUnitName('../stackchan.service'),
    /unit name/,
  )
  assert.throws(() => validateSystemdUnitName('stackchan'), /unit name/)
})
