import { describe, expect, it } from 'vitest'
import {
  bucketPackageChanges,
  parseNameStatus,
  parseReportArgs,
  topLevelChangeCounts,
} from './sync-upstream-report.ts'
import type { UpstreamSyncManifest } from './verify-upstream-sovereignty.ts'

const manifest: UpstreamSyncManifest = {
  version: 1,
  syncedTag: 'dsh-v0.0.0-test',
  syncedCommit: '82a5fd61a7cf5c293cec4bdff68f455398d685e9',
  packages: {
    'jobs/jobs': { sovereignty: 'tracked' },
    'core/session': { sovereignty: 'adapted' },
    'local/owned': { sovereignty: 'owned' },
  },
  upstreamOnly: ['util/time'],
}

describe('parseReportArgs', () => {
  it('requires --tag and accepts an optional --from', () => {
    expect(parseReportArgs(['--tag', 'dsh-v0.1.5-alpha.1'])).toEqual({
      tag: 'dsh-v0.1.5-alpha.1',
      from: undefined,
    })
    expect(parseReportArgs(['--', '--tag', 'dsh-v0.1.5-alpha.1'])).toEqual({
      tag: 'dsh-v0.1.5-alpha.1',
      from: undefined,
    })
    expect(parseReportArgs(['--from', 'dsh-v0.1.3-alpha.2', '--tag', 'dsh-v0.1.5-alpha.1'])).toEqual({
      tag: 'dsh-v0.1.5-alpha.1',
      from: 'dsh-v0.1.3-alpha.2',
    })
    expect(() => parseReportArgs([])).toThrow('missing required --tag')
    expect(() => parseReportArgs(['--tag'])).toThrow('--tag requires a tag value')
    expect(() => parseReportArgs(['--tag', 'x', '--bogus'])).toThrow('unknown argument')
  })
})

describe('parseNameStatus', () => {
  it('parses single-path and rename records', () => {
    const entries = parseNameStatus([
      'M\tpackages/jobs/jobs/src/queue.ts',
      'A\tpackages/core/session/src/new.ts',
      'R100\tpackages/jobs/jobs/src/old.ts\tpackages/jobs/jobs/src/renamed.ts',
      '',
    ].join('\n'))
    expect(entries).toEqual([
      { status: 'M', path: 'packages/jobs/jobs/src/queue.ts' },
      { status: 'A', path: 'packages/core/session/src/new.ts' },
      { status: 'R', oldPath: 'packages/jobs/jobs/src/old.ts', path: 'packages/jobs/jobs/src/renamed.ts' },
    ])
  })
})

describe('bucketPackageChanges', () => {
  it('attributes each packages/ change to its manifest sovereignty', () => {
    const buckets = bucketPackageChanges(parseNameStatus([
      'M\tpackages/jobs/jobs/src/queue.ts',
      'A\tpackages/core/session/src/new.ts',
      'D\tpackages/local/owned/src/gone.ts',
      'M\tpackages/util/time/src/tick.ts',
      'A\tpackages/brand/new/src/index.ts',
      'M\tdocs/architecture.md',
      'R100\tpackages/jobs/jobs/src/old.ts\tpackages/core/session/src/moved.ts',
    ].join('\n')), manifest)

    expect(buckets.tracked.map(e => e.path)).toEqual(['packages/jobs/jobs/src/queue.ts'])
    expect(buckets.adapted.map(e => e.path)).toEqual([
      'packages/core/session/src/new.ts',
      'packages/core/session/src/moved.ts',
    ])
    expect(buckets.owned.map(e => e.key)).toEqual(['local/owned'])
    expect(buckets.upstreamOnly.map(e => e.key)).toEqual(['util/time'])
    expect(buckets.unmanifested.map(e => e.key)).toEqual(['brand/new'])
    for (const bucket of Object.values(buckets)) {
      expect(bucket.every(entry => entry.path.startsWith('packages/'))).toBe(true)
    }
  })
})

describe('topLevelChangeCounts', () => {
  it('summarizes non-packages paths per top-level segment', () => {
    const counts = topLevelChangeCounts(parseNameStatus([
      'M\tdocs/architecture.md',
      'A\tdocs/cookbook/new.md',
      'M\tpackage.json',
      'M\tpackages/jobs/jobs/src/queue.ts',
      'D\tpython/sdk/x.py',
    ].join('\n')))
    expect(counts).toEqual([['docs', 2], ['package.json', 1], ['python', 1]])
  })
})
