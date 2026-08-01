import { chmod, copyFile, mkdir } from 'node:fs/promises'

const appletSource = new URL('../src/applet/status-applet.js', import.meta.url)
const appletDestination = new URL('../dist/src/applet/status-applet.js', import.meta.url)
await mkdir(new URL('../dist/src/applet/', import.meta.url), { recursive: true })
await copyFile(appletSource, appletDestination)

if (process.platform !== 'win32') {
  await Promise.all(
    [
      '../dist/src/cli.js',
      '../dist/src/service/install-user-service.js',
      '../dist/src/applet/install-status-applet.js',
      '../dist/src/applet/status-applet.js',
    ].map((path) => chmod(new URL(path, import.meta.url), 0o755)),
  )
}
