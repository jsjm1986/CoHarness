import { describe, expect, it } from 'vitest'
import { checkInventoryCoverage, checkManifest, checkMatrix } from './verify-upgrade-records.ts'

const SHA = 'a'.repeat(40)

function matrixRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    area: 'session-format',
    status: 'adapt',
    localOwner: 'coharness',
    reviewState: 'pending-cumulative-source-review',
    upstreamCommits: [SHA],
    ...overrides,
  }
}

function matrix(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    reviewDate: '2026-09-13',
    baseline: { tag: 'dsh-v0.1.3-alpha.2', commit: SHA },
    target: { tag: 'dsh-v0.1.5-rc.2', commit: SHA },
    rows: [matrixRow()],
    ...overrides,
  }
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    reviewDate: '2026-09-13',
    upstream: { targetTags: [{ tag: 'dsh-v0.1.5-rc.2', commit: SHA }] },
    baseline: { tag: 'dsh-v0.1.3-alpha.2', commit: SHA },
    targetVersion: '0.1.5-rc.2.coharness.1',
    status: 'implementation-in-progress',
    decisions: [{ id: 'session-core', status: 'adapt', localOwner: 'coharness', reviewState: 'pending-cumulative-source-review', upstreamCommits: [SHA] }],
    ...overrides,
  }
}

describe('checkMatrix', () => {
  it('accepts a conforming schema v2 matrix', () => {
    expect(() => checkMatrix('m.json', matrix())).not.toThrow()
  })

  it('skips strict checks for legacy schema versions', () => {
    expect(() => checkMatrix('m.json', { schemaVersion: 1 })).not.toThrow()
  })

  it.each([
    ['missing reviewDate', { reviewDate: undefined }],
    ['a malformed reviewDate', { reviewDate: 'Sept 13' }],
    ['a missing baseline', { baseline: undefined }],
    ['a missing target commit', { target: { tag: 'x' } }],
    ['empty rows', { rows: [] }],
  ] as const)('rejects %s', (_label, patch) => {
    expect(() => checkMatrix('m.json', matrix(patch))).toThrow('upgrade-records:')
  })

  it.each([
    ['an unknown status', { status: 'merged' }],
    ['a missing localOwner', { localOwner: undefined }],
    ['an unknown reviewState', { reviewState: 'done' }],
    ['a short upstream commit id', { upstreamCommits: ['abc123'] }],
    ['empty coverage entirely', { upstreamCommits: [], commitScope: undefined, noUpstreamCommitReason: undefined }],
  ] as const)('rejects a row with %s', (_label, patch) => {
    expect(() => checkMatrix('m.json', matrix({ rows: [matrixRow(patch)] }))).toThrow('upgrade-records:')
  })

  it('accepts a commitScope in place of enumerated commits', () => {
    expect(() => checkMatrix('m.json', matrix({ rows: [matrixRow({ upstreamCommits: [], commitScope: ['packages/session'] })] }))).not.toThrow()
  })

  it('accepts a noUpstreamCommitReason in place of commits', () => {
    expect(() => checkMatrix('m.json', matrix({ rows: [matrixRow({ upstreamCommits: [], commitScope: undefined, noUpstreamCommitReason: 'local-only policy' })] }))).not.toThrow()
  })

  it('requires evidence when a row claims released', () => {
    expect(() => checkMatrix('m.json', matrix({ rows: [matrixRow({ reviewState: 'released' })] }))).toThrow('evidence')
    expect(() => checkMatrix('m.json', matrix({ rows: [matrixRow({ reviewState: 'released', evidence: 'ci run' })] }))).not.toThrow()
  })
})

describe('checkManifest', () => {
  it('accepts a conforming schema v2 manifest', () => {
    expect(() => checkManifest('f.json', manifest())).not.toThrow()
  })

  it.each([
    ['missing targetTags', { upstream: {} }],
    ['a malformed target commit', { upstream: { targetTags: [{ tag: 'x', commit: 'short' }] } }],
    ['a missing baseline commit', { baseline: {} }],
    ['a missing targetVersion', { targetVersion: undefined }],
    ['empty decisions', { decisions: [] }],
  ] as const)('rejects %s', (_label, patch) => {
    expect(() => checkManifest('f.json', manifest(patch))).toThrow('upgrade-records:')
  })
})

describe('checkInventoryCoverage', () => {
  const inv = {
    commits: [
      { sha: SHA, bucket: 'carried', packages: ['session/session-format'] },
      { sha: 'b'.repeat(40), bucket: 'carried', packages: ['client/ui-chat'] },
      { sha: 'c'.repeat(40), bucket: 'upstreamOnly', packages: ['bundle/web-app'] },
      { sha: 'd'.repeat(40), bucket: 'newUpstream', packages: ['fs/tool-present'] },
    ],
  }

  it('passes when every carried and newUpstream commit is claimed', () => {
    const m = matrix({ rows: [
      matrixRow({ upstreamCommits: [SHA] }),
      matrixRow({ upstreamCommits: [], commitScope: ['packages/client', 'packages/fs'] }),
    ] })
    expect(() => checkInventoryCoverage('i.json', inv, m)).not.toThrow()
  })

  it('fails when a carried commit is unclaimed', () => {
    const m = matrix({ rows: [matrixRow({ upstreamCommits: [SHA] })] })
    expect(() => checkInventoryCoverage('i.json', inv, m)).toThrow('upgrade-records:')
  })

  it('does not require coverage for upstreamOnly or none commits', () => {
    const only = { commits: inv.commits.filter(c => c.bucket === 'upstreamOnly') }
    expect(() => checkInventoryCoverage('i.json', only, matrix())).not.toThrow()
  })
})
