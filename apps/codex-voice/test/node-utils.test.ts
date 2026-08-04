import assert from 'node:assert/strict'
import test from 'node:test'
import { runCommand } from '../src/node-utils.js'

test('shared command runner captures output and returns a nonzero exit', async () => {
  const result = await runCommand(
    process.execPath,
    [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7',
    ],
    { output: 'capture', timeoutMs: 1_000 },
  )

  assert.deepEqual(result, {
    exitCode: 7,
    signal: null,
    stdout: 'out',
    stderr: 'err',
  })
})

test('shared command runner waits for descendant output to close', async () => {
  const grandchildScript = [
    'setTimeout(() => {',
    '  process.stdout.write("late stdout\\n");',
    '  process.stderr.write("late stderr\\n");',
    '}, 50)',
  ].join('\n')
  const directChildScript = [
    'const { spawn } = require("node:child_process")',
    `spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], {`,
    '  stdio: ["ignore", "inherit", "inherit"],',
    '})',
    'process.stdout.write("direct stdout\\n")',
    'process.stderr.write("direct stderr\\n")',
    'process.exit(0)',
  ].join('\n')

  const result = await runCommand(
    process.execPath,
    ['-e', directChildScript],
    { output: 'capture', timeoutMs: 2_000 },
  )

  assert.equal(result.stdout, 'direct stdout\nlate stdout\n')
  assert.equal(result.stderr, 'direct stderr\nlate stderr\n')
})

test('shared command runner kills and rejects a timed-out child', async () => {
  await assert.rejects(
    runCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      { output: 'capture', timeoutMs: 50 },
    ),
    /timed out after 50 ms/,
  )
})
