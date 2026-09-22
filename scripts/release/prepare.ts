/** Assemble deterministic readiness inputs from immutable CI artifacts and one upgrade record. */
import { execFileSync } from 'node:child_process'
import { globSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { gateEvidenceDigest, type GateEvidence } from '../gate-evidence.ts'
import { requiredReleaseChecks, type ReleaseCheck } from './requirements.ts'
import { releaseCandidateVersion, verifyConfiguredReadiness } from './readiness.ts'
import { releaseFamily } from './families.ts'
import { resolveUpgradeRecord, type UpgradeRecord } from './records.ts'
import { consumerReasons } from '../ci-consumer-relations.ts'

function matchesEnvironment(report: GateEvidence, check: ReleaseCheck): boolean {
  const env = report.stable.environment
  if (check.environment === 'windows-native') return env.runnerOS.toLowerCase() === 'windows' && env.execution === 'native'
  if (check.environment === 'linux-sandbox') return env.runnerOS.toLowerCase() === 'linux'
  if (check.environment === 'macos-sandbox') return env.runnerOS.toLowerCase() === 'macos'
  return check.environment !== 'artifact' || env.buildProfile === 'official'
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    family: { type: 'string' }, version: { type: 'string' }, runs: { type: 'string' }, record: { type: 'string' },
    phase: { type: 'string', default: 'preflight' }, directory: { type: 'string', default: '.artifacts/release-evidence' },
  }, allowPositionals: false })
  const root = process.cwd()
  const family = values.family
  if (!family || !['dsh', 'vendor', 'python', 'native'].includes(family)) throw new Error('release readiness: --family is required')
  const phase = values.phase
  if (phase !== 'preflight' && phase !== 'publish') throw new Error('release readiness: invalid phase')
  const git = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
  let version = values.version
  if (family === 'dsh' || family === 'vendor') {
    const owner = releaseFamily(family)
    const selected = releaseCandidateVersion(owner, owner.members(root), process.env.GITHUB_REF ?? '')
    if (version !== undefined && version !== selected) throw new Error('release readiness: version override differs from tag')
    version = selected
  } else if (!version || process.env.GITHUB_REF !== `refs/tags/${family === 'python' ? 'python-v' : 'node-addon-system-v'}${version}`) {
    throw new Error('release readiness: native/Python candidate must match its verified tag')
  }
  const commit = git(['rev-parse', 'HEAD'])
  const { syncedCommit: upstreamCommit } = JSON.parse(readFileSync('scripts/upstream-sync.json', 'utf8')) as { syncedCommit: string }
  const records = readdirSync('upgrades/manifests').filter(name => name.endsWith('.json')).map((name) => {
    const path = `upgrades/manifests/${name}`
    return { path, record: JSON.parse(readFileSync(path, 'utf8')) as UpgradeRecord }
  })
  const selected = resolveUpgradeRecord(records, family, version, upstreamCommit, values.record)
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('release readiness: GITHUB_REPOSITORY is required')
  const runs = (values.runs ?? process.env.DSH_RELEASE_EVIDENCE_RUNS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (phase === 'publish' && process.env.GITHUB_RUN_ID) runs.push(process.env.GITHUB_RUN_ID)
  if (runs.length === 0 || runs.some(run => !/^[1-9]\d*$/.test(run))) throw new Error('release readiness: explicit evidence run IDs are required')
  const directory = resolve(root, values.directory)
  const child = relative(resolve(root, '.artifacts'), directory)
  if (child.startsWith('..') || child === '') throw new Error('release readiness: evidence directory must be inside .artifacts')
  mkdirSync(directory, { recursive: true })
  for (const run of [...new Set(runs)].sort()) {
    execFileSync('gh', ['run', 'download', run, '--repo', repository, '--pattern', 'gate-evidence-*', '--dir', resolve(directory, run)],
      { cwd: root, stdio: 'inherit', timeout: 120_000 })
  }
  const reports = globSync('**/*.json', { cwd: directory }).flatMap((path) => {
    const report = JSON.parse(readFileSync(resolve(directory, path), 'utf8')) as Partial<GateEvidence>
    return report.version === 1 && report.stable?.commit === commit && report.stable.clean ? [{ path, report: report as GateEvidence }] : []
  })
  // A rerun has a monotonic GitHub attempt number. Keep earlier outcomes as
  // raw evidence, while selecting the latest attempt of each actual job.
  const latest = reports.filter(({ report }) => {
    const producer = report.observations.producer
    return producer !== null && !reports.some(({ report: other }) => {
      const previous = other.observations.producer
      return previous !== null && previous.runId === producer.runId && previous.job === producer.job
        && other.stable.mode === report.stable.mode && previous.attempt > producer.attempt
    })
  })
  const paths = git(['diff', '--name-only', '-z', '--no-renames', selected.baseCommit, commit]).split('\0').filter(Boolean)
  const requirements = requiredReleaseChecks(paths, family, phase).map((check) => {
    const matches = latest.filter(({ report }) => report.stable.mode === check.mode
      && report.stable.checks.some(item => item.id === check.check) && matchesEnvironment(report, check))
    if (matches.length === 0) throw new Error(`release readiness: missing ${check.mode}/${check.environment} on ${commit}`)
    // Complementary targets (the Python runtime matrix publishes one report
    // per platform) are not conflicts; only same-environment contradictions are.
    const byEnvironment = new Map<string, Set<string>>()
    for (const { report } of matches) {
      const key = JSON.stringify(report.stable.environment)
      const digests = byEnvironment.get(key) ?? new Set<string>()
      digests.add(gateEvidenceDigest(report))
      byEnvironment.set(key, digests)
    }
    for (const [environment, digests] of byEnvironment) {
      if (digests.size > 1) throw new Error(`release readiness: conflicting evidence for ${check.mode} on ${environment}`)
    }
    const proof = matches.sort((a, b) => a.path.localeCompare(b.path))[0]
    if (proof === undefined) throw new Error('release readiness: empty proof selection')
    return { ...check, report: proof.path }
  })
  const artifactMap = new Map<string, string>()
  for (const requirement of requirements.filter(item => item.environment === 'artifact')) {
    const proof = reports.find(item => item.path === requirement.report)
    if (proof === undefined) throw new Error('release readiness: lost selected proof')
    for (const artifact of proof.report.stable.artifacts) {
      if (artifactMap.has(artifact.path) && artifactMap.get(artifact.path) !== artifact.sha256) throw new Error('release readiness: conflicting artifact hashes')
      artifactMap.set(artifact.path, artifact.sha256)
    }
  }
  const path = resolve(directory, 'readiness.json')
  writeFileSync(path, JSON.stringify({ version: 1, policyVersion: 1, repository,
    subject: { family, version, commit, upstreamCommit, record: selected.path, mode: selected.mode, baseCommit: selected.baseCommit },
    requirements, artifacts: [...artifactMap].sort().map(([path, sha256]) => ({ path, sha256 })),
    scope: { paths, reasons: consumerReasons(paths), selectorPhase: 'shadow' },
    observations: { supersededEvidence: reports.filter(item => !latest.includes(item)).map(item => ({
      report: item.path, producer: item.report.observations.producer, checks: item.report.stable.checks,
    })) },
  }, null, 2) + '\n')
  process.env.DSH_RELEASE_READINESS = path
  await verifyConfiguredReadiness(root, family, version, phase, [...artifactMap.keys()])
  console.log(`release readiness: ${path}`)
}

if (import.meta.main) await main()
