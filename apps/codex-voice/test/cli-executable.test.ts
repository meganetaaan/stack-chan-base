import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import test from 'node:test'

test('built CLIs are executable on POSIX', async () => {
  if (process.platform === 'win32') return

  for (const path of [
    '../src/cli.js',
    '../src/service/install-user-service.js',
    '../src/applet/install-status-applet.js',
    '../src/applet/status-applet.js',
  ]) {
    const metadata = await stat(new URL(path, import.meta.url))
    assert.notEqual(metadata.mode & 0o111, 0, `${path} is not executable`)
  }
})
