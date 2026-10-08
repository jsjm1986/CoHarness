import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyCiPrProofs } from './ci-pr-proofs.ts'
import { classifyCiPrScope } from './ci-pr-scope.ts'
import { requiredPrJobs, verifyPrResults } from './verify-pr-results.ts'

const commit = 'a'.repeat(40)
function plan() {
  return {
    version: 1, commit,
    scope: {
      runExpensive: false, compatMode: 'skip', pythonMode: 'skip', windowsMode: 'skip',
      gatewayMode: 'skip', adminUiMode: 'skip',
      coverageMode: 'skip', snapshotMode: 'skip', webGroups: [] as string[], webScenarios: [] as string[],
    },
    proofs: {
      releasePack: false, vendorPack: false, nativePack: false, sandbox: false,
      provider: false, piAi: false, nativeWindows: false,
    },
  }
}
const results = (jobs: string[]) => Object.fromEntries(jobs.map(job => [job, { result: 'success' }]))

describe('current candidate CI result admission', () => {
  it('admits a small change without requiring unrelated jobs', () => {
    const input = plan()
    const jobs = requiredPrJobs(input, commit)
    expect(jobs).toEqual(['node-24', 'pr-scope', 'web-verification'])
    expect(verifyPrResults(input, { ...results(jobs), 'windows-native': { result: 'skipped' } }, commit)).toEqual(jobs)
  })

  it('requires installer proofs through the complete classification path', () => {
    const paths = ['.github/workflows/ci.yml', '.github/workflows/landlock-run.yml']
    const input = {
      ...plan(),
      scope: classifyCiPrScope(paths, ''),
      proofs: classifyCiPrProofs(paths, undefined, { untrustedActor: true }),
    }
    const jobs = requiredPrJobs(input, commit)
    for (const job of ['native-pack', 'windows-native', 'python-runtime']) {
      expect(jobs).toContain(job)
    }
    // Credential-bound proofs stay withheld from the untrusted actor and are
    // not required, while the installer proofs still gate admission.
    expect(jobs).not.toContain('provider-proof')
    expect(jobs).not.toContain('pi-ai-proof')
    expect(verifyPrResults(input, results(jobs), commit)).toEqual(jobs)
    for (const job of ['native-pack', 'windows-native']) {
      for (const result of ['skipped', 'cancelled', 'failure', undefined] as const) {
        const outcomes = results(jobs)
        if (result === undefined) Reflect.deleteProperty(outcomes, job)
        else outcomes[job] = { result }
        expect(() => verifyPrResults(input, outcomes, commit), `${job} ${String(result)}`).toThrow(`${job}:`)
      }
    }
  })

  it('requires every selected consumer and real environment proof', () => {
    const input = plan()
    input.scope = { ...input.scope, runExpensive: true, coverageMode: 'full', snapshotMode: 'full',
      compatMode: 'full', pythonMode: 'full', windowsMode: 'full', gatewayMode: 'full', adminUiMode: 'full' }
    for (const key of Object.keys(input.proofs) as (keyof typeof input.proofs)[]) input.proofs[key] = true
    const jobs = requiredPrJobs(input, commit)
    expect(jobs).toEqual([
      'gateway', 'gateway-admin-ui', 'native-pack', 'node-24', 'node-24-consumers', 'node-24-coverage',
      'node-compat', 'pi-ai-proof', 'pr-scope', 'provider-proof', 'python-runtime', 'python-sdk',
      'release-pack', 'sandbox-proof', 'vendor-pack', 'web-verification', 'windows', 'windows-native',
    ])
    expect(verifyPrResults(input, results(jobs), commit)).toEqual(jobs)
  })

  it.each(['skipped', 'cancelled', 'failure', 'neutral', undefined])('refuses a selected proof with result %j', (result) => {
    const input = plan()
    input.proofs.provider = true
    const outcomes = results(requiredPrJobs(input, commit))
    if (result === undefined) delete outcomes['provider-proof']
    else outcomes['provider-proof'] = { result }
    expect(() => verifyPrResults(input, outcomes, commit)).toThrow('provider-proof:')
  })

  it('refuses another commit and an incomplete or malformed plan', () => {
    expect(() => requiredPrJobs(plan(), 'b'.repeat(40))).toThrow('candidate commit')
    expect(() => requiredPrJobs({ ...plan(), proofs: {} }, commit)).toThrow('proof selection')
    expect(() => requiredPrJobs({ ...plan(), scope: {} }, commit)).toThrow('runExpensive')
  })

  it('refuses unknown modes and modes that would skip selected producers', () => {
    const input = plan()
    input.scope.coverageMode = 'typo'
    expect(() => requiredPrJobs(input, commit)).toThrow('invalid coverage')
    input.scope.coverageMode = 'full'
    expect(() => requiredPrJobs(input, commit)).toThrow('contradict runExpensive')
    input.scope.runExpensive = true
    input.scope.snapshotMode = 'focused'
    expect(() => requiredPrJobs(input, commit)).toThrow('browser selection')
    input.scope.webScenarios = ['vite-entry.e2e.ts']
    expect(requiredPrJobs(input, commit)).toContain('web-verification')
    input.scope.webGroups = ['shell']
    expect(() => requiredPrJobs(input, commit)).toThrow('browser selection')
  })

  it('accepts and rejects evidence through the public command', () => {
    const input = plan()
    const invoke = (outcomes: unknown) => spawnSync(process.execPath, [resolve(import.meta.dirname, 'verify-pr-results.ts')], {
      encoding: 'utf8', env: {
        ...process.env, GITHUB_SHA: commit, DSH_PR_VALIDATION_PLAN: JSON.stringify(input),
        DSH_CI_RESULTS: JSON.stringify(outcomes),
      },
    })
    const accepted = invoke(results(requiredPrJobs(input, commit)))
    expect(accepted.status, accepted.stderr).toBe(0)
    const rejected = invoke({})
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toContain('node-24: missing')
    expect(rejected.stderr).toContain('web-verification: missing')
  })
})
