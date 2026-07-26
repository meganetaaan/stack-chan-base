import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const legacyOutputDirectory = resolve(packageRoot, 'src/generated')
const outputDirectory = resolve(packageRoot, 'generated/codex')

await rm(legacyOutputDirectory, { recursive: true, force: true })
await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })

const child = spawn('codex', ['app-server', 'generate-ts', '--experimental', '--out', outputDirectory], {
  stdio: 'inherit',
})

const exitCode = await new Promise((resolveExit) => {
  child.once('error', (error) => {
    console.error(`codex app-server schema generation failed: ${error.message}`)
    resolveExit(1)
  })
  child.once('exit', (code) => resolveExit(code ?? 1))
})

process.exitCode = exitCode
