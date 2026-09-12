import { existsSync } from 'node:fs'
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

const SYNCED_COMMIT = '82a5fd61a7cf5c293cec4bdff68f455398d685e9'

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
    expect(manifest.syncedTag).toBe('dsh-v0.1.3-alpha.2')
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

  it.runIf(tagPresent)('keeps every tracked package diff-free against the synced commit', () => {
    const tracked = Object.entries(manifest.packages)
      .filter(([, entry]) => entry.sovereignty === 'tracked')
      .map(([key]) => key)
    expect(tracked.length).toBeGreaterThan(0)
    for (const key of tracked) {
      expect(packageSrcMatchesCommit(root, manifest.syncedCommit, key), `${key} must have an empty src diff`).toBe(true)
    }
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
    const report: UpstreamSovereigntyReport = checkUpstreamSovereignty(root, manifest)
    expect(report.violations).toEqual([])
  })
})
