/** Deployment configuration stays current while an application-data backup is restored. */
import { join, resolve } from 'node:path'
import type { GatewayConfig } from '../config.ts'
import { normalizeManagedRoots, type ManagedSnapshot, type PreservedManagedFiles } from '../managed-files.ts'
import type { NodeSettingValues } from '../node-config-fields.ts'
import { nodeSettingsFromConfig, readNodeConfiguration, type NodeConfigurationRecord } from '../node-config-store.ts'
import { MaintenanceError } from './maintenance-service.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'

const STORAGE_FIELDS = [
  'HGW_USERS_ROOT', 'HGW_PROJECT_RUNTIMES_ROOT', 'HGW_DATABASE_URL_FILE', 'HGW_PRINCIPAL_KEY_DIR',
  'HGW_RUNTIME_CREDENTIAL_DIR', 'HGW_ORGANIZATION_MODEL_CREDENTIAL_KEY_FILE', 'HGW_WEBHOOK_SECRET_KEY_FILE',
  'HGW_DEFAULT_ENV_FILE',
] as const

/** A verified backup's non-secret settings, available for deliberate administrator review. */
export interface BackupNodeConfigurationView {
  backupId: string
  configFile: string | null
  appliedRevision: number | null
  values: NodeSettingValues | null
  incompatibleFields: string[]
}

async function configPath(snapshot: ManagedSnapshot, cfg: GatewayConfig): Promise<string | undefined> {
  const recorded = snapshot.roots.filter(root => root.owner === 'gateway-node-configuration')
  if (recorded.length > 1 || recorded.some(root => root.kind !== 'file')) throw new MaintenanceError(409, 'backup-node-configuration-identity-ambiguous')
  if (recorded.length === 1) return recorded[0]!.path
  const currentPath = (await normalizeManagedRoots([{ owner: 'gateway', kind: 'file', path: resolve(cfg.nodeConfigFile) }]))[0]!.path
  return snapshot.roots.find(root => root.path === currentPath && root.kind === 'file')?.path
}

async function readConfig(snapshot: ManagedSnapshot, filesDir: string, path: string | undefined,
  environment: NodeJS.ProcessEnv): Promise<NodeConfigurationRecord | undefined> {
  const file = snapshot.files.find(file => file.sourcePath === path)
  if (file === undefined) return undefined
  const record = await readNodeConfiguration(join(filesDir, file.member), environment)
  if (record === undefined) throw new MaintenanceError(409, 'backup-node-configuration-file-missing')
  return record
}

function sameIdentity(record: NodeConfigurationRecord, context: PostgresRuntimeContext, cfg: GatewayConfig): boolean {
  return record.organizationId === context.organizationId && record.nodeId === context.nodeId
    && record.organizationSlug === cfg.organizationSlug && record.nodeName === context.nodeName
}

/**
 * Compare a verified backup's applied values with current node storage locations.
 * @param id - backup registry identity.
 * @param snapshot - verified complete backup membership.
 * @param filesDir - verified immutable backup bytes.
 * @param context - server-confirmed current organization and node.
 * @param cfg - current deployment configuration.
 * @param environment - current effective non-editable bootstrap and applied values.
 * @returns whitelisted applied settings and precise incompatible storage fields, never credential contents.
 */
export async function previewBackupNodeConfiguration(id: string, snapshot: ManagedSnapshot, filesDir: string,
  context: PostgresRuntimeContext, cfg: GatewayConfig, environment: NodeJS.ProcessEnv): Promise<BackupNodeConfigurationView> {
  const path = await configPath(snapshot, cfg), record = await readConfig(snapshot, filesDir, path, environment)
  const incompatibleFields: string[] = []
  const currentPath = (await normalizeManagedRoots([{ owner: 'gateway', kind: 'file', path: resolve(cfg.nodeConfigFile) }]))[0]!.path
  if (path !== undefined && path !== currentPath) incompatibleFields.push('HGW_NODE_CONFIG_FILE')
  if (record !== undefined && !sameIdentity(record, context, cfg)) incompatibleFields.push('node-identity')
  if (record !== undefined) {
    const current = nodeSettingsFromConfig(cfg, environment)
    for (const field of STORAGE_FIELDS) {
      const before = record.applied[field], now = current[field]
      if (before === '' || now === '') {
        if (before !== now) incompatibleFields.push(field)
      } else if (resolve(before) !== resolve(now)) incompatibleFields.push(field)
    }
  }
  return { backupId: id, configFile: path ?? null, appliedRevision: record?.appliedRevision ?? null,
    values: record?.applied ?? null, incompatibleFields }
}

/**
 * Keep current control files and reject storage changes before restoring any database row.
 * @param selected - verified backup selected by the administrator.
 * @param protectedFiles - first complete pre-restore protection snapshot, immutable across retries.
 * @param context - current database identity.
 * @param cfg - current effective deployment configuration.
 * @param environment - effective launch settings used to validate stored node records.
 * @returns control files matched against the protection snapshot; the old configuration remains in its backup for review.
 */
export async function preservedDeploymentControlFiles(
  selected: { id: string; snapshot: ManagedSnapshot; filesDir: string },
  protectedFiles: { snapshot: ManagedSnapshot; filesDir: string },
  context: PostgresRuntimeContext, cfg: GatewayConfig, environment: NodeJS.ProcessEnv,
): Promise<PreservedManagedFiles> {
  const preview = await previewBackupNodeConfiguration(selected.id, selected.snapshot, selected.filesDir, context, cfg, environment)
  const currentPath = await configPath(protectedFiles.snapshot, cfg)
  const current = await readConfig(protectedFiles.snapshot, protectedFiles.filesDir, currentPath, environment)
  if (current !== undefined && !sameIdentity(current, context, cfg)) throw new MaintenanceError(409, 'current-node-configuration-identity-mismatch')
  if (current?.operation?.status === 'applying') throw new MaintenanceError(409, 'node-configuration-apply-incomplete')
  if (current !== undefined && preview.values === null) throw new MaintenanceError(409, 'backup-node-configuration-evidence-missing')
  if (preview.incompatibleFields.length > 0) throw new MaintenanceError(409,
    `backup-data-paths-require-explicit-migration:${preview.incompatibleFields.join(',')}`)
  const control = [cfg.nodeConfigFile, ...(cfg.databaseUrlFile === undefined ? [] : [cfg.databaseUrlFile])]
  const paths = (await normalizeManagedRoots(control.map(path => ({ owner: 'gateway', kind: 'file' as const, path: resolve(path) })))).map(root => root.path)
  for (const path of paths) {
    if (!protectedFiles.snapshot.roots.some(root => root.path === path && root.kind === 'file')) throw new MaintenanceError(409, 'control-file-protection-missing')
  }
  return { ...protectedFiles, paths }
}
