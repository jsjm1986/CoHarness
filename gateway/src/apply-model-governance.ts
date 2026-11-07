import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { join } from 'node:path'
import { type Document, isScalar, isSeq, parseDocument, Scalar } from 'yaml'
import type { GatewayConfig } from './config.ts'
import type { PersonalRuntime, ProjectRuntime } from './instances.ts'
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
type ModelGovernanceRefreshDeps = Pick<GatewayDeps, 'cfg' | 'governance'> & {
  users: Pick<GatewayDeps['users'], 'list'>
  projects: Pick<GatewayDeps['projects'], 'list'>
  instances?: Pick<GatewayDeps['instances'], 'targetsForOwner' | 'storageOf'>
}

/** Account privileges can change without a model configuration revision. */
const projectionFingerprints = new Map<string, string>()
const projectionQueues = new Map<string, Promise<void>>()
const refreshTasks = new Map<string, { pending: boolean }>()
/** Bound concurrent policy-file work below the PostgreSQL pool size. */
const MODEL_POLICY_REFRESH_CONCURRENCY = 4
/** Projection versions are an optimization cache, never an unbounded roster. */
const MAX_PROJECTION_VERSION_ENTRIES = 10_000

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
  const owner = lstatSync(dshHome)
  await writeFileAtomic(path, next, { mode: 0o600, owner })
}

async function writeProjection(
  cfg: GatewayConfig,
  governance: GatewayModelGovernanceService,
  dshHome: string,
  subject: ModelIntakeSubject,
  policy: Awaited<ReturnType<GatewayModelGovernanceService['policyFor']>>,
): Promise<string> {
  if (governance.resolveIntakeSubject !== undefined) subject = await governance.resolveIntakeSubject(subject)
  const path = join(dshHome, 'model-governance.json')
  mkdirSync(dshHome, { recursive: true, mode: 0o700 })
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
  // The base bundle's legacy default is intentionally not authorized by the
  // organization policy. Projecting an authorized organization route here
  // gives accounts without a personal selection a usable starting point;
  // settings.yaml remains the higher-precedence user choice.
  await updateManagedDefaultPatch(dshHome, policy)
  // Matching effective policy and a live credential keep reconciliation byte-stable.
  if (current) return path
  token ??= await governance.issueIntakeToken(subject)
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
  await writeFileAtomic(path, JSON.stringify(body, null, 2), { mode: 0o600, owner })
  return path
}

/** Apply a policy when its effective contents, revision or file changed. */
async function ensureProjection(
  cfg: GatewayConfig,
  governance: GatewayModelGovernanceService,
  dshHome: string,
  subject: ModelIntakeSubject,
  readPolicy: () => Promise<Awaited<ReturnType<GatewayModelGovernanceService['policyFor']>>>,
): Promise<void> {
  const key = projectionKey(subject, dshHome)
  await queueProjection(key, governance, async () => {
    const policy = await readPolicy()
    const path = join(dshHome, 'model-governance.json')
    if (projectionFingerprints.get(key) === policyFingerprint(policy) && existsSync(path)) {
      rememberProjection(key, policy)
      return
    }
    await writeProjection(cfg, governance, dshHome, subject, policy)
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

/**
 * Run one complete policy refresh with bounded workers and the catalog rows
 * already fetched for this pass. A worker failure is surfaced only after all
 * workers settle, so no rejected projection promise becomes detached work.
 * @param deps - Gateway policy and catalog services.
 */
export async function refreshModelGovernance(
  deps: ModelGovernanceRefreshDeps,
): Promise<void> {
  if (deps.governance === undefined) return
  const [users, projects] = await Promise.all([deps.users.list(), deps.projects.list()])
  const runBounded = async <T>(values: readonly T[], operation: (value: T) => Promise<void>): Promise<void> => {
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= values.length) return
        await operation(values[index] as T)
      }
    }
    const settled = await Promise.allSettled(Array.from(
      { length: Math.min(MODEL_POLICY_REFRESH_CONCURRENCY, values.length) },
      () => worker(),
    ))
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure !== undefined) throw failure.reason
  }
  await runBounded(users.filter(user => user.status === 'active'), async user => {
    if (deps.instances?.targetsForOwner === undefined || deps.instances.storageOf === undefined) {
      await writeModelGovernanceFile(deps.cfg, deps.governance!, user)
      return
    }
    for (const target of await deps.instances.targetsForOwner(user.id)) {
      const storage = await deps.instances.storageOf(target)
      if (storage.provisioning === 'preparing') continue
      await writeModelGovernanceFile(deps.cfg, deps.governance!, { ...user, ...storage })
    }
  })
  await runBounded(projects, project => writeProjectModelGovernanceFile(deps.cfg, deps.governance!, {
    kind: 'project', id: project.id, name: project.name, path: project.path,
  }).then(() => undefined))
}

/** Atomically project one user's effective model policy and stable intake credential. */
export async function writeModelGovernanceFile(
  cfg: GatewayConfig, governance: GatewayModelGovernanceService, user: PersonalRuntime,
): Promise<string> {
  const { dshHome } = personalRuntimeLayout(cfg, user)
  const subject = { kind: 'user' as const, id: user.id, ...(user.runtimeId === undefined ? {} : { runtimeId: user.runtimeId }) }
  const key = projectionKey(subject, dshHome)
  return queueProjection(key, governance, async () => {
    const policy = await governance.policyFor(user)
    const path = await writeProjection(cfg, governance, dshHome, subject, policy)
    rememberProjection(key, policy)
    return path
  })
}

/** Atomically project the shared member policy and project-owned intake credential. */
export async function writeProjectModelGovernanceFile(
  cfg: GatewayConfig,
  governance: GatewayModelGovernanceService,
  project: ProjectRuntime,
): Promise<string> {
  const dshHome = join(cfg.projectRuntimesRoot, String(project.id), 'dsh')
  const subject = { kind: 'project' as const, id: project.id, ...(project.runtimeId === undefined ? {} : { runtimeId: project.runtimeId }) }
  const key = projectionKey(subject, dshHome)
  return queueProjection(key, governance, async () => {
    const policy = await governance.policyForProject(project.id)
    const path = await writeProjection(cfg, governance, dshHome, subject, policy)
    rememberProjection(key, policy)
    return path
  })
}

/** Lazily refresh one personal runtime's policy before it handles a request. */
export async function ensureModelGovernanceForUser(
  cfg: GatewayConfig,
  governance: GatewayModelGovernanceService,
  user: PersonalRuntime,
): Promise<void> {
  const { dshHome } = personalRuntimeLayout(cfg, user)
  await ensureProjection(cfg, governance, dshHome, { kind: 'user', id: user.id, ...(user.runtimeId === undefined ? {} : { runtimeId: user.runtimeId }) }, () => Promise.resolve(governance.policyFor(user)))
}

/** Lazily refresh one project runtime's policy before it handles a request. */
export async function ensureModelGovernanceForProject(
  cfg: GatewayConfig,
  governance: GatewayModelGovernanceService,
  project: ProjectRuntime,
): Promise<void> {
  const dshHome = join(cfg.projectRuntimesRoot, String(project.id), 'dsh')
  await ensureProjection(cfg, governance, dshHome, { kind: 'project', id: project.id, ...(project.runtimeId === undefined ? {} : { runtimeId: project.runtimeId }) }, () => Promise.resolve(governance.policyForProject(project.id)))
}

/**
 * Retry a complete policy projection after a database mutation. The database
 * revision is durable; this task is only an eventually-consistent file cache,
 * so a transient filesystem/runtime failure must not turn a committed admin
 * mutation into a half-failed request. Triggers received during a pass retain
 * one pending pass, which reads the current durable policy for every subject.
 */
export function scheduleModelGovernanceRefresh(
  deps: ModelGovernanceRefreshDeps,
): void {
  if (deps.governance === undefined) return
  const key = `${deps.cfg.usersRoot}:${deps.cfg.projectRuntimesRoot}`
  const running = refreshTasks.get(key)
  if (running !== undefined) {
    running.pending = true
    return
  }
  const state = { pending: true }
  refreshTasks.set(key, state)
  const task = (async () => {
    try {
      while (state.pending) {
        state.pending = false
        let delay = 250
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            await refreshModelGovernance(deps)
            break
          } catch (error: unknown) {
            if (attempt === 5) {
              console.error('[gateway] model policy projection remains pending:', error)
              break
            }
            await new Promise<void>(resolve => {
              const timer = setTimeout(resolve, delay)
              timer.unref?.()
            })
            delay = Math.min(10_000, delay * 2)
          }
        }
      }
    } finally {
      if (refreshTasks.get(key) === state) refreshTasks.delete(key)
    }
  })()
  void task.catch(error => { console.error('[gateway] model policy refresh worker failed:', error) })
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
  if (deps.instances?.targetsForOwner === undefined || deps.instances.storageOf === undefined) {
    await writeModelGovernanceFile(deps.cfg, deps.governance, user)
    return
  }
  for (const target of await deps.instances.targetsForOwner(userId)) {
    const storage = await deps.instances.storageOf(target)
    if (storage.provisioning === 'preparing') continue
    await writeModelGovernanceFile(deps.cfg, deps.governance, { ...user, ...storage })
  }
}

/** Rewrite one project's shared policy; a running runtime applies it through the file watcher. */
export async function applyModelGovernanceToProject(
  deps: Pick<GatewayDeps, 'cfg' | 'governance' | 'projects'>,
  projectId: number,
): Promise<void> {
  if (deps.governance === undefined) throw new Error('model governance unavailable')
  const project = await deps.projects.getById(projectId)
  if (project === null) throw new Error(`no project ${projectId}`)
  await writeProjectModelGovernanceFile(deps.cfg, deps.governance, {
    kind: 'project',
    id: project.id,
    name: project.name,
    path: project.path,
  })
}
