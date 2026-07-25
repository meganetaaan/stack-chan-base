import { chmod } from 'node:fs/promises'

if (process.platform !== 'win32') {
  await chmod(new URL('../dist/src/cli.js', import.meta.url), 0o755)
}
