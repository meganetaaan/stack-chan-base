#!/usr/bin/env node

import { runApplication } from './application.js'
import { CLI_HELP, parseCliOptions } from './cli-options.js'

const VERSION = '0.1.0'

async function main(): Promise<void> {
  const parsed = parseCliOptions(process.argv.slice(2))
  if (parsed.kind === 'help') {
    process.stdout.write(CLI_HELP)
    return
  }
  if (parsed.kind === 'version') {
    console.log(VERSION)
    return
  }
  const controller = new AbortController()
  let signalCount = 0
  const shutdown = (signal: NodeJS.Signals) => {
    signalCount += 1
    if (signalCount > 1) {
      process.exitCode = 130
      process.exit()
    }
    console.log(`${signal}を受信しました。音声と未解決承認を安全に停止します。`)
    controller.abort(new Error(`received ${signal}`))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await runApplication(parsed.options, controller.signal)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
