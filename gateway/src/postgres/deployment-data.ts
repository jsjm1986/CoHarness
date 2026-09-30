/** Deployment-owned file selection, combining database runtime ownership and provider records. */
import { lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readManagedDataPaths, registerManagedDataPath, type ManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import type { GatewayConfig } from '../config.ts'
import { normalizeManagedRoots } from '../managed-files.ts'
import { MaintenanceError, PostgresMaintenanceService } from './maintenance-service.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'

interface RuntimeDataOwner {
  runtime: string
  dshHome: string
  home: string
  generation: number
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function same(left: ManagedDataPath, right: ManagedDataPath): boolean {
  return left.owner === right.owner && left.kind === right.kind && resolve(left.path) === resolve(right.path)
}

function allowedDefault(row: ManagedDataPath, runtime: RuntimeDataOwner): boolean {
  const defaults: ManagedDataPath[] = [
    { owner: '@deepseek-ai/dsh-session-persistence-jsonl', kind: 'directory', path: join(runtime.dshHome, 'sessions') },
    { owner: '@deepseek-ai/dsh-attachment-local', kind: 'directory', path: join(runtime.dshHome, 'attachments', 'v1') },
    { owner: '@deepseek-ai/dsh-storage-json', kind: 'directory', path: join(runtime.dshHome, 'storages') },
    { owner: '@deepseek-ai/dsh-settings-file', kind: 'file', path: join(runtime.dshHome, 'settings.yaml') },
    { owner: '@deepseek-ai/dsh-credentials-local', kind: 'file', path: join(runtime.dshHome, '.credentials.yaml') },
    { owner: '@deepseek-ai/dsh-agent-presets', kind: 'directory', path: join(runtime.dshHome, '.agent-presets') },
    { owner: '@deepseek-ai/dsh-workspace-changes', kind: 'directory', path: join(runtime.dshHome, 'workspace-reviews') },
    { owner: '@deepseek-ai/dsh-anonymous-user-id', kind: 'file', path: join(runtime.dshHome, '.anonymous-user-id') },
    { owner: '@deepseek-ai/dsh-userdoc-local', kind: 'directory', path: join(runtime.home, 'documents') },
    { owner: '@deepseek-ai/dsh-userdoc-local', kind: 'directory', path: join(runtime.home, 'uploads') },
  ]
  if (defaults.some(entry => same(entry, row))) return true
  if (row.owner === '@deepseek-ai/dsh-subagent' && row.kind === 'file') {
    const child = relative(join(runtime.home, '.dsh', 'external-members'), row.path)
    return !child.includes(sep) && /^[a-z0-9][a-z0-9._-]*\.jsonl$/u.test(child)
  }
  if (row.owner === 'app-boot' && row.kind === 'file') {
    const parts = relative(join(runtime.dshHome, 'profiles'), row.path).split(sep)
    return parts.length === 2 && parts[0] !== '..' && parts[0] !== ''
      && ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'].includes(parts[1]!)
  }
  return false
}

async function runtimeDataOwners(context: PostgresRuntimeContext, cfg: GatewayConfig): Promise<RuntimeDataOwner[]> {
  const topology = await context.pool.query<{ organizations: string; nodes: string }>(
    'SELECT (SELECT count(*)::text FROM harness.organizations) organizations, (SELECT count(*)::text FROM harness.compute_nodes) nodes')
  if (topology.rows[0]?.organizations !== '1' || topology.rows[0]?.nodes !== '1') {
    throw new MaintenanceError(409, 'backup-requires-data-bundles-from-every-database-node')
  }
  const users = await context.pool.query<{ public_id: string; username: string; home_path: string; generation: number }>(
    `SELECT u.public_id::text,u.username::text,u.home_path,COALESCE(i.generation,0) generation FROM harness.users u
      LEFT JOIN harness.instances i ON i.user_id=u.id AND i.organization_id=u.organization_id
      WHERE u.organization_id=$1 AND (i.assigned_node_id=$2 OR i.assigned_node_id IS NULL)`, [context.organizationId, context.nodeId])
  const projects = await context.pool.query<{ public_id: string; local_path: string; generation: number }>(
    `SELECT p.public_id::text,m.local_path,COALESCE(i.generation,0) generation FROM harness.projects p
      JOIN harness.project_mounts m ON m.project_id=p.id AND m.organization_id=p.organization_id
      LEFT JOIN harness.instances i ON i.project_id=p.id AND i.organization_id=p.organization_id AND i.assigned_node_id=m.node_id
      WHERE p.organization_id=$1 AND m.node_id=$2`, [context.organizationId, context.nodeId])
  return [
    ...users.rows.map(row => ({ runtime: `user:${row.public_id}`, dshHome: join(cfg.usersRoot, row.username, 'dsh'), home: row.home_path, generation: row.generation })),
    ...projects.rows.map(row => ({ runtime: `project:${row.public_id}`, dshHome: join(cfg.projectRuntimesRoot, row.public_id, 'dsh'), home: row.local_path, generation: row.generation })),
  ]
}

async function approvedRoots(cfg: GatewayConfig): Promise<ManagedDataPath[]> {
  if (cfg.managedDataApprovalFile === undefined) return []
  const info = await lstat(cfg.managedDataApprovalFile)
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o022) !== 0
    || (info.uid !== 0 && info.uid !== process.getuid?.())) {
    throw new MaintenanceError(409, 'managed-data-approvals-must-be-node-admin-owned')
  }
  return readManagedDataPaths(cfg.managedDataApprovalFile)
}

function ancestor(parent: string, child: string): boolean {
  const tail = relative(parent, child)
  return tail === '' || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`))
}

async function validatedRuntimeRoot(row: ManagedDataPath, runtime: RuntimeDataOwner, approvals: ManagedDataPath[]): Promise<ManagedDataPath> {
  const canonical = (await normalizeManagedRoots([row]))[0]!
  const canonicalRuntime = { ...runtime,
    dshHome: (await normalizeManagedRoots([{ owner: 'gateway', kind: 'directory', path: resolve(runtime.dshHome) }]))[0]!.path,
    home: (await normalizeManagedRoots([{ owner: 'gateway', kind: 'directory', path: resolve(runtime.home) }]))[0]!.path,
  }
  if (canonical.kind === 'directory' && (ancestor(canonical.path, canonicalRuntime.home)
    || ancestor(canonical.path, canonicalRuntime.dshHome))) throw new MaintenanceError(409, 'managed-data-root-includes-unowned-workspace')
  if (!allowedDefault(canonical, canonicalRuntime)) {
    const accepted = approvals.find(approval => same(approval, { ...row, owner: `${runtime.runtime}/${row.owner}` }))
    if (accepted === undefined) throw new MaintenanceError(409, `managed-data-root-needs-approval:${runtime.runtime}:${row.path}`)
    const approved = (await normalizeManagedRoots([accepted]))[0]!
    if (approved.path !== canonical.path) throw new MaintenanceError(409, 'managed-data-approved-root-changed')
  }
  return { ...canonical, owner: `${runtime.runtime}/${canonical.owner}` }
}

/**
 * Adopt explicitly reviewed historical provider roots without guessing from folder names.
 * @param context - database-confirmed node and runtime ownership.
 * @param cfg - node administrator's private approval file and storage configuration.
 * @param runtimeId - exact user or project runtime public identity.
 * @returns recorded roots; callers must hold the maintenance data lease and stop writers.
 */
export async function adoptDeploymentInventory(context: PostgresRuntimeContext, cfg: GatewayConfig, runtimeId: string): Promise<ManagedDataPath[]> {
  const { inventory, records } = await reviewedDeploymentInventory(context, cfg, runtimeId)
  for (const row of records) registerManagedDataPath(row, inventory)
  return readManagedDataPaths(inventory)
}

/**
 * Validate the administrator's complete provider list without writing an inventory.
 * @param context - database-confirmed runtime ownership with stopped writers.
 * @param cfg - current or explicitly selected candidate storage locations.
 * @param runtimeId - exact runtime public identity.
 * @returns normalized provider records and their private inventory destination.
 */
export async function reviewedDeploymentInventory(context: PostgresRuntimeContext, cfg: GatewayConfig, runtimeId: string): Promise<{ inventory: string; records: ManagedDataPath[] }> {
  const state = await new PostgresMaintenanceService(context, cfg.nodeStaleMs).state()
  if (state.mode !== 'maintenance' || !state.writersQuiesced) throw new MaintenanceError(409, 'inventory-adoption-requires-quiesced-maintenance')
  const runtime = (await runtimeDataOwners(context, cfg)).find(owner => owner.runtime === runtimeId)
  if (runtime === undefined) throw new MaintenanceError(404, 'managed-data-runtime-not-on-current-node')
  const approvals = await approvedRoots(cfg)
  const records = approvals.filter(row => row.owner.startsWith(`${runtimeId}/`))
    .map(row => ({ ...row, owner: row.owner.slice(runtimeId.length + 1) }))
  if (records.length === 0) throw new MaintenanceError(409, 'managed-data-adoption-requires-reviewed-roots')
  const canonical = await Promise.all(records.map(async row => {
    const value = await validatedRuntimeRoot(row, runtime, approvals)
    return { ...value, owner: row.owner }
  }))
  const inventory = join(runtime.dshHome, 'managed-data.jsonl')
  return { inventory, records: canonical }
}

/**
 * Select every recorded root owned by this database's current node.
 * @param context - server-confirmed organization and node, never a client-supplied runtime.
 * @param cfg - node-owned deployment configuration and optional explicit custom-root approvals.
 * @returns canonical local data roots; incomplete inventory or unavailable node coverage rejects the backup.
 */
export async function collectDeploymentData(context: PostgresRuntimeContext, cfg: GatewayConfig): Promise<ManagedDataPath[]> {
  const runtimes = await runtimeDataOwners(context, cfg)
  const approvals = await approvedRoots(cfg)
  const roots: ManagedDataPath[] = [
    { owner: 'gateway-principal', kind: 'directory', path: cfg.principalKeyDir },
    { owner: 'gateway-runtime-credentials', kind: 'directory', path: cfg.runtimeCredentialDir },
    { owner: 'gateway-node-configuration', kind: 'file', path: cfg.nodeConfigFile },
    ...(cfg.databaseUrlFile === undefined ? [] : [{ owner: 'gateway-database-connection', kind: 'file' as const, path: cfg.databaseUrlFile }]),
    ...[cfg.organizationModelCredentialKeyFile, cfg.webhookSecretKeyFile, cfg.bootstrapAdminPasswordFile,
      ...(cfg.defaultEnvFile === '' ? [] : [cfg.defaultEnvFile]),
      ...(cfg.fcmServiceAccountFile === undefined ? [] : [cfg.fcmServiceAccountFile]),
      ...(cfg.managedDataApprovalFile === undefined ? [] : [cfg.managedDataApprovalFile]),
    ].map(path => ({ owner: 'gateway', kind: 'file' as const, path: resolve(path) })),
  ]
  for (const runtime of runtimes) {
    const inventory = join(runtime.dshHome, 'managed-data.jsonl')
    if (!await exists(inventory)) {
      if (runtime.generation === 0 && !await exists(runtime.dshHome)
        && !await exists(join(runtime.home, 'documents')) && !await exists(join(runtime.home, 'uploads'))
        && !await exists(join(runtime.home, '.dsh', 'external-members'))) continue
      throw new MaintenanceError(409, `managed-data-inventory-missing:${runtime.runtime}`)
    }
    const records = readManagedDataPaths(inventory)
    if (records.length === 0) throw new MaintenanceError(409, `managed-data-inventory-empty:${runtime.runtime}`)
    for (const row of records) roots.push(await validatedRuntimeRoot(row, runtime, approvals))
    for (const name of ['managed-data.jsonl', '.env', 'cordis.patch.yml', 'directory-grants.json', 'model-governance.json']) {
      roots.push({ owner: `${runtime.runtime}/gateway`, kind: 'file', path: join(runtime.dshHome, name) })
    }
    roots.push({ owner: `${runtime.runtime}/model-governance`, kind: 'directory', path: join(runtime.dshHome, 'model-governance-outbox') })
  }
  return normalizeManagedRoots(roots)
}

/** A prepared inventory keeps custom paths and database-owned workspaces in their existing locations. */
export interface DeploymentDataRelocation {
  roots: ManagedDataPath[]
  copies: Array<{ from: ManagedDataPath; to: ManagedDataPath }>
  inventories: Array<{ runtime: string; from: string; to: string; sourceRecords: ManagedDataPath[]; records: ManagedDataPath[] }>
  movements: Array<{ from: string; to: string }>
  configuredSources: string[]
  runtimeSources: string[]
}

/**
 * Resolve data that must remain byte-identical when a node setting changes storage locations.
 * @param context - database-confirmed node whose writers are stopped.
 * @param current - currently applied deployment settings.
 * @param next - saved candidate settings; database-owned HOME and project mounts remain unchanged.
 * @returns expected candidate ownership and the complete reviewed provider inventories it requires.
 */
export async function planDeploymentDataRelocation(context: PostgresRuntimeContext, current: GatewayConfig, next: GatewayConfig): Promise<DeploymentDataRelocation> {
  const roots = await collectDeploymentData(context, current)
  const owners = await runtimeDataOwners(context, current), nextOwners = await runtimeDataOwners(context, next)
  const normalizedPath = async (path: string) => (await normalizeManagedRoots([{ owner: 'gateway', kind: 'directory', path: resolve(path) }]))[0]!.path
  const runtimes = await Promise.all(owners.map(async owner => ({ ...owner,
    dshHome: await normalizedPath(owner.dshHome), home: await normalizedPath(owner.home),
    nextHome: await normalizedPath(nextOwners.find(candidate => candidate.runtime === owner.runtime)!.dshHome),
  })))
  const movements = runtimes.filter(owner => owner.dshHome !== owner.nextHome).map(owner => ({ from: owner.dshHome, to: owner.nextHome }))
  for (const owner of runtimes) {
    if (next.launcher === 'systemd' && owner.runtime.startsWith('user:') && !ancestor(await normalizedPath(next.usersRoot), owner.home)) {
      throw new MaintenanceError(409, 'systemd-user-home-relocation-requires-coordinated-data-migration')
    }
  }
  const keys = ['principalKeyDir', 'runtimeCredentialDir', 'organizationModelCredentialKeyFile', 'webhookSecretKeyFile'] as const
  const controlMoves = (await Promise.all(keys.filter(key => current[key] !== next[key]).map(async key => {
    const kind = key.endsWith('Dir') ? 'directory' : 'file'
    const from = (await normalizeManagedRoots([{ owner: 'gateway', kind, path: resolve(current[key]) }]))[0]!.path
    const to = (await normalizeManagedRoots([{ owner: 'gateway', kind, path: resolve(next[key]) }]))[0]!.path
    return { from, to }
  }))).filter(move => move.from !== move.to)
  movements.push(...controlMoves)
  if (movements.some(move => movements.some(other => ancestor(move.from, other.to) || ancestor(other.to, move.from)
    || move !== other && (ancestor(move.to, other.to) || ancestor(other.to, move.to))))) {
    throw new MaintenanceError(409, 'overlapping-data-relocation-requires-coordinated-data-migration')
  }
  const relocateProvider = (row: ManagedDataPath, runtime: typeof runtimes[number]): ManagedDataPath =>
    allowedDefault(row, runtime) && ancestor(runtime.dshHome, row.path)
      ? { ...row, path: join(runtime.nextHome, relative(runtime.dshHome, row.path)) } : row
  const mapped = roots.map(root => {
    const runtime = runtimes.find(owner => root.owner.startsWith(`${owner.runtime}/`))
    if (runtime !== undefined) {
      const owner = root.owner.slice(runtime.runtime.length + 1)
      if ((owner === 'gateway' || owner === 'model-governance') && ancestor(runtime.dshHome, root.path)) {
        return { ...root, path: join(runtime.nextHome, relative(runtime.dshHome, root.path)) }
      }
      return { ...relocateProvider({ ...root, owner }, runtime), owner: root.owner }
    }
    const move = controlMoves.find(item => ancestor(item.from, root.path))
    return move === undefined ? root : { ...root, path: join(move.to, relative(move.from, root.path)) }
  })
  const inventories: DeploymentDataRelocation['inventories'] = []
  for (const owner of runtimes.filter(runtime => runtime.dshHome !== runtime.nextHome)) {
    const from = join(owner.dshHome, 'managed-data.jsonl'), to = join(owner.nextHome, 'managed-data.jsonl')
    if (!await exists(from)) continue // A never-started runtime has no recorded data or inventory to migrate.
    const sourceRecords = await Promise.all(readManagedDataPaths(from).map(async row => (await normalizeManagedRoots([row]))[0]!))
    inventories.push({ runtime: owner.runtime, from, to, sourceRecords, records: sourceRecords.map(row => relocateProvider(row, owner)) })
  }
  const copies = mapped.flatMap((to, index) => to.path === roots[index]!.path ? [] : [{ from: roots[index]!, to }])
  const configuredSources = ([...keys, 'usersRoot', 'projectRuntimesRoot'] as const)
    .filter(key => current[key] !== next[key]).map(key => resolve(current[key]))
  const runtimeSources = owners.filter(owner => runtimes.some(runtime => runtime.runtime === owner.runtime && runtime.dshHome !== runtime.nextHome))
    .map(owner => resolve(owner.dshHome))
  return { roots: await normalizeManagedRoots(mapped), copies, inventories, movements, configuredSources, runtimeSources }
}
