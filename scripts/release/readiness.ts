/** Fail-closed publication evidence for a fixed candidate, upstream record, and artifact set. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import type { ReleaseFamily, ReleaseMember } from './families.ts'
import { requiredReleaseChecks } from './requirements.ts'
import { resolveUpgradeRecord, type UpgradeRecord } from './records.ts'

/** Resolve the one version selected by a verified family tag.
 * @param family - owning release-family implementation.
 * @param members - current family members.
 * @param ref - authoritative publication ref.
 * @returns the candidate version named by that tag.
 */
export function releaseCandidateVersion(family: ReleaseFamily, members: readonly ReleaseMember[], ref: string): string {
  if (!ref.startsWith('refs/tags/')) throw new Error('release readiness: publication requires a tag')
  const tag = ref.slice('refs/tags/'.length)
  const versions = [...new Set(members.filter(member => family.tagFor(member) === tag).map(member => member.version))]
  const version = versions[0]
  if (versions.length !== 1 || version === undefined) throw new Error('release readiness: tag does not select one family version')
  return version
}

/** Required host capability; unavailable proof is never interpreted as not applicable. */
export type EvidenceEnvironment = 'source' | 'artifact' | 'windows-native' | 'linux-sandbox' | 'macos-sandbox' | 'real-provider' | 'android-native' | 'android-push'

/** Authoritative lookup injected by tests only at the external GitHub boundary. */
export interface EvidenceAuthority {
  run(repository: string, runId: number): Promise<unknown>
  jobs(repository: string, runId: number, attempt: number): Promise<unknown>
  report(repository: string, runId: number, artifact: string, filename: string): Promise<string>
}

/** Candidate identity derived by the owning release-family implementation. */
export interface ReleaseCandidate {
  readonly root: string
  readonly family: string
  readonly version: string
  readonly evidencePath: string
  readonly repository: string
  readonly phase: 'preflight' | 'publish'
  readonly artifactPaths: readonly string[]
  readonly currentRunId?: number
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`release readiness: ${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`release readiness: ${label} must be non-empty`)
  return value
}

function sha(value: unknown, label: string): string {
  const result = text(value, label)
  if (!/^[a-f0-9]{40,64}$/.test(result)) throw new Error(`release readiness: ${label} is not a commit id`)
  return result
}

function rows(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`release readiness: ${label} must be non-empty`)
  return value
}

function ownedPath(root: string, path: unknown): string {
  const value = text(path, 'repository-relative path')
  const resolved = resolve(root, value)
  const child = relative(root, resolved)
  if (isAbsolute(value) || child === '..' || child.startsWith('..' + sep) || child === '') {
    throw new Error('release readiness: path escapes its evidence owner')
  }
  return resolved
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function matchesScope(path: string, scope: string): boolean {
  const prefix = scope.replace(/\/$/u, '')
  return path === prefix || path.startsWith(prefix + '/')
}

/** Assert environment capability against both the report and the authoritative job.
 * @param expected - required proof class.
 * @param environment - report environment fields.
 * @param job - authoritative GitHub job.
 * @param workflow - authoritative workflow path.
 */
export function assertEvidenceEnvironment(
  expected: string, environment: Record<string, unknown>, job: Record<string, unknown>, workflow: string,
): void {
  const labels = Array.isArray(job.labels) ? job.labels.filter((label): label is string => typeof label === 'string') : []
  const native = environment.execution === 'native'
  const runner = text(environment.runnerOS, 'runner OS').toLowerCase()
  switch (expected) {
    case 'source': return
    case 'artifact':
      if (environment.buildProfile !== 'official') throw new Error('release readiness: artifact proof requires the official build profile')
      return
    case 'windows-native':
      if (!native || runner !== 'windows' || environment.processPlatform !== 'win32'
        || !labels.some(label => /windows|dsh-win-ci/i.test(label))) {
        throw new Error('release readiness: Wine or a non-Windows runner cannot prove native Windows behavior')
      }
      return
    case 'linux-sandbox':
    case 'macos-sandbox': {
      const os = expected === 'linux-sandbox' ? 'linux' : 'macos'
      if (!native || runner !== os || workflow !== '.github/workflows/sandbox.yml') {
        throw new Error('release readiness: confinement requires its real-kernel workflow and host')
      }
      return
    }
    case 'real-provider':
      if (!['.github/workflows/e2e.yml', '.github/workflows/pi-ai-provider-e2e.yml'].includes(workflow)) {
        throw new Error('release readiness: mocked or replayed checks cannot prove a real provider')
      }
      return
    case 'android-native':
    case 'android-push':
      if (job.name !== (expected === 'android-native' ? 'android / native bridge' : 'android / real push')) {
        throw new Error('release readiness: Android build, bridge, and real push evidence are not interchangeable')
      }
      return
    default: throw new Error(`release readiness: unknown required environment ${expected}`)
  }
}

/** Validate a release without performing registry writes.
 * @param candidate - authoritative family/version and the supplied report location.
 * @param authority - authenticated GitHub read operations.
 */
export async function assertReleaseReadiness(candidate: ReleaseCandidate, authority: EvidenceAuthority): Promise<void> {
  // Read-only GitHub lookups are identical for every requirement of one
  // release path; cache them within this assertion so four executions do not
  // multiply into four times the API calls.
  const cachedRuns = new Map<string, Promise<unknown>>()
  const cachedJobs = new Map<string, Promise<unknown>>()
  const cachedReports = new Map<string, Promise<string>>()
  authority = {
    run: (repository, runId) => {
      const key = `${repository}#${runId}`
      const hit = cachedRuns.get(key) ?? authority.run(repository, runId)
      cachedRuns.set(key, hit)
      return hit
    },
    jobs: (repository, runId, attempt) => {
      const key = `${repository}#${runId}#${attempt}`
      const hit = cachedJobs.get(key) ?? authority.jobs(repository, runId, attempt)
      cachedJobs.set(key, hit)
      return hit
    },
    report: (repository, runId, artifact, filename) => {
      const key = `${repository}#${runId}#${artifact}#${filename}`
      const hit = cachedReports.get(key) ?? authority.report(repository, runId, artifact, filename)
      cachedReports.set(key, hit)
      return hit
    },
  }
  const { root, family, version } = candidate
  const report = object(json(candidate.evidencePath), 'readiness report')
  if (report.version !== 1 || report.policyVersion !== 1) throw new Error('release readiness: unsupported report or policy version')
  const subject = object(report.subject, 'subject')
  const head = git(root, ['rev-parse', 'HEAD'])
  if (subject.family !== family || subject.version !== version || subject.commit !== head) {
    throw new Error('release readiness: candidate family, version or commit mismatch')
  }
  if (report.repository !== candidate.repository) throw new Error('release readiness: candidate repository mismatch')
  if (git(root, ['status', '--porcelain', '--untracked-files=all']) !== '') {
    throw new Error('release readiness: publication requires a clean committed source tree')
  }
  const sourceManifest = object(json(resolve(root, 'scripts/upstream-sync.json')), 'upstream manifest')
  const upstream = sha(subject.upstreamCommit, 'upstream commit')
  if (sourceManifest.syncedCommit !== upstream) throw new Error('release readiness: upstream comparison target mismatch')
  const recordPath = ownedPath(root, subject.record)
  if (!relative(root, recordPath).replaceAll('\\', '/').startsWith('upgrades/manifests/')) {
    throw new Error('release readiness: record must be an upgrade manifest')
  }
  const record = object(json(recordPath), 'upgrade record')
  const directory = resolve(root, 'upgrades/manifests')
  const records = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => ({
    path: `upgrades/manifests/${name}`, record: json(resolve(directory, name)) as UpgradeRecord,
  }))
  const selected = resolveUpgradeRecord(records, family, version, upstream, text(subject.record, 'selected record'))
  if (subject.mode !== selected.mode) throw new Error('release readiness: release mode does not match the applicable record')
  const expectedBaseline = selected.baseCommit
  const targets = rows(object(record.upstream, 'record upstream').targetTags, 'upstream targets')
  if (!targets.some(target => object(target, 'target').commit === upstream)) throw new Error('release readiness: record does not own upstream target')
  const matrix = object(json(ownedPath(root, record.alignment)), 'alignment matrix')
  if (object(matrix.target, 'matrix target').commit !== upstream) throw new Error('release readiness: matrix target mismatch')
  const decisions = [...rows(record.decisions, 'decisions'), ...rows(matrix.rows, 'alignment rows')].map(row => object(row, 'decision'))
  rows(record.verification, 'upgrade verification')
  for (const decision of decisions) {
    if (!['retain', 'equivalent', 'adapt', 'required', 'defer', 'reject'].includes(String(decision.status))) {
      throw new Error('release readiness: unknown decision disposition')
    }
    if (!['implemented-local-tests-passing', 'released'].includes(String(decision.reviewState))) {
      throw new Error(`release readiness: unaccepted decision ${String(decision.id ?? decision.area)}`)
    }
    if (decision.status === 'defer' || decision.status === 'reject') text(decision.evidence, 'approved exclusion evidence')
  }
  const baseline = sha(subject.baseCommit, 'local baseline')
  if (baseline !== expectedBaseline) throw new Error('release readiness: unregistered local baseline')
  git(root, ['merge-base', '--is-ancestor', baseline, head])
  const changes = git(root, ['diff', '--name-only', '-z', '--no-renames', baseline, head]).split('\0').filter(Boolean)
  if (JSON.stringify(object(report.scope, 'scope').paths) !== JSON.stringify(changes)) {
    throw new Error('release readiness: reported scope does not match the actual candidate diff')
  }
  const scopes = decisions.flatMap(decision => Array.isArray(decision.commitScope)
    ? decision.commitScope.map(scope => text(scope, 'decision scope')) : [])
  const uncovered = changes.filter(path =>
    /^(?:packages|apps|gateway|plugins|python|vendor|native|scripts|\.github)\//.test(path)
    || /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|lefthook\.yml|tsconfig.*\.json)$/.test(path),
  ).filter(path => !scopes.some(scope => matchesScope(path, scope)))
  if (uncovered.length > 0) throw new Error('release readiness: unclaimed candidate paths: ' + uncovered.join(', '))
  // A vendored input changed after acceptance cannot inherit a review that
  // never saw those bytes: some claiming decision must bind the release's
  // upstream target in its reviewed upstreamCommits. Ordinary local hotfixes
  // outside vendored inputs keep inheriting the accepted baseline.
  const vendorChanges = changes.filter(path => path.startsWith('vendor/'))
  const unboundVendor = vendorChanges.filter(path => !decisions.some(decision =>
    Array.isArray(decision.commitScope)
    && (decision.commitScope as unknown[]).some(scope => matchesScope(path, text(scope, 'decision scope')))
    && Array.isArray(decision.upstreamCommits)
    && (decision.upstreamCommits as unknown[]).includes(upstream)))
  if (unboundVendor.length > 0) {
    throw new Error('release readiness: vendor changes since the accepted baseline need a decision whose upstreamCommits bind the release target: ' + unboundVendor.join(', '))
  }
  const proofRoot = resolve(candidate.evidencePath, '..')
  const requirements = rows(report.requirements, 'required checks')
  const policyRequired = requiredReleaseChecks(changes, family, candidate.phase)
  for (const required of policyRequired) {
    if (!requirements.some((raw) => {
      const item = object(raw, 'required check')
      return item.mode === required.mode && item.check === required.check && item.environment === required.environment
    })) throw new Error(`release readiness: missing required policy check ${required.mode}/${required.check}/${required.environment}`)
  }
  // Only the announced policy set gates the verdict: proofs recorded beyond it
  // (a wider manual run's extra platforms or consumers) stay raw evidence in
  // the report and cannot silently block a narrower required release.
  const requiredKeys = new Set(policyRequired.map(required => `${required.mode}${required.check}${required.environment}`))
  const verdictRequirements = requirements.filter((raw) => {
    const item = object(raw, 'required check')
    return requiredKeys.has(`${text(item.mode, 'required mode')}${text(item.check, 'required check')}${text(item.environment, 'required environment')}`)
  })
  const coveredEnvironments = new Set<string>()
  const verifiedArtifacts = new Map<string, string>()
  const androidArtifacts = new Map<string, Map<string, string>>()
  for (const raw of verdictRequirements) {
    const requirement = object(raw, 'required check')
    if (candidate.phase === 'preflight' && requirement.environment === 'artifact') continue
    const proofPath = ownedPath(proofRoot, requirement.report)
    const rawProof = readFileSync(proofPath, 'utf8')
    const proof = object(JSON.parse(rawProof) as unknown, 'gate evidence')
    if (proof.version !== 1) throw new Error('release readiness: unsupported gate evidence version')
    const stable = object(proof.stable, 'stable evidence')
    if (stable.commit !== head || stable.upstreamCommit !== upstream || stable.clean !== true) {
      throw new Error('release readiness: stale or dirty gate evidence')
    }
    const checks = rows(stable.checks, 'executed checks').map(check => object(check, 'check'))
    if (new Set(checks.map(check => check.id)).size !== checks.length) throw new Error('release readiness: duplicate check identity')
    const chosen = checks.filter(check => check.id === requirement.check)
    if (chosen.length !== 1 || stable.mode !== requirement.mode) throw new Error('release readiness: required check was not executed')
    for (const check of checks.filter(check => check.required === true || check === chosen[0])) {
      if (check.status !== 'passed' || check.exitCode !== 0 || check.signal !== null || check.aborted !== false) {
        throw new Error('release readiness: failed, skipped or cancelled required check')
      }
    }
    const producer = object(object(proof.observations, 'observations').producer, 'GitHub producer')
    const repository = text(producer.repository, 'producer repository')
    if (repository !== report.repository) throw new Error('release readiness: evidence repository mismatch')
    const runId = producer.runId
    const attempt = producer.attempt
    if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(attempt) || Number(runId) < 1 || Number(attempt) < 1) {
      throw new Error('release readiness: invalid run identity')
    }
    const run = object(await authority.run(repository, Number(runId)), 'GitHub run')
    const completed = run.status === 'completed' && run.conclusion === 'success'
    const publishing = Number(runId) === candidate.currentRunId && run.status === 'in_progress'
      && ['.github/workflows/release.yml', '.github/workflows/release-vendor.yml', '.github/workflows/python-release.yml', '.github/workflows/landlock-run-release.yml'].includes(String(run.path))
    if (run.head_sha !== head || (!completed && !publishing) || run.path !== producer.workflow) {
      throw new Error('release readiness: authoritative run does not match candidate')
    }
    if (object(run.repository, 'GitHub repository').full_name !== candidate.repository) throw new Error('release readiness: foreign evidence repository')
    const jobs = object(await authority.jobs(repository, Number(runId), Number(attempt)), 'GitHub jobs')
    const matching = rows(jobs.jobs, 'GitHub jobs').map(job => object(job, 'job')).filter(job =>
      job.name === producer.job || (typeof job.name === 'string' && job.name.endsWith(' / ' + text(producer.job, 'producer job'))))
    if (matching.length !== 1 || matching[0]?.conclusion !== 'success') throw new Error('release readiness: authoritative job did not succeed')
    const authoritative = await authority.report(repository, Number(runId), text(producer.artifact, 'evidence artifact'), basename(proofPath))
    if (rawProof !== authoritative) throw new Error('release readiness: report bytes do not match the completed job artifact')
    const environment = text(requirement.environment, 'required environment')
    if (environment === 'real-provider' && (!Array.isArray(stable.providerAssertions) || stable.providerAssertions.length === 0)) {
      throw new Error('release readiness: no executed provider assertion evidence')
    }
    if (environment === 'artifact' && !['built-bin-smoke', 'node-next-types', 'built-package-invariants', 'publint', 'npm-pack', 'python-runtime', 'python-release', 'native-pack'].includes(String(requirement.check))) {
      throw new Error('release readiness: a source check is not published-artifact proof')
    }
    assertEvidenceEnvironment(environment, object(stable.environment, 'environment'), matching[0], String(run.path))
    coveredEnvironments.add(environment)
    const artifacts = stable.artifacts
    if (artifacts !== undefined) {
      if (!Array.isArray(artifacts)) throw new Error('release readiness: malformed artifact evidence')
      for (const item of artifacts) {
        const artifact = object(item, 'tested artifact')
        const path = text(artifact.path, 'tested artifact path')
        const digest = text(artifact.sha256, 'tested artifact hash')
        if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('release readiness: malformed artifact hash')
        const previous = verifiedArtifacts.get(path)
        if (previous !== undefined && previous !== digest) throw new Error('release readiness: contradictory tested artifacts')
        verifiedArtifacts.set(path, digest)
        if (requirement.mode === 'android-build' || requirement.mode === 'android-bridge') {
          const hashes = androidArtifacts.get(requirement.mode) ?? new Map<string, string>()
          hashes.set(basename(path), digest)
          androidArtifacts.set(requirement.mode, hashes)
        }
      }
    }
  }
  if (coveredEnvironments.has('android-native')) {
    for (const name of ['app-debug.apk', 'app-debug-androidTest.apk']) {
      const built = androidArtifacts.get('android-build')?.get(name)
      if (built === undefined || built !== androidArtifacts.get('android-bridge')?.get(name)) {
        throw new Error('release readiness: Android build and bridge did not validate the same APKs')
      }
    }
  }
  if (!coveredEnvironments.has('source') || (candidate.phase === 'publish' && !coveredEnvironments.has('artifact'))) {
    throw new Error('release readiness: both source and published-artifact evidence are required')
  }
  if (candidate.phase === 'preflight') return
  const expectedPaths = [...candidate.artifactPaths].map(path => relative(root, resolve(root, path)).replaceAll('\\', '/')).sort()
  if (expectedPaths.length === 0) throw new Error('release readiness: publisher supplied no artifact inventory')
  const actualPaths: string[] = []
  for (const item of rows(report.artifacts, 'tested artifacts')) {
    const artifact = object(item, 'artifact')
    const path = ownedPath(root, artifact.path)
    const expected = text(artifact.sha256, 'artifact digest')
    const rel = relative(root, path).replaceAll('\\', '/')
    actualPaths.push(rel)
    if (!/^[a-f0-9]{64}$/.test(expected) || verifiedArtifacts.get(rel) !== expected
      || createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) {
      throw new Error('release readiness: tested artifact identity mismatch')
    }
  }
  if (JSON.stringify(actualPaths.sort()) !== JSON.stringify(expectedPaths)) throw new Error('release readiness: report does not cover the publisher artifact inventory')
}

/** Build authenticated, read-only GitHub lookups without accepting a report-supplied API URL.
 * @param token - release job's GitHub token.
 * @returns authoritative run/job readers.
 */
export function githubEvidenceAuthority(token: string): EvidenceAuthority {
  const request = async (repository: string, path: string): Promise<unknown> => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('release readiness: invalid repository')
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`release readiness: GitHub evidence unavailable (HTTP ${response.status})`)
    return await response.json() as unknown
  }
  const reportCache = new Map<string, Promise<string>>()
  return {
    run: (repository, id) => request(repository, `runs/${id}`),
    jobs: async (repository, id, attempt) => {
      const jobs: unknown[] = []
      for (let page = 1; ; page++) {
        const data = object(await request(repository, `runs/${id}/attempts/${attempt}/jobs?per_page=100&page=${page}`), 'job page')
        if (!Array.isArray(data.jobs)) throw new Error('release readiness: invalid jobs response')
        const pageJobs: unknown[] = data.jobs
        jobs.push(...pageJobs)
        if (jobs.length >= Number(data.total_count)) return { jobs }
        if (data.jobs.length === 0) throw new Error('release readiness: incomplete jobs response')
      }
    },
    report: (repository, id, artifact, filename) => {
      const key = `${repository}/${id}/${artifact}/${filename}`
      const existing = reportCache.get(key)
      if (existing !== undefined) return existing
      const task = (async (): Promise<string> => {
        if (!/^gate-evidence-[\w.-]+$/.test(artifact) || !/^[\w.-]+\.json$/.test(filename)) throw new Error('release readiness: invalid evidence artifact identity')
        const artifacts: Record<string, unknown>[] = []
        for (let page = 1; ; page++) {
          const data = object(await request(repository, `runs/${id}/artifacts?per_page=100&page=${page}`), 'artifact page')
          if (!Array.isArray(data.artifacts)) throw new Error('release readiness: invalid artifacts response')
          artifacts.push(...data.artifacts.map(item => object(item, 'artifact')))
          if (artifacts.length >= Number(data.total_count)) break
          if (data.artifacts.length === 0) throw new Error('release readiness: incomplete artifacts response')
        }
        const selected = artifacts.filter(item => item.name === artifact && item.expired === false)
        const artifactRow = selected[0]
        if (selected.length !== 1 || artifactRow === undefined || !Number.isSafeInteger(artifactRow.id)) throw new Error('release readiness: missing or ambiguous evidence artifact')
        const response = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${String(artifactRow.id)}/zip`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) throw new Error(`release readiness: artifact download failed (HTTP ${response.status})`)
        const directory = mkdtempSync(resolve(tmpdir(), 'release-proof-'))
        try {
          const archive = resolve(directory, 'evidence.zip')
          writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
          // Read one named entry; never extract paths supplied by an archive.
          return execFileSync('unzip', ['-p', archive, filename], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 })
        } finally { rmSync(directory, { recursive: true, force: true }) }
      })()
      reportCache.set(key, task)
      return task
    },
  }
}

/** Require configured evidence before a publishing caller can write to a registry.
 * @param root - release checkout.
 * @param family - verified release family.
 * @param version - verified candidate version.
 * @param phase - preflight validates source readiness; publication additionally verifies immutable artifacts.
 * @param artifactPaths - exact files the publisher will consume.
 */
export async function verifyConfiguredReadiness(
  root: string, family: string, version: string, phase: ReleaseCandidate['phase'], artifactPaths: readonly string[],
): Promise<void> {
  const path = process.env.DSH_RELEASE_READINESS
  if (!path || !existsSync(resolve(root, path))) throw new Error('release readiness: DSH_RELEASE_READINESS must name the candidate evidence report')
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (!token) throw new Error('release readiness: authenticated GitHub evidence is unavailable')
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error('release readiness: authoritative repository identity is unavailable')
  await assertReleaseReadiness({ root, family, version, evidencePath: resolve(root, path), repository, phase, artifactPaths,
    ...(process.env.GITHUB_RUN_ID ? { currentRunId: Number(process.env.GITHUB_RUN_ID) } : {}),
  }, githubEvidenceAuthority(token))
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { family: { type: 'string' }, version: { type: 'string' } }, allowPositionals: false })
  if (!values.family || !values.version) throw new Error('release readiness: --family and --version are required')
  await verifyConfiguredReadiness(process.cwd(), values.family, values.version, 'preflight', [])
}
