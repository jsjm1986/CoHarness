import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkUpstreamSovereignty,
  diskPackageKeys,
  loadUpstreamSyncManifest,
  packageKeysAtCommit,
  packageSrcMatchesCommit,
  resolveTagCommit,
  validateUpstreamSyncManifest,
  type UpstreamSovereigntyReport,
  type UpstreamSyncManifest,
} from './verify-upstream-sovereignty.ts'

const root = resolve(import.meta.dirname, '..')

const SYNCED_COMMIT = 'ddefc45fbc7f8e46dd73185e68295696d1297887'

function sourceFixture(run: (directory: string, commit: string, git: (...args: string[]) => string) => void): void {
  const directory = mkdtempSync(resolve(tmpdir(), 'dsh-sovereignty-test-'))
  try {
    const git = (...args: string[]): string => execFileSync('git', ['-C', directory, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    git('init')
    git('config', 'user.name', 'Sovereignty fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'core.autocrlf', 'false')
    mkdirSync(resolve(directory, 'packages/test/sample/src'), { recursive: true })
    writeFileSync(resolve(directory, 'packages/test/sample/src/index.ts'), 'export const value = 1\n')
    writeFileSync(resolve(directory, '.gitignore'), '*.generated.ts\n')
    git('add', '.')
    git('commit', '-m', 'baseline')
    run(directory, git('rev-parse', 'HEAD'), git)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('working source comparison', () => {
  it('rejects staged, unstaged, deleted and new sources without changing the real index', () => {
    sourceFixture((directory, commit, git) => {
      const path = resolve(directory, 'packages/test/sample/src/index.ts')
      expect(packageSrcMatchesCommit(directory, commit, 'test/sample')).toBe(true)
      writeFileSync(path, 'export const value = 2\n')
      expect(packageSrcMatchesCommit(directory, commit, 'test/sample')).toBe(false)
      git('add', '.')
      const index = readFileSync(resolve(directory, '.git/index'))
      expect(packageSrcMatchesCommit(directory, commit, 'test/sample')).toBe(false)
      expect(readFileSync(resolve(directory, '.git/index'))).toEqual(index)
      writeFileSync(path, 'export const value = 1\n')
      expect(packageSrcMatchesCommit(directory, commit, 'test/sample')).toBe(true)
      expect(readFileSync(resolve(directory, '.git/index'))).toEqual(index)
      rmSync(path)
      expect(packageSrcMatchesCommit(directory, commit, 'test/sample')).toBe(false)
      writeFileSync(path, 'export const value = 1\n')
      writeFileSync(resolve(directory, 'packages/test/sample/src/new.ts'), 'export {}\n')
      expect(packageSrcMatchesCommit(directory, commit, 'test/sample')).toBe(false)
    })
  })

  it('accepts an untracked upstream import and ignores generated output', () => {
    sourceFixture((directory, commit, git) => {
      git('rm', '--cached', 'packages/test/sample/src/index.ts')
      git('commit', '-m', 'remove carried source')
      writeFileSync(resolve(directory, 'packages/test/sample/src/output.generated.ts'), 'generated\n')
      expect(packageSrcMatchesCommit(directory, commit, 'test/sample')).toBe(true)
      const manifest = validateUpstreamSyncManifest({ version: 2, syncedTag: 'baseline', syncedCommit: commit,
        packages: { 'test/sample': { sovereignty: 'tracked' } }, upstreamOnly: [] }, directory)
      git('tag', 'baseline', commit)
      expect(checkUpstreamSovereignty(directory, manifest).violations).toEqual([])
      writeFileSync(resolve(directory, 'packages/test/sample/src/extra.ts'), 'export {}\n')
      expect(checkUpstreamSovereignty(directory, manifest).violations).toEqual([
        'classified "tracked" but packages/test/sample/src differs from baseline',
      ])
    })
  })

  it('compares CRLF checkouts using Git clean normalization', () => {
    sourceFixture((directory, commit, git) => {
      git('config', 'core.autocrlf', 'true')
      writeFileSync(resolve(directory, 'packages/test/sample/src/index.ts'), 'export const value = 1\r\n')
      expect(packageSrcMatchesCommit(directory, commit, 'test/sample')).toBe(true)
    })
  })

  // POSIX modes and symlinks are not available on every Windows checkout.
  it.skipIf(process.platform === 'win32')('rejects executable and symlink changes', () => {
    sourceFixture((directory, commit, git) => {
      git('config', 'core.filemode', 'true')
      const path = resolve(directory, 'packages/test/sample/src/index.ts')
      chmodSync(path, 0o755)
      expect(packageSrcMatchesCommit(directory, commit, 'test/sample')).toBe(false)
      rmSync(path)
      symlinkSync('missing.ts', path)
      expect(packageSrcMatchesCommit(directory, commit, 'test/sample')).toBe(false)
    })
  })
})

function synthetic(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 2,
    syncedTag: 'dsh-v0.0.0-test',
    syncedCommit: SYNCED_COMMIT,
    packages: {
      'core/session': { sovereignty: 'tracked' },
      'web/fetch': { sovereignty: 'adapted' },
    },
    upstreamOnly: [{ package: 'util/time', reason: 'not needed by current consumers' }],
    ...overrides,
  }
}

describe('manifest validation', () => {
  it('accepts a minimal conforming manifest', () => {
    const manifest = validateUpstreamSyncManifest(synthetic(), root)
    expect(manifest.syncedTag).toBe('dsh-v0.0.0-test')
    expect(Object.keys(manifest.packages)).toEqual(['core/session', 'web/fetch'])
    expect(manifest.upstreamOnly).toEqual([{ package: 'util/time', reason: 'not needed by current consumers' }])
  })

  it.each([
    ['a non-number version', { version: '2' }],
    ['the retired schema version', { version: 1 }],
    ['a newer schema version', { version: 3 }],
    ['a missing version', { version: undefined }],
  ] as const)('rejects %s', (_label, patch) => {
    expect(() => validateUpstreamSyncManifest(synthetic(patch), root)).toThrow('upstream-sovereignty:')
  })

  it('rejects an unknown sovereignty class', () => {
    expect(() => validateUpstreamSyncManifest(synthetic({
      packages: { 'core/session': { sovereignty: 'vendored' } },
    }), root)).toThrow('sovereignty must be one of')
  })

  it('rejects an owned package that is also listed upstreamOnly', () => {
    expect(() => validateUpstreamSyncManifest(synthetic({
      packages: { 'local/only': { sovereignty: 'owned' } },
      upstreamOnly: [{ package: 'local/only', reason: 'test' }],
    }), root)).toThrow('in both packages and upstreamOnly')
  })

  it('rejects a replaced package without a note', () => {
    expect(() => validateUpstreamSyncManifest(synthetic({
      packages: { 'core/session': { sovereignty: 'replaced' } },
    }), root)).toThrow('must name a note file')
  })

  it('accepts a replaced package with a note', () => {
    const manifest = validateUpstreamSyncManifest(synthetic({
      packages: { 'core/session': { sovereignty: 'replaced', note: 'AGENTS.md' } },
    }), root)
    expect(manifest.packages['core/session']?.sovereignty).toBe('replaced')
  })

  it('rejects removedUpstreamPaths entries that exist on disk or escape the package', () => {
    expect(() => validateUpstreamSyncManifest(synthetic({
      packages: { 'core/session': { sovereignty: 'adapted', removedUpstreamPaths: ['packages/core/session/src/index.ts'] } },
    }), root)).toThrow('exists on disk')
    expect(() => validateUpstreamSyncManifest(synthetic({
      packages: { 'web/fetch': { sovereignty: 'adapted', removedUpstreamPaths: ['packages/core/session/src/x.ts'] } },
    }), root)).toThrow('must be a "packages/web/fetch/…" path')
    expect(() => validateUpstreamSyncManifest(synthetic({
      packages: { 'web/fetch': { sovereignty: 'adapted', removedUpstreamPaths: ['packages/web/fetch/src/gone.ts'] } },
    }), root)).not.toThrow()
  })

  it('rejects upstreamOnly entries without a reason or with a foreign replacedBy', () => {
    expect(() => validateUpstreamSyncManifest(synthetic({
      upstreamOnly: [{ package: 'util/time' }],
    }), root)).toThrow('non-empty reason')
    expect(() => validateUpstreamSyncManifest(synthetic({
      upstreamOnly: [{ package: 'util/time', reason: 'x', replacedBy: 'ghost/pkg' }],
    }), root)).toThrow('must name a packages key')
  })

  it('accepts an upstreamOnly entry whose replacedBy names a local package', () => {
    const manifest = validateUpstreamSyncManifest(synthetic({
      upstreamOnly: [{ package: 'util/time', reason: 'x', replacedBy: 'core/session' }],
    }), root)
    expect(manifest.upstreamOnly[0]?.replacedBy).toBe('core/session')
  })

  it('rejects a note that is not an existing repo-relative file', () => {
    expect(() => validateUpstreamSyncManifest(synthetic({
      packages: { 'web/fetch': { sovereignty: 'adapted', note: 'docs/no-such-rationale.md' } },
    }), root)).toThrow('not an existing repository file')
    expect(() => validateUpstreamSyncManifest(synthetic({
      packages: { 'web/fetch': { sovereignty: 'adapted', note: '../outside.md' } },
    }), root)).toThrow('repo-relative path')
  })

  it('accepts a note naming an existing repo file', () => {
    const manifest = validateUpstreamSyncManifest(synthetic({
      packages: { 'web/fetch': { sovereignty: 'adapted', note: 'AGENTS.md' } },
    }), root)
    expect(manifest.packages['web/fetch']?.note).toBe('AGENTS.md')
  })

  it.each([
    ['an unknown top-level key', { packages: {}, extra: true }],
    ['an unknown package field', { packages: { 'a/b': { sovereignty: 'tracked', owner: 'x' } } }],
    ['a non-"<group>/<pkg>" package key', { packages: { 'a/b/c': { sovereignty: 'tracked' } } }],
    ['a duplicated upstreamOnly entry', { upstreamOnly: [{ package: 'util/time', reason: 'a' }, { package: 'util/time', reason: 'b' }] }],
    ['a non-hex syncedCommit', { syncedCommit: 'not-a-commit' }],
  ] as const)('rejects %s', (_label, patch) => {
    expect(() => validateUpstreamSyncManifest(synthetic(patch), root)).toThrow('upstream-sovereignty:')
  })
})

describe('checked-in manifest', () => {
  const manifest: UpstreamSyncManifest = loadUpstreamSyncManifest(root)

  it('loads scripts/upstream-sync.json pinned at the mirrored release tag', () => {
    expect(manifest.version).toBe(2)
    expect(manifest.syncedTag).toBe('dsh-v0.1.6-alpha.2')
    expect(manifest.syncedCommit).toBe(SYNCED_COMMIT)
  })

  it('is in bijection with the packages on disk', () => {
    expect([...diskPackageKeys(root)].sort()).toEqual(Object.keys(manifest.packages).sort())
  })

  it('keeps every upstreamOnly package absent from disk', () => {
    for (const item of manifest.upstreamOnly) {
      expect(existsSync(resolve(root, 'packages', item.package)), `${item.package} must not exist on disk`).toBe(false)
    }
  })

  // Clones that never fetched the mirrored upstream tags cannot resolve the
  // synced commit; tag-dependent assertions skip there instead of failing.
  const tagPresent = resolveTagCommit(root, manifest.syncedTag) !== null

  it.runIf(tagPresent)('resolves the synced tag to the recorded commit', () => {
    expect(resolveTagCommit(root, manifest.syncedTag)).toBe(manifest.syncedCommit)
  })

  it.runIf(tagPresent)('partitions upstream packages into tracked|adapted|replaced and upstreamOnly', () => {
    const upstream = packageKeysAtCommit(root, manifest.syncedCommit)
    const upstreamOnly = new Set(manifest.upstreamOnly.map(item => item.package))
    for (const key of upstream) {
      const entry = manifest.packages[key]
      if (entry === undefined) {
        expect(upstreamOnly.has(key), `${key} must be upstreamOnly`).toBe(true)
      } else {
        expect(entry.sovereignty, `${key} must not be owned`).not.toBe('owned')
      }
    }
    for (const key of upstreamOnly) {
      expect(upstream.has(key), `${key} must exist at ${manifest.syncedTag}`).toBe(true)
    }
  })

  it.runIf(tagPresent)('reports zero violations for the checked-in state', { timeout: 120_000 }, () => {
    expect(Object.values(manifest.packages).some(entry => entry.sovereignty === 'tracked')).toBe(true)
    const report: UpstreamSovereigntyReport = checkUpstreamSovereignty(root, manifest)
    expect(report.violations).toEqual([])
  })
})
