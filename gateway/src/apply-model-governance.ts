import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GatewayConfig } from './config.ts'
import type { ProjectRuntime } from './instances.ts'
import { ORGANIZATION_PROVIDER_PATTERN, type ModelUsageSubject } from './model-governance.ts'
import type { GatewayModelGovernanceService } from './services.ts'
import type { UserRow } from './auth.ts'
import type { GatewayDeps } from './server.ts'

interface PreviousPolicy { intakeToken?: unknown }

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

function sameSubject(left: ModelUsageSubject | null, right: ModelUsageSubject): boolean {
  return left?.kind === right.kind && left.id === right.id
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

function withoutManagedDefault(source: string): string {
  const start = source.indexOf(MANAGED_DEFAULT_START)
  if (start < 0) return source
  const end = source.indexOf(MANAGED_DEFAULT_END, start + MANAGED_DEFAULT_START.length)
  if (end < 0) throw new Error('cordis.patch.yml contains an incomplete managed organization default block')
  return `${source.slice(0, start)}${source.slice(end + MANAGED_DEFAULT_END.length)}`
}

function managedDefaultBlock(defaultModel: { provider: string; model: string } | undefined): string {
  if (defaultModel === undefined) return ''
  // JSON string literals are valid YAML scalars and keep arbitrary route ids
  // from changing the generated patch structure.
  return `${MANAGED_DEFAULT_START}- id: agent-default-model\n  config:\n    provider: ${JSON.stringify(defaultModel.provider)}\n    model: ${JSON.stringify(defaultModel.model)}\n${MANAGED_DEFAULT_END}`
}

/** Keep the generated default below user settings while preserving all other home patches. */
function updateManagedDefaultPatch(
  dshHome: string,
  policy: ModelPolicyProjection,
): void {
  const path = join(dshHome, 'cordis.patch.yml')
  if (!existsSync(path)) return
  const current = readFileSync(path, 'utf8')
  const base = withoutManagedDefault(current).trimEnd()
  const block = managedDefaultBlock(defaultModelFromPolicy(policy))
  const retained = base === '' ? '[]' : base
  const next = block === '' ? `${retained}\n` : `${retained}\n${block}`
  if (next === current) return
  const temp = `${path}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, next, { mode: 0o644 })
    renameSync(temp, path)
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp)
    throw error
  }
}

async function writeProjection(
  cfg: GatewayConfig,
  governance: GatewayModelGovernanceService,
  dshHome: string,
  subject: ModelUsageSubject,
  policy: Awaited<ReturnType<GatewayModelGovernanceService['policyFor']>>,
): Promise<string> {
  const path = join(dshHome, 'model-governance.json')
  mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  let token: string | undefined
  if (existsSync(path)) {
    try {
      const previous = JSON.parse(readFileSync(path, 'utf8')) as PreviousPolicy
      if (typeof previous.intakeToken === 'string'
        && sameSubject(await governance.subjectForIntakeToken(previous.intakeToken), subject)) {
        token = previous.intakeToken
      }
    } catch { /* replace malformed old projection */ }
  }
  token ??= await governance.issueIntakeToken(subject)
  const body = {
    ...policy,
    intakeUrl: `http://127.0.0.1:${cfg.intakePort}/usage`,
    intakeToken: token,
    // A personal runtime honors user-declared (BYOK) routes; a shared project
    // runtime stays catalog-only because members share one settings document.
    userDeclaredAllowed: subject.kind === 'user',
  }
  // The base bundle's legacy default is intentionally not authorized by the
  // organization policy. Projecting an authorized organization route here
  // gives accounts without a personal selection a usable starting point;
  // settings.yaml remains the higher-precedence user choice.
  updateManagedDefaultPatch(dshHome, policy)
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, JSON.stringify(body, null, 2), { mode: 0o600 })
  renameSync(temp, path)
  chmodSync(path, 0o600)
  return path
}

/** Atomically project one user's effective model policy and stable intake credential. */
export async function writeModelGovernanceFile(
  cfg: GatewayConfig, governance: GatewayModelGovernanceService, user: UserRow,
): Promise<string> {
  return writeProjection(
    cfg,
    governance,
    join(cfg.usersRoot, user.username, 'dsh'),
    { kind: 'user', id: user.id },
    await governance.policyFor(user),
  )
}

/** Atomically project the shared member policy and project-owned intake credential. */
export async function writeProjectModelGovernanceFile(
  cfg: GatewayConfig,
  governance: GatewayModelGovernanceService,
  project: ProjectRuntime,
): Promise<string> {
  return writeProjection(
    cfg,
    governance,
    join(cfg.projectRuntimesRoot, String(project.id), 'dsh'),
    { kind: 'project', id: project.id },
    await governance.policyForProject(project.id),
  )
}

/** Rewrite policy; a running instance applies it through the plugin's file watcher. */
export async function applyModelGovernanceToUser(
  deps: Pick<GatewayDeps, 'cfg' | 'governance' | 'users'>,
  userId: number,
): Promise<void> {
  if (deps.governance === undefined) throw new Error('model governance unavailable')
  const user = await deps.users.getById(userId)
  if (user === null) throw new Error(`no user ${userId}`)
  await writeModelGovernanceFile(deps.cfg, deps.governance, user)
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
