import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkActiveInventory, checkInventoryCoverage, checkManifest, checkMatrix, checkMatrixFileInventories, checkCurrentPackageDispositions, requireCurrentSchema } from './verify-upgrade-records.ts'
import { readUpstreamCommitInventory } from './upstream-commit-inventory.ts'

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
    expect(() => { checkMatrix('m.json', matrix()) }).not.toThrow()
  })

  it('skips strict checks for legacy schema versions', () => {
    expect(() => { checkMatrix('m.json', { schemaVersion: 1 }) }).not.toThrow()
  })

  it('accepts unique area identities in schema v3 while retaining pending reviews', () => {
    expect(() => { checkMatrix('m.json', matrix({ schemaVersion: 3, rows: [matrixRow(), matrixRow({ area: 'other' })] })) }).not.toThrow()
  })

  it.each(['adapt', 'required'])('rejects a repeated schema v3 area even when its second status is %s', (status) => {
    expect(() => { checkMatrix('m.json', matrix({ schemaVersion: 3, rows: [matrixRow(), matrixRow({ status })] })) })
      .toThrow('duplicate area "session-format"')
  })

  it('requires an explicit, trimmed area in schema v3', () => {
    for (const patch of [{ area: undefined, id: 'legacy-alias' }, { area: ' session-format ' }]) {
      expect(() => { checkMatrix('m.json', matrix({ schemaVersion: 3, rows: [matrixRow(patch)] })) }).toThrow('area')
    }
  })

  it('preserves duplicate-area and fallback-id interpretation for frozen schema v2 records', () => {
    expect(() => { checkMatrix('m.json', matrix({ rows: [matrixRow(), matrixRow(), matrixRow({ area: undefined, id: 'legacy-alias' })] })) }).not.toThrow()
  })

  it.each([
    ['missing reviewDate', { reviewDate: undefined }],
    ['a malformed reviewDate', { reviewDate: 'Sept 13' }],
    ['a missing baseline', { baseline: undefined }],
    ['a missing target commit', { target: { tag: 'x' } }],
    ['empty rows', { rows: [] }],
  ] as const)('rejects %s', (_label, patch) => {
    expect(() => { checkMatrix('m.json', matrix(patch)) }).toThrow('upgrade-records:')
  })

  it.each([
    ['an unknown status', { status: 'merged' }],
    ['a missing localOwner', { localOwner: undefined }],
    ['an unknown reviewState', { reviewState: 'done' }],
    ['a short upstream commit id', { upstreamCommits: ['abc123'] }],
    ['empty coverage entirely', { upstreamCommits: [], commitScope: undefined, noUpstreamCommitReason: undefined }],
  ] as const)('rejects a row with %s', (_label, patch) => {
    expect(() => { checkMatrix('m.json', matrix({ rows: [matrixRow(patch)] })) }).toThrow('upgrade-records:')
  })

  it('accepts a commitScope in place of enumerated commits', () => {
    expect(() => { checkMatrix('m.json', matrix({ rows: [matrixRow({ upstreamCommits: [], commitScope: ['packages/session'] })] })) }).not.toThrow()
  })

  it('accepts a noUpstreamCommitReason in place of commits', () => {
    expect(() => { checkMatrix('m.json', matrix({ rows: [matrixRow({ upstreamCommits: [], commitScope: undefined, noUpstreamCommitReason: 'local-only policy' })] })) }).not.toThrow()
  })

  it('requires evidence when a row claims released', () => {
    expect(() => { checkMatrix('m.json', matrix({ rows: [matrixRow({ reviewState: 'released' })] })) }).toThrow('evidence')
    expect(() => { checkMatrix('m.json', matrix({ rows: [matrixRow({ reviewState: 'released', evidence: 'ci run' })] })) }).not.toThrow()
  })
})

describe('checkManifest', () => {
  it('accepts a conforming schema v2 manifest', () => {
    expect(() => { checkManifest('f.json', manifest()) }).not.toThrow()
  })

  it('accepts unique decision ids in schema v3', () => {
    const decisions = [matrixRow({ id: 'first' }), matrixRow({ id: 'second' })]
    expect(() => { checkManifest('f.json', manifest({ schemaVersion: 3, decisions })) }).not.toThrow()
  })

  it('rejects repeated schema v3 decision ids even when their area fields differ', () => {
    const decisions = [matrixRow({ id: 'same' }), matrixRow({ id: 'same', area: 'other' })]
    expect(() => { checkManifest('f.json', manifest({ schemaVersion: 3, decisions })) }).toThrow('duplicate id "same"')
  })

  it('requires explicit, trimmed decision ids in schema v3', () => {
    for (const id of [undefined, ' decision ']) {
      expect(() => { checkManifest('f.json', manifest({ schemaVersion: 3, decisions: [matrixRow({ id })] })) }).toThrow('id')
    }
  })

  it('preserves duplicate-id and fallback-area interpretation for frozen schema v2 manifests', () => {
    const decisions = [matrixRow({ id: 'same' }), matrixRow({ id: 'same' }), matrixRow()]
    expect(() => { checkManifest('f.json', manifest({ decisions })) }).not.toThrow()
  })

  it.each([
    ['missing targetTags', { upstream: {} }],
    ['a malformed target commit', { upstream: { targetTags: [{ tag: 'x', commit: 'short' }] } }],
    ['a missing baseline commit', { baseline: {} }],
    ['a missing targetVersion', { targetVersion: undefined }],
    ['empty decisions', { decisions: [] }],
  ] as const)('rejects %s', (_label, patch) => {
    expect(() => { checkManifest('f.json', manifest(patch)) }).toThrow('upgrade-records:')
  })
})

it('the record CLI verifies identities and the exact raw cumulative and incremental Git inventories', () => {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-record-identities-'))
  const write = (path: string, value: string | object): void => {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, typeof value === 'string' ? value : JSON.stringify(value))
  }
  try {
    write('package.json', { type: 'module' })
    write('scripts/input.ts', 'export const input = true\n')
    write('scripts/input.spec.ts', 'export const regression = true\n')
    write('legacy/说明.txt', 'renamed upstream source\n')
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['add', '.'], { cwd: root })
    const commitSource = () => execFileSync('git', ['-c', 'user.name=Upgrade fixture', '-c', 'user.email=upgrade@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', `core.hooksPath=${join(root, '.hooks')}`, 'commit', '-qm', 'source fixture'], { cwd: root })
    commitSource()
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    write('scripts/input.ts', 'export const input = false\n')
    write('current/说明.txt', 'renamed upstream source\n')
    rmSync(join(root, 'legacy/说明.txt'))
    execFileSync('git', ['add', '.'], { cwd: root })
    commitSource()
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const blob = execFileSync('git', ['rev-parse', 'HEAD:scripts/input.ts'], { cwd: root, encoding: 'utf8' }).trim()
    const matrixPath = 'upgrades/alignment/UPSTREAM-ALIGNMENT-MATRIX-fixture.json'
    const manifestPath = 'upgrades/manifests/UPGRADE-MANIFEST-fixture.json'
    const changedFiles = ['current/说明.txt', 'legacy/说明.txt', 'scripts/input.ts']
    const row = matrixRow({ cumulativeFiles: changedFiles, incrementFiles: changedFiles, gateReplays: [{ path: 'scripts/input.ts', reviewedUpstreamCommit: commit, upstreamBlob: blob,
      replay: 'Replay the owned input patch.', retireWhen: 'Upstream supplies the same validation.', regressions: ['scripts/input.spec.ts'] }] })
    const currentMatrix = matrix({ schemaVersion: 3, baseline: { tag: 'baseline', commit: baseline }, incrementBaseline: { tag: 'baseline', commit: baseline },
      target: { tag: 'fixture', commit }, rows: [row], summary: { rows: 1, cumulativeChangedFiles: 3, incrementChangedFiles: 3 } })
    const currentManifest = manifest({ schemaVersion: 3 })
    write(matrixPath, currentMatrix)
    write(manifestPath, currentManifest)
    write('upgrades/plans/UPGRADE-PLAN-fixture.md', '# Fixture plan\n')
    write('scripts/upstream-sync.json', { syncedTag: 'fixture', syncedCommit: commit, gateReplayRecord: matrixPath, packages: { 'core/fixture': { sovereignty: 'tracked' } }, upstreamOnly: [] })
    write('scripts/verify-upgrade-records.ts', readFileSync(new URL('./verify-upgrade-records.ts', import.meta.url), 'utf8'))
    write('scripts/upstream-commit-inventory.ts', readFileSync(new URL('./upstream-commit-inventory.ts', import.meta.url), 'utf8'))
    const inventoryPath = 'upgrades/alignment/UPSTREAM-COMMIT-INVENTORY-fixture.json'
    const inventoryCommit = { sha: commit, subject: 'source fixture', packages: [], bucket: 'none' }
    const inventory = {
      schemaVersion: 1, generatedFrom: { baselineCommit: baseline, targetCommit: commit, target: 'fixture' },
      commitCount: 1, commits: [inventoryCommit],
    }
    write(inventoryPath, inventory)
    const run = (script = 'scripts/verify-upgrade-records.ts', args: string[] = []) => {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href, join(root, script), ...args], {
        cwd: root, encoding: 'utf8', timeout: 30_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      return { status: result.status, output: result.stdout + result.stderr }
    }
    const accepted = run()
    expect(accepted.status, accepted.output).toBe(0)
    const syncManifest: unknown = JSON.parse(readFileSync(join(root, 'scripts/upstream-sync.json'), 'utf8'))
    for (const patch of [
      { commits: null },
      { commitCount: 0, commits: [] },
      { commitCount: 2 },
      { commitCount: 2, commits: [inventoryCommit, inventoryCommit] },
      { commits: [{ ...inventoryCommit, sha: baseline }] },
      { commits: [{ ...inventoryCommit, bucket: 'carried' }] },
      { commits: [{ ...inventoryCommit, packages: ['core/fixture'] }] },
      { commits: [{ ...inventoryCommit, subject: 'a different commit' }] },
      { generatedFrom: { ...inventory.generatedFrom, targetCommit: baseline } },
    ]) {
      expect(() => {
        checkActiveInventory(root, inventoryPath, { ...inventory, ...patch }, currentMatrix, syncManifest)
      }).toThrow(inventoryPath)
    }
    write('.git/shallow', `${baseline}\n`)
    expect(() => {
      checkActiveInventory(root, inventoryPath, inventory, currentMatrix, syncManifest)
    }).toThrow('shallow ancestry')
    rmSync(join(root, '.git/shallow'))
    expect(() => {
      checkMatrix(matrixPath, { ...currentMatrix, rows: [row, { ...row, status: 'required', gateReplays: undefined }] })
    }).toThrow('duplicate area "session-format"')
    const carriedRow = { ...row, area: 'packages/core/fixture', localSovereignty: 'tracked' }
    expect(() => {
      checkMatrix(matrixPath, { ...currentMatrix, rows: [carriedRow] })
    }).not.toThrow()
    for (const patch of [{ localSovereignty: 'upstreamOnly' }, { targetAssessment: 'not-carried' }, { upstreamOnly: { reason: 'obsolete exclusion' } }]) {
      expect(() => {
        checkCurrentPackageDispositions(matrixPath, { ...currentMatrix, rows: [{ ...carriedRow, ...patch }] },
          (syncManifest as Record<string, unknown>).packages)
      }).toThrow('packages/core/fixture')
    }
    const decisions = currentManifest.decisions as Record<string, unknown>[]
    expect(() => {
      checkManifest(manifestPath, { ...currentManifest, decisions: [...decisions, ...decisions] })
    }).toThrow('duplicate id "session-core"')
    for (const field of ['cumulativeFiles', 'incrementFiles'] as const) {
      const missing = { ...currentMatrix, rows: [{ ...row, [field]: changedFiles.filter(path => path !== 'legacy/说明.txt') }] }
      expect(() => {
        checkMatrixFileInventories(root, matrixPath, missing)
      }).toThrow(`${field} does not match the raw Git diff`)
      expect(() => {
        checkMatrixFileInventories(root, matrixPath, missing)
      }).toThrow('legacy/说明.txt')
    }
    for (const patch of [
      { cumulativeFiles: [...changedFiles, 'normalized/说明.txt'] },
      { cumulativeFiles: [...changedFiles, 'current/说明.txt'] },
      { cumulativeFiles: changedFiles.filter(path => path !== 'legacy/说明.txt'), historicalPathAliases: [{ sourcePath: 'legacy/说明.txt' }] },
    ]) {
      expect(() => {
        checkMatrixFileInventories(root, matrixPath, { ...currentMatrix, rows: [{ ...row, ...patch }] })
      }).toThrow()
    }
    expect(() => {
      checkMatrixFileInventories(root, matrixPath,
        { ...currentMatrix, summary: { rows: 1, cumulativeChangedFiles: 2, incrementChangedFiles: 3 } })
    }).toThrow('summary.cumulativeChangedFiles')
    expect(() => {
      requireCurrentSchema(matrixPath, { ...currentMatrix, schemaVersion: 2 })
    }).toThrow('active upgrade record requires schemaVersion: 3')
    expect(() => {
      requireCurrentSchema(manifestPath, { ...currentManifest, schemaVersion: 2 })
    }).toThrow('active upgrade record requires schemaVersion: 3')
    write(manifestPath, currentManifest)
    expect(() => {
      checkInventoryCoverage('upgrades/alignment/UPSTREAM-COMMIT-INVENTORY-historical.json',
        { schemaVersion: 1, commitCount: 0, commits: [] },
        { ...currentMatrix, schemaVersion: 2, rows: [{ ...row, cumulativeFiles: ['historical-normalized-path'] }] },
        'historical')
    }).not.toThrow()
    write('scripts/upstream-sync.json', { version: 2, syncedTag: 'fixture', syncedCommit: commit, packages: {}, upstreamOnly: [] })
    for (const file of ['gen-upstream-commit-inventory.ts', 'verify-upstream-sovereignty.ts']) {
      write(`scripts/${file}`, readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'))
    }
    execFileSync('git', ['-c', 'tag.gpgsign=false', 'tag', 'fixture', commit], { cwd: root })
    execFileSync('git', ['-c', 'tag.gpgsign=false', 'tag', 'baseline', baseline], { cwd: root })
    const before = readFileSync(join(root, inventoryPath), 'utf8')
    write('.git/shallow', `${baseline}\n`)
    const refusedGeneration = run('scripts/gen-upstream-commit-inventory.ts', ['--tag', 'fixture', '--from', 'baseline'])
    expect(refusedGeneration.status, refusedGeneration.output).toBe(1)
    expect(refusedGeneration.output).toContain('shallow ancestry')
    expect(readFileSync(join(root, inventoryPath), 'utf8')).toBe(before)
    rmSync(join(root, '.git/shallow'))
    const generated = run('scripts/gen-upstream-commit-inventory.ts', ['--tag', 'fixture', '--from', 'baseline'])
    expect(generated.status, generated.output).toBe(0)
    const generatedInventory: unknown = JSON.parse(readFileSync(join(root, inventoryPath), 'utf8'))
    expect(generatedInventory).toEqual({
      ...inventory, generatedFrom: { ...inventory.generatedFrom, baseline: 'baseline' },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('reads Unicode package paths, includes root commits, and checks both endpoint ancestries without requiring unrelated refs', () => {
  const root = mkdtempSync(join(tmpdir(), 'upstream-commit-range-'))
  const git = (...args: string[]): string => execFileSync('git', [
    '-c', 'user.name=Inventory fixture', '-c', 'user.email=inventory@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, '.hooks')}`, ...args,
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const sources = { packages: { 'core/sample': { sovereignty: 'tracked' } }, upstreamOnly: [] }
  try {
    git('init', '-q')
    const source = join(root, 'packages/core/sample/说明.ts')
    mkdirSync(dirname(source), { recursive: true })
    const commit = (content: string): string => {
      writeFileSync(source, content)
      git('add', '.')
      git('commit', '-qm', content)
      return git('rev-parse', 'HEAD')
    }
    const initial = commit('initial')
    const baseline = commit('baseline')
    const target = commit('target')
    expect(readUpstreamCommitInventory(root, initial, target, sources)).toEqual([
      { sha: target, subject: 'target', packages: ['core/sample'], bucket: 'carried' },
      { sha: baseline, subject: 'baseline', packages: ['core/sample'], bucket: 'carried' },
    ])
    const shallow = join(root, '.git/shallow')
    writeFileSync(shallow, `${baseline}\n`)
    expect(git('rev-list', `${baseline}..${target}`)).toBe(target)
    expect(() => readUpstreamCommitInventory(root, baseline, target, sources)).toThrow('shallow ancestry')
    rmSync(shallow)
    const unrelated = git('commit-tree', 'HEAD^{tree}', '-p', target, '-m', 'unrelated')
    writeFileSync(shallow, `${unrelated}\n`)
    expect(readUpstreamCommitInventory(root, baseline, target, sources)).toEqual([
      { sha: target, subject: 'target', packages: ['core/sample'], bucket: 'carried' },
    ])
    const orphan = git('commit-tree', 'HEAD^{tree}', '-m', 'orphan')
    expect(readUpstreamCommitInventory(root, initial, orphan, sources)).toEqual([
      { sha: orphan, subject: 'orphan', packages: ['core/sample'], bucket: 'carried' },
    ])
    expect(() => readUpstreamCommitInventory(root, baseline, target, {
      ...sources, packages: { 'core/sample': { sovereignty: ['owned'] } },
    })).toThrow('invalid sovereignty')
    rmSync(shallow)
    const side = git('commit-tree', 'HEAD^{tree}', '-p', baseline, '-m', 'side')
    const merge = git('commit-tree', 'HEAD^{tree}', '-p', target, '-p', side, '-m', 'merge')
    expect(readUpstreamCommitInventory(root, baseline, merge, sources).map(row => row.sha).sort())
      .toEqual([target, side].sort())
    writeFileSync(shallow, `${merge}\n`)
    expect(git('log', '--no-merges', '--format=%H', `${baseline}..${merge}`)).toBe(merge)
    expect(() => readUpstreamCommitInventory(root, baseline, merge, sources)).toThrow('shallow ancestry')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('checkInventoryCoverage', () => {
  it('does not claim a similarly named package through a partial directory prefix', () => {
    const inventory = { commits: [{ sha: SHA, bucket: 'carried', packages: ['core/session-next'] }] }
    const claimed = matrix({ rows: [matrixRow({ upstreamCommits: [], commitScope: ['packages/core/session'] })] })
    expect(() => { checkInventoryCoverage('i.json', inventory, claimed) }).toThrow('no matrix row claims')
  })
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
    expect(() => { checkInventoryCoverage('i.json', inv, m) }).not.toThrow()
  })

  it('fails when a carried commit is unclaimed', () => {
    const m = matrix({ rows: [matrixRow({ upstreamCommits: [SHA] })] })
    expect(() => { checkInventoryCoverage('i.json', inv, m) }).toThrow('upgrade-records:')
  })

  it('does not require coverage for upstreamOnly or none commits', () => {
    const only = { commits: inv.commits.filter(c => c.bucket === 'upstreamOnly') }
    expect(() => { checkInventoryCoverage('i.json', only, matrix()) }).not.toThrow()
  })
})

describe('active package dispositions', () => {
  const packages = { 'core/example': { sovereignty: 'adapted' } }
  it('accepts a carried adaptation without claiming release or external acceptance', () => {
    expect(() =>{  checkCurrentPackageDispositions('active.json', { rows: [
      { area: 'packages/core/example', localSovereignty: 'adapted', reviewState: 'pending-cumulative-source-review' },
    ] }, packages) }).not.toThrow()
  })
  it('rejects a stale absence claim for carried source', () => {
    expect(() =>{  checkCurrentPackageDispositions('active.json', { rows: [
      { area: 'packages/core/example', localSovereignty: 'adapted', targetAssessment: 'not-carried' },
    ] }, packages) }).toThrow('is carried')
  })
})
