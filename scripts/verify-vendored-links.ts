/** Reject registry copies or wrong workspace targets for the vendored framework. */
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as yaml from 'js-yaml'

const root = resolve(import.meta.dirname, '..')
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function vendoredNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (const entry of await readdir(join(root, 'vendor'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = join(root, 'vendor', entry.name)
    let source: string
    try { source = await readFile(join(directory, 'package.json'), 'utf8') } catch (error) {
      // Non-package directories have no manifest; malformed or unreadable manifests are errors.
      if (isRecord(error) && error.code === 'ENOENT') continue
      throw error
    }
    const manifest: unknown = JSON.parse(source)
    if (!isRecord(manifest) || typeof manifest.name !== 'string' || manifest.name === '') {
      throw new Error(`verify-vendored-links: invalid package name in ${directory}`)
    }
    if (names.has(manifest.name)) throw new Error(`verify-vendored-links: duplicate vendored package ${manifest.name}`)
    names.set(manifest.name, directory)
  }
  return names
}

const names = await vendoredNames()
if (names.size === 0) throw new Error('verify-vendored-links: no vendored package manifests found under vendor/')
const raw: unknown = yaml.load(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'))
if (!isRecord(raw) || !isRecord(raw.importers) || Object.keys(raw.importers).length === 0) {
  throw new Error('verify-vendored-links: lockfile importer corpus is empty or malformed')
}
const violations: string[] = []
let references = 0
for (const [importer, sections] of Object.entries(raw.importers)) {
  if (!isRecord(sections)) throw new Error(`verify-vendored-links: malformed importer ${importer}`)
  if (importer.startsWith('vendor/') && ![...names.values()].includes(resolve(root, importer))) {
    violations.push(`${importer} has no corresponding vendored package manifest`)
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = sections[section]
    if (dependencies === undefined) continue
    if (!isRecord(dependencies)) throw new Error(`verify-vendored-links: malformed ${importer}.${section}`)
    for (const [dependency, entry] of Object.entries(dependencies)) {
      const expected = names.get(dependency)
      if (expected === undefined) continue
      references++
      const version = isRecord(entry) && typeof entry.version === 'string' ? entry.version : ''
      if (!version.startsWith('link:') || resolve(root, importer, version.slice(5)) !== expected) {
        violations.push(`${importer} ${section}.${dependency} resolves to ${JSON.stringify(version)} (expected its vendor workspace link)`)
      }
    }
  }
}
if (references === 0) throw new Error('verify-vendored-links: no vendored dependency resolutions were inspected')
for (const section of ['packages', 'snapshots']) {
  const entries = raw[section]
  if (entries === undefined) continue
  if (!isRecord(entries)) throw new Error(`verify-vendored-links: malformed ${section}`)
  for (const key of Object.keys(entries)) {
    // The first separator after the name precedes any parenthesized peer versions.
    const separator = key.indexOf('@', 1)
    if (separator > 0 && names.has(key.slice(0, separator))) {
      violations.push(`${section} entry ${key} is a registry copy of a vendored package`)
    }
  }
}
if (violations.length > 0) {
  console.error(`verify-vendored-links: ${violations.length} invalid resolution(s):\n${violations.join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`verify-vendored-links: ${names.size} manifests and ${references} workspace resolutions checked.`)
}
