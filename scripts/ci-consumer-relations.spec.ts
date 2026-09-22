import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    ['packages/context/gateway-runtime/src/index.ts', ['gateway']],
    ['packages/context/collaboration-gateway/src/index.ts', ['gateway']],
    ['scripts/build-exe-for-python-sdk.ts', ['python']],
    ['.github/workflows/build-exe-for-python-sdk.yml', ['python']],
    ['scripts/snapshots/python-sdk-single-exe/minimal/model-visible.json', ['python']],
    ['examples/cli/cordis.yml', ['python', 'gateway', 'adminUi', 'android']],
  ])('routes %s to its consumers', (path, lanes) => {
    const reasons = consumerReasons([path])
    for (const lane of lanes) expect(reasons[lane as keyof typeof reasons].length).toBeGreaterThan(0)
  })

  it('records Android impact without scheduling optional native verification', () => {
    for (const path of ['docs/testing.md', 'apps/web/src/style.css', 'packages/util/timeout/src/index.ts', 'apps/web/src/native-push.ts', 'apps/android-shell/android/app/build.gradle']) {
      expect(classifyCiPrScope([path], '').androidMode, path).toBe('skip')
    }
    expect(classifyCiPrScope(['gateway/README.md'], '')).toMatchObject({ gatewayMode: 'skip', adminUiMode: 'skip' })
    expect(consumerReasons(['packages/core-other/index.ts']).python).toEqual([])
  })

  it('selects real execution consumers while preserving documentation-only paths', () => {
    const relation = policy.relations.find(row => row.id === 'gateway-execution')
    expect(relation).toBeDefined()
    for (const prefix of relation!.paths) {
      expect(existsSync(prefix), prefix).toBe(true)
      const path = prefix.endsWith('.ts') ? prefix : `${prefix}/src/index.ts`
      const result = classifyCiPrScope([path], '')
      expect(result, path).toMatchObject({ runExpensive: true, gatewayMode: 'full' })
      expect(result.consumerReasons.gateway, path).toContain('gateway-execution')
      const readme = prefix.endsWith('.ts') ? `${dirname(prefix)}/README.md` : `${prefix}/README.md`
      expect(classifyCiPrScope([readme], ''), readme).toMatchObject({ runExpensive: false, gatewayMode: 'skip' })
    }
    expect(classifyCiPrScope(['packages/util/timeout/src/index.ts'], '')).toMatchObject({ gatewayMode: 'skip' })
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
        const manifests = [entry.manifest, ...'additionalEntries' in entry ? entry.additionalEntries.map(owner => owner.manifest) : []]
        for (const path of [...manifests, entry.workflow, ...entry.sources]) write(path, readFileSync(path, 'utf8'))
      }
      verifyConsumerReferences(root)
      const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
      delete manifest.scripts['test:gateway:execution']
      write('package.json', JSON.stringify(manifest))
      expect(() => { verifyConsumerReferences(root) }).toThrow('missing script test:gateway:execution')
      write('package.json', readFileSync('package.json', 'utf8'))
      const source = policy.lanes.android.sources[0]!
      rmSync(join(root, source))
      expect(() =>{  verifyConsumerReferences(root) }).toThrow('missing source')
      write(source, readFileSync(source, 'utf8'))
      write('.github/workflows/ci.yml', 'jobs: {}\n')
      expect(() =>{  verifyConsumerReferences(root) }).toThrow('missing workflow job')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
