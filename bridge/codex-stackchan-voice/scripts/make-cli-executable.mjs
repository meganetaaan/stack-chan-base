import { chmod } from 'node:fs/promises'

if (process.platform !== 'win32') {
  await Promise.all(
    [
      '../dist/src/cli.js',
      '../dist/src/service/install-user-service.js',
    ].map((path) => chmod(new URL(path, import.meta.url), 0o755)),
  )
}
