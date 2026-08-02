import { spawnSync } from 'node:child_process'

const WAIVER_ID = 'codex-voice-2026-08-01'
const allowedVulnerabilities = new Set([
  'ip',
  'werift',
  'werift-ice',
])
const allowedAdvisories = new Set([
  1_101_851,
])

const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
})
if (!audit.stdout) {
  process.stderr.write(audit.stderr || 'npm audit did not return JSON\n')
  process.exit(1)
}

const report = JSON.parse(audit.stdout)
const vulnerabilities = report.vulnerabilities ?? {}
const names = Object.keys(vulnerabilities)
const unexpectedNames = names.filter((name) => !allowedVulnerabilities.has(name))
const advisoryIds = new Set()
for (const vulnerability of Object.values(vulnerabilities)) {
  for (const item of vulnerability.via ?? []) {
    if (typeof item === 'object' && typeof item.source === 'number') advisoryIds.add(item.source)
  }
}
const unexpectedAdvisories = [...advisoryIds].filter((id) => !allowedAdvisories.has(id))

if (unexpectedNames.length > 0 || unexpectedAdvisories.length > 0) {
  console.error('Dependency audit contains findings outside the reviewed waiver.')
  if (unexpectedNames.length > 0) console.error(`Packages: ${unexpectedNames.join(', ')}`)
  if (unexpectedAdvisories.length > 0) {
    console.error(`Advisories: ${unexpectedAdvisories.join(', ')}`)
  }
  process.exit(1)
}
if (names.length === 0) {
  console.log('Production dependency audit passed without waivers.')
  process.exit(0)
}
if (process.env.STACKCHAN_DEPENDENCY_WAIVER !== WAIVER_ID) {
  console.error(
    `Known production dependency findings require explicit waiver ${WAIVER_ID}. ` +
      'See docs/WEBRTC_TRANSPORT.md.',
  )
  process.exit(1)
}

console.warn(`Accepted reviewed dependency waiver ${WAIVER_ID} for: ${names.join(', ')}`)
