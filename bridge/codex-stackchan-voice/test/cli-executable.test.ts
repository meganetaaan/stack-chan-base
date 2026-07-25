import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import test from 'node:test'

test('built CLI is executable on POSIX', async () => {
  if (process.platform === 'win32') return

  const metadata = await stat(new URL('../src/cli.js', import.meta.url))
  assert.notEqual(metadata.mode & 0o111, 0)
})
