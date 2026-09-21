import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectGateEvidence, gateEvidenceDigest, providerAssertions, writeGateEvidence } from './gate-evidence.ts'
import { checkGateReplays } from './verify-upgrade-records.ts'
import type { GateResult } from './run-gates.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gate-evidence-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, '.gitignore'), '.artifacts/\n')
  writeFileSync(join(root, 'scripts/upstream-sync.json'), JSON.stringify({ syncedCommit: 'a'.repeat(40) }))
  writeFileSync(join(root, 'scripts/gate.ts'), 'export const value = 1\n')
  writeFileSync(join(root, 'scripts/gate.spec.ts'), '// behavioral fixture\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=Gate', '-c', 'user.email=gate@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], { cwd: root })
  return root
}
const passed: GateResult = {
  gate: { id: 'guard', label: 'guard', command: 'node', args: ['guard.ts'], displayCommand: 'node guard.ts' },
  status: 'passed', output: [], durationMs: 5, exitCode: 0, signalCode: null,
}

describe('immutable gate evidence', () => {
  it('requires actual successful assertions for both pi-ai protocols instead of credential presence', () => {
    const openai = { fullName: 'llm-pi-ai openai e2e (openai-responses) tool round', status: 'passed' }
    const anthropic = { fullName: 'llm-pi-ai anthropic e2e (anthropic-messages) tool round', status: 'passed' }
    const raw = { numFailedTests: 0, testResults: [{ assertionResults: [openai, anthropic] }] }
    expect(providerAssertions(raw, 'real-provider-pi-ai')).toHaveLength(2)
    anthropic.status = 'skipped'
    expect(() => providerAssertions(raw, 'real-provider-pi-ai')).toThrow('every required protocol')
    expect(() => providerAssertions({ numFailedTests: 0, testResults: [] }, 'real-provider')).toThrow('no successful')
  })
  it('binds source and results while excluding timing, run IDs and secrets from comparison', () => {
    const root = fixture()
    const first = collectGateEvidence(root, 'test', [passed], 5, { SECRET: 'never-record-this' })
    const second = collectGateEvidence(root, 'test', [passed], 99, {})
    expect(first.stable.clean).toBe(true)
    expect(gateEvidenceDigest(first)).toBe(gateEvidenceDigest(second))
    expect(JSON.stringify(first)).not.toContain('never-record-this')
    const failed = collectGateEvidence(root, 'test', [{ ...passed, status: 'failed', exitCode: 1 }], 5, {})
    expect(gateEvidenceDigest(failed)).not.toBe(gateEvidenceDigest(first))
    writeFileSync(join(root, 'scripts/gate.ts'), 'changed source\n')
    expect(collectGateEvidence(root, 'test', [passed], 5, {}).stable.clean).toBe(false)
  })

  it('records the producer and refuses absent artifacts or an escaping report directory', () => {
    const root = fixture()
    const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '15', GITHUB_RUN_ATTEMPT: '2',
      GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/ci.yml@refs/heads/master', DSH_EVIDENCE_JOB_NAME: 'node 24 / static',
      DSH_EVIDENCE_ARTIFACT_NAME: 'gate-evidence-static', DSH_GATE_REPORT_DIR: '.artifacts/gates/test' }
    const path = writeGateEvidence(root, 'ci-static', [passed], 5, env)
    expect(path).toBeDefined()
    expect(JSON.parse(readFileSync(path!, 'utf8')) as unknown).toMatchObject({ observations: { producer: { runId: 15, attempt: 2 } } })
    expect(() => collectGateEvidence(root, 'test', [passed], 5, { DSH_GATE_ARTIFACT_GLOBS: '[".artifacts/missing/*.tgz"]' })).toThrow('absent')
    const globs = { DSH_GATE_ARTIFACT_GLOBS: '["scripts/gate.ts", ".artifacts/missing/*.tgz"]' }
    expect(() => collectGateEvidence(root, 'test', [passed], 5, globs)).toThrow('absent')
    const failed = collectGateEvidence(root, 'test', [{ ...passed, status: 'failed', exitCode: 1 }], 5, globs)
    expect(failed.stable.checks[0]?.status).toBe('failed')
    expect(failed.stable.artifacts).toHaveLength(1)
    expect(() => writeGateEvidence(root, 'test', [passed], 5, { DSH_GATE_REPORT_DIR: '../outside' })).toThrow('under .artifacts/gates')
  })

  it('invalidates replay instructions after upstream input changes or a regression reference disappears', () => {
    const root = fixture()
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const blob = execFileSync('git', ['rev-parse', 'HEAD:scripts/gate.ts'], { cwd: root, encoding: 'utf8' }).trim()
    const replay = { path: 'scripts/gate.ts', upstreamBlob: blob, reviewedUpstreamCommit: commit,
      replay: 'Preserve failure propagation.', retireWhen: 'Upstream has the same rejection.', regressions: ['scripts/gate.spec.ts'] }
    const matrix = { rows: [{ gateReplays: [replay] }] }
    checkGateReplays(root, commit, matrix)
    expect(() => { checkGateReplays(root, 'b'.repeat(40), matrix) }).toThrow('new upstream target')
    replay.upstreamBlob = 'c'.repeat(40)
    expect(() => { checkGateReplays(root, commit, matrix) }).toThrow('changed upstream input')
    replay.upstreamBlob = blob
    rmSync(join(root, 'scripts/gate.spec.ts'))
    expect(() => { checkGateReplays(root, commit, matrix) }).toThrow('missing or invalid source reference')
  })
})
