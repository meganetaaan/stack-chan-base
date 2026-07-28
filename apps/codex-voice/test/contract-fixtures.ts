import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function loadContractFixture<T>(name: string): T {
  const testDirectory = dirname(fileURLToPath(import.meta.url))
  const fixturePath = [
    resolve(testDirectory, `../../../contracts/usb-cdc-v2/${name}`),
    resolve(testDirectory, `../../../../contracts/usb-cdc-v2/${name}`),
  ].find(existsSync)
  if (!fixturePath) throw new Error(`shared USB CDC contract fixture was not found: ${name}`)
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as T
}
