import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  activeWorkspacePath,
  initializeWorkspace,
  loadActiveWorkspace,
  loadWorkspace,
  setActiveWorkspace,
  setWorkspaceVoice,
  setWorkspaceVoiceEffect,
  STACKCHAN_SKILL_FILE,
  WORKSPACE_SCHEMA_VERSION,
  workspaceConfigPath,
  workspaceRealtimePromptPath,
} from '../src/workspace.js'

test('workspace init creates config, prompt, AGENTS, and repo-local skill without overwriting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-workspace-'))
  try {
    await writeFile(join(directory, 'AGENTS.md'), '既存の指示\n')
    const first = await initializeWorkspace(directory)
    assert.ok(first.created.includes(workspaceConfigPath(directory)))
    assert.ok(first.created.includes(join(directory, STACKCHAN_SKILL_FILE)))
    assert.ok(first.existing.includes(join(directory, 'AGENTS.md')))
    assert.equal(await readFile(join(directory, 'AGENTS.md'), 'utf8'), '既存の指示\n')

    const second = await initializeWorkspace(directory)
    assert.equal(second.created.length, 0)
    assert.ok(second.existing.includes(workspaceConfigPath(directory)))

    const loaded = await loadWorkspace(directory)
    assert.deepEqual(loaded.session, { schemaVersion: WORKSPACE_SCHEMA_VERSION })
    assert.match(loaded.realtimePrompt, /日本語/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('workspace voice is updated and unset through a canonical TOML document', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-workspace-'))
  try {
    await initializeWorkspace(directory)
    await setWorkspaceVoiceEffect(directory, 'cute')
    assert.equal((await setWorkspaceVoice(directory, ' juniper ')).session.voice, 'juniper')
    const configured = await readFile(workspaceConfigPath(directory), 'utf8')
    assert.match(configured, /schema_version = 2/)
    assert.match(configured, /voice = "juniper"/)
    assert.match(configured, /voice_effect = "cute"/)
    const voiceUnset = await setWorkspaceVoice(directory, undefined)
    assert.equal(voiceUnset.session.voice, undefined)
    assert.equal(voiceUnset.session.voiceEffect, 'cute')
    assert.doesNotMatch(
      await readFile(workspaceConfigPath(directory), 'utf8'),
      /^voice =/m,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('workspace voice effect is set and unset without losing the selected voice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-workspace-'))
  try {
    await initializeWorkspace(directory)
    await setWorkspaceVoice(directory, 'juniper')
    const enabled = await setWorkspaceVoiceEffect(directory, 'cute')
    assert.deepEqual(enabled.session, {
      schemaVersion: 2,
      voice: 'juniper',
      voiceEffect: 'cute',
    })
    const disabled = await setWorkspaceVoiceEffect(directory, undefined)
    assert.deepEqual(disabled.session, {
      schemaVersion: 2,
      voice: 'juniper',
    })
    assert.doesNotMatch(
      await readFile(workspaceConfigPath(directory), 'utf8'),
      /voice_effect/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('workspace schema v1 remains readable with voice effects disabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-workspace-'))
  try {
    await initializeWorkspace(directory)
    await writeFile(
      workspaceConfigPath(directory),
      'schema_version = 1\nvoice = "juniper"\n',
    )
    assert.deepEqual((await loadWorkspace(directory)).session, {
      schemaVersion: 1,
      voice: 'juniper',
    })
    await writeFile(
      workspaceConfigPath(directory),
      'schema_version = 1\nvoice_effect = "cute"\n',
    )
    await assert.rejects(loadWorkspace(directory), /未知のキー/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('workspace validation rejects unknown keys, unsupported schema, and empty prompt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-workspace-'))
  try {
    await initializeWorkspace(directory)
    await writeFile(workspaceConfigPath(directory), 'schema_version = 1\nunknown = true\n')
    await assert.rejects(loadWorkspace(directory), /未知のキー/)

    await writeFile(workspaceConfigPath(directory), 'schema_version = 3\n')
    await assert.rejects(loadWorkspace(directory), /schema_version/)

    await writeFile(
      workspaceConfigPath(directory),
      'schema_version = 2\nvoice_effect = "robot"\n',
    )
    await assert.rejects(loadWorkspace(directory), /voice_effect/)

    await writeFile(workspaceConfigPath(directory), 'schema_version = 2\n')
    await writeFile(workspaceRealtimePromptPath(directory), '  \n')
    await assert.rejects(loadWorkspace(directory), /Realtime promptが空/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('active workspace stores an absolute validated workspace path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-workspace-'))
  const configHome = await mkdtemp(join(tmpdir(), 'stackchan-config-'))
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = configHome
  try {
    await initializeWorkspace(directory)
    await setActiveWorkspace(directory)
    assert.equal((await readFile(activeWorkspacePath(), 'utf8')).trim(), directory)
    assert.equal((await loadActiveWorkspace()).root, directory)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    await rm(directory, { recursive: true, force: true })
    await rm(configHome, { recursive: true, force: true })
  }
})
