import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertEvidenceEnvironment, assertReleaseReadiness, githubEvidenceAuthority, type EvidenceAuthority, type ReleaseCandidate } from './readiness.ts'
import { resolveUpgradeRecord } from './records.ts'
import { requiredReleaseChecks } from './requirements.ts'

const upstream = 'a'.repeat(40)
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-readiness-'))
  roots.push(root)
  const write = (path: string, value: unknown): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
  }
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = (): string => {
    git('add', '.')
    git('-c', 'user.name=Gate fixture', '-c', 'user.email=gate@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q')
  write('.gitignore', '.artifacts/\n')
  write('scripts/upstream-sync.json', { syncedCommit: upstream })
  const base = commit()
  const decision = { id: 'consumer', status: 'adapt', reviewState: 'implemented-local-tests-passing', commitScope: ['packages/util/probe'] }
  const record = { targetVersion: '1.0.0', baseline: { commit: base }, upstream: { targetTags: [{ commit: upstream }] },
    alignment: 'upgrades/alignment/current.json', verification: ['focused fixture evidence'], decisions: [decision] }
  write('upgrades/manifests/current.json', record)
  write('upgrades/alignment/current.json', { target: { commit: upstream }, rows: [decision] })
  write('packages/util/probe/src/index.ts', 'export const value = 1\n')
  const head = commit()
  write('.artifacts/dist/package.tgz', 'tested packed bytes')
  const digest = createHash('sha256').update('tested packed bytes').digest('hex')
  const check = (id: string) => ({ id, command: id, required: true, reason: 'candidate', status: 'passed', exitCode: 0, signal: null, aborted: false })
  const proof = (mode: string, id: string) => ({ version: 1, stable: {
    policyVersion: 1, commit: head, upstreamCommit: upstream, clean: true, mode,
    environment: { runnerOS: 'Linux', execution: 'native', buildProfile: 'official', processPlatform: 'linux', architecture: 'x64', node: 'v24.0.0' },
    checks: [check(id)], artifacts: mode === 'npm-pack' ? [{ path: '.artifacts/dist/package.tgz', sha256: digest }] : [],
  }, observations: { durationMs: 1, recordedAt: '2026-09-21', producer: {
    repository: 'owner/repo', runId: mode === 'npm-pack' ? 2 : 1, attempt: 1, job: mode, artifact: `gate-evidence-${mode}`,
    workflow: mode === 'npm-pack' ? '.github/workflows/release.yml' : '.github/workflows/ci.yml',
  } } })
  const source = proof('ci-linux-primary', 'lint')
  const packed = proof('npm-pack', 'npm-pack')
  write('.artifacts/proofs/source.json', source)
  write('.artifacts/proofs/pack.json', packed)
  const report = { version: 1, policyVersion: 1, repository: 'owner/repo',
    scope: { paths: git('diff', '--name-only', '-z', '--no-renames', base, head).split('\0').filter(Boolean) }, subject: {
      family: 'dsh', version: '1.0.0', commit: head, upstreamCommit: upstream, baseCommit: base,
      record: 'upgrades/manifests/current.json', mode: 'alignment',
    }, requirements: [
      { mode: 'ci-linux-primary', check: 'lint', environment: 'source', report: 'source.json' },
      { mode: 'npm-pack', check: 'npm-pack', environment: 'artifact', report: 'pack.json' },
    ], artifacts: [{ path: '.artifacts/dist/package.tgz', sha256: digest }] }
  write('.artifacts/proofs/readiness.json', report)
  const authoritative = new Map(['source.json', 'pack.json'].map(name => [name, readFileSync(join(root, '.artifacts/proofs', name), 'utf8')]))
  const authority: EvidenceAuthority = {
    run: async (_repository, id) => ({ head_sha: report.subject.commit, status: id === 2 ? 'in_progress' : 'completed',
      conclusion: id === 2 ? null : 'success', path: id === 2 ? '.github/workflows/release.yml' : '.github/workflows/ci.yml', repository: { full_name: 'owner/repo' } }),
    jobs: async (_repository, id) => ({ jobs: [{ name: id === 2 ? 'npm-pack' : 'ci-linux-primary', conclusion: 'success', labels: ['ubuntu-latest'] }] }),
    report: async (_repository, _id, _artifact, name) => authoritative.get(name) ?? '',
  }
  const candidate: ReleaseCandidate = { root, family: 'dsh', version: '1.0.0', phase: 'publish', evidencePath: join(root, '.artifacts/proofs/readiness.json'),
    repository: 'owner/repo', currentRunId: 2, artifactPaths: ['.artifacts/dist/package.tgz'] }
  const updateHead = (): void => {
    const head = commit()
    report.subject.commit = head
    source.stable.commit = head
    packed.stable.commit = head
    report.scope.paths = git('diff', '--name-only', '-z', '--no-renames', base, head).split('\0').filter(Boolean)
  }
  const save = (authentic = true): void => {
    write('.artifacts/proofs/readiness.json', report)
    write('.artifacts/proofs/source.json', source)
    write('.artifacts/proofs/pack.json', packed)
    if (authentic) for (const name of authoritative.keys()) authoritative.set(name, readFileSync(join(root, '.artifacts/proofs', name), 'utf8'))
  }
  return { root, candidate, authority, record, report, source, packed, write, updateHead, save }
}

describe('publication readiness', () => {
  it('reads every authoritative job page and rejects incomplete GitHub responses', async () => {
    const fetcher = vi.fn(async (url: string) => Response.json(url.includes('page=2')
      ? { jobs: [{ name: 'last', conclusion: 'success' }], total_count: 101 }
      : { jobs: Array.from({ length: 100 }, (_, index) => ({ name: String(index) })), total_count: 101 }))
    vi.stubGlobal('fetch', fetcher)
    try {
      const authority = githubEvidenceAuthority('fixture-token')
      const result = await authority.jobs('owner/repo', 42, 2) as { jobs: unknown[] }
      expect(result.jobs).toHaveLength(101)
      expect(fetcher).toHaveBeenCalledTimes(2)
      fetcher.mockImplementation(async () => Response.json({ jobs: [], total_count: 1 }))
      await expect(authority.jobs('owner/repo', 42, 2)).rejects.toThrow('incomplete jobs response')
      await expect(authority.run('owner/repo/extra', 42)).rejects.toThrow('invalid repository')
    } finally { vi.unstubAllGlobals() }
  })
  it('requires the Android build and real bridge to use the same application and test APKs', async () => {
    const f = fixture()
    const build = structuredClone(f.source)
    const bridge = structuredClone(f.source)
    build.stable.mode = 'android-build'
    build.stable.checks[0]!.id = 'android-build'
    build.observations.producer.job = 'android / debug build and lint'
    bridge.stable.mode = 'android-bridge'
    bridge.stable.checks[0]!.id = 'android-bridge'
    bridge.observations.producer.job = 'android / native bridge'
    build.stable.artifacts = ['app-debug.apk', 'app-debug-androidTest.apk'].map(path => ({ path: `build/${path}`, sha256: 'a'.repeat(64) }))
    bridge.stable.artifacts = ['app-debug.apk', 'app-debug-androidTest.apk'].map(path => ({ path: `download/${path}`, sha256: 'a'.repeat(64) }))
    f.write('.artifacts/proofs/android-build.json', build)
    f.write('.artifacts/proofs/android-bridge.json', bridge)
    f.report.requirements.push({ mode: 'android-build', check: 'android-build', environment: 'source', report: 'android-build.json' },
      { mode: 'android-bridge', check: 'android-bridge', environment: 'android-native', report: 'android-bridge.json' })
    f.save()
    f.authority.jobs = async () => ({ jobs: ['ci-linux-primary', build.observations.producer.job, bridge.observations.producer.job]
      .map(name => ({ name, conclusion: 'success', labels: ['ubuntu-latest'] })) })
    f.authority.report = async (_repo, _id, _artifact, name) => readFileSync(join(f.root, '.artifacts/proofs', name), 'utf8')
    await expect(assertReleaseReadiness({ ...f.candidate, phase: 'preflight' }, f.authority)).resolves.toBeUndefined()
    bridge.stable.artifacts[0]!.sha256 = 'b'.repeat(64)
    f.write('.artifacts/proofs/android-bridge.json', bridge)
    await expect(assertReleaseReadiness({ ...f.candidate, phase: 'preflight' }, f.authority)).rejects.toThrow('same APKs')
  })
  it('accepts completed source and pack jobs for identical candidate bytes before the release workflow ends', async () => {
    const f = fixture()
    await expect(assertReleaseReadiness(f.candidate, f.authority)).resolves.toBeUndefined()
  })

  it.each(['failed', 'skipped'])('rejects %s required checks and an omitted policy requirement', async (status) => {
    const f = fixture()
    f.source.stable.checks[0]!.status = status
    f.save()
    await expect(assertReleaseReadiness(f.candidate, f.authority)).rejects.toThrow('failed, skipped or cancelled')
    f.report.requirements.shift()
    f.save()
    await expect(assertReleaseReadiness(f.candidate, f.authority)).rejects.toThrow('missing required policy check')
  })

  it('rejects a forged report, a different candidate, and artifact changes after verification', async () => {
    const f = fixture()
    f.source.observations.durationMs = 999
    f.save(false)
    await expect(assertReleaseReadiness(f.candidate, f.authority)).rejects.toThrow('report bytes')
    f.save()
    f.write('.artifacts/dist/package.tgz', 'changed after testing')
    await expect(assertReleaseReadiness(f.candidate, f.authority)).rejects.toThrow('artifact identity')
    f.report.subject.commit = 'b'.repeat(40)
    f.save()
    await expect(assertReleaseReadiness(f.candidate, f.authority)).rejects.toThrow('candidate family, version or commit')
  })

  it('blocks pending decisions and empty verification even when CI is green', async () => {
    const f = fixture()
    f.record.decisions[0]!.reviewState = 'pending-cumulative-source-review'
    f.write('upgrades/manifests/current.json', f.record)
    f.updateHead(); f.save()
    await expect(assertReleaseReadiness(f.candidate, f.authority)).rejects.toThrow('unaccepted decision')
    f.record.decisions[0]!.reviewState = 'implemented-local-tests-passing'
    f.record.verification = []
    f.write('upgrades/manifests/current.json', f.record)
    f.updateHead(); f.save()
    await expect(assertReleaseReadiness(f.candidate, f.authority)).rejects.toThrow('upgrade verification')
  })

  it('rejects unclaimed vendor paths and does not treat a prefix as a directory segment', async () => {
    const f = fixture()
    f.write('vendor-new/index.ts', 'not a vendor directory\n')
    f.write('vendor/cordis/src/index.ts', 'changed framework\n')
    f.updateHead(); f.save()
    await expect(assertReleaseReadiness(f.candidate, f.authority)).rejects.toThrow('unclaimed candidate paths: vendor/cordis/src/index.ts')
  })

  it('rejects ambiguous records even with an explicit choice', async () => {
    const f = fixture()
    f.write('upgrades/manifests/duplicate.json', f.record)
    f.updateHead(); f.save()
    await expect(assertReleaseReadiness(f.candidate, f.authority)).rejects.toThrow('multiple applicable upgrade records')
    const records = [{ path: 'a', record: f.record }, { path: 'b', record: f.record }]
    expect(() => resolveUpgradeRecord(records, 'dsh', '1.0.0', upstream, 'a')).toThrow('multiple applicable')
    expect(() => resolveUpgradeRecord(records, 'dsh', '0.0.0', upstream)).toThrow('placeholder')
  })

  it('rejects a different upstream target for a product release', async () => {
    const f = fixture()
    f.report.subject.mode = 'product'
    f.save()
    await expect(assertReleaseReadiness(f.candidate, f.authority)).rejects.toThrow('release mode does not match')
  })

  it('executes the real preflight command without registry access when evidence is missing', () => {
    const env = { ...process.env }
    delete env.DSH_RELEASE_READINESS
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', resolve(import.meta.dirname, 'readiness.ts'), '--family', 'dsh', '--version', '1.0.0'],
      { cwd: process.cwd(), env, encoding: 'utf8', timeout: 20_000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('DSH_RELEASE_READINESS')
  }, 30_000)
})

describe('release environment requirements', () => {
  it('distinguishes native Windows, real providers and the ordinary Android bridge', () => {
    expect(() =>{  assertEvidenceEnvironment('windows-native', { runnerOS: 'Linux', execution: 'wine' }, { labels: ['ubuntu-latest'] }, '.github/workflows/ci.yml') }).toThrow('Wine')
    expect(() =>{  assertEvidenceEnvironment('real-provider', { runnerOS: 'Linux' }, {}, '.github/workflows/ci.yml') }).toThrow('mocked or replayed')
    expect(() =>{  assertEvidenceEnvironment('android-native', { runnerOS: 'Linux' }, { name: 'android / debug build and lint' }, '.github/workflows/ci.yml') }).toThrow('not interchangeable')
    expect(() =>{  assertEvidenceEnvironment('windows-native', { runnerOS: 'Windows', execution: 'native', processPlatform: 'win32' }, { labels: ['windows-2025'] }, '.github/workflows/ci.yml') }).not.toThrow()
  })
  it('requires kernel and SDK proofs while leaving Android outside product release requirements', () => {
    expect(requiredReleaseChecks(['packages/core/agent-loop/src/index.ts'], 'dsh', 'preflight').map(check => check.mode)).toContain('python-sdk')
    expect(requiredReleaseChecks(['packages/sandbox/sandbox-local/src/index.ts'], 'dsh', 'preflight').map(check => check.environment)).toContain('windows-native')
    const checks = requiredReleaseChecks(['gateway/src/push-notifications.ts', 'apps/android-shell/android/app/src/main/MainActivity.java'], 'dsh', 'publish')
    expect(checks.map(check => check.mode)).toContain('gateway')
    expect(checks.some(check => check.mode.startsWith('android-'))).toBe(false)
  })
})
