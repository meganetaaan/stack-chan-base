import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('built status applet loads its GJS, GTK, and AppIndicator runtime', (context) => {
  if (process.platform !== 'linux') {
    context.skip('the status applet is Linux-specific')
    return
  }
  const path = fileURLToPath(new URL('../src/applet/status-applet.js', import.meta.url))
  const result = spawnSync('gjs', [path, '--check'], { encoding: 'utf8' })
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
    context.skip('gjs is unavailable')
    return
  }
  if (
    result.status !== 0 &&
    /Typelib file.*not found|Requiring .* version/u.test(result.stderr)
  ) {
    context.skip('GTK 3 or AyatanaAppIndicator3 is unavailable')
    return
  }
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /AyatanaAppIndicator3/)
})
