import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { getSystemErrorMap } from 'node:util'
import { type Document, isScalar, isSeq, parseDocument, Scalar } from 'yaml'
import type { GatewayConfig } from './config.ts'
import { RuntimeStartBlockedError, type PersonalRuntime, type ProjectRuntime } from './instances.ts'
import { errorCodeForDiagnostics } from './postgres/database.ts'
import { personalRuntimeLayout } from './runtime-layout.ts'
import { ORGANIZATION_PROVIDER_PATTERN, type ModelIntakeSubject } from './model-governance.ts'
import type { GatewayModelGovernanceService } from './services.ts'
import type { GatewayDeps } from './server.ts'

interface PreviousPolicy {
  intakeToken?: unknown
  intakeUrl?: unknown
  version?: unknown
  defaultAllowed?: unknown
  models?: unknown
  providers?: unknown
  userDeclaredAllowed?: unknown
}

const MANAGED_DEFAULT_START = '# gateway-managed organization default: begin\n'
const MANAGED_DEFAULT_END = '# gateway-managed organization default: end\n'

interface ModelRoute {
  provider: string
  model: string
  allowed: boolean
}

interface ModelPolicyProjection {
  models: ReadonlyArray<ModelRoute>
  providers: ReadonlyArray<{
    provider: string
    models: ReadonlyArray<{ id: string }>
  }>
}

/** Services needed to enumerate every subject for a complete projection pass. */
type ModelGovernanceRefreshDeps = Pick<GatewayDeps, 'cfg' | 'governance' | 'maintenanceGate'> & {
  users: Pick<GatewayDeps['users'], 'list'>
  projects: Pick<GatewayDeps['projects'], 'list'>
  instances?: Pick<GatewayDeps['instances'], 'targetsForOwner' | 'storageOf'>
}

type ProjectionScope = ModelIntakeSubject | { kind: 'catalog' }
type ProjectionAttempt = (scope: ProjectionScope, run: (attempt: ProjectionAttempt) => Promise<unknown>) => Promise<void>

type ProjectionIssue = Readonly<ProjectionScope> & {
  readonly status: 'retrying' | 'failed'
  readonly errorCode: string
}

/** Bounded diagnostics from the latest settled reconciliation round on this Gateway. */
export interface ModelPolicyProjectionDiagnostics {
  readonly status: 'idle' | 'in-progress' | 'complete' | 'paused' | 'stopped'
  readonly issueCount: number
  readonly issues: readonly ProjectionIssue[]
}

interface ProjectionWork {
  scope: ProjectionScope
  run: (attempt: ProjectionAttempt) => Promise<unknown>
}

interface RefreshTask {
  lifetime: AbortController
  pending: boolean
  flight?: Promise<void>
  diagnostics: ModelPolicyProjectionDiagnostics
}

/** Account privileges can change without a model configuration revision. */
const projectionFingerprints = new Map<string, string>()
const projectionQueues = new Map<string, Promise<void>>()
const refreshTasks = new WeakMap<ModelGovernanceRefreshDeps, RefreshTask>()
/** Bound concurrent policy-file work below the PostgreSQL pool size. */
const MODEL_POLICY_REFRESH_CONCURRENCY = 4
const MODEL_POLICY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000]
const MAX_PROJECTION_DIAGNOSTIC_ISSUES = 32
const IDLE_PROJECTION: ModelPolicyProjectionDiagnostics = { status: 'idle', issueCount: 0, issues: [] }
const PROJECTION_ERROR_CODES = new Set([
  ...Array.from(getSystemErrorMap().values(), ([code]) => code),
  '40001', '40P01', '55P03', '57014', '57P01',
  'DB_CHECKOUT_QUEUE_FULL', 'INSTANCE_UNAVAILABLE', 'INSTANCE_STOPPED',
  'runtime-catalog/ambiguous-target', 'runtime-catalog/unavailable',
])
/** Projection versions are an optimization cache, never an unbounded roster. */
const MAX_PROJECTION_VERSION_ENTRIES = 10_000

function retainedProjectionHome(home:string,options?:{existingHome:true}):(()=>void)|undefined {
  if(!options)return undefined
  const original=lstatSync(home,{bigint:true})
  const verify=()=>{
    const current=lstatSync(home,{bigint:true})
    if(!isAbsolute(home)||resolve(home)!==home||realpathSync(home)!==home||!current.isDirectory()||current.isSymbolicLink()
      ||current.dev!==original.dev||current.ino!==original.ino)throw new Error('Retained model policy home changed')
  }
  verify();return verify
}

function projectionKey(subject: ModelIntakeSubject, dshHome: string): string {
  return `${subject.kind}:${String(subject.id)}:${dshHome}`
}

function sameSubject(left: ModelIntakeSubject | null, right: ModelIntakeSubject): boolean {
  return left?.kind === right.kind && left.id === right.id && left.runtimeId === right.runtimeId
}

function policyFingerprint(policy: Pick<PreviousPolicy, 'version' | 'defaultAllowed' | 'models' | 'providers'>): string {
  return createHash('sha256').update(JSON.stringify([policy.version, policy.defaultAllowed, policy.models, policy.providers])).digest('hex')
}

/**
 * Select the first route that is both authorized and registered by the runtime
 * Provider projection. The policy's stable provider/model ordering makes this
 * choice deterministic while excluding stale catalog rows.
 * @param policy - effective model authorization and Provider projection.
 * @returns a serviceable default route, or `undefined` when none is available.
 */
export function defaultModelFromPolicy(policy: ModelPolicyProjection): { provider: string; model: string } | undefined {
  const served = new Set(
    policy.providers.flatMap(provider => provider.models.map(model => `${provider.provider}\0${model.id}`)),
  )
  for (const route of policy.models) {
    if (!route.allowed) continue
    // PostgreSQL organization routes are serviceable only through the managed
    // Provider projection. SQLite's legacy fallback has no Provider list, so
    // its non-organization catalog routes retain the old local behavior.
    if (served.size === 0 && ORGANIZATION_PROVIDER_PATTERN.test(route.provider)) continue
    if (served.size > 0 && !served.has(`${route.provider}\0${route.model}`)) continue
    return { provider: route.provider, model: route.model }
  }
  return undefined
}

function withoutManagedDefault(source: string): { base: string; start: number } {
  const start = source.match(/^# gateway-managed organization default: begin\n/m)?.index ?? -1
  if (start < 0) return { base: source, start }
  const end = source.indexOf(MANAGED_DEFAULT_END, start + MANAGED_DEFAULT_START.length)
  if (end < 0) throw new Error('cordis.patch.yml contains an incomplete managed organization default block')
  return { base: `${source.slice(0, start)}${source.slice(end + MANAGED_DEFAULT_END.length)}`, start }
}

/** Keep the generated default below user settings while preserving all other home patches. */
async function updateManagedDefaultPatch(
  dshHome: string,
  policy: ModelPolicyProjection,
  verifyHome?:()=>void,
): Promise<void> {
  const path = join(dshHome, 'cordis.patch.yml')
  if (!existsSync(path)) return
  const current = readFileSync(path, 'utf8')
  const { base, start } = withoutManagedDefault(current)
  const options = {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  }
  let document: Document = parseDocument(base, options)
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (document.contents === null || isScalar(document.contents) && document.contents.value === null) {
    if (start >= 0) {
      // Keep trailing comments and document-end markers after the owned row
      // when removing it leaves no user rows.
      document = parseDocument(`${base.slice(0, start)}[]\n${base.slice(start)}`, options)
    } else {
      const empty = document.createNode([])
      empty.commentBefore = document.contents?.commentBefore
      empty.comment = document.contents?.comment
      document.contents = empty
    }
  }
  if (!isSeq(document.contents)) throw new Error('cordis.patch.yml must contain a YAML sequence')
  document.contents.flow = false
  if (document.contents.comment) {
    document.comment = [document.contents.comment, document.comment].filter(Boolean).join('\n')
    document.contents.comment = null
  }
  const defaultModel = defaultModelFromPolicy(policy)
  if (defaultModel !== undefined) {
    const provider = new Scalar(defaultModel.provider)
    const model = new Scalar(defaultModel.model)
    provider.type = model.type = Scalar.QUOTE_DOUBLE
    const row = document.createNode({ id: 'agent-default-model', config: { provider, model } })
    row.commentBefore = MANAGED_DEFAULT_START.slice(1, -1)
    row.comment = MANAGED_DEFAULT_END.slice(1, -1)
    document.add(row)
  }
  const next = String(document)
  if (next === current) return
  verifyHome?.()
  const owner = lstatSync(dshHome)
  await writeFileAtomic(path, next, { mode: 0o600, owner,createParent:verifyHome===undefined })
  verifyHome?.()
}

async function writeProjection(
  cfg: GatewayConfig,
  governance: GatewayModelGovernanceService,
  dshHome: string,
  subject: ModelIntakeSubject,
  policy: Awaited<ReturnType<GatewayModelGovernanceService['policyFor']>>,
  verifyHome?:()=>void,
): Promise<string> {
  if (governance.resolveIntakeSubject !== undefined) subject = await governance.resolveIntakeSubject(subject)
  const path = join(dshHome, 'model-governance.json')
  if(verifyHome)verifyHome()
  else mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  const intakeUrl = `http://127.0.0.1:${cfg.intakePort}/usage`
  let token: string | undefined, current = false
  if (existsSync(path)) {
    const source = readFileSync(path, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      // Invalid JSON has no reusable credential; replace it from current policy.
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const previous = parsed as PreviousPolicy
      if (typeof previous.intakeToken === 'string'
        && sameSubject(await governance.subjectForIntakeToken(previous.intakeToken), subject)) {
        token = previous.intakeToken
        current = policyFingerprint(previous) === policyFingerprint(policy) && previous.intakeUrl === intakeUrl
          && previous.userDeclaredAllowed === (subject.kind === 'user')
      }
    }
  }
  verifyHome?.()
  // The base bundle's legacy default is intentionally not authorized by the
  // organization policy. Projecting an authorized organization route here
  // gives accounts without a personal selection a usable starting point;
  // settings.yaml remains the higher-precedence user choice.
  await updateManagedDefaultPatch(dshHome, policy,verifyHome)
  // Matching effective policy and a live credential keep reconciliation byte-stable.
  if (current) return path
  token ??= await governance.issueIntakeToken(subject)
  verifyHome?.()
  const body = {
    ...policy,
    intakeUrl,
    intakeToken: token,
    // A personal runtime honors user-declared (BYOK) routes; a shared project
    // runtime receives only the organization catalog and project-owned routes
    // selected by the Gateway policy.
    userDeclaredAllowed: subject.kind === 'user',
  }
  const owner = lstatSync(dshHome)
  await writeFileAtomic(path, JSON.stringify(body, null, 2), { mode: 0o600, owner,createParent:verifyHome===undefined })
  verifyHome?.()
  return path
}

/** Apply a policy when its effective contents, revision or file changed. */
async function ensureProjection(
  cfg: GatewayConfig,
  governance: GatewayModelGovernanceService,
  dshHome: string,
  subject: ModelIntakeSubject,
  readPolicy: () => Promise<Awaited<ReturnType<GatewayModelGovernanceService['policyFor']>>>,
  options?:{existingHome:true},
): Promise<void> {
  const verifyHome=retainedProjectionHome(dshHome,options)
  const key = projectionKey(subject, dshHome)
  await queueProjection(key, governance, async () => {
    verifyHome?.()
    const policy = await readPolicy()
    verifyHome?.()
    const path = join(dshHome, 'model-governance.json')
    if (projectionFingerprints.get(key) === policyFingerprint(policy) && existsSync(path)) {
      rememberProjection(key, policy)
      return
    }
    await writeProjection(cfg, governance, dshHome, subject, policy,verifyHome)
    rememberProjection(key, policy)
  })
}

/** Serialize every projection write, including eager startup writes. */
async function queueProjection<T>(key: string, governance: GatewayModelGovernanceService, operation: () => Promise<T>): Promise<T> {
  const previous = projectionQueues.get(key) ?? Promise.resolve()
  const admitted = (): Promise<T> => governance.projectionWrite === undefined
    ? operation() : governance.projectionWrite(operation)
  const run = previous.then(admitted, admitted)
  const tail = run.then(() => undefined, () => undefined)
  projectionQueues.set(key, tail)
  void tail.then(() => {
    if (projectionQueues.get(key) === tail) projectionQueues.delete(key)
  })
  return run
}

/** Remember one projection version using insertion order as a small LRU. */
function rememberProjection(key: string, policy: Pick<PreviousPolicy, 'version' | 'defaultAllowed' | 'models' | 'providers'>): void {
  projectionFingerprints.delete(key)
  projectionFingerprints.set(key, policyFingerprint(policy))
  while (projectionFingerprints.size > MAX_PROJECTION_VERSION_ENTRIES) {
    const oldest = projectionFingerprints.keys().next().value
    if (oldest === undefined) return
    projectionFingerprints.delete(oldest)
  }
}

function throwProjectionFailures(failures: readonly unknown[]): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Model policy projections remain pending')
}

async function projectEach<T>(values: readonly T[], operation: (value: T) => Promise<void>): Promise<void> {
  const failures: unknown[] = []
  for (const value of values) {
    try { await operation(value) } catch (error) { failures.push(error) }
  }
  throwProjectionFailures(failures)
}

async function projectBounded<T>(values: readonly T[], operation: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const failures: unknown[] = []
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= values.length) return
      try { await operation(values[index] as T) } catch (error) { failures.push(error) }
    }
  }
  const settled = await Promise.allSettled(Array.from(
    { length: Math.min(MODEL_POLICY_REFRESH_CONCURRENCY, values.length) },
    () => worker(),
  ))
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure !== undefined) throw failure.reason
  throwProjectionFailures(failures)
}

const runProjection: ProjectionAttempt = async (_scope, run) => { await run(runProjection) }

async function projectCurrentModelPolicies(
  deps: ModelGovernanceRefreshDeps,
  governance: GatewayModelGovernanceService,
  attempt: ProjectionAttempt,
  signal?: AbortSignal,
): Promise<void> {
  const [users, projects] = await Promise.allSettled([
    Promise.resolve().then(() => deps.users.list()),
    Promise.resolve().then(() => deps.projects.list()),
  ])
  if (users.status === 'rejected') throw users.reason
  if (projects.status === 'rejected') throw projects.reason
  if (signal?.aborted) return
  await projectEach([
    () => projectBounded(users.value.filter(user => user.status === 'active'), user =>
      attempt({ kind: 'user', id: user.id }, retry => userModelPolicies(deps, governance, user, retry, signal))),
    () => projectBounded(projects.value, project => attempt({ kind: 'project', id: project.id }, retry =>
      projectModelPolicies(deps, governance, { kind: 'project', id: project.id, name: project.name, path: project.path }, retry, signal))),
  ], operation => operation())
}

/**
 * Run one complete policy refresh with bounded workers and the catalog rows
 * already fetched for this pass. A worker failure is surfaced only after all
 * workers settle, so no rejected projection promise becomes detached work.
 * @param deps - Gateway policy and catalog services.
 */
export async function refreshModelGovernance(
  deps: ModelGovernanceRefreshDeps,
): Promise<void> {
  if (deps.governance !== undefined) await projectCurrentModelPolicies(deps, deps.governance, runProjection)
}

async function userModelPolicies(
  deps: Pick<ModelGovernanceRefreshDeps, 'cfg' | 'instances'>,
  governance: GatewayModelGovernanceService,
  user: PersonalRuntime,
  attempt: ProjectionAttempt = runProjection,
  signal?: AbortSignal,
): Promise<void> {
  const instances = deps.instances
  if (instances?.targetsForOwner === undefined || instances.storageOf === undefined) {
    await writeModelGovernanceFile(deps.cfg, governance, user)
    return
  }
  const storageOf = instances.storageOf.bind(instances)
  await projectEach(await instances.targetsForOwner(user.id), target => attempt(target, async () => {
    const storage = await storageOf(target)
    if (!signal?.aborted && storage.provisioning !== 'preparing') {
      await writeModelGovernanceFile(deps.cfg, governance, { ...user, ...storage },storage.retainedData?{existingHome:true}:undefined)
    }
  }))
}

async function projectModelPolicies(
  deps: Pick<ModelGovernanceRefreshDeps, 'cfg' | 'instances'>,
  governance: GatewayModelGovernanceService,
  project: ProjectRuntime,
  attempt: ProjectionAttempt = runProjection,
  signal?: AbortSignal,
): Promise<void> {
  if (deps.instances?.targetsForOwner === undefined || deps.instances.storageOf === undefined) {
    await writeProjectModelGovernanceFile(deps.cfg, governance, project)
    return
  }
  const storageOf = deps.instances.storageOf.bind(deps.instances)
  await projectEach(await deps.instances.targetsForOwner(project), target => attempt(target, async () => {
    const storage = await storageOf(target)
    if (!signal?.aborted && storage.provisioning !== 'preparing') {
      await writeProjectModelGovernanceFile(deps.cfg, governance, { ...project, runtimeId: storage.runtimeId }, storage.dshHome,storage.retainedData?{existingHome:true}:undefined)
    }
  }))
}

/** Atomically project one user's effective model policy and stable intake credential.
 * @param cfg - local deployment configuration.
 * @param governance - current organization policy and intake authority.
 * @param user - authorized personal Runtime with its verified local paths.
 * @param options - require an existing retained home; ordinary allocation may provision its standard home.
 * @returns the written policy file.
 */
export async function writeModelGovernanceFile(
  cfg: GatewayConfig, governance: GatewayModelGovernanceService, user: PersonalRuntime,
  options?:{existingHome:true},
): Promise<string> {
  const dshHome = user.dshHome ?? personalRuntimeLayout(cfg, user).dshHome
  const verifyHome=retainedProjectionHome(dshHome,options)
  const subject = { kind: 'user' as const, id: user.id, ...(user.runtimeId === undefined ? {} : { runtimeId: user.runtimeId }) }
  const key = projectionKey(subject, dshHome)
  return queueProjection(key, governance, async () => {
    verifyHome?.()
    const policy = await governance.policyFor(user)
    const path = await writeProjection(cfg, governance, dshHome, subject, policy,verifyHome)
    rememberProjection(key, policy)
    return path
  })
}

/** Atomically project the shared member policy and project-owned intake credential.
 * @param cfg - local deployment configuration.
 * @param governance - current organization model policy and intake authority.
 * @param project - authorized project and exact Runtime identity when available.
 * @param runtimeHome - repository-verified local home; omitted only for the standard legacy layout.
 * @param options - require the verified retained home to remain present throughout projection without provisioning it.
 * @returns the written policy file.
 */
export async function writeProjectModelGovernanceFile(
  cfg: GatewayConfig,
  governance: GatewayModelGovernanceService,
  project: ProjectRuntime,
  runtimeHome?: string,
  options?:{existingHome:true},
): Promise<string> {
  const dshHome = runtimeHome ?? join(cfg.projectRuntimesRoot, String(project.id), 'dsh')
  const verifyHome=retainedProjectionHome(dshHome,options)
  const subject = { kind: 'project' as const, id: project.id, ...(project.runtimeId === undefined ? {} : { runtimeId: project.runtimeId }) }
  const key = projectionKey(subject, dshHome)
  return queueProjection(key, governance, async () => {
    verifyHome?.()
    const policy = await governance.policyForProject(project.id)
    const path = await writeProjection(cfg, governance, dshHome, subject, policy,verifyHome)
    rememberProjection(key, policy)
    return path
  })
}

/** Lazily refresh one personal Runtime's policy before it handles a request.
 * @param cfg - local deployment configuration.
 * @param governance - current organization policy and intake authority.
 * @param user - current personal policy re-read from the repository.
 * @param options - require an existing retained home; ordinary allocation may provision its standard home.
 */
export async function ensureModelGovernanceForUser(
  cfg: GatewayConfig,
  governance: GatewayModelGovernanceService,
  user: PersonalRuntime,
  options?:{existingHome:true},
): Promise<void> {
  const dshHome = user.dshHome ?? personalRuntimeLayout(cfg, user).dshHome
  await ensureProjection(cfg, governance, dshHome, { kind: 'user', id: user.id, ...(user.runtimeId === undefined ? {} : { runtimeId: user.runtimeId }) }, () => Promise.resolve(governance.policyFor(user)),options)
}

/** Lazily refresh one project runtime's policy before it handles a request.
 * @param cfg - local deployment configuration.
 * @param governance - current organization model policy and intake authority.
 * @param project - authorized project and exact Runtime identity when available.
 * @param runtimeHome - repository-verified local home; omitted only for the standard legacy layout.
 * @param options - require the verified retained home to remain present throughout projection without provisioning it.
 */
export async function ensureModelGovernanceForProject(
  cfg: GatewayConfig,
  governance: GatewayModelGovernanceService,
  project: ProjectRuntime,
  runtimeHome?: string,
  options?:{existingHome:true},
): Promise<void> {
  const dshHome = runtimeHome ?? join(cfg.projectRuntimesRoot, String(project.id), 'dsh')
  await ensureProjection(cfg, governance, dshHome, { kind: 'project', id: project.id, ...(project.runtimeId === undefined ? {} : { runtimeId: project.runtimeId }) }, () => Promise.resolve(governance.policyForProject(project.id)),options)
}

function refreshTaskFor(deps: ModelGovernanceRefreshDeps): RefreshTask {
  let task = refreshTasks.get(deps)
  if (task === undefined) {
    task = { lifetime: new AbortController(), pending: false, diagnostics: IDLE_PROJECTION }
    refreshTasks.set(deps, task)
  }
  return task
}

function projectionIssue(scope: ProjectionScope, status: ProjectionIssue['status'], error: unknown): ProjectionIssue {
  const code = errorCodeForDiagnostics(error)
  const errorCode = PROJECTION_ERROR_CODES.has(code) ? code : 'unknown'
  return scope.kind === 'catalog' ? { kind: scope.kind, status, errorCode } : {
    kind: scope.kind, id: scope.id, runtimeId: scope.runtimeId, status, errorCode,
  }
}

/**
 * Read the background projection state without waiting for a scan or accessing storage.
 * @param deps - the Gateway-owned service object used by refresh triggers.
 * @returns The current state and bounded issue sample, or null without model governance.
 */
export function modelPolicyProjectionDiagnostics(deps: ModelGovernanceRefreshDeps): ModelPolicyProjectionDiagnostics | null {
  return deps.governance === undefined ? null : refreshTasks.get(deps)?.diagnostics ?? IDLE_PROJECTION
}

async function reconcileModelPolicies(
  deps: ModelGovernanceRefreshDeps,
  governance: GatewayModelGovernanceService,
  task: RefreshTask,
): Promise<'paused' | 'complete'> {
  const signal = task.lifetime.signal
  let paused = false
  let work: ProjectionWork[] = [{
    scope: { kind: 'catalog' },
    run: async attempt => {
      const verdict = await deps.maintenanceGate?.()
      if (verdict !== undefined && verdict !== 'open') {
        paused = true
        return
      }
      if (!signal.aborted) await projectCurrentModelPolicies(deps, governance, attempt, signal)
    },
  }]
  for (let index = 0; work.length > 0 && !task.pending && !signal.aborted; index += 1) {
    const wait = MODEL_POLICY_RETRY_DELAYS_MS[index]
    const failed: ProjectionWork[] = []
    const issues: ProjectionIssue[] = []
    let issueCount = 0
    const attempt: ProjectionAttempt = async (scope, run) => {
      if (signal.aborted) return
      try {
        await run(attempt)
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof RuntimeStartBlockedError && (error.reason === 'maintenance' || error.reason === 'stale-epoch')) {
          paused = true
          return
        }
        const issue = projectionIssue(scope, wait === undefined ? 'failed' : 'retrying', error)
        issueCount += 1
        if (issues.length < MAX_PROJECTION_DIAGNOSTIC_ISSUES) issues.push(issue)
        if (wait !== undefined) failed.push({ scope, run })
        else console.error('[gateway] model policy projection remains pending', issue)
      }
    }
    await projectBounded(work, ({ scope, run }) => attempt(scope, run))
    if (!signal.aborted) task.diagnostics = { status: 'in-progress', issueCount, issues }
    work = failed
    if (work.length > 0 && wait !== undefined && !task.pending && !signal.aborted) {
      await delay(wait, undefined, { ref: false, signal })
    }
  }
  return paused ? 'paused' : 'complete'
}

/**
 * Request a bounded scan of the Gateway's policy file cache. Retries resolve
 * the failed targets again. A newer trigger coalesces into a fresh scan.
 * @param deps - the Gateway-owned service object used by all refresh triggers.
 */
export function scheduleModelGovernanceRefresh(deps: ModelGovernanceRefreshDeps): void {
  const governance = deps.governance
  if (governance === undefined) return
  const task = refreshTaskFor(deps)
  if (task.lifetime.signal.aborted) return
  task.pending = true
  task.diagnostics = { ...task.diagnostics, status: 'in-progress' }
  task.flight ??= Promise.resolve().then(async () => {
    try {
      while (task.pending && !task.lifetime.signal.aborted) {
        task.pending = false
        const status = await reconcileModelPolicies(deps, governance, task)
        if (!task.pending && !task.lifetime.signal.aborted) task.diagnostics = { ...task.diagnostics, status }
      }
    } catch (error) {
      if (!task.lifetime.signal.aborted) {
        const issue = projectionIssue({ kind: 'catalog' }, 'failed', error)
        task.diagnostics = { status: 'complete', issueCount: 1, issues: [issue] }
        console.error('[gateway] model policy refresh worker failed', issue)
      }
    } finally {
      task.flight = undefined
    }
  })
}

/**
 * Cancel pending reconciliation and wait for active operations before their services close.
 * @param deps - the Gateway-owned service object used by refresh triggers.
 */
export async function closeModelGovernanceRefresh(deps: ModelGovernanceRefreshDeps): Promise<void> {
  const task = refreshTaskFor(deps)
  task.lifetime.abort()
  await task.flight
  task.diagnostics = { ...task.diagnostics, status: 'stopped' }
}

/** Rewrite policy; a running instance applies it through the plugin's file watcher. */
export async function applyModelGovernanceToUser(
  deps: Pick<GatewayDeps, 'cfg' | 'governance' | 'users'> & { instances?: Pick<GatewayDeps['instances'], 'targetsForOwner' | 'storageOf'> },
  userId: number,
): Promise<void> {
  if (deps.governance === undefined) throw new Error('model governance unavailable')
  const user = await deps.users.getById(userId)
  if (user === null) throw new Error(`no user ${userId}`)
  if (user.status !== 'active') return
  await userModelPolicies(deps, deps.governance, user)
}

/** Rewrite one project's shared policy; a running runtime applies it through the file watcher. */
export async function applyModelGovernanceToProject(
  deps: Pick<GatewayDeps, 'cfg' | 'governance' | 'projects'> & Pick<ModelGovernanceRefreshDeps, 'instances'>,
  projectId: number,
): Promise<void> {
  if (deps.governance === undefined) throw new Error('model governance unavailable')
  const project = await deps.projects.getById(projectId)
  if (project === null) throw new Error(`no project ${projectId}`)
  await projectModelPolicies(deps, deps.governance, {
    kind: 'project',
    id: project.id,
    name: project.name,
    path: project.path,
  })
}
