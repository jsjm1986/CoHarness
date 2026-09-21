import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { consumerReasons, verifyConsumerReferences } from './ci-consumer-relations.ts'
import policy from './ci-consumer-relations.json' with { type: 'json' }
import { classifyCiPrScope, previousConsumerSelection, unionConsumerSelection } from './ci-pr-scope.ts'

describe('fork consumer selection', () => {
  it.each([
    ['packages/core/agent-loop/src/index.ts', ['python', 'gateway']],
    ['packages/session/session-format/src/index.ts', ['python', 'gateway']],
    ['packages/llm/llm/src/discovery.ts', ['gateway', 'adminUi']],
    ['packages/client/ui-primitives/src/Button.tsx', ['adminUi']],
    ['apps/web/src/native-push.ts', ['android', 'gateway']],
    ['examples/cli/cordis.yml', ['python', 'gateway', 'adminUi', 'android']],
  ])('routes %s to its consumers', (path, lanes) => {
    const reasons = consumerReasons([path])
    for (const lane of lanes) expect(reasons[lane as keyof typeof reasons].length).toBeGreaterThan(0)
  })

  it('keeps ordinary docs, unrelated packages and hosted web outside Android rebuilds', () => {
    for (const path of ['docs/testing.md', 'apps/web/src/style.css', 'packages/util/timeout/src/index.ts']) {
      expect(classifyCiPrScope([path], '').androidMode, path).toBe('skip')
    }
    expect(classifyCiPrScope(['gateway/README.md'], '')).toMatchObject({ gatewayMode: 'skip', adminUiMode: 'skip' })
    expect(consumerReasons(['packages/core-other/index.ts']).python).toEqual([])
  })

  it('keeps prior execution in the shadow union when a docs-only reduction is justified', () => {
    const paths = ['gateway/README.md']
    const candidate = classifyCiPrScope(paths, '')
    const previous = previousConsumerSelection(paths, candidate)
    expect(previous.gatewayMode).toBe('full')
    expect(candidate.gatewayMode).toBe('skip')
    expect(unionConsumerSelection(previous, candidate).gatewayMode).toBe('full')
    const changed = classifyCiPrScope(['packages/core/agent-loop/src/index.ts'], '')
    expect(unionConsumerSelection(previousConsumerSelection(['packages/core/agent-loop/src/index.ts'], changed), changed).pythonMode).toBe('full')
  })

  it('validates real entries and fails before planning when a referenced source or job disappears', () => {
    verifyConsumerReferences(process.cwd())
    const root = mkdtempSync(join(tmpdir(), 'consumer-refs-'))
    const write = (path: string, content: string): void => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    try {
      for (const entry of Object.values(policy.lanes)) {
        for (const path of [entry.manifest, entry.workflow, ...entry.sources]) write(path, readFileSync(path, 'utf8'))
      }
      verifyConsumerReferences(root)
      const source = policy.lanes.android.sources[0]!
      rmSync(join(root, source))
      expect(() =>{  verifyConsumerReferences(root) }).toThrow('missing source')
      write(source, readFileSync(source, 'utf8'))
      write('.github/workflows/ci.yml', 'jobs: {}\n')
      expect(() =>{  verifyConsumerReferences(root) }).toThrow('missing workflow job')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
