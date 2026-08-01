import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  readSelectedDeviceId,
  readSelectedDeviceIdIfPresent,
  validateDeviceId,
  writeSelectedDeviceId,
} from '../src/device-selection.js'

test('selected device is written atomically and read as a canonical ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackchan-device-selection-'))
  const path = join(directory, 'config', 'selected-device')
  try {
    assert.equal(await readSelectedDeviceIdIfPresent(path), undefined)
    await assert.rejects(readSelectedDeviceId(path), /未設定/)

    await writeSelectedDeviceId('  STACKCHAN-PRIMARY  ', path)
    assert.equal(await readSelectedDeviceId(path), 'STACKCHAN-PRIMARY')
    assert.equal(await readFile(path, 'utf8'), 'STACKCHAN-PRIMARY\n')
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600)
    }

    await writeSelectedDeviceId('STACKCHAN-SECONDARY', path)
    assert.equal(await readSelectedDeviceId(path), 'STACKCHAN-SECONDARY')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('selected device rejects empty, multiline, NUL, and oversized IDs', () => {
  for (const value of ['', '   ', 'first\nsecond', 'nul\0id', 'x'.repeat(257)]) {
    assert.throws(() => validateDeviceId(value))
  }
})
