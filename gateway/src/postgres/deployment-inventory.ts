/** Explicit replacement of copied inventories for a reviewed, unapplied node configuration revision. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readManagedDataPaths } from '@deepseek-ai/dsh-managed-data'
import { loadConfig, type GatewayConfig } from '../config.ts'
import { nodeSettingsEnvironment } from '../node-config-host.ts'
import { readNodeConfiguration } from '../node-config-store.ts'
import { normalizeManagedRoots } from '../managed-files.ts'
import { planDeploymentDataRelocation, reviewedDeploymentInventory } from './deployment-data.ts'
import { MaintenanceError } from './maintenance-service.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'

async function flushDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function inventoryBytes(path: string) {
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await source.stat()
    if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) throw new MaintenanceError(409, 'inventory-is-not-a-bounded-regular-file')
    const bytes = await source.readFile(), after = await source.stat()
    if (bytes.length !== metadata.size || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) {
      throw new MaintenanceError(409, 'inventory-changed-during-read')
    }
    return { bytes, metadata }
  } finally { await source.close() }
}

/**
 * Replace one copied manifest with the complete approved candidate list, preserving its original bytes.
 * @param context - current database identity; the caller holds its data-operation lease.
 * @param cfg - currently applied settings, retained until a separate explicit configuration application.
 * @param environment - effective current deployment environment.
 * @param runtimeId - runtime whose copied inventory was reviewed.
 * @param revision - exact saved desired revision; stale or wrong-node requests perform no writes.
 * @param signal - lifetime of the data-operation lease.
 * @returns preserved inventory evidence and the full installed candidate records.
 */
export async function replaceCandidateDeploymentInventory(context: PostgresRuntimeContext, cfg: GatewayConfig, environment: NodeJS.ProcessEnv,
  runtimeId: string, revision: number, signal: AbortSignal) {
  signal.throwIfAborted()
  const record = await readNodeConfiguration(cfg.nodeConfigFile, environment)
  if (record === undefined || record.organizationId !== context.organizationId || record.nodeId !== context.nodeId
    || record.organizationSlug !== context.organizationSlug || record.nodeName !== context.nodeName) {
    throw new MaintenanceError(409, 'candidate-inventory-node-identity-mismatch')
  }
  if (record.revision !== revision || record.appliedRevision === revision || record.operation?.status === 'applying') {
    throw new MaintenanceError(409, 'candidate-inventory-configuration-revision-conflict')
  }
  const next = loadConfig(nodeSettingsEnvironment(environment, record.desired))
  const plan = await planDeploymentDataRelocation(context, cfg, next)
  const target = plan.inventories.find(inventory => inventory.runtime === runtimeId)
  if (target === undefined) throw new MaintenanceError(409, 'candidate-inventory-has-no-existing-runtime-relocation')
  const reviewed = await reviewedDeploymentInventory(context, next, runtimeId)
  const keys = (records: typeof target.records) => records.map(row => JSON.stringify([row.owner, row.kind, row.path])).sort()
  if (JSON.stringify(keys(reviewed.records)) !== JSON.stringify(keys(target.records))) {
    throw new MaintenanceError(409, 'candidate-inventory-review-must-cover-all-relocated-and-retained-roots')
  }
  // Require the operator's copied file, including a valid old inventory; adoption does not create missing data.
  const copiedRecords = await Promise.all(readManagedDataPaths(target.to).map(async row => (await normalizeManagedRoots([row]))[0]!))
  if (JSON.stringify(keys(copiedRecords)) !== JSON.stringify(keys(target.sourceRecords))
    && JSON.stringify(keys(copiedRecords)) !== JSON.stringify(keys(target.records))) {
    throw new MaintenanceError(409, 'copied-inventory-does-not-match-current-or-reviewed-roots')
  }
  const { bytes, metadata } = await inventoryBytes(target.to)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const evidenceDirectory = join(cfg.backupDir, 'inventory-adoptions', context.nodeId, runtimeId.replace(':', '-'))
  const evidence = join(evidenceDirectory, `revision-${revision}-${digest}.jsonl`)
  signal.throwIfAborted()
  const firstCreated = await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
  let archive
  try { archive = await open(evidence, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!(await inventoryBytes(evidence)).bytes.equals(bytes)) throw new MaintenanceError(409, 'inventory-evidence-content-mismatch')
  }
  if (archive !== undefined) {
    try { await archive.writeFile(bytes); await archive.sync() } finally { await archive.close() }
  }
  let directory = evidenceDirectory
  const last = firstCreated === undefined ? directory : dirname(firstCreated)
  for (;;) {
    await flushDirectory(directory)
    if (directory === last) break
    directory = dirname(directory)
  }
  const temp = join(dirname(target.to), `.managed-data-${randomUUID()}.tmp`)
  try {
    const replacement = await open(temp, 'wx', metadata.mode & 0o777)
    try {
      await replacement.chown(metadata.uid, metadata.gid)
      await replacement.chmod(metadata.mode & 0o777)
      await replacement.writeFile(reviewed.records.map(row => JSON.stringify({ version: 1, ...row })).join('\n') + '\n')
      await replacement.sync()
    } finally { await replacement.close() }
    signal.throwIfAborted()
    if (!(await inventoryBytes(target.to)).bytes.equals(bytes)) throw new MaintenanceError(409, 'copied-inventory-changed-during-adoption')
    await rename(temp, target.to)
    await flushDirectory(dirname(target.to))
  } finally { await rm(temp, { force: true }) }
  signal.throwIfAborted()
  return { roots: reviewed.records, evidence }
}
