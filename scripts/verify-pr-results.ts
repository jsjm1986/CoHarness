/** Require the current candidate's selected CI jobs to complete successfully. */
import { appendFileSync } from 'node:fs'

const scopeJobs = {
  compatMode: 'node-compat',
  pythonMode: 'python-sdk',
  windowsMode: 'windows',
  gatewayMode: 'gateway',
  adminUiMode: 'gateway-admin-ui',
} as const

const proofJobs = {
  releasePack: 'release-pack',
  vendorPack: 'vendor-pack',
  nativePack: 'native-pack',
  sandbox: 'sandbox-proof',
  provider: 'provider-proof',
  piAi: 'pi-ai-proof',
  nativeWindows: 'windows-native',
} as const

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * Derive required result names from the plan already used by the producer jobs.
 * @param input - versioned scope and proof plan emitted by the current PR scope job.
 * @param commit - full commit identity of this workflow run.
 * @returns each required job once; malformed or different-commit plans fail.
 */
export function requiredPrJobs(input: unknown, commit: string): string[] {
  const plan = record(input, 'validation plan')
  if (plan.version !== 1 || !/^[a-f0-9]{40}$/.test(commit) || plan.commit !== commit) {
    throw new Error('validation plan version or candidate commit does not match this run')
  }
  const scope = record(plan.scope, 'validation scope')
  const proofs = record(plan.proofs, 'validation proofs')
  if (typeof scope.runExpensive !== 'boolean') throw new Error('runExpensive must be boolean')
  if (typeof scope.coverageMode !== 'string' || !['skip', 'scoped', 'full'].includes(scope.coverageMode)
    || typeof scope.snapshotMode !== 'string' || !['skip', 'scoped', 'focused', 'full'].includes(scope.snapshotMode)) {
    throw new Error('invalid coverage or snapshot mode')
  }
  if (scope.runExpensive !== (scope.coverageMode !== 'skip')
    || scope.runExpensive !== (scope.snapshotMode !== 'skip')) {
    throw new Error('runtime modes contradict runExpensive')
  }
  for (const field of ['webGroups', 'webScenarios']) {
    if (!Array.isArray(scope[field]) || !scope[field].every(value => typeof value === 'string' && value.length > 0)) {
      throw new Error(`invalid ${field}`)
    }
  }
  const groups = scope.webGroups as string[]
  const scenarios = scope.webScenarios as string[]
  if (scope.snapshotMode === 'focused' ? (groups.length === 0) === (scenarios.length === 0)
    : groups.length !== 0 || scenarios.length !== 0) {
    throw new Error('browser selection contradicts snapshot mode')
  }
  const jobs = new Set(['pr-scope', 'node-24', 'web-verification'])
  if (scope.runExpensive) {
    jobs.add('node-24-coverage')
    jobs.add('node-24-consumers')
  }
  for (const [field, job] of Object.entries(scopeJobs)) {
    const selected = scope[field]
    if (selected !== 'skip' && selected !== 'full') throw new Error(`invalid ${field}`)
    if (selected === 'full') jobs.add(job)
  }
  if (scope.pythonMode === 'full') jobs.add('python-runtime')
  for (const [field, job] of Object.entries(proofJobs)) {
    if (typeof proofs[field] !== 'boolean') throw new Error(`invalid proof selection: ${field}`)
    if (proofs[field]) jobs.add(job)
  }
  return [...jobs].sort()
}

/**
 * Reject missing, skipped, cancelled, or failed results for any selected proof.
 * @param input - the producer plan, including candidate identity.
 * @param outcomes - GitHub's current-run `needs` object.
 * @param commit - full commit identity of this workflow run.
 * @returns required result names after every selected job succeeds.
 */
export function verifyPrResults(input: unknown, outcomes: unknown, commit: string): string[] {
  const jobs = requiredPrJobs(input, commit)
  const needs = record(outcomes, 'CI results')
  const failures = jobs.flatMap((job) => {
    const item = needs[job]
    const result = item !== null && typeof item === 'object' && 'result' in item ? item.result : 'missing'
    return result === 'success' ? [] : [`${job}: ${String(result)}`]
  })
  if (failures.length > 0) throw new Error(`Required CI evidence is incomplete:\n${failures.join('\n')}`)
  return jobs
}

if (import.meta.main) {
  const plan = JSON.parse(process.env.DSH_PR_VALIDATION_PLAN ?? '') as unknown
  const jobs = verifyPrResults(
    plan,
    JSON.parse(process.env.DSH_CI_RESULTS ?? '') as unknown,
    process.env.GITHUB_SHA ?? '',
  )
  const unsupported = record(record(plan, 'validation plan').proofs, 'validation proofs').unsupportedProofs
  const scopeNote = unsupported === undefined ? ''
    : `\nOutside the supported acceptance scope (unverified):\n\n\`\`\`json\n${JSON.stringify(unsupported, null, 2)}\n\`\`\`\n`
  const summary = `All ${jobs.length} required jobs passed for ${process.env.GITHUB_SHA}.\n\n${jobs.map(job => `- ${job}`).join('\n')}\n${scopeNote}`
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
}
