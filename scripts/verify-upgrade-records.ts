/**
 * Gate the machine-readable upgrade records under `upgrades/`.
 *
 * Every `upgrades/alignment/UPSTREAM-ALIGNMENT-MATRIX-<tag>.json` and
 * `upgrades/manifests/UPGRADE-MANIFEST-<tag>.json` must carry a complete
 * schema, and every decision/matrix row must either enumerate the upstream
 * commits it covers (`upstreamCommits`) or record why none apply
 * (`noUpstreamCommitReason`). A row that silently lists no commits is the
 * failure mode this gate exists to prevent: areas of an upgrade whose source
 * review never happened read exactly like areas whose review found nothing to
 * do.
 *
 * The gate checks record structure and coverage declarations, not outcome: a
 * `pending-*` review state is legal but must be explicit. External-validation
 * status stays honest because `released` requires an evidence field.
 *
 * Strict checks apply to records declaring `schemaVersion: 2` or newer;
 * earlier generations keep their frozen historical shape and are validated
 * only as parseable objects. Every manifest still requires its plan pair.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

const ALIGNMENT_DIR = 'upgrades/alignment'
const MANIFEST_DIR = 'upgrades/manifests'
const PLANS_DIR = 'upgrades/plans'

/** Row/decision classification shared by the matrix and the manifest. */
const STATUSES = new Set(['retain', 'equivalent', 'adapt', 'required', 'defer', 'reject'])

/** Review states the records may claim; `released` additionally needs evidence. */
const REVIEW_STATES = new Set([
  'pending-cumulative-source-review',
  'deferred-platform-review',
  'implemented-local-tests-passing',
  'local-tests-passing-real-provider-unverified',
  'local-tests-passing-platform-unverified',
  'local-tests-passing-browser-unverified',
  'local-tests-passing-production-unverified',
  'local-tests-passing-artifact-unverified',
  'local-tests-passing-ci-unverified',
  'implemented-local-external-validation-pending',
  'released',
])

const COMMIT_ID = /^[0-9a-f]{40,64}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Verify that recorded gate adaptations still refer to the current upstream input and executable regressions.
 * @param root - source checkout.
 * @param upstreamCommit - current pinned comparison target.
 * @param matrix - active non-package alignment record.
 */
export function checkGateReplays(root: string, upstreamCommit: string, matrix: unknown): void {
  if (!isRecord(matrix) || !Array.isArray(matrix.rows)) fail('gate replay matrix has no rows')
  const replays: unknown[] = matrix.rows.flatMap((row: unknown): unknown[] =>
    isRecord(row) && Array.isArray(row.gateReplays) ? row.gateReplays as unknown[] : [])
  if (replays.length === 0) fail('active gate replay inventory is empty')
  const paths = new Set<string>()
  for (const raw of replays) {
    if (!isRecord(raw)) fail('gate replay must be an object')
    const path = requireString('gate replay', raw.path, 'path')
    if (paths.has(path)) fail(`duplicate gate replay ${path}`)
    paths.add(path)
    if (raw.reviewedUpstreamCommit !== upstreamCommit) fail(`gate replay ${path} requires review against the new upstream target`)
    if (!COMMIT_ID.test(String(raw.upstreamBlob))) fail(`gate replay ${path} has no upstream source identity`)
    const blob = execFileSync('git', ['rev-parse', '--verify', `${upstreamCommit}:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    if (blob !== raw.upstreamBlob) fail(`gate replay ${path} has changed upstream input; replay and re-review are required`)
    requireString(path, raw.replay, 'replay')
    requireString(path, raw.retireWhen, 'retireWhen')
    if (!Array.isArray(raw.regressions) || raw.regressions.length === 0) fail(`gate replay ${path} has no regressions`)
    const regressions: unknown[] = raw.regressions
    for (const value of [path, ...regressions]) {
      const ref = requireString(path, value, 'source reference')
      if (isAbsolute(ref) || relative(root, resolve(root, ref)).startsWith('..') || !existsSync(resolve(root, ref))) {
        fail(`gate replay ${path} has a missing or invalid source reference ${ref}`)
      }
    }
  }
}

function fail(message: string): never {
  throw new Error(`upgrade-records: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireString(owner: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') fail(`${owner} requires a non-empty "${field}"`)
  return value
}

function requireCommits(owner: string, row: Record<string, unknown>): void {
  const commits = row.upstreamCommits
  const scope = row.commitScope
  const reason = row.noUpstreamCommitReason
  if (Array.isArray(commits) && commits.length > 0) {
    for (const commit of commits) {
      if (typeof commit !== 'string' || !COMMIT_ID.test(commit)) {
        fail(`${owner} upstreamCommits entries must be commit ids, got ${JSON.stringify(commit)}`)
      }
    }
    return
  }
  if (Array.isArray(scope) && scope.length > 0) {
    for (const prefix of scope) {
      if (typeof prefix !== 'string' || prefix === '') {
        fail(`${owner} commitScope entries must be upstream path prefixes, got ${JSON.stringify(prefix)}`)
      }
    }
    return
  }
  if (typeof reason === 'string' && reason.trim() !== '') return
  fail(`${owner} must list upstreamCommits, a commitScope, or a noUpstreamCommitReason`)
}

function checkRow(owner: string, row: unknown): void {
  if (!isRecord(row)) fail(`${owner} must be an object`)
  const area = row.area ?? row.id
  const name = `${owner} "${typeof area === 'string' && area !== '' ? area : '?'}"`
  requireString(name, area, 'area/id')
  const status = requireString(name, row.status, 'status')
  if (!STATUSES.has(status)) fail(`${name} status must be one of ${[...STATUSES].join(' | ')}, got ${JSON.stringify(status)}`)
  requireString(name, row.localOwner, 'localOwner')
  const reviewState = requireString(name, row.reviewState, 'reviewState')
  if (!REVIEW_STATES.has(reviewState)) {
    fail(`${name} reviewState must be one of ${[...REVIEW_STATES].join(' | ')}, got ${JSON.stringify(reviewState)}`)
  }
  if (reviewState === 'released' && (typeof row.evidence !== 'string' || row.evidence.trim() === '')) {
    fail(`${name} claims "released" without an evidence field`)
  }
  requireCommits(name, row)
}

export function checkMatrix(path: string, raw: unknown): void {
  if (!isRecord(raw)) fail(`${path} must be a JSON object`)
  if (typeof raw.schemaVersion !== 'number' || raw.schemaVersion < 2) return // legacy generation
  requireString(path, raw.reviewDate, 'reviewDate')
  if (!DATE.test(raw.reviewDate as string)) fail(`${path} reviewDate must be YYYY-MM-DD`)
  if (!isRecord(raw.baseline)) fail(`${path} requires a baseline object`)
  requireString(`${path} baseline`, raw.baseline.tag, 'tag')
  if (!isRecord(raw.target)) fail(`${path} requires a target object`)
  requireString(`${path} target`, raw.target.tag, 'tag')
  if (!COMMIT_ID.test(String(raw.target.commit))) fail(`${path} target.commit must be a commit id`)
  if (!Array.isArray(raw.rows) || raw.rows.length === 0) fail(`${path} requires a non-empty rows array`)
  raw.rows.forEach((row, i) => {
    checkRow(`${path} row ${String(i)}`, row)
  })
}

export function checkManifest(path: string, raw: unknown): void {
  if (!isRecord(raw)) fail(`${path} must be a JSON object`)
  if (typeof raw.schemaVersion !== 'number' || raw.schemaVersion < 2) return // legacy generation
  requireString(path, raw.reviewDate, 'reviewDate')
  if (!isRecord(raw.upstream)) fail(`${path} requires an upstream object`)
  if (!Array.isArray(raw.upstream.targetTags) || raw.upstream.targetTags.length === 0) {
    fail(`${path} upstream.targetTags must be a non-empty array`)
  }
  for (const target of raw.upstream.targetTags) {
    if (!isRecord(target) || typeof target.tag !== 'string' || !COMMIT_ID.test(String(target.commit))) {
      fail(`${path} upstream.targetTags entries need { tag, commit }`)
    }
  }
  if (!isRecord(raw.baseline)) fail(`${path} requires a baseline object`)
  if (!COMMIT_ID.test(String(raw.baseline.commit))) fail(`${path} baseline.commit must be a commit id`)
  requireString(path, raw.targetVersion, 'targetVersion')
  requireString(path, raw.status, 'status')
  if (!Array.isArray(raw.decisions) || raw.decisions.length === 0) fail(`${path} requires a non-empty decisions array`)
  raw.decisions.forEach((row, i) => {
    checkRow(`${path} decision ${String(i)}`, row)
  })
}

/** Files present in one directory matching `prefix` and `suffix`. */
function recordsIn(dir: string, prefix: string, suffix: string): string[] {
  const abs = resolve(root, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter(name => name.startsWith(prefix) && name.endsWith(suffix) && statSync(resolve(abs, name)).isFile())
    .sort()
}

/**
 * Verify a generated commit inventory is fully claimed by its matrix.
 * @param path - inventory file path, for error messages.
 * @param inventory - parsed `UPSTREAM-COMMIT-INVENTORY-*.json`.
 * @param matrix - parsed matrix whose rows claim the commits.
 * @param matching - frozen historical inventories retain their original prefix interpretation; current proof uses directory segments.
 */
export function checkInventoryCoverage(path: string, inventory: unknown, matrix: unknown, matching: 'segments' | 'historical' = 'segments'): void {
  if (!isRecord(inventory) || !Array.isArray(inventory.commits)) return
  const claimed = new Set<string>()
  const scopes: string[] = []
  if (isRecord(matrix) && Array.isArray(matrix.rows)) {
    for (const row of matrix.rows) {
      if (!isRecord(row)) continue
      for (const sha of Array.isArray(row.upstreamCommits) ? row.upstreamCommits : []) {
        if (typeof sha === 'string') claimed.add(sha)
      }
      for (const prefix of Array.isArray(row.commitScope) ? row.commitScope : []) {
        if (typeof prefix === 'string') scopes.push(prefix)
      }
    }
  }
  const uncovered: string[] = []
  for (const commit of inventory.commits) {
    if (!isRecord(commit) || (commit.bucket !== 'carried' && commit.bucket !== 'newUpstream') || typeof commit.sha !== 'string') continue
    if (claimed.has(commit.sha)) continue
    const packages = Array.isArray(commit.packages) ? commit.packages.filter((p): p is string => typeof p === 'string') : []
    if (packages.some(key => scopes.some((prefix) => {
      if (matching === 'historical') return `packages/${key}`.startsWith(prefix) || prefix.startsWith(`packages/${key}`)
      const scope = prefix.replace(/\/+$/, '')
      const path = `packages/${key}`
      return path === scope || path.startsWith(scope + '/') || scope.startsWith(path + '/')
    }))) continue
    uncovered.push(commit.sha)
  }
  if (uncovered.length > 0) {
    fail(`${path} has ${String(uncovered.length)} carried-package commit(s) no matrix row claims (e.g. ${uncovered.slice(0, 5).join(', ')})`)
  }
}

function main(): number {
  const sync = JSON.parse(readFileSync(resolve(root, 'scripts/upstream-sync.json'), 'utf8')) as {
    syncedTag: string
    syncedCommit: string
    gateReplayRecord?: string
  }
  let checked = 0
  const matrices = new Map<string, unknown>()
  for (const name of recordsIn(ALIGNMENT_DIR, 'UPSTREAM-ALIGNMENT-MATRIX-', '.json')) {
    const rel = `${ALIGNMENT_DIR}/${name}`
    const parsed: unknown = JSON.parse(readFileSync(resolve(root, rel), 'utf8'))
    checkMatrix(rel, parsed)
    matrices.set(name.replace('UPSTREAM-ALIGNMENT-MATRIX-', '').replace('.json', ''), parsed)
    checked += 1
  }
  for (const name of recordsIn(ALIGNMENT_DIR, 'UPSTREAM-COMMIT-INVENTORY-', '.json')) {
    const rel = `${ALIGNMENT_DIR}/${name}`
    const parsed: unknown = JSON.parse(readFileSync(resolve(root, rel), 'utf8'))
    const tag = name.replace('UPSTREAM-COMMIT-INVENTORY-', '').replace('.json', '')
    const matrix = matrices.get(tag)
    if (matrix === undefined) fail(`${rel} has no matching UPSTREAM-ALIGNMENT-MATRIX-${tag}.json`)
    checkInventoryCoverage(rel, parsed, matrix, tag === sync.syncedTag ? 'segments' : 'historical')
    checked += 1
  }
  for (const name of recordsIn(MANIFEST_DIR, 'UPGRADE-MANIFEST-', '.json')) {
    const rel = `${MANIFEST_DIR}/${name}`
    checkManifest(rel, JSON.parse(readFileSync(resolve(root, rel), 'utf8')) as unknown)
    const plan = resolve(root, PLANS_DIR, name.replace('UPGRADE-MANIFEST-', 'UPGRADE-PLAN-').replace('.json', '.md'))
    if (!existsSync(plan)) fail(`${rel} has no matching plan ${PLANS_DIR}/${name.replace('UPGRADE-MANIFEST-', 'UPGRADE-PLAN-').replace('.json', '.md')}`)
    checked += 1
  }
  if (checked === 0) fail(`no upgrade records found under ${ALIGNMENT_DIR}/ or ${MANIFEST_DIR}/`)
  const replayRecord = requireString('upstream sync', sync.gateReplayRecord, 'gateReplayRecord')
  if (!replayRecord.startsWith(ALIGNMENT_DIR + '/') || relative(root, resolve(root, replayRecord)).startsWith('..')) fail('gate replay record must be an alignment matrix')
  checkGateReplays(root, sync.syncedCommit, JSON.parse(readFileSync(resolve(root, replayRecord), 'utf8')) as unknown)
  console.log(`upgrade-records: ${String(checked)} record file(s) conform; every row carries commit coverage or an explicit reason.`)
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message.startsWith('upgrade-records:') ? message : `upgrade-records: ${message}`)
    process.exitCode = 1
  }
}
