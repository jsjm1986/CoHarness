/**
 * Gate the per-package upstream sovereignty manifest in `scripts/upstream-sync.json`.
 *
 * This fork shares no git history with `deepseek-harness`; upstream release tags
 * are mirrored onto origin so `git diff <tag> HEAD` resolves. The manifest
 * records, per `packages/<group>/<pkg>` directory, how the local tree relates to
 * the synced tag: `tracked` packages hold a `src/` identical to the synced
 * commit, `adapted` packages exist upstream but carry owned `src/` deltas, and
 * `owned` packages have no upstream counterpart. Directories upstream ships
 * that the fork does not carry sit in `upstreamOnly`. The gate re-checks every
 * `tracked` claim against `git diff --quiet` and enforces the manifest↔disk↔tag
 * bijections, so which packages faithfully track upstream is a mechanical fact
 * instead of prose in upgrade docs.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** Manifest path relative to the repository root. */
const MANIFEST_REL = 'scripts/upstream-sync.json'

const SOVEREIGNTIES = ['tracked', 'adapted', 'owned'] as const

/** The `<group>/<pkg>` key grammar the manifest and both bijections share. */
const PACKAGE_KEY = /^[0-9A-Za-z._-]+\/[0-9A-Za-z._-]+$/

/** A commit id: lowercase hex, covering sha1 and sha256 object formats. */
const COMMIT_ID = /^[0-9a-f]{40,64}$/

const TOP_LEVEL_KEYS = new Set(['version', 'syncedTag', 'syncedCommit', 'packages', 'upstreamOnly'])
const ENTRY_KEYS = new Set(['sovereignty', 'note'])

/** How one package's `src/` relates to the synced upstream commit. */
export type Sovereignty = (typeof SOVEREIGNTIES)[number]

/** The validated contents of `scripts/upstream-sync.json`. */
export interface UpstreamSyncManifest {
  version: 1
  syncedTag: string
  syncedCommit: string
  /** Per-package sovereignty, keyed `<group>/<pkg>`. */
  packages: Record<string, {
    sovereignty: Sovereignty
    /** Repo-relative path of a file recording why the package carries this class. */
    note?: string
  }>
  upstreamOnly: string[]
}

/** One sovereignty sweep: fatal violations plus printed-but-passing advisories. */
export interface UpstreamSovereigntyReport {
  violations: string[]
  advisories: string[]
}

function fail(message: string): never {
  throw new Error(`upstream-sovereignty: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate parsed manifest JSON against the version-1 contract.
 * @param raw - parsed JSON value of unknown provenance.
 * @param repoRoot - repository root `note` paths resolve against.
 * @returns the manifest with exactly the schema fields, no extras.
 */
export function validateUpstreamSyncManifest(raw: unknown, repoRoot: string): UpstreamSyncManifest {
  if (!isRecord(raw)) fail('manifest must be a JSON object')
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) fail(`manifest has unknown key "${key}"`)
  }
  if (raw.version !== 1) fail(`manifest version must be 1, got ${JSON.stringify(raw.version)}`)
  if (typeof raw.syncedTag !== 'string' || raw.syncedTag === '') {
    fail(`manifest syncedTag must be a non-empty string, got ${JSON.stringify(raw.syncedTag)}`)
  }
  if (typeof raw.syncedCommit !== 'string' || !COMMIT_ID.test(raw.syncedCommit)) {
    fail(`manifest syncedCommit must be a lowercase hex commit id, got ${JSON.stringify(raw.syncedCommit)}`)
  }
  if (!isRecord(raw.packages)) fail('manifest packages must be an object keyed by "<group>/<pkg>"')
  const packages: UpstreamSyncManifest['packages'] = {}
  for (const [key, value] of Object.entries(raw.packages)) {
    if (!PACKAGE_KEY.test(key)) fail(`manifest package key "${key}" is not "<group>/<pkg>"`)
    if (!isRecord(value)) fail(`manifest package "${key}" must be an object`)
    for (const field of Object.keys(value)) {
      if (!ENTRY_KEYS.has(field)) fail(`manifest package "${key}" has unknown field "${field}"`)
    }
    const sovereignty = value.sovereignty
    if (typeof sovereignty !== 'string' || !(SOVEREIGNTIES as readonly string[]).includes(sovereignty)) {
      fail(`manifest package "${key}" sovereignty must be one of ${SOVEREIGNTIES.join(' | ')}, got ${JSON.stringify(sovereignty)}`)
    }
    const entry: UpstreamSyncManifest['packages'][string] = { sovereignty: sovereignty as Sovereignty }
    const note = value.note
    if (note !== undefined) {
      if (typeof note !== 'string' || note.startsWith('/') || note.includes('\\') || note.split('/').includes('..')) {
        fail(`manifest package "${key}" note must be a repo-relative path, got ${JSON.stringify(note)}`)
      }
      const notePath = resolve(repoRoot, note)
      if (!existsSync(notePath) || !statSync(notePath).isFile()) {
        fail(`manifest package "${key}" note "${note}" is not an existing repository file`)
      }
      entry.note = note
    }
    packages[key] = entry
  }
  if (!Array.isArray(raw.upstreamOnly)) fail('manifest upstreamOnly must be an array of "<group>/<pkg>" keys')
  const upstreamOnly: string[] = []
  for (const key of raw.upstreamOnly) {
    if (typeof key !== 'string' || !PACKAGE_KEY.test(key)) {
      fail(`manifest upstreamOnly entry must be a "<group>/<pkg>" string, got ${JSON.stringify(key)}`)
    }
    if (upstreamOnly.includes(key)) fail(`manifest upstreamOnly lists "${key}" twice`)
    if (key in packages) fail(`manifest lists "${key}" in both packages and upstreamOnly`)
    upstreamOnly.push(key)
  }
  return { version: 1, syncedTag: raw.syncedTag, syncedCommit: raw.syncedCommit, packages, upstreamOnly }
}

/**
 * Read and validate `scripts/upstream-sync.json`.
 * @param repoRoot - repository root the manifest resolves against.
 * @returns the validated manifest.
 */
export function loadUpstreamSyncManifest(repoRoot: string): UpstreamSyncManifest {
  const path = resolve(repoRoot, MANIFEST_REL)
  if (!existsSync(path)) fail(`manifest is missing; expected ${MANIFEST_REL}`)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateUpstreamSyncManifest(raw, repoRoot)
}

interface GitRun {
  status: number | null
  stdout: string
  stderr: string
}

function git(repoRoot: string, args: string[]): GitRun {
  const run = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 })
  if (run.error !== undefined) fail(`git ${args.join(' ')} failed to spawn: ${run.error.message}`)
  return run
}

function gitOrFail(repoRoot: string, args: string[]): string {
  const run = git(repoRoot, args)
  if (run.status !== 0) fail(`git ${args.join(' ')} failed: ${run.stderr.trim()}`)
  return run.stdout
}

/**
 * The commit a mirrored upstream tag peels to.
 * @param repoRoot - repository root the git invocation runs in.
 * @param tag - tag name, resolved strictly as `refs/tags/<tag>`.
 * @returns the peeled commit id, or `null` when the tag is not fetched.
 */
export function resolveTagCommit(repoRoot: string, tag: string): string | null {
  const present = git(repoRoot, ['rev-parse', '--verify', '-q', `refs/tags/${tag}`])
  if (present.status !== 0 || present.stdout.trim() === '') return null
  return gitOrFail(repoRoot, ['rev-list', '-n1', tag]).trim()
}

/**
 * Every `packages/<group>/<pkg>` directory at one commit.
 * @param repoRoot - repository root the git invocation runs in.
 * @param commit - commit whose tree is listed.
 * @returns `<group>/<pkg>` keys present under `packages/` at that commit.
 */
export function packageKeysAtCommit(repoRoot: string, commit: string): Set<string> {
  // -z terminates entries with NUL and never quotes them.
  const out = gitOrFail(repoRoot, ['ls-tree', '-d', '-r', '-z', '--name-only', commit, '--', 'packages'])
  const keys = new Set<string>()
  for (const line of out.split('\0')) {
    const match = /^packages\/([0-9A-Za-z._-]+\/[0-9A-Za-z._-]+)$/.exec(line)
    if (match !== null) keys.add(match[1] as string)
  }
  return keys
}

/**
 * Every `packages/<group>/<pkg>` directory on disk.
 * @param repoRoot - repository root whose working tree is listed.
 * @returns `<group>/<pkg>` keys present under `packages/`.
 */
export function diskPackageKeys(repoRoot: string): Set<string> {
  const keys = new Set<string>()
  const packagesDir = resolve(repoRoot, 'packages')
  for (const group of readdirSync(packagesDir)) {
    if (!statSync(resolve(packagesDir, group)).isDirectory()) continue
    for (const pkg of readdirSync(resolve(packagesDir, group))) {
      if (statSync(resolve(packagesDir, group, pkg)).isDirectory()) keys.add(`${group}/${pkg}`)
    }
  }
  return keys
}

/**
 * Whether `packages/<key>/src` is identical between one commit and HEAD.
 * @param repoRoot - repository root the git invocation runs in.
 * @param commit - baseline commit for the diff.
 * @param key - `<group>/<pkg>` package key.
 * @returns `true` when `git diff --quiet` reports no `src/` change.
 */
export function packageSrcMatchesCommit(repoRoot: string, commit: string, key: string): boolean {
  const run = git(repoRoot, ['diff', '--quiet', commit, 'HEAD', '--', `packages/${key}/src`])
  if (run.status === 0) return true
  if (run.status === 1) return false
  fail(`git diff --quiet ${commit} HEAD -- packages/${key}/src failed: ${run.stderr.trim()}`)
}

/**
 * Check a manifest against the working tree and the synced tag.
 * @param repoRoot - repository root holding the tree and the git object store.
 * @param manifest - a validated manifest.
 * @returns every bijection and zero-diff violation, plus promotable advisories.
 */
export function checkUpstreamSovereignty(repoRoot: string, manifest: UpstreamSyncManifest): UpstreamSovereigntyReport {
  const tagCommit = resolveTagCommit(repoRoot, manifest.syncedTag)
  if (tagCommit === null) {
    fail(`synced tag "${manifest.syncedTag}" is not fetched locally; fetch it with \`git fetch --tags origin\` or \`git fetch upstream --tags\` and re-run`)
  }
  const violations: string[] = []
  const advisories: string[] = []
  const entries = Object.entries(manifest.packages)
  const manifestKeys = new Set(entries.map(([key]) => key))
  const upstreamOnly = new Set(manifest.upstreamOnly)

  if (tagCommit !== manifest.syncedCommit) {
    violations.push(`tag "${manifest.syncedTag}" resolves to ${tagCommit}, not manifest syncedCommit ${manifest.syncedCommit}`)
  }

  const disk = diskPackageKeys(repoRoot)
  const upstream = packageKeysAtCommit(repoRoot, manifest.syncedCommit)

  const missingFromManifest = [...disk].filter(key => !manifestKeys.has(key)).sort()
  if (missingFromManifest.length > 0) {
    violations.push(`on disk but absent from the manifest: ${missingFromManifest.join(', ')}`)
  }
  const missingFromDisk = [...manifestKeys].filter(key => !disk.has(key)).sort()
  if (missingFromDisk.length > 0) {
    violations.push(`in the manifest but absent on disk: ${missingFromDisk.join(', ')}`)
  }

  const uncovered = [...upstream].filter(key => !manifestKeys.has(key) && !upstreamOnly.has(key)).sort()
  if (uncovered.length > 0) {
    violations.push(`present at ${manifest.syncedTag} but in neither packages nor upstreamOnly: ${uncovered.join(', ')}`)
  }
  const ownedAtUpstream = entries
    .filter(([, entry]) => entry.sovereignty === 'owned')
    .map(([key]) => key)
    .filter(key => upstream.has(key))
    .sort()
  if (ownedAtUpstream.length > 0) {
    violations.push(`classified "owned" but present at ${manifest.syncedTag}: ${ownedAtUpstream.join(', ')}`)
  }
  const absentAtUpstream = entries
    .filter(([, entry]) => entry.sovereignty !== 'owned')
    .map(([key]) => key)
    .filter(key => !upstream.has(key))
    .sort()
  if (absentAtUpstream.length > 0) {
    violations.push(`classified "tracked"/"adapted" but absent at ${manifest.syncedTag}: ${absentAtUpstream.join(', ')}`)
  }
  const upstreamOnlyAbsent = manifest.upstreamOnly.filter(key => !upstream.has(key)).sort()
  if (upstreamOnlyAbsent.length > 0) {
    violations.push(`listed in upstreamOnly but absent at ${manifest.syncedTag}: ${upstreamOnlyAbsent.join(', ')}`)
  }
  const upstreamOnlyOnDisk = manifest.upstreamOnly.filter(key => disk.has(key)).sort()
  if (upstreamOnlyOnDisk.length > 0) {
    violations.push(`listed in upstreamOnly but present on disk: ${upstreamOnlyOnDisk.join(', ')}`)
  }

  for (const [key, entry] of entries) {
    // A package absent at the synced commit already holds a bijection
    // violation; diffing it would double-report the same drift.
    if (entry.sovereignty === 'tracked' && upstream.has(key) && !packageSrcMatchesCommit(repoRoot, manifest.syncedCommit, key)) {
      violations.push(`classified "tracked" but packages/${key}/src differs from ${manifest.syncedTag}`)
    }
  }
  for (const [key, entry] of entries) {
    if (entry.sovereignty === 'adapted' && upstream.has(key) && packageSrcMatchesCommit(repoRoot, manifest.syncedCommit, key)) {
      advisories.push(`classified "adapted" but packages/${key}/src is identical to ${manifest.syncedTag}; promote it to "tracked"`)
    }
  }
  return { violations, advisories }
}

/** CLI entry: print advisories, then either the violation list or the summary. */
function main(): number {
  const manifest = loadUpstreamSyncManifest(root)
  const { violations, advisories } = checkUpstreamSovereignty(root, manifest)
  for (const advisory of advisories) {
    console.log(`verify-upstream-sovereignty: advisory: ${advisory}`)
  }
  if (violations.length > 0) {
    console.error(`verify-upstream-sovereignty: ${violations.length} violation(s) against ${manifest.syncedTag}:`)
    for (const violation of violations) console.error(`  ${violation}`)
    return 1
  }
  const counts: Record<Sovereignty, number> = { tracked: 0, adapted: 0, owned: 0 }
  for (const entry of Object.values(manifest.packages)) counts[entry.sovereignty] += 1
  console.log(
    `verify-upstream-sovereignty: ${counts.tracked} tracked, ${counts.adapted} adapted, ${counts.owned} owned,`
    + ` ${manifest.upstreamOnly.length} upstream-only package(s) conform to ${manifest.syncedTag}.`,
  )
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message.startsWith('upstream-sovereignty:') ? message : `upstream-sovereignty: ${message}`)
    process.exitCode = 1
  }
}
