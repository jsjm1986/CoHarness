import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectWebFixtures } from './verify-web-fixtures.ts'
import { loadWebTestPolicy } from './web-test-policy.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'web-fixture-preflight-'))
  roots.push(root)
  for (const directory of ['scripts', 'apps/web/tests/snapshots/one', 'apps/web/tests/snapshots/two']) {
    mkdirSync(resolve(root, directory), { recursive: true })
  }
  writeFileSync(resolve(root, 'apps/web/tests/one.e2e.ts'), "const fixture = 'snapshots/one/session.jsonl'\n")
  writeFileSync(resolve(root, 'apps/web/tests/two.e2e.ts'), "const fixture = 'snapshots/two/session.jsonl'\n")
  const existing = Object.keys(loadWebTestPolicy(resolve(import.meta.dirname, '..')).scenarios)
  for (const scenario of existing) {
    const target = resolve(root, 'apps/web/tests', scenario)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '')
  }
  writeFileSync(resolve(root, 'scripts/web-test-policy.json'), JSON.stringify({
    version: 1, groups: ['shell'], scenarios: {
      ...Object.fromEntries(existing.map(scenario => [scenario, 'shell'])),
      'one.e2e.ts': 'shell', 'two.e2e.ts': 'shell',
    },
    packages: {}, fullPrefixes: [], webInfraPrefixes: [], smokeScenarios: ['one.e2e.ts'], unknown: 'full',
  }))
  return root
}

const header = JSON.stringify({
  type: 'session', version: 4, id: 'fixture', createdAt: 0,
  cwd: '/fixture', isSeeded: false, delegationDepth: 0,
}) + '\n'

function cli(root: string) {
  return spawnSync(process.execPath, [
    '--import', 'tsx/esm', resolve(import.meta.dirname, 'verify-web-fixtures.ts'), '--root', root,
  ], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' })
}

describe('browser fixture admission preflight', () => {
  it('refuses missing literal inputs while ignoring comments and unrelated scenarios', () => {
    const root = fixture()
    writeFileSync(resolve(root, 'apps/web/tests/one.e2e.ts'),
      "// './snapshots/one/comment.jsonl'\nconst fixture = './snapshots/one/session.jsonl'\n")
    expect(inspectWebFixtures(root, ['one.e2e.ts']).problems).toEqual([{
      path: 'apps/web/tests/snapshots/one/session.jsonl',
      message: 'missing recorded input referenced by one.e2e.ts',
    }])
  })

  it.each(['', '{"jsonrpc":"2.0"}\n'])('refuses a Session fixture without its required header: %j', (source) => {
    const root = fixture()
    writeFileSync(resolve(root, 'apps/web/tests/snapshots/one/session.jsonl'), source)
    expect(inspectWebFixtures(root, ['one.e2e.ts']).problems).toHaveLength(1)
  })
  it('validates selected Session files without consuming unrelated wire goldens', () => {
    const root = fixture()
    writeFileSync(resolve(root, 'apps/web/tests/snapshots/one/session.jsonl'), header)
    writeFileSync(resolve(root, 'apps/web/tests/snapshots/one/stdout.expected.jsonl'), '{"jsonrpc":"2.0"}\n')
    writeFileSync(resolve(root, 'apps/web/tests/snapshots/two/session.jsonl'), '{broken\n')
    expect(inspectWebFixtures(root, ['one.e2e.ts'])).toEqual({
      files: ['apps/web/tests/snapshots/one/session.jsonl'], problems: [],
    })
  })

  it('reports every invalid selected file instead of stopping at the first one', () => {
    const root = fixture()
    writeFileSync(resolve(root, 'apps/web/tests/snapshots/one/session.jsonl'), header
      + '{"type":"user/message","data":{"content":"invalid"}}\n')
    writeFileSync(resolve(root, 'apps/web/tests/snapshots/two/session.jsonl'), '{broken\n')
    expect(inspectWebFixtures(root, ['one.e2e.ts', 'two.e2e.ts']).problems.map(problem => problem.path)).toEqual([
      'apps/web/tests/snapshots/one/session.jsonl',
      'apps/web/tests/snapshots/two/session.jsonl',
    ])
  })

  it('accepts an admitted corpus and refuses corruption through the public command', () => {
    const root = fixture()
    writeFileSync(resolve(root, 'apps/web/tests/snapshots/one/session.jsonl'), header)
    writeFileSync(resolve(root, 'apps/web/tests/snapshots/two/session.jsonl'), header)
    const accepted = cli(root)
    expect(accepted.status, accepted.stderr).toBe(0)
    expect(accepted.stdout).toContain('2 Session files, 0 admission failures')
    writeFileSync(resolve(root, 'apps/web/tests/snapshots/two/session.jsonl'), header
      + '{"type":"turn/start","seq":0,"data":{"turn":1}}\n')
    const rejected = cli(root)
    expect(rejected.status, rejected.stderr).toBe(1)
    expect(rejected.stderr).toContain('both seq and time')
  })
})
