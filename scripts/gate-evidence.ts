/** Versioned, commit-bound execution evidence without changing runner result semantics. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import type { GateResult } from './run-gates.ts'

/** A GitHub producer whose completed run is verified independently at publication. */
interface GateEvidenceProducer {
  readonly repository: string
  readonly runId: number
  readonly attempt: number
  readonly job: string
  readonly workflow: string
  readonly artifact: string
}

/** One check's existing result plus the reason it was selected. */
interface GateEvidenceCheck {
  readonly id: string
  readonly command: string
  readonly required: boolean
  readonly reason: string
  readonly status: GateResult['status']
  readonly exitCode: number | null
  readonly signal: string | null
  readonly aborted: boolean
}

/** Stable comparison data is separate from observations which vary between executions. */
export interface GateEvidence {
  readonly version: 1
  readonly stable: {
    readonly policyVersion: 1
    readonly commit: string
    readonly upstreamCommit: string
    readonly clean: boolean
    readonly mode: string
    readonly environment: {
      readonly runnerOS: string
      readonly processPlatform: string
      readonly architecture: string
      readonly node: string
      readonly execution: 'native' | 'wine'
      readonly buildProfile: string
    }
    readonly checks: readonly GateEvidenceCheck[]
    readonly artifacts: readonly { readonly path: string; readonly sha256: string }[]
    readonly providerAssertions: readonly string[]
  }
  readonly observations: {
    readonly recordedAt: string
    readonly durationMs: number | null
    readonly producer: GateEvidenceProducer | null
    readonly checks: readonly { readonly id: string; readonly durationMs: number | null; readonly detail: string | null }[]
  }
}

/** Compare set-valued check inventory independently of timing and runner instance details.
 * @param report - collected execution evidence.
 * @returns SHA-256 of the normalized stable data.
 */
export function gateEvidenceDigest(report: GateEvidence): string {
  const normalized = { ...report.stable, checks: [...report.stable.checks].sort((a, b) => a.id.localeCompare(b.id)) }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

/** Require executed tests for every claimed external protocol.
 * @param raw - Vitest JSON output from the real-provider workflow.
 * @param mode - provider workflow identity.
 * @returns names of the passed external assertions retained in the report.
 */
export function providerAssertions(raw: unknown, mode: 'real-provider' | 'real-provider-pi-ai'): string[] {
  if (raw === null || typeof raw !== 'object') throw new Error('gate evidence: invalid provider results')
  const result = raw as {
    numFailedTests?: number
    testResults?: { assertionResults?: { fullName?: string; status?: string }[] }[]
  }
  const groups = mode === 'real-provider' ? ['llm-deepseek e2e (real API)']
    : ['llm-pi-ai openai e2e (openai-responses)', 'llm-pi-ai anthropic e2e (anthropic-messages)']
  const passed = result.testResults?.flatMap(file => file.assertionResults ?? [])
    .filter(test => test.status === 'passed' && groups.some(group => test.fullName?.includes(group)))
    .map(test => test.fullName ?? '') ?? []
  if (result.numFailedTests !== 0 || groups.some(group => !passed.some(name => name.includes(group)))) {
    throw new Error('gate evidence: no successful real-provider calls were proven for every required protocol')
  }
  return passed.sort()
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
}

/** Collect only allowlisted environment values; logs and credentials stay out of the report.
 * @param root - checked-out repository root.
 * @param mode - the executed aggregate or external lane identity.
 * @param results - settled runner results.
 * @param durationMs - aggregate wall-clock observation.
 * @param environment - process environment supplied by the producer.
 * @returns evidence bound to the actual checkout.
 */
export function collectGateEvidence(
  root: string, mode: string, results: readonly GateResult[], durationMs: number | null, environment: NodeJS.ProcessEnv,
): GateEvidence {
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/upstream-sync.json'), 'utf8')) as { syncedCommit?: unknown }
  if (typeof manifest.syncedCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(manifest.syncedCommit)) {
    throw new Error('gate evidence: upstream manifest has no pinned commit')
  }
  const runId = environment.GITHUB_RUN_ID === undefined ? undefined : Number(environment.GITHUB_RUN_ID)
  let producer: GateEvidenceProducer | null = null
  if (runId !== undefined) {
    const repository = environment.GITHUB_REPOSITORY
    const job = environment.DSH_EVIDENCE_JOB_NAME ?? environment.GITHUB_JOB
    const ref = environment.GITHUB_WORKFLOW_REF
    const attempt = Number(environment.GITHUB_RUN_ATTEMPT ?? '1')
    if (!Number.isSafeInteger(runId) || runId < 1 || !repository || !job || !ref
      || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('gate evidence: incomplete GitHub producer identity')
    if (!ref.startsWith(repository + '/')) throw new Error('gate evidence: workflow repository mismatch')
    const workflow = ref.slice(repository.length + 1).split('@')[0]
    if (!workflow?.startsWith('.github/workflows/')) throw new Error('gate evidence: invalid workflow reference')
    const artifact = environment.DSH_EVIDENCE_ARTIFACT_NAME
    if (!artifact || !/^gate-evidence-[\w.-]+$/.test(artifact)) throw new Error('gate evidence: missing uploaded artifact identity')
    producer = { repository, runId, attempt, job, workflow, artifact }
  }
  const runnerOS = environment.RUNNER_OS ?? process.platform
  const rawGlobs: unknown = JSON.parse(environment.DSH_GATE_ARTIFACT_GLOBS ?? '[]')
  if (!Array.isArray(rawGlobs) || !rawGlobs.every(pattern => typeof pattern === 'string')) {
    throw new Error('gate evidence: artifact globs must be a JSON string array')
  }
  const matches = rawGlobs.map(pattern => [...globSync(pattern, { cwd: root })])
  if (results.every(result => result.status === 'passed') && matches.some(paths => paths.length === 0)) {
    throw new Error('gate evidence: declared artifacts are absent')
  }
  const artifactPaths = [...new Set(matches.flat())].sort()
  const artifacts = artifactPaths.map((path) => {
    const child = relative(root, resolve(root, path))
    if (child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) throw new Error('gate evidence: artifact escapes checkout')
    return { path: child.replaceAll('\\', '/'), sha256: createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex') }
  })
  let providerTests: string[] = []
  if ((mode === 'real-provider' || mode === 'real-provider-pi-ai') && results.every(result => result.status === 'passed')) {
    const path = environment.DSH_PROVIDER_TEST_RESULTS
    if (!path) throw new Error('gate evidence: real-provider requires executed API-test results')
    providerTests = providerAssertions(JSON.parse(readFileSync(path, 'utf8')) as unknown, mode)
  }
  return {
    version: 1,
    stable: {
      policyVersion: 1,
      commit: git(root, ['rev-parse', 'HEAD']), upstreamCommit: manifest.syncedCommit,
      clean: git(root, ['status', '--porcelain', '--untracked-files=all']) === '',
      mode,
      environment: {
        runnerOS, processPlatform: process.platform, architecture: process.arch, node: process.version,
        execution: process.platform === 'win32' && runnerOS.toLowerCase() !== 'windows' && runnerOS !== 'win32' ? 'wine' : 'native',
        buildProfile: results.find(result => result.gate.env?.DSH_BUILD_CLIENT_PROFILE !== undefined)
          ?.gate.env?.DSH_BUILD_CLIENT_PROFILE ?? environment.DSH_BUILD_CLIENT_PROFILE ?? 'unspecified',
      },
      checks: results.map(result => ({
        id: result.gate.id, command: result.gate.displayCommand, required: result.gate.allowFailure !== true,
        reason: result.gate.label, status: result.status, exitCode: result.exitCode,
        signal: result.signalCode, aborted: result.aborted === true,
      })),
      artifacts,
      providerAssertions: providerTests,
    },
    observations: {
      recordedAt: new Date().toISOString(), durationMs, producer,
      checks: results.map(result => ({
        id: result.gate.id, durationMs: durationMs === null ? null : result.durationMs, detail: result.error ?? null,
      })),
    },
  }
}

/** Save optional evidence under a dedicated directory; nested modes use different filenames.
 * @param root - checked-out repository.
 * @param mode - executed aggregate.
 * @param results - settled results.
 * @param durationMs - aggregate wall time.
 * @param environment - producer environment.
 * @returns saved path, or undefined when evidence collection is not requested.
 */
export function writeGateEvidence(
  root: string, mode: string, results: readonly GateResult[], durationMs: number | null, environment: NodeJS.ProcessEnv,
): string | undefined {
  const directory = environment.DSH_GATE_REPORT_DIR
  if (directory === undefined || directory === '') return undefined
  if (!/^[a-z0-9-]+$/.test(mode)) throw new Error('gate evidence: invalid mode identity')
  const target = resolve(root, directory)
  const child = relative(resolve(root, '.artifacts/gates'), target)
  if (child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) {
    throw new Error('gate evidence: report directory must be under .artifacts/gates')
  }
  mkdirSync(target, { recursive: true })
  const report = collectGateEvidence(root, mode, results, durationMs, environment)
  const path = join(target, `${mode}-${process.platform}-${process.versions.node}-${process.pid}.json`)
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  return path
}

function main(): void {
  const { values } = parseArgs({
    options: {
      external: { type: 'string' }, status: { type: 'string' }, command: { type: 'string' },
    },
    allowPositionals: false,
  })
  const external = values.external ?? process.env.EVIDENCE_CHECK
  const command = values.command ?? process.env.EVIDENCE_COMMAND
  const outcome = values.status ?? process.env.EVIDENCE_STATUS
  if (!external || !command || !['success', 'failure', 'cancelled'].includes(outcome ?? '')) {
    throw new Error('gate evidence: --external, --command and --status success|failure|cancelled are required')
  }
  const status = outcome === 'success' ? 'passed' : outcome === 'failure' ? 'failed' : 'skipped'
  const result: GateResult = {
    gate: { id: external, label: external, command: '', args: [], displayCommand: command },
    status, durationMs: 0, output: [], exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null,
    signalCode: null, aborted: outcome === 'cancelled',
  }
  const root = resolve(import.meta.dirname, '..')
  const path = writeGateEvidence(root, external, [result], null, {
    ...process.env, DSH_GATE_REPORT_DIR: process.env.DSH_GATE_REPORT_DIR ?? '.artifacts/gates',
  })
  console.log(`gate evidence: ${path}`)
}

if (import.meta.main) main()
