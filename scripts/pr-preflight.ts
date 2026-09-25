/** Read-only local PR planning with explicit, narrowly registered generated-file repair. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { load as parseYaml } from 'js-yaml'
import { readChangeScope, type ChangeScopeReport } from './change-scope.ts'
import { resolveCiPrScopePlans, type CiPrScope, type CiPrScopePlans } from './ci-pr-scope.ts'
import { classifyCiPrProofs, type CiPrProofs } from './ci-pr-proofs.ts'
import { verifyConsumerReferences } from './ci-consumer-relations.ts'
import { loadWebTestPolicy, WEB_TESTS_ROOT } from './web-test-policy.ts'
import { pairAnchorOfArgument, parseTranslationPairingManifest, translationPairSourcePredicate } from './translation-pairing.ts'
import { translationPairPaths } from './translation-pairing-record.ts'

interface Diagnostic { code: string; path: string; message: string }
interface Command {
  id: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  reason: string
  owner: 'local' | 'ci'
}
interface MechanicalCheck { id: string; script: string; args: string[] }
interface GeneratedFile { id: string; script: string; outputs: string[]; status: 'not-checked' | 'passed' | 'failed'; fixable: true }
interface CheckResult { id: string; exitCode: number | null; signal: string | null; stdout: string; stderr: string }

/** A plan is not a claim that its recommended product checks have run. */
export interface PrPreflightReport {
  version: 1
  kind: 'pr-preflight'
  mode: 'plan' | 'check' | 'fix-generated'
  scope: ChangeScopeReport
  paths: string[]
  selectionPlans: CiPrScopePlans | null
  runtimeSelection: CiPrScope | null
  proofs: CiPrProofs | null
  requiredCommands: Command[]
  generated: GeneratedFile[]
  translationPairs: { source: string; zh: string; meta: string; missing: string[] }[]
  diagnostics: Diagnostic[]
  executedChecks: CheckResult[]
  repairedGenerators: CheckResult[]
  localEvidence: { reusable: false; reason: string }
  validation: { mechanical: 'not-run' | 'passed' | 'failed'; productChecks: 'not-run' }
}

/** Only these deterministic writers can run through --fix-generated. Neither records translations or golden output. */
const GENERATORS = [
  { id: 'tsconfig-paths', script: 'scripts/gen-tsconfig-paths.ts', outputs: ['tsconfig.base.json'],
    matches: (path: string): boolean => /^packages\/[^/]+\/[^/]+\/(?:package\.json|src\/invariant\.ts)$/.test(path)
      || ['tsconfig.base.json', 'scripts/gen-tsconfig-paths.ts'].includes(path) },
  { id: 'third-party-notices', script: 'scripts/gen-third-party-notices.ts', outputs: ['THIRD_PARTY_NOTICES.md'],
    matches: (path: string): boolean => /(?:^|\/)package\.json$/.test(path) || /^python\/[^/]+\/pyproject\.toml$/.test(path)
      || ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'vendor/README.md', 'scripts/gen-third-party-notices.ts',
        'scripts/build-exe-for-python-sdk.ts', 'THIRD_PARTY_NOTICES.md'].includes(path) },
] as const

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function gitDiff(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', ...args, '--'], {
    encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr)
  return result.stdout
}

function readObject(root: string, path: string, diagnostics: Diagnostic[]): Record<string, unknown> | undefined {
  try {
    const raw: unknown = path.endsWith('.json') ? JSON.parse(readFileSync(resolve(root, path), 'utf8')) : parseYaml(readFileSync(resolve(root, path), 'utf8'))
    if (!object(raw)) throw new Error('expected an object')
    return raw
  } catch (error) {
    diagnostics.push({ code: 'invalid-input', path, message: message(error) })
    return undefined
  }
}

function reference(root: string, path: string, diagnostics: Diagnostic[]): void {
  const child = relative(root, resolve(root, path))
  if (isAbsolute(path) || child === '..' || child.startsWith(`..${sep}`)) {
    diagnostics.push({ code: 'invalid-reference', path, message: 'Expected an entry inside the repository.' })
  } else if (!existsSync(resolve(root, path))) {
    diagnostics.push({ code: 'missing-entry', path, message: 'Referenced source entry does not exist.' })
  }
}

function publicScript(root: string, manifestPath: string, name: string, diagnostics: Diagnostic[], seen = new Set<string>()): void {
  const identity = `${manifestPath}:${name}`
  if (seen.has(identity)) return
  seen.add(identity)
  const manifest = readObject(root, manifestPath, diagnostics)
  if (!manifest) return
  const scripts = manifest.scripts
  const command = object(scripts) ? scripts[name] : undefined
  if (typeof command !== 'string' || command.trim() === '') {
    diagnostics.push({ code: 'missing-script', path: manifestPath, message: `Missing public script ${name}.` })
    return
  }
  // Check only explicit source references. A declared build may create lib/dist later.
  const directory = relative(root, resolve(root, manifestPath, '..'))
  for (const match of command.matchAll(/(?:^|\s)(scripts\/[^\s'";&|]+\.[cm]?[jt]s)(?=\s|$)/g)) {
    const path = match[1]
    if (path !== undefined) reference(root, directory ? `${directory}/${path}` : path, diagnostics)
  }
  for (const match of command.matchAll(/\b(?:pnpm|npm)\s+run\s+([\w:-]+)/g)) {
    const nested = match[1]
    if (nested !== undefined) publicScript(root, manifestPath, nested, diagnostics, seen)
  }
}

function consumerDiagnostics(root: string, diagnostics: Diagnostic[]): void {
  let failure: string | undefined
  try { verifyConsumerReferences(root) } catch (error) { failure = message(error) }
  const initial = diagnostics.length
  const policy = readObject(root, 'scripts/ci-consumer-relations.json', diagnostics)
  if (object(policy?.lanes)) for (const raw of Object.values(policy.lanes)) {
    if (!object(raw)) continue
    if (typeof raw.manifest === 'string' && Array.isArray(raw.scripts)) {
      for (const script of raw.scripts) if (typeof script === 'string') publicScript(root, raw.manifest, script, diagnostics)
    }
    if (typeof raw.workflow === 'string') {
      const workflow = readObject(root, raw.workflow, diagnostics)
      if (workflow !== undefined && !object(workflow.jobs)) {
        diagnostics.push({ code: 'missing-job', path: raw.workflow, message: 'Workflow has no jobs object.' })
      }
      if (Array.isArray(raw.jobs) && object(workflow?.jobs)) for (const job of raw.jobs) {
        if (typeof job === 'string' && !Object.hasOwn(workflow.jobs, job)) {
          diagnostics.push({ code: 'missing-job', path: raw.workflow, message: `Missing workflow job ${job}.` })
        }
      }
    }
    if (Array.isArray(raw.sources)) for (const source of raw.sources) if (typeof source === 'string') reference(root, source, diagnostics)
  }
  if (failure !== undefined && diagnostics.length === initial) diagnostics.push({ code: 'consumer-policy', path: 'scripts/ci-consumer-relations.json', message: failure })
}

function plannedCommands(selection: CiPrScope, paths: readonly string[]): Command[] {
  const commands: Command[] = []
  const add = (id: string, script: string, reason: string, env: Record<string, string> = {}): void => {
    commands.push({ id, command: 'pnpm', args: ['run', script], cwd: '.', env, reason, owner: 'local' })
  }
  add('static', 'check:ci:static', 'Shared source and configuration checks.')
  if (paths.some(path => /\.(?:md|mdx)$|\.i18n\.yaml$/.test(path))) add('documentation', 'test:docs', 'Changed documentation and bilingual records.')
  if (selection.coverageMode !== 'skip') {
    const packages = [...new Set(paths.flatMap((path) => {
      const match = /^packages\/([^/]+\/[^/]+)\/(?:src|tests)\//.exec(path)
      return match?.[1] === undefined ? [] : [match[1]]
    }))].sort()
    add('coverage', selection.coverageMode === 'scoped' ? 'check:ci:coverage:scoped' : 'check:ci:coverage',
      'Coverage scope comes from the CI classifier.', selection.coverageMode === 'scoped' ? { DSH_SCOPED_PACKAGES: JSON.stringify(packages) } : {})
  }
  if (selection.snapshotMode !== 'skip') add('consumers', 'check:ci:consumers:scoped', 'Built consumers and keyless snapshots selected by CI.')
  if (selection.snapshotMode === 'focused' || selection.snapshotMode === 'full') {
    const scenarios = 'webScenarios' in selection && Array.isArray(selection.webScenarios) ? selection.webScenarios as string[] : []
    add('web', `check:ci:web:${selection.snapshotMode}`, 'Browser scenario selection is shared with CI.', selection.snapshotMode === 'focused'
      ? scenarios.length > 0 ? { DSH_WEB_SCENARIOS: JSON.stringify(scenarios) } : { DSH_WEB_GROUPS: selection.webGroups.join(',') } : {})
  }
  if (selection.compatMode === 'full') commands.push({ id: 'node-matrix', command: 'pnpm', args: ['run', 'check:node-compat'], cwd: '.', env: {}, owner: 'ci', reason: 'Execute on every Node version selected by CI; one local Node cannot certify the matrix.' })
  if (selection.windowsMode === 'full') commands.push({ id: 'windows', command: 'pnpm', args: ['run', 'check:ci:windows-complete'], cwd: '.', env: {}, owner: 'ci', reason: 'Native Windows evidence must come from the actual Windows lane.' })
  for (const [enabled, cwd, scripts] of [
    [selection.gatewayMode === 'full', 'gateway', ['typecheck', 'build:check', 'test']],
    [selection.adminUiMode === 'full', 'gateway/admin-ui', ['test', 'build']],
  ] as const) if (enabled) for (const script of scripts) commands.push({ id: `${cwd}/${script}`, command: 'npm', args: ['run', script], cwd, env: {}, owner: 'local', reason: 'Independent consumer selected by its CI relationship.' })
  if (selection.pythonMode === 'full') {
    add('python-static', 'check:python:static', 'Python static errors are checked independently of pytest.')
    commands.push({ id: 'python-sdk', command: 'uv', args: ['run', '--python', '3.10', '--group', 'test', '--project', 'python/sdk', 'pytest'], cwd: '.', env: {}, owner: 'local', reason: 'Complete keyless Python suite.' },
      { id: 'python-runtime', command: 'workflow', args: ['.github/workflows/build-exe-for-python-sdk.yml'], cwd: '.', env: {}, owner: 'ci', reason: 'Installed runtime and platform artifact proof remain owned by the existing CI workflow.' })
  }
  return commands
}

function proofCommands(proofs: CiPrProofs, commands: readonly Command[]): Command[] {
  const extra: Command[] = []
  for (const [name, filename] of [
    ['releasePack', 'release.yml'], ['vendorPack', 'release-vendor.yml'], ['nativePack', 'landlock-run.yml'],
    ['sandbox', 'sandbox.yml'], ['provider', 'e2e.yml'], ['piAi', 'pi-ai-provider-e2e.yml'],
  ] as const) if (proofs[name]) extra.push({ id: name, command: 'workflow', args: [`.github/workflows/${filename}`],
    cwd: '.', env: {}, owner: 'ci', reason: 'Required by the candidate proof policy; see the corresponding path reasons.' })
  if (proofs.nativeWindows && !commands.some(command => command.id === 'windows')) {
    extra.push({ id: 'windows', command: 'pnpm', args: ['run', 'check:ci:windows-complete'], cwd: '.', env: {},
      owner: 'ci', reason: 'The candidate needs native Windows proof.' })
  }
  return extra
}

/**
 * Collect a read-only plan from all four local change layers and the existing CI policy.
 * @param base - Explicit locally resolvable Git baseline; never fetched or guessed.
 * @param cwd - Worktree to inspect.
 * @param environment - The same explicit shadow/candidate selection policy used by CI.
 * @returns Versioned plan and every independently discoverable entry diagnostic.
 */
export function planPrPreflight(base: string, cwd: string, environment: NodeJS.ProcessEnv = process.env): PrPreflightReport {
  const scope = readChangeScope(['--base', base], cwd)
  const root = scope.repositoryRoot
  const paths = [...new Set(Object.values(scope.paths).flat())].sort()
  const diagnostics: Diagnostic[] = []
  consumerDiagnostics(root, diagnostics)
  let selectionPlans: CiPrScopePlans | null = null
  let runtimeSelection: CiPrScope | null = null
  let proofs: CiPrProofs | null = null
  try {
    const policy = loadWebTestPolicy(root)
    for (const scenario of Object.keys(policy.scenarios)) reference(root, `${WEB_TESTS_ROOT}${scenario}`, diagnostics)
    const diff = [gitDiff(root, [scope.resolved.mergeBaseSha, scope.resolved.headSha]), gitDiff(root, ['--cached']), gitDiff(root, []),
      ...scope.paths.untracked.map(path => `+untracked input: ${path}`)].join('\n')
    selectionPlans = resolveCiPrScopePlans(paths, diff, root, environment)
    runtimeSelection = selectionPlans.execution
    proofs = classifyCiPrProofs(paths, selectionPlans.candidate, root)
  } catch (error) { diagnostics.push({ code: 'selection-policy', path: 'scripts/web-test-policy.json', message: message(error) }) }
  const commands = runtimeSelection === null ? [] : plannedCommands(runtimeSelection, paths)
  if (proofs !== null) commands.push(...proofCommands(proofs, commands))
  for (const command of commands) {
    if (command.args[0] === 'run' && (command.command === 'pnpm' || command.command === 'npm')) {
      const script = command.args[1]
      if (script !== undefined) publicScript(root, command.cwd === '.' ? 'package.json' : `${command.cwd}/package.json`, script, diagnostics)
    }
    if (command.command === 'workflow' && command.args[0] !== undefined) reference(root, command.args[0], diagnostics)
  }
  const generated: GeneratedFile[] = GENERATORS.filter(generator => paths.some(generator.matches)).map(generator => ({
    id: generator.id, script: generator.script, outputs: [...generator.outputs], status: 'not-checked', fixable: true,
  }))
  for (const generator of generated) reference(root, generator.script, diagnostics)
  const translationPairs: PrPreflightReport['translationPairs'] = []
  try {
    const predicate = translationPairSourcePredicate(parseTranslationPairingManifest(readFileSync(resolve(root, 'scripts/translation-pairing.manifest.json'), 'utf8')))
    const anchors = [...new Set(paths.filter(path => /\.md$|\.i18n\.yaml$/.test(path)).map(pairAnchorOfArgument))].sort()
    for (const source of anchors.filter(predicate)) {
      const pair = translationPairPaths(source)
      const missing = [pair.source, pair.zh, pair.meta].filter(path => !existsSync(resolve(root, path)))
      // A deleted complete triplet has no remaining counterpart to repair.
      if (missing.length === 3) continue
      translationPairs.push({ ...pair, missing })
      for (const path of missing) diagnostics.push({ code: 'missing-translation-pair', path, message: `Update the complete bilingual pair for ${source}; review translation before recording hashes.` })
    }
  } catch (error) { diagnostics.push({ code: 'translation-policy', path: 'scripts/translation-pairing.manifest.json', message: message(error) }) }
  const report: PrPreflightReport = { version: 1, kind: 'pr-preflight', mode: 'plan', scope, paths, selectionPlans, runtimeSelection, proofs,
    requiredCommands: commands, generated, translationPairs,
    diagnostics: [...new Map(diagnostics.map(diagnostic => [`${diagnostic.code}:${diagnostic.path}:${diagnostic.message}`, diagnostic])).values()],
    executedChecks: [], repairedGenerators: [], localEvidence: { reusable: false, reason: 'Local result reuse is not implemented: complete command inputs, environment and artifact identities are not attested; previous local or CI green results are not reused.' },
    validation: { mechanical: 'not-run', productChecks: 'not-run' } }
  for (const check of mechanicalChecks(report)) reference(root, check.script, report.diagnostics)
  return report
}

function mechanicalChecks(report: PrPreflightReport): MechanicalCheck[] {
  const checks: MechanicalCheck[] = [{ id: 'consumer-references', script: 'scripts/ci-consumer-relations.ts', args: [] }]
  for (const generated of report.generated) checks.push({ id: generated.id, script: generated.script, args: ['--check'] })
  if (report.translationPairs.length > 0) checks.push({ id: 'translation-pairing', script: 'scripts/verify-translation-pairing.ts', args: report.translationPairs.map(pair => pair.source) })
  const selection = report.runtimeSelection
  if (selection?.snapshotMode === 'focused' || selection?.snapshotMode === 'full') {
    const web = report.requiredCommands.find(command => command.id === 'web')
    const scenarios = web?.env.DSH_WEB_SCENARIOS
    checks.push({ id: 'web-plan', script: 'scripts/run-web-snapshots.ts', args: ['--print-plan', ...selection.snapshotMode === 'focused'
      ? ['--focused', ...scenarios ? ['--scenarios', scenarios] : ['--groups', selection.webGroups.join(',')]] : []] })
  }
  return checks
}

function execute(root: string, check: MechanicalCheck, launcher: string): CheckResult {
  const result = spawnSync(process.execPath, [launcher, resolve(root, check.script), ...check.args], {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
  return { id: check.id, exitCode: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.error?.message ?? result.stderr }
}

/**
 * Run the local planning CLI; only explicit mechanical check/fix modes execute child commands.
 * @param args - --base plus optional --check or --fix-generated.
 * @param cwd - Worktree containing the candidate.
 * @returns Machine-readable report and its process exit code; zero never certifies product CI.
 */
export function runPrPreflight(args: string[], cwd: string): { report: PrPreflightReport; exitCode: number } {
  const { values } = parseArgs({ args, allowPositionals: false, strict: true, options: {
    base: { type: 'string' }, check: { type: 'boolean', default: false }, 'fix-generated': { type: 'boolean', default: false },
  } })
  if (!values.base?.trim()) throw new Error('missing required --base <ref>')
  if (values.check && values['fix-generated']) throw new Error('--check and --fix-generated are separate modes')
  let report = planPrPreflight(values.base, cwd)
  const mode = values['fix-generated'] ? 'fix-generated' : values.check ? 'check' : 'plan'
  report.mode = mode
  if (mode !== 'plan' && report.diagnostics.length === 0) {
    const root = report.scope.repositoryRoot
    let launcher: string | undefined
    try { launcher = createRequire(resolve(root, 'package.json')).resolve('tsx/cli') }
    catch (error) { report.diagnostics.push({ code: 'missing-tooling', path: 'node_modules/tsx', message: message(error) }) }
    if (launcher !== undefined) {
      const repaired: CheckResult[] = []
      if (mode === 'fix-generated') {
        for (const generated of report.generated) {
          repaired.push(execute(root, { id: generated.id, script: generated.script, args: [] }, launcher))
        }
        report = planPrPreflight(values.base, cwd)
        report.mode = mode
        report.repairedGenerators = repaired
      }
      for (const check of mechanicalChecks(report)) {
        reference(root, check.script, report.diagnostics)
        if (!existsSync(resolve(root, check.script))) continue
        const result = execute(root, check, launcher)
        report.executedChecks.push(result)
        const generated = report.generated.find(item => item.id === check.id)
        if (generated) generated.status = result.exitCode === 0 ? 'passed' : 'failed'
      }
      for (const result of [...report.repairedGenerators, ...report.executedChecks]) if (result.exitCode !== 0 || result.signal !== null) {
        report.diagnostics.push({ code: 'mechanical-check-failed', path: result.id, message: `Exit ${String(result.exitCode)}${result.signal === null ? '' : `, signal ${result.signal}`}; see the captured check output.` })
      }
    }
    report.validation.mechanical = report.diagnostics.length === 0 ? 'passed' : 'failed'
  }
  if (mode !== 'plan' && report.diagnostics.length > 0) report.validation.mechanical = 'failed'
  return { report, exitCode: report.diagnostics.length === 0 ? 0 : 1 }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { report, exitCode } = runPrPreflight(process.argv.slice(2), process.cwd())
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exitCode = exitCode
  } catch (error) {
    process.stderr.write(`pr-preflight: ${message(error)}\n`)
    process.exitCode = 1
  }
}
