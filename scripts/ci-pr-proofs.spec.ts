import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { classifyCiPrScope } from './ci-pr-scope.ts'
import { classifyCiPrProofs, parseProviderAcceptance } from './ci-pr-proofs.ts'

const root = resolve(import.meta.dirname, '..')
const callees = ['sandbox.yml', 'e2e.yml', 'pi-ai-provider-e2e.yml', 'release.yml', 'release-vendor.yml', 'landlock-run.yml']
interface Workflow {
  on: Record<string, { inputs?: Record<string, unknown>; secrets?: Record<string, unknown>; paths?: string[] } | null>
  concurrency: { group: string }
  jobs: Record<string, { if?: string; needs?: string; steps?: { name?: string; if?: string; run?: string }[] }>
}
function workflow(name: string): Workflow {
  return parseYaml(readFileSync(join(root, '.github/workflows', name), 'utf8')) as Workflow
}
function proofs(paths: string[]) { return classifyCiPrProofs(paths, classifyCiPrScope(paths, '')) }

describe('additional PR proof selection', () => {
  it('keeps ordinary prose and permitted action pin changes outside expensive proof lanes', () => {
    for (const paths of [['docs/testing.md'], ['packages/llm/llm/README.md'], ['gateway/README.md'],
      ['AGENTS.md', 'SKILL.md', 'docs/testing.md', 'packages/llm/llm/README.md']]) {
      const result = proofs(paths)
      expect(Object.values(result.reasons).flat()).toEqual([])
      expect(result.unsupportedProofs).toEqual([{
        proof: 'piAi', status: 'unsupported', affected: false, providers: ['azure-openai', 'anthropic'], reasons: [],
      }])
    }
    expect(Object.values(classifyCiPrProofs(['.github/workflows/release.yml'], { reason: 'action-only' }).reasons).flat()).toEqual([])
  })

  it('keeps model/preset content and source-of-record vendor metadata in scope', () => {
    for (const path of ['apps/cli/config/agent-presets/standard/AGENTS.md', 'packages/skill/skill-badge/assets/dsh-badge.md', 'vendor/README.md']) {
      expect(proofs([path]), path).toMatchObject({ provider: true, sandbox: true, nativeWindows: true, releasePack: true })
    }
  })

  it('preserves the existing packaging and native workflow inputs', () => {
    expect(proofs(['packages/util/timeout/src/index.ts'])).toMatchObject({ releasePack: true, vendorPack: false, nativePack: false, provider: false })
    expect(proofs(['native/system/src/index.ts'])).toMatchObject({ releasePack: true, nativePack: true, sandbox: true, nativeWindows: true })
    expect(proofs(['vendor/cordis/src/index.ts'])).toMatchObject({ releasePack: true, vendorPack: true, nativePack: true, provider: true, piAi: false })
    expect(proofs(['scripts/release/pack.ts'])).toMatchObject({ releasePack: true, vendorPack: true })
  })

  it('requires DeepSeek and records unsupported provider impact without claiming successful acceptance', () => {
    for (const path of ['packages/llm/llm/src/index.ts', 'packages/credentials/credentials/src/index.ts', 'plugins/dsh-model-governance/src/index.ts']) {
      const result = proofs([path])
      expect(result).toMatchObject({
        provider: true, piAi: false,
        providerAcceptance: { deepseek: 'required', azureOpenai: 'unsupported', anthropic: 'unsupported' },
        unsupportedProofs: [{ proof: 'piAi', status: 'unsupported', affected: true, providers: ['azure-openai', 'anthropic'] }],
      })
      expect(result.unsupportedProofs[0]?.reasons).toEqual(result.reasons.piAi)
      expect(result.reasons.piAi).toContain(`protocol-consumer:${path}`)
    }
    expect(proofs(['packages/llm/llm-deepseek/src/index.ts'])).toMatchObject({ provider: true, piAi: false })
    expect(proofs(['packages/subprocess/subprocess-local/src/index.ts'])).toMatchObject({ sandbox: true, nativeWindows: true })
  })

  it('keeps shared API and dynamic composition consumers beyond their packaging owner', () => {
    for (const path of ['packages/api/remotes/src/wire.ts', 'packages/host/apiproxy/src/api-proxy.ts',
      'packages/client/web/cordis.yml', 'examples/private/agent.cordis.yml']) {
      const result = proofs([path])
      expect(result, path).toMatchObject({ releasePack: true, provider: true, piAi: false, sandbox: true, nativeWindows: true })
      expect(result.reasons.provider).toContain(`shared-runtime-input:${path}`)
    }
    expect(Object.values(proofs(['docs/cordis-guide.md', 'AGENTS.md']).reasons).flat()).toEqual([])
    expect(proofs(['packages/api-other/future/src/index.ts']).reasons.provider)
      .not.toContain('shared-runtime-input:packages/api-other/future/src/index.ts')
  })

  it('falls back to every supported proof and records unsupported impact for unknown input or an empty diff', () => {
    for (const paths of [[], ['new-runtime/index.rs'], ['packages/future-capability/new/src/index.ts']]) {
      const result = proofs(paths)
      expect(result).toMatchObject({ releasePack: true, vendorPack: true, nativePack: true,
        sandbox: true, provider: true, piAi: false, nativeWindows: true })
      expect(Object.values(result.reasons).every(reasons => reasons.length > 0)).toBe(true)
      expect(result.unsupportedProofs[0]).toMatchObject({ status: 'unsupported', affected: true })
    }
  })

  it('rejects missing, unknown or contradictory provider acceptance configuration', () => {
    const supported = { deepseek: 'required', azureOpenai: 'required', anthropic: 'required' }
    expect(parseProviderAcceptance(supported)).toEqual(supported)
    for (const value of [undefined, {}, { ...supported, gemini: 'unsupported' },
      { ...supported, deepseek: 'unsupported' }, { ...supported, anthropic: 'skipped' },
      { ...supported, azureOpenai: 'unsupported' }]) {
      expect(() => parseProviderAcceptance(value)).toThrow('ci-pr-proofs:')
    }
  })

  it('fails loudly when an owning workflow loses its input policy', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pr-proof-policy-'))
    try {
      mkdirSync(join(fixture, '.github/workflows'), { recursive: true })
      for (const file of ['release.yml', 'release-vendor.yml', 'landlock-run.yml', 'sandbox.yml']) {
        writeFileSync(join(fixture, '.github/workflows', file), readFileSync(join(root, '.github/workflows', file)))
      }
      writeFileSync(join(fixture, '.github/workflows/release.yml'), 'on:\n  push:\n    paths: []\n')
      expect(() => classifyCiPrProofs(['docs/testing.md'], { reason: 'docs-only' }, fixture)).toThrow('release.yml must retain')
    } finally { rmSync(fixture, { recursive: true, force: true }) }
  })
})

describe('reusable proof workflows', () => {
  it('uses callable existing jobs without duplicate independent PR triggers or shared caller cancellation', () => {
    const concurrency = new Set<string>()
    for (const file of callees) {
      const loaded = workflow(file)
      expect(loaded.on.workflow_call?.inputs?.required_proof, file).toMatchObject({ type: 'boolean', default: false })
      expect(loaded.on).not.toHaveProperty('pull_request')
      expect(loaded.concurrency.group, file).toMatch(/^[a-z][a-z0-9-]+-\$\{\{ github\.workflow \}\}/)
      concurrency.add(loaded.concurrency.group)
    }
    expect(concurrency.size).toBe(callees.length)
  })

  it('never exposes registry publication through the call interface', () => {
    for (const file of ['release.yml', 'release-vendor.yml']) {
      const loaded = workflow(file)
      expect(loaded.on.workflow_call?.inputs).not.toHaveProperty('publish')
      expect(loaded.jobs.publish?.if).toBe("github.event_name == 'workflow_dispatch' && inputs.publish && !inputs.required_proof")
      expect(loaded.jobs.pack?.steps?.some(step => step.name === 'Verify packed install')).toBe(true)
    }
  })

  it('retains manual execution for providers outside the current acceptance scope', () => {
    expect(workflow('pi-ai-provider-e2e.yml').on).toHaveProperty('workflow_dispatch')
    const result = proofs(['.github/workflows/pi-ai-provider-e2e.yml'])
    expect(result.piAi).toBe(false)
    expect(result.unsupportedProofs[0]).toMatchObject({
      affected: true, status: 'unsupported', reasons: ['proof-owner:.github/workflows/pi-ai-provider-e2e.yml'],
    })
  })

  // These preflight commands belong to Linux workflow jobs and require a POSIX shell.
  it.skipIf(process.platform === 'win32')('rejects missing provider credentials and unsuccessful proof through the actual workflow commands', () => {
    for (const [file, keys] of [
      ['e2e.yml', ['DEEPSEEK_API_KEY']],
      ['pi-ai-provider-e2e.yml', ['AZURE_OPENAI_API_KEY', 'ANTHROPIC_API_KEY']],
    ] as const) {
      const loaded = workflow(file)
      const e2e = loaded.jobs.e2e
      expect(e2e?.if).toContain('github.event.pull_request.head.repo.fork')
      expect(e2e?.if).toContain('dependabot[bot]')
      const preflight = e2e?.steps?.find(step => step.name?.startsWith('Preflight'))
      if (typeof preflight?.run !== 'string') throw new Error(`Missing real preflight in ${file}`)
      const env = Object.fromEntries(keys.map(key => [key, '']))
      const missing = spawnSync('bash', ['-c', preflight.run], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
      expect(missing.status, file).toBe(1)
      const present = spawnSync('bash', ['-c', preflight.run], {
        encoding: 'utf8', env: { PATH: process.env.PATH, ...Object.fromEntries(keys.map(key => [key, 'fixture-presence-only'])) },
      })
      expect(present.status, file).toBe(0)
      const guard = loaded.jobs['proof-status']
      expect(guard?.needs).toBe('e2e')
      expect(guard?.if).toBe('always() && inputs.required_proof')
      const failure = guard?.steps?.[0]
      expect(failure?.if).toBe("needs.e2e.result != 'success'")
      if (typeof failure?.run !== 'string') throw new Error('Missing required proof rejection')
      expect(spawnSync('bash', ['-c', failure.run], { encoding: 'utf8' }).status).toBe(1)
    }
  })
})
