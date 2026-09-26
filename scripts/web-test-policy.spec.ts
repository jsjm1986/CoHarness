import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { clientSurfacePackages } from './ci-pr-scope.ts'
import {
  expandPackageGroups,
  exactScenarioFiles,
  focusedScenarioFiles,
  listWebScenarioFiles,
  loadWebTestPolicy,
  scanGoldenOwners,
  validateWebTestPolicy,
  WEB_TESTS_ROOT,
} from './web-test-policy.ts'

const root = process.cwd()
const policy = loadWebTestPolicy(root)
const goldenOwners = scanGoldenOwners(root)

function scenarioNames(): ReadonlySet<string> {
  return new Set(listWebScenarioFiles(root))
}

describe('web test policy document', () => {
  it('loads the checked-in policy at version 1 with the full fallback', () => {
    expect(policy.version).toBe(1)
    expect(policy.unknown).toBe('full')
    expect(policy.groups.length).toBeGreaterThan(0)
    expect(new Set(policy.groups).size).toBe(policy.groups.length)
    expect(policy.smokeScenarios.length).toBeGreaterThan(0)
  })

  it('maps every browser scenario on disk to exactly one group', () => {
    const onDisk = scenarioNames()
    const mapped = new Set(Object.keys(policy.scenarios))
    expect(mapped.size).toBe(onDisk.size)
    expect([...onDisk].filter(name => !mapped.has(name))).toEqual([])
    expect([...mapped].filter(name => !onDisk.has(name))).toEqual([])
  })

  it('maps every scenario file to an existing regular file', () => {
    for (const scenario of Object.keys(policy.scenarios)) {
      const path = resolve(root, WEB_TESTS_ROOT, scenario)
      expect(statSync(path).isFile(), scenario).toBe(true)
    }
  })

  it('attributes every golden directory to scenario files that reference it', () => {
    const goldenDirs = readdirSync(resolve(root, WEB_TESTS_ROOT, 'snapshots'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
    expect(goldenDirs.length).toBeGreaterThan(0)
    for (const dir of goldenDirs) {
      const owners = goldenOwners.get(dir)
      expect(owners, dir).toBeDefined()
      expect(owners?.length, dir).toBeGreaterThan(0)
      for (const owner of owners ?? []) {
        expect(policy.scenarios[owner], `${dir} -> ${owner}`).toBeDefined()
      }
    }
    for (const owner of [...goldenOwners.values()].flat()) {
      expect(statSync(resolve(root, WEB_TESTS_ROOT, owner)).isFile(), owner).toBe(true)
    }
  })

  it('attributes shared goldens to every scenario that reads them', () => {
    expect(goldenOwners.get('seeded-history')).toEqual(expect.arrayContaining([
      'message-actions.e2e.ts',
      'sidebar-scrollbar.e2e.ts',
      'workspace-management.e2e.ts',
    ]))
    expect(goldenOwners.get('search-card')).toEqual(['search-card.snapshot.ts'])
  })

  it('gives every business group at least one scenario', () => {
    for (const group of policy.groups) {
      const owned = Object.values(policy.scenarios).filter(scenarioGroup => scenarioGroup === group)
      expect(owned.length, group).toBeGreaterThan(0)
    }
  })

  it('maps every browser-rendered package outside a full prefix to a group', () => {
    const unmapped = [...clientSurfacePackages(root)]
      .filter(pkg => !policy.fullPrefixes.some(prefix => `packages/${pkg}/`.startsWith(prefix)))
      .filter(pkg => !(pkg in policy.packages))
    expect(unmapped).toEqual([])
  })
})

describe('focusedScenarioFiles', () => {
  it('unions the selected groups with the always-on smoke scenarios', () => {
    const conversation = focusedScenarioFiles(policy, ['conversation'])
    for (const [scenario, group] of Object.entries(policy.scenarios)) {
      expect(conversation.includes(scenario), scenario).toBe(group === 'conversation' || policy.smokeScenarios.includes(scenario))
    }
    expect(conversation).toEqual([...conversation].sort())
  })

  it('keeps the smoke set in every focused selection', () => {
    for (const group of policy.groups) {
      const selection = focusedScenarioFiles(policy, [group])
      for (const smoke of policy.smokeScenarios) {
        expect(selection).toContain(smoke)
      }
    }
  })

  it('selects every scenario of a multi-group package mapping', () => {
    const workbench = focusedScenarioFiles(policy, ['workbench', 'settings'])
    expect(workbench).toContain('workbench.e2e.ts')
    expect(workbench).toContain('settings-chrome.e2e.ts')
    expect(workbench).not.toContain('subagent-conversation.e2e.ts')
  })

  it('fails loud on an unknown group', () => {
    expect(() => focusedScenarioFiles(policy, ['nonexistent'])).toThrow(/unknown group/)
  })
})

describe('exactScenarioFiles', () => {
  it('keeps only exact owners and every smoke scenario', () => {
    const selected = exactScenarioFiles(policy, ['goal-bar.e2e.ts', 'goal-bar.e2e.ts', 'workbench.e2e.ts'])
    expect(selected).toEqual([...new Set([...policy.smokeScenarios, 'goal-bar.e2e.ts', 'workbench.e2e.ts'])].sort())
    expect(selected).not.toContain('queue-actions.e2e.ts')
  })

  it('rejects empty and unknown selections instead of silently running only smokes', () => {
    expect(() => exactScenarioFiles(policy, [])).toThrow(/must not be empty/)
    expect(() => exactScenarioFiles(policy, ['missing.e2e.ts'])).toThrow(/unknown scenario/)
  })
})

describe('expandPackageGroups', () => {
  it('expands the reserved all-group token to every business group', () => {
    expect(expandPackageGroups('all', policy)).toEqual(policy.groups)
  })

  it('passes concrete groups and group lists through', () => {
    expect(expandPackageGroups('conversation', policy)).toEqual(['conversation'])
    expect(expandPackageGroups(['settings', 'mobile'], policy)).toEqual(['settings', 'mobile'])
  })
})

describe('validateWebTestPolicy', () => {
  const valid = JSON.parse(JSON.stringify(policy)) as Record<string, unknown>

  function rejected(field: string, value: unknown, message: RegExp): void {
    const broken = { ...valid, [field]: value }
    expect(() => validateWebTestPolicy(broken, 'test-policy.json')).toThrow(message)
  }

  it('rejects an unknown version and a non-full unknown fallback', () => {
    rejected('version', 2, /version must be 1/)
    rejected('unknown', 'skip', /unknown must be "full"/)
  })

  it('rejects empty, duplicated, and non-string groups', () => {
    rejected('groups', [], /groups must not be empty/)
    rejected('groups', ['a', 'a'], /duplicates/)
    rejected('groups', ['a', 3], /only strings/)
  })

  it('rejects scenarios naming unknown groups', () => {
    rejected('scenarios', { 'workbench.e2e.ts': 'nonexistent' }, /unknown group/)
    rejected('scenarios', { 'helper.ts': 'conversation' }, /relative browser scenario path/)
  })

  it('rejects smoke scenarios outside the scenario table', () => {
    rejected('smokeScenarios', ['missing.e2e.ts'], /not in scenarios/)
  })

  it('rejects an empty inventory, unsafe scenario paths and a missing smoke corpus', () => {
    rejected('scenarios', {}, /scenarios must not be empty/)
    rejected('scenarios', { '../outside.e2e.ts': 'conversation' }, /normalized repository-relative file path/)
    rejected('smokeScenarios', [], /non-empty/)
    rejected('smokeScenarios', [policy.smokeScenarios[0], policy.smokeScenarios[0]], /duplicates/)
  })

  it('rejects packages naming unknown groups', () => {
    rejected('packages', { 'client/ui-workbench': 'nonexistent' }, /unknown group/)
  })

  it('rejects empty, duplicate, unknown, or non-list shared-input owners', () => {
    rejected('sharedInputs', { 'fixture.jsonl': [] }, /non-empty/)
    rejected('sharedInputs', { 'fixture.jsonl': ['diff-context.e2e.ts', 'diff-context.e2e.ts'] }, /duplicate-free/)
    rejected('sharedInputs', { 'fixture.jsonl': ['removed.e2e.ts'] }, /unknown scenario/)
    rejected('sharedInputs', { 'fixture.jsonl': 'diff-context.e2e.ts' }, /string array/)
  })

  it.each(['../fixture.jsonl', '/fixture.jsonl', 'a//fixture.jsonl', 'a/./fixture.jsonl', 'C:/fixture.jsonl', 'a\\fixture.jsonl'])(
    'rejects non-relative shared input %s', (input) => {
      rejected('sharedInputs', { [input]: ['diff-context.e2e.ts'] }, /normalized repository-relative/)
    },
  )

  it('rejects the all-group token inside a package group list', () => {
    rejected('packages', { 'client/ui-workbench': ['all'] }, /bare string "all"/)
  })
})

describe('shared-input references at policy load', () => {
  it('requires both a real input file and a real registered scenario file', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-web-policy-'))
    try {
      mkdirSync(join(fixtureRoot, 'scripts'))
      writeFileSync(join(fixtureRoot, 'scripts/web-test-policy.json'), JSON.stringify({
        ...policy, sharedInputs: { 'fixture.jsonl': ['diff-context.e2e.ts'] },
      }))
      expect(() => loadWebTestPolicy(fixtureRoot)).toThrow(/shared input .*existing regular file/)
      mkdirSync(join(fixtureRoot, 'fixture.jsonl'))
      expect(() => loadWebTestPolicy(fixtureRoot)).toThrow(/existing regular file/)
      rmSync(join(fixtureRoot, 'fixture.jsonl'), { recursive: true })
      writeFileSync(join(fixtureRoot, 'fixture.jsonl'), '{}\n')
      expect(() => loadWebTestPolicy(fixtureRoot)).toThrow(/missing scenario/)
      mkdirSync(join(fixtureRoot, WEB_TESTS_ROOT), { recursive: true })
      writeFileSync(join(fixtureRoot, WEB_TESTS_ROOT, 'diff-context.e2e.ts'), 'export {}\n')
      expect(loadWebTestPolicy(fixtureRoot).sharedInputs).toEqual({ 'fixture.jsonl': ['diff-context.e2e.ts'] })
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })
})
