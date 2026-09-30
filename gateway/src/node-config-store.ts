/** Durable current-node deployment configuration, separate from secrets and executable launch commands. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { loadConfig, type GatewayConfig } from './config.ts'
import { NODE_CONFIG_FIELDS, type NodeConfigurationIdentity, type NodeConfigurationOperation, type NodeConfigurationView, type NodeSettingValues } from './node-config-fields.ts'

/** Invalid input, identity mismatch or a concurrent configuration edit. */
export class NodeConfigurationError extends Error {
  constructor(readonly status: 400 | 409, message: string) { super(message) }
}

/** Stored desired/applied revisions; previous remains available while an apply is incomplete. */
export interface NodeConfigurationRecord extends NodeConfigurationIdentity {
  version: 1
  organizationSlug: string
  nodeName: string
  revision: number
  appliedRevision: number
  desired: NodeSettingValues
  applied: NodeSettingValues
  previous: { revision: number; values: NodeSettingValues } | null
  operation: NodeConfigurationOperation | null
}

/** Database exclusion and generation capture supplied by the Gateway's deployment owner. */
export interface NodeConfigurationMutationAuthority {
  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>
  writeEpoch(): Promise<string>
}

const MAX_CONFIG_BYTES = 1024 * 1024

/**
 * Resolve the stable bootstrap location, never from a candidate setting.
 * @param env - process launcher environment.
 * @returns the absolute node configuration filename.
 */
export function nodeConfigurationFile(env: NodeJS.ProcessEnv): string {
  return resolve(env.HGW_NODE_CONFIG_FILE ?? join(env.HGW_STATE_ROOT ?? join(homedir(), '.harness-gateway'), 'node-config.json'))
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new NodeConfigurationError(400, 'node-configuration-must-be-an-object')
  return value as Record<string, unknown>
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new NodeConfigurationError(400, 'invalid-node-configuration-revision')
  return value
}

/**
 * Validate only the declared public fields; secret values and shell commands are not accepted.
 * @param input - durable or HTTP JSON settings.
 * @param environment - immutable bootstrap environment used for complete cross-field validation.
 * @returns normalized settings suitable for loadConfig.
 */
export function parseNodeSettingValues(input: unknown, environment: NodeJS.ProcessEnv): NodeSettingValues {
  const values = object(input)
  if (Object.keys(values).some(key => !NODE_CONFIG_FIELDS.some(field => field.key === key))) throw new NodeConfigurationError(400, 'unknown-node-configuration-field')
  const result = {} as NodeSettingValues
  for (const field of NODE_CONFIG_FIELDS) {
    const value = values[field.key]
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value)) throw new NodeConfigurationError(400, `invalid-node-setting:${field.key}`)
    if (field.kind === 'directory' || field.kind === 'file' || field.kind === 'optional-file' && value !== '') {
      if (!isAbsolute(value) || resolve(value) === '/') throw new NodeConfigurationError(400, `node-setting-needs-absolute-path:${field.key}`)
    }
    result[field.key] = value.trim()
  }
  for (const origin of result.HGW_PUBLIC_ORIGINS.split(',')) {
    let url: URL
    try { url = new URL(origin.trim()) } catch { throw new NodeConfigurationError(400, 'invalid-public-origin') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== ''
      || url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new NodeConfigurationError(400, 'invalid-public-origin')
  }
  try { loadConfig({ ...environment, ...result }) } catch (error) {
    throw new NodeConfigurationError(400, error instanceof Error ? error.message : 'invalid-node-configuration')
  }
  return result
}

/**
 * Select the non-secret values actually used by one running Gateway.
 * @param cfg - resolved process configuration.
 * @param environment - effective environment, used only for the database credential filename.
 * @returns declared editable fields without secret contents.
 */
export function nodeSettingsFromConfig(cfg: GatewayConfig, environment: NodeJS.ProcessEnv): NodeSettingValues {
  return {
    HGW_PORT: String(cfg.port), HGW_INTAKE_PORT: String(cfg.intakePort), HGW_PUBLIC_ORIGINS: cfg.publicOrigins.join(','),
    HGW_USERS_ROOT: cfg.usersRoot, HGW_PROJECT_RUNTIMES_ROOT: cfg.projectRuntimesRoot,
    HGW_PROJECTS_ROOT: cfg.projectsRoot, HGW_USER_PROJECTS_ROOT: cfg.userProjectsRoot,
    HGW_BACKUP_DIR: cfg.backupDir, HGW_DATABASE_URL_FILE: environment.HGW_DATABASE_URL_FILE ?? '',
    HGW_PRINCIPAL_KEY_DIR: cfg.principalKeyDir, HGW_RUNTIME_CREDENTIAL_DIR: cfg.runtimeCredentialDir,
    HGW_ORGANIZATION_MODEL_CREDENTIAL_KEY_FILE: cfg.organizationModelCredentialKeyFile,
    HGW_WEBHOOK_SECRET_KEY_FILE: cfg.webhookSecretKeyFile, HGW_DEFAULT_ENV_FILE: cfg.defaultEnvFile,
    HGW_INSTANCE_PORT_BASE: String(cfg.instancePortBase), HGW_IDLE_TIMEOUT_MS: String(cfg.idleTimeoutMs),
    HGW_READINESS_TIMEOUT_MS: String(cfg.readinessTimeoutMs), HGW_MEMORY_MAX: cfg.memoryMax, HGW_CPU_QUOTA: cfg.cpuQuota,
  }
}

/**
 * Read bounded configuration bytes without following a link at the config file.
 * @param file - private node configuration filename.
 * @param environment - bootstrap environment for complete field validation.
 * @returns validated data, or undefined only when the file is absent.
 */
export async function readNodeConfiguration(file: string, environment: NodeJS.ProcessEnv): Promise<NodeConfigurationRecord | undefined> {
  let handle
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let value: unknown
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES || (info.mode & 0o077) !== 0) throw new NodeConfigurationError(409, 'node-configuration-file-must-be-private')
    value = JSON.parse(await handle.readFile('utf8'))
  } finally { await handle.close() }
  const row = object(value)
  if (row.version !== 1 || ['organizationId', 'nodeId', 'organizationSlug', 'nodeName'].some(key => typeof row[key] !== 'string' || row[key] === '')) throw new NodeConfigurationError(409, 'invalid-node-configuration-identity')
  const previous = row.previous === null ? null : object(row.previous)
  let operation: NodeConfigurationOperation | null = null
  if (row.operation !== null) {
    const op = object(row.operation)
    if (typeof op.id !== 'string' || op.id === '' || typeof op.requestedAt !== 'string'
      || typeof op.writeEpoch !== 'string' || !/^[1-9][0-9]*$/u.test(op.writeEpoch)
      || !['pending', 'applying', 'completed', 'failed'].includes(String(op.status))
      || (op.error !== null && typeof op.error !== 'string')
      || (op.actor !== null && (typeof op.actor !== 'number' || !Number.isSafeInteger(op.actor) || op.actor < 1))) throw new NodeConfigurationError(409, 'invalid-node-configuration-operation')
    operation = { id: op.id, revision: revision(op.revision), writeEpoch: op.writeEpoch, requestedAt: op.requestedAt,
      status: op.status as NodeConfigurationOperation['status'], actor: op.actor as number | null, error: op.error as string | null }
  }
  const parsed: NodeConfigurationRecord = {
    version: 1, organizationId: row.organizationId as string, nodeId: row.nodeId as string,
    organizationSlug: row.organizationSlug as string, nodeName: row.nodeName as string,
    revision: revision(row.revision), appliedRevision: revision(row.appliedRevision),
    desired: parseNodeSettingValues(row.desired, environment), applied: parseNodeSettingValues(row.applied, environment),
    previous: previous === null ? null : { revision: revision(previous.revision), values: parseNodeSettingValues(previous.values, environment) }, operation,
  }
  if (parsed.appliedRevision > parsed.revision || (parsed.previous !== null && parsed.previous.revision > parsed.appliedRevision)
    || operation !== null && (operation.revision > parsed.revision
      || (operation.status === 'pending' || operation.status === 'applying') && operation.revision !== parsed.revision
      || operation.status === 'completed' && operation.revision !== parsed.appliedRevision
      || operation.status === 'applying' && parsed.previous === null)) {
    throw new NodeConfigurationError(409, 'inconsistent-node-configuration-revisions')
  }
  return parsed
}

/**
 * Commit the private config file durably; the caller holds its deployment and file locks.
 * @param file - fixed private filename.
 * @param value - complete validated next record.
 * @param signal - lease lifetime; cancellation prevents publication.
 * @returns after file and containing directory have been flushed.
 */
export async function writeNodeConfiguration(file: string, value: NodeConfigurationRecord, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n')
      await handle.sync()
    } finally { await handle.close() }
    signal?.throwIfAborted()
    await rename(temporary, file)
    const directory = await open(dirname(file), 'r')
    try { await directory.sync() } finally { await directory.close() }
    signal?.throwIfAborted()
  } finally { await rm(temporary, { force: true }) }
}

/**
 * Load applied values before opening a database or listener; desired values never take effect here.
 * @param environment - process launcher configuration containing the stable config-file location.
 * @returns an explicit effective environment with the configuration revision for health verification.
 */
export async function loadManagedNodeEnvironment(environment: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const file = nodeConfigurationFile(environment), record = await readNodeConfiguration(file, environment)
  if (record === undefined) return { ...environment, HGW_NODE_CONFIG_FILE: file, HGW_NODE_CONFIG_REVISION: '0' }
  if (record.organizationSlug !== (environment.HGW_ORGANIZATION_SLUG ?? 'default')
    || record.nodeName !== (environment.HGW_COMPUTE_NODE_NAME ?? 'local')) throw new NodeConfigurationError(409, 'node-configuration-bootstrap-identity-mismatch')
  const effective: NodeJS.ProcessEnv = { ...environment, ...record.applied, HGW_NODE_CONFIG_FILE: file, HGW_NODE_CONFIG_REVISION: String(record.appliedRevision) }
  if (record.applied.HGW_DATABASE_URL_FILE !== '') delete effective.HGW_DATABASE_URL
  return effective
}

/** Admin edits remain node-bound and cannot publish over a newer revision or an in-flight apply. */
export class NodeConfigurationStore {
  private readonly identity: NodeConfigurationIdentity
  private readonly effective: NodeSettingValues
  private readonly runningRevision: number
  /**
   * @param identity - server-confirmed organization and node.
   * @param cfg - configuration of this running process.
   * @param environment - effective process environment.
   * @param authority - exclusion shared with backups/restores and fresh write-epoch capture.
   */
  constructor(
    identity: NodeConfigurationIdentity,
    private readonly cfg: GatewayConfig,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly authority: NodeConfigurationMutationAuthority,
  ) {
    this.identity = { organizationId: identity.organizationId, nodeId: identity.nodeId }
    this.effective = nodeSettingsFromConfig(cfg, environment)
    this.runningRevision = Number(environment.HGW_NODE_CONFIG_REVISION ?? '0')
  }

  /** Initialize a private file without replacing an existing node's configuration. */
  async initialize(): Promise<void> {
    await mkdir(dirname(this.cfg.nodeConfigFile), { recursive: true, mode: 0o700 })
    const existing = await readNodeConfiguration(this.cfg.nodeConfigFile, this.environment)
    if (existing !== undefined) { this.assertIdentity(existing); return }
    await this.authority.run(signal => withFileLock(this.cfg.nodeConfigFile, async () => {
      const raced = await readNodeConfiguration(this.cfg.nodeConfigFile, this.environment)
      if (raced !== undefined) { this.assertIdentity(raced); return }
      // Database passwords remain in their existing private file, never this record.
      const initial = parseNodeSettingValues(this.effective, this.environment)
      await writeNodeConfiguration(this.cfg.nodeConfigFile, { version: 1, ...this.identity,
        organizationSlug: this.cfg.organizationSlug, nodeName: this.cfg.computeNodeName,
        revision: 0, appliedRevision: 0, desired: initial, applied: initial, previous: null, operation: null }, signal)
    }))
  }

  private assertIdentity(identity: NodeConfigurationIdentity): void {
    if (identity.organizationId !== this.identity.organizationId || identity.nodeId !== this.identity.nodeId) throw new NodeConfigurationError(409, 'node-configuration-identity-mismatch')
  }

  private async read(): Promise<NodeConfigurationRecord> {
    const record = await readNodeConfiguration(this.cfg.nodeConfigFile, this.environment)
    if (record === undefined) throw new NodeConfigurationError(409, 'node-configuration-file-missing')
    this.assertIdentity(record)
    return record
  }

  /** Return desired values together with the actual values of this serving process. */
  async view(): Promise<NodeConfigurationView> {
    const record = await this.read()
    return { ...this.identity, revision: record.revision, runningRevision: this.runningRevision,
      appliedRevision: record.appliedRevision, desired: record.desired, effective: this.effective,
      operation: record.operation, configFile: this.cfg.nodeConfigFile }
  }

  /**
   * Save a validated revision without applying it or restarting any process.
   * @param identity - node and organization shown to the editor.
   * @param expectedRevision - revision read before editing.
   * @param values - untrusted settings payload.
   * @returns the persisted candidate and unchanged effective values.
   */
  async save(identity: NodeConfigurationIdentity, expectedRevision: number, values: unknown): Promise<NodeConfigurationView> {
    this.assertIdentity(identity)
    const desired = parseNodeSettingValues(values, this.environment)
    await this.authority.run(signal => withFileLock(this.cfg.nodeConfigFile, async () => {
      const record = await this.read()
      if (record.revision !== expectedRevision) throw new NodeConfigurationError(409, 'node-configuration-revision-conflict')
      if (record.operation?.status === 'pending' || record.operation?.status === 'applying') throw new NodeConfigurationError(409, 'node-configuration-apply-in-progress')
      record.revision += 1
      record.desired = desired
      await writeNodeConfiguration(this.cfg.nodeConfigFile, record, signal)
    }))
    return this.view()
  }

  /**
   * Queue an explicit application of exactly one saved revision.
   * @param identity - reviewed node and organization.
   * @param expectedRevision - reviewed configuration revision.
   * @param actor - authenticated administrator public ID.
   * @returns the queued request bound to the current database write epoch.
   */
  async requestApply(identity: NodeConfigurationIdentity, expectedRevision: number, actor: number): Promise<NodeConfigurationView> {
    this.assertIdentity(identity)
    await this.authority.run(signal => withFileLock(this.cfg.nodeConfigFile, async () => {
      const record = await this.read()
      if (record.revision !== expectedRevision) throw new NodeConfigurationError(409, 'node-configuration-revision-conflict')
      if (record.operation?.status === 'pending' || record.operation?.status === 'applying') throw new NodeConfigurationError(409, 'node-configuration-apply-in-progress')
      if (record.revision === record.appliedRevision) throw new NodeConfigurationError(409, 'node-configuration-already-applied')
      record.operation = { id: randomUUID(), revision: record.revision, writeEpoch: await this.authority.writeEpoch(), actor, status: 'pending', requestedAt: new Date().toISOString(), error: null }
      await writeNodeConfiguration(this.cfg.nodeConfigFile, record, signal)
    }))
    return this.view()
  }
}
