import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseUserServiceStatus,
  queryUserServiceStatus,
  restartUserService,
  startUserService,
  stopUserService,
  tryRestartUserService,
} from '../src/service/control.js'

test('systemctl show output maps active and missing units without guessing', () => {
  assert.deepEqual(
    parseUserServiceStatus(
      'stackchan-codex-voice.service',
      'LoadState=loaded\nActiveState=active\nSubState=running\n',
    ),
    {
      unitName: 'stackchan-codex-voice.service',
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      installed: true,
      active: true,
    },
  )
  assert.equal(
    parseUserServiceStatus(
      'missing.service',
      'LoadState=not-found\nActiveState=inactive\nSubState=dead\n',
    ).installed,
    false,
  )
  assert.throws(
    () => parseUserServiceStatus('broken.service', 'LoadState=loaded\n'),
    /必要な状態/,
  )
})

test('service status uses a narrow systemctl show query', async () => {
  const calls: string[][] = []
  const status = await queryUserServiceStatus(
    'stackchan-codex-voice.service',
    async (args) => {
      calls.push(args)
      return {
        exitCode: 0,
        stdout: 'LoadState=loaded\nActiveState=inactive\nSubState=dead\n',
        stderr: '',
      }
    },
  )
  assert.equal(status.active, false)
  assert.deepEqual(calls, [[
    '--user',
    'show',
    'stackchan-codex-voice.service',
    '--property=LoadState',
    '--property=ActiveState',
    '--property=SubState',
  ]])
})

test('service controls verify starts and restarts while stop stays off', async () => {
  const calls: string[][] = []
  const runner = async (args: string[]) => {
    calls.push(args)
  }
  await startUserService('stackchan-codex-voice.service', runner)
  await stopUserService('stackchan-codex-voice.service', runner)
  await restartUserService('stackchan-codex-voice.service', runner)
  await tryRestartUserService('stackchan-codex-voice.service', runner)
  assert.deepEqual(calls, [
    ['--user', 'start', 'stackchan-codex-voice.service'],
    ['--user', 'is-active', '--quiet', 'stackchan-codex-voice.service'],
    ['--user', 'stop', 'stackchan-codex-voice.service'],
    ['--user', 'restart', 'stackchan-codex-voice.service'],
    ['--user', 'is-active', '--quiet', 'stackchan-codex-voice.service'],
    ['--user', 'try-restart', 'stackchan-codex-voice.service'],
  ])
})
