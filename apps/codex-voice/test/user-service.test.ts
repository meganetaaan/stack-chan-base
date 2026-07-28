import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildStackChanUserServiceUnit,
  enableAndStartUserService,
  GENERATED_UNIT_MARKER,
  validateSystemdUnitName,
} from '../src/service/user-service.js'

test('systemd unit pins the USB device ID and keeps Realtime gesture-triggered', () => {
  const unit = buildStackChanUserServiceUnit({
    nodePath: '/opt/node/bin/node',
    cliPath: '/opt/stack chan/dist/src/cli.js',
    deviceId: 'STACKCHAN-PRIMARY',
  })

  assert.ok(unit.startsWith(GENERATED_UNIT_MARKER))
  assert.match(unit, /--device-id" "STACKCHAN-PRIMARY"/)
  assert.doesNotMatch(unit, /ttyACM/)
  assert.doesNotMatch(unit, /start-immediately/)
  assert.doesNotMatch(unit, /WorkingDirectory/)
  assert.doesNotMatch(unit, /--cwd|--voice|--thread/)
  assert.match(unit, /cli\.js" "run" "--device-id"/)
  assert.match(unit, /Restart=on-failure/)
  assert.match(unit, /TimeoutStopSec=15/)
})

test('systemd unit quotes paths and escapes specifier expansion', () => {
  const unit = buildStackChanUserServiceUnit({
    nodePath: '/opt/node $current/bin/node',
    cliPath: '/opt/stack%20chan/cli.js',
    deviceId: 'id%$"',
  })

  assert.match(unit, /\$\$current/)
  assert.match(unit, /stack%%20chan/)
  assert.match(unit, /id%%\$\$\\"/)
})

test('generated systemd unit passes the installed systemd parser', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('systemd is Linux-specific')
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-user-service-'))
  try {
    const unitPath = join(directory, 'stackchan-codex-voice.service')
    await writeFile(
      unitPath,
      buildStackChanUserServiceUnit({
        nodePath: process.execPath,
        cliPath: process.execPath,
        deviceId: 'STACKCHAN-PRIMARY',
      }),
    )
    const result = spawnSync('systemd-analyze', ['verify', unitPath], {
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

test('service activation verifies the process is active after enablement', async () => {
  const calls: string[][] = []
  await enableAndStartUserService(
    'stackchan-codex-voice.service',
    async (args) => {
      calls.push([...args])
    },
  )

  assert.deepEqual(calls, [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--now', 'stackchan-codex-voice.service'],
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
