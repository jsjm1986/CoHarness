/** Canonical Ubuntu repositories and bounded APT networking for ephemeral CI images. */
import { lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Network, repository-validation, and lock limits shared by hosted APT consumers. */
export const NETWORK_POLICY = `Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
Acquire::Retries "0";
Acquire::Languages "none";
APT::Update::Error-Mode "any";
DPkg::Lock::Timeout "30";
`

function sourceExists(filename) {
  try {
    lstatSync(filename)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function writeChanged(filename, text) {
  if (sourceExists(filename) && readFileSync(filename, 'utf8') === text) return false
  const temporary = `${filename}.dsh-ci-${process.pid}.tmp`
  writeFileSync(temporary, text, { flag: 'wx', mode: 0o644 })
  renameSync(temporary, filename)
  return true
}

/** Configure an ephemeral Ubuntu image; retain repository suites and signing keys.
 * @param aptDirectory Ubuntu's existing APT directory, or a private fixture.
 * @returns Files whose contents change.
 * @throws On source I/O failures, including an existing dangling source link.
 */
export function prepareHostedApt(aptDirectory) {
  const candidates = [
    join(aptDirectory, 'sources.list'),
    join(aptDirectory, 'apt-mirrors.txt'),
  ]
  const sourcesDirectory = join(aptDirectory, 'sources.list.d')
  if (sourceExists(sourcesDirectory)) {
    for (const entry of readdirSync(sourcesDirectory)) {
      if (/\.(?:list|sources)$/.test(entry)) candidates.push(join(sourcesDirectory, entry))
    }
  }
  const changed = []
  for (const filename of candidates) {
    if (!sourceExists(filename)) continue
    const previous = readFileSync(filename, 'utf8')
    const next = previous
      .replace(/\bhttps?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?(?=\s|$)/g, 'https://archive.ubuntu.com/ubuntu/')
      .replace(/\bhttp:\/\/(?:archive|security)\.ubuntu\.com\/ubuntu\/?(?=\s|$)/g, match => match.replace('http:', 'https:'))
      .replace(/\bhttp:\/\/ports\.ubuntu\.com\/ubuntu-ports\/?(?=\s|$)/g, match => match.replace('http:', 'https:'))
    if (next !== previous && writeChanged(filename, next)) changed.push(filename)
  }
  const policy = join(aptDirectory, 'apt.conf.d', '98-dsh-ci-network')
  if (writeChanged(policy, NETWORK_POLICY)) changed.push(policy)
  return changed
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') {
    throw new Error('Usage: node scripts/prepare-ci-apt.mjs --apply')
  }
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('prepare-ci-apt requires root on an ephemeral Ubuntu runner')
  }
  for (const filename of prepareHostedApt('/etc/apt')) console.log(`prepare-ci-apt: configured ${filename}`)
}
