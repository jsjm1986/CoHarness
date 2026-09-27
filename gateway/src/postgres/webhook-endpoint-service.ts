/** Administrator-registered webhook endpoints with encrypted signing secrets. */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { transaction } from './database.ts'
import type { PoolClient } from 'pg'
import type { PostgresRuntimeContext } from './runtime-context.ts'
import { REPLAY_WINDOW_LIMIT_MS } from './webhook-delivery-service.ts'

/** Dispatch POST read limit enforced by the managed runtime; bounds intake bodies and pre-send payloads. */
export const DISPATCH_BODY_LIMIT = 1_048_576
/** Public endpoint view; the signing secret is write-only and never leaves the service. */
export interface WebhookEndpointView {
  id: string
  publicId: number
  name: string
  provider: 'github'
  source: string
  events: string[]
  actions: string[]
  repositories: string[]
  titleTemplate: string
  promptTemplate: string
  workspacePath: string
  agentPreset: string
  permissionPreset: string
  modelProvider: string | null
  modelId: string | null
  modelMaxTokens: number | null
  executionUserId: number
  runtimeKind: 'user' | 'project'
  runtimePublicId: number
  intakeLimit: number
  intakeWindowMs: number
  replayWindowMs: number
  maxBodyBytes: number
  enabled: boolean
  revision: string
}

/** Intake-resolved endpoint including the decrypted signing secret. */
export interface WebhookIntakeConfig {
  endpointId: string
  endpointPublicId: number
  provider: 'github'
  source: string
  events: string[]
  actions: string[]
  repositories: string[]
  titleTemplate: string
  promptTemplate: string
  workspacePath: string
  agentPreset: string
  permissionPreset: string
  modelProvider: string | null
  modelId: string | null
  modelMaxTokens: number | null
  executionUserUuid: string
  executionUserId: number
  runtimeKind: 'user' | 'project'
  runtimePublicId: number
  intakeLimit: number
  intakeWindowMs: number
  replayWindowMs: number
  maxBodyBytes: number
  revision: string
  secret: string
}

/** A registration, update, or intake request was invalid or addressed a missing row. */
export class WebhookEndpointError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message) }
}

function isCodedError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
}

const REVISION = /^(0|[1-9][0-9]{0,18})$/u
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16

/** AES-256-GCM with endpoint-bound AAD; the deployment key file is shared with model credentials. */
export class WebhookSecretCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('webhook secret key must be 32 bytes')
  }

  private aad(organizationId: string, endpointId: string): Buffer {
    return Buffer.from(`dsh-webhook-endpoint\0${organizationId}\0${endpointId}\0v1`, 'utf8')
  }

  /** Encrypt one non-empty signing secret for its owning endpoint. */
  encrypt(organizationId: string, endpointId: string, value: string) {
    if (value.length === 0) throw new Error('webhook signing secret must not be empty')
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: AUTH_TAG_BYTES })
    cipher.setAAD(this.aad(organizationId, endpointId))
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return { keyVersion: 1, nonce, ciphertext, authTag: cipher.getAuthTag() }
  }

  /** Decrypt one stored secret after authenticating its owning endpoint. */
  decrypt(organizationId: string, endpointId: string,
    encrypted: { keyVersion: number; nonce: Buffer; ciphertext: Buffer; authTag: Buffer }): string {
    if (encrypted.keyVersion !== 1) throw new Error(`unsupported webhook secret key version ${String(encrypted.keyVersion)}`)
    const decipher = createDecipheriv('aes-256-gcm', this.key, encrypted.nonce, { authTagLength: AUTH_TAG_BYTES })
    decipher.setAAD(this.aad(organizationId, endpointId))
    decipher.setAuthTag(encrypted.authTag)
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString('utf8')
  }
}

const boundedText = (max: number) => z.string().min(1).max(max)
const names = z.array(z.string().min(1).max(128)).max(64)
/** Structured `owner/repo` full name; GitHub matching compares case-insensitively. */
const repositoryName = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)

const fields = z.object({
  name: boundedText(128),
  provider: z.literal('github'),
  source: boundedText(128),
  events: names,
  actions: names,
  repositories: z.array(repositoryName).max(64),
  titleTemplate: boundedText(512),
  promptTemplate: boundedText(16_384),
  workspacePath: boundedText(1024),
  agentPreset: boundedText(128),
  permissionPreset: boundedText(128),
  modelProvider: boundedText(128).nullish(),
  modelId: boundedText(256).nullish(),
  modelMaxTokens: z.number().int().positive().nullish(),
  executionUserId: z.number().int().positive(),
  runtimeKind: z.enum(['user', 'project']),
  runtimePublicId: z.number().int().positive(),
  intakeLimit: z.number().int().min(1).max(1_000_000),
  intakeWindowMs: z.number().int().min(1).max(86_400_000),
  replayWindowMs: z.number().int().min(1).max(REPLAY_WINDOW_LIMIT_MS),
  maxBodyBytes: z.number().int().min(1).max(DISPATCH_BODY_LIMIT),
}).strict().refine(value => (value.modelProvider == null) === (value.modelId == null),
  { message: 'model provider and model id must be supplied together' })

const createInput = fields.extend({ secret: boundedText(4096) })
const updateInput = z.object({ targetId: z.number().int().positive(), revision: z.string().regex(REVISION) })
  .extend({ fields, secret: boundedText(4096).optional() }).strict()
const mutateInput = z.object({ targetId: z.number().int().positive(), revision: z.string().regex(REVISION),
  action: z.enum(['enable', 'disable', 'remove']) }).strict()

interface EndpointRow {
  id: string
  public_id: string
  name: string
  provider: string
  source: string
  events: string[]
  actions: string[]
  repositories: string[]
  title_template: string
  prompt_template: string
  workspace_path: string
  agent_preset: string
  permission_preset: string
  model_provider: string | null
  model_id: string | null
  model_max_tokens: number | null
  execution_user_id: string
  execution_user_public_id: string
  runtime_kind: 'user' | 'project'
  runtime_public_id: string
  intake_limit: number
  intake_window_ms: string
  replay_window_ms: string
  max_body_bytes: number
  key_version: number
  nonce: Buffer
  ciphertext: Buffer
  auth_tag: Buffer
  enabled: boolean
  revision: string
}

const columns = `e.id,e.public_id::text,e.name,e.provider,e.source,e.events,e.actions,e.repositories,
  e.title_template,e.prompt_template,e.workspace_path,e.agent_preset,e.permission_preset,
  e.model_provider,e.model_id,e.model_max_tokens,e.execution_user_id,u.public_id::text execution_user_public_id,
  e.runtime_kind,e.runtime_public_id::text,e.intake_limit,e.intake_window_ms::text,e.replay_window_ms::text,
  e.max_body_bytes,e.key_version,e.nonce,e.ciphertext,e.auth_tag,e.enabled,e.revision::text`
const from = `FROM harness.webhook_endpoints e
  JOIN harness.users u ON u.organization_id=e.organization_id AND u.id=e.execution_user_id`

function view(row: EndpointRow): WebhookEndpointView {
  return {
    id: row.id, publicId: Number(row.public_id), name: row.name, provider: 'github', source: row.source,
    events: row.events, actions: row.actions, repositories: row.repositories,
    titleTemplate: row.title_template,
    promptTemplate: row.prompt_template, workspacePath: row.workspace_path,
    agentPreset: row.agent_preset, permissionPreset: row.permission_preset,
    modelProvider: row.model_provider, modelId: row.model_id, modelMaxTokens: row.model_max_tokens,
    executionUserId: Number(row.execution_user_public_id),
    runtimeKind: row.runtime_kind, runtimePublicId: Number(row.runtime_public_id),
    intakeLimit: row.intake_limit, intakeWindowMs: Number(row.intake_window_ms),
    replayWindowMs: Number(row.replay_window_ms), maxBodyBytes: row.max_body_bytes,
    enabled: row.enabled, revision: row.revision,
  }
}

function intake(row: EndpointRow, secret: string): WebhookIntakeConfig {
  return {
    endpointId: row.id, endpointPublicId: Number(row.public_id), provider: 'github',
    source: row.source, events: row.events, actions: row.actions, repositories: row.repositories,
    titleTemplate: row.title_template, promptTemplate: row.prompt_template, workspacePath: row.workspace_path,
    agentPreset: row.agent_preset, permissionPreset: row.permission_preset,
    modelProvider: row.model_provider, modelId: row.model_id, modelMaxTokens: row.model_max_tokens,
    executionUserUuid: row.execution_user_id, executionUserId: Number(row.execution_user_public_id),
    runtimeKind: row.runtime_kind, runtimePublicId: Number(row.runtime_public_id),
    intakeLimit: row.intake_limit, intakeWindowMs: Number(row.intake_window_ms),
    replayWindowMs: Number(row.replay_window_ms), maxBodyBytes: row.max_body_bytes,
    revision: row.revision, secret,
  }
}

/** Endpoint registration, rotation, and intake resolution; deliveries live in {@link PostgresWebhookDeliveryService}. */
export class PostgresWebhookEndpointService {
  constructor(private readonly context: PostgresRuntimeContext, private readonly cipher: WebhookSecretCipher) {}

  /** Run one transaction, translating a raced name uniqueness violation into a conflict. */
  private async run<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await transaction(this.context.pool, work)
    } catch (error) {
      if (isCodedError(error) && error.code === '23505') {
        throw new WebhookEndpointError(409, 'webhook endpoint name is already registered')
      }
      throw error
    }
  }

  /** @returns every registered endpoint without secret material, ordered by name. */
  async list(): Promise<WebhookEndpointView[]> {
    const rows = await this.context.pool.query<EndpointRow>(
      `SELECT ${columns} ${from} WHERE e.organization_id=$1 ORDER BY e.name,e.public_id`, [this.context.organizationId])
    return rows.rows.map(view)
  }

  /**
   * Register one endpoint, validating the execution account and runtime target exist.
   * New endpoints start disabled; an administrator enables intake explicitly via {@link mutate}.
   * @param adminPublicId - administrator creating the record.
   * @param input - structured rule, target, limits, and the signing secret.
   * @returns the created endpoint view.
   */
  async create(adminPublicId: number, input: unknown): Promise<WebhookEndpointView> {
    const parsed = createInput.safeParse(input)
    if (!parsed.success) throw new WebhookEndpointError(400, 'invalid webhook endpoint')
    const value = parsed.data
    return this.run(async client => {
      await this.requireRuntimeTarget(client, value.runtimeKind, value.runtimePublicId)
      const user = await client.query<{ id: string }>(
        `SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2 AND status='active' AND deleted_at IS NULL`,
        [this.context.organizationId, value.executionUserId])
      if (user.rows[0] === undefined) throw new WebhookEndpointError(400, 'webhook execution account not found')
      const duplicate = await client.query(
        'SELECT 1 FROM harness.webhook_endpoints WHERE organization_id=$1 AND name=$2',
        [this.context.organizationId, value.name])
      if (duplicate.rowCount !== 0) throw new WebhookEndpointError(409, 'webhook endpoint name is already registered')
      const admin = await client.query<{ id: string }>(
        'SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',
        [this.context.organizationId, adminPublicId])
      const id = randomUUID()
      const secret = this.cipher.encrypt(this.context.organizationId, id, value.secret)
      const inserted = await client.query<{ public_id: string }>(`INSERT INTO harness.webhook_endpoints
        (id,organization_id,name,provider,source,events,actions,repositories,title_template,prompt_template,workspace_path,
          agent_preset,permission_preset,model_provider,model_id,model_max_tokens,execution_user_id,
          runtime_kind,runtime_public_id,intake_limit,intake_window_ms,replay_window_ms,max_body_bytes,
          key_version,nonce,ciphertext,auth_tag,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
        RETURNING public_id::text`,
      [id, this.context.organizationId, value.name, value.provider, value.source, value.events, value.actions,
        value.repositories, value.titleTemplate, value.promptTemplate, value.workspacePath, value.agentPreset,
        value.permissionPreset,
        value.modelProvider ?? null, value.modelId ?? null, value.modelMaxTokens ?? null, user.rows[0].id,
        value.runtimeKind, value.runtimePublicId, value.intakeLimit, value.intakeWindowMs, value.replayWindowMs,
        value.maxBodyBytes, secret.keyVersion, secret.nonce, secret.ciphertext, secret.authTag,
        admin.rows[0]?.id ?? null])
      const created = await client.query<EndpointRow>(
        `SELECT ${columns} ${from} WHERE e.organization_id=$1 AND e.public_id=$2`,
        [this.context.organizationId, inserted.rows[0]!.public_id])
      return view(created.rows[0]!)
    })
  }

  /**
   * Replace an endpoint's configuration only when the submitted revision is current.
   * A present `secret` rotates the signing key; receipts keep their identity across rotation.
   * @param input - public endpoint id, observed revision, new fields, and optional new secret.
   * @returns the updated endpoint view.
   */
  async update(input: unknown): Promise<WebhookEndpointView> {
    const parsed = updateInput.safeParse(input)
    if (!parsed.success) throw new WebhookEndpointError(400, 'invalid webhook endpoint update')
    const { targetId, revision, fields: value, secret } = parsed.data
    return this.run(async client => {
      const current = await client.query<{ id: string; revision: string }>(
        `SELECT id,revision::text FROM harness.webhook_endpoints WHERE organization_id=$1 AND public_id=$2 FOR UPDATE`,
        [this.context.organizationId, targetId])
      const row = current.rows[0]
      if (row === undefined) throw new WebhookEndpointError(404, 'webhook endpoint not found')
      if (row.revision !== revision) throw new WebhookEndpointError(409, 'webhook endpoint changed; reload before saving')
      const renamed = await client.query(
        'SELECT 1 FROM harness.webhook_endpoints WHERE organization_id=$1 AND name=$2 AND public_id<>$3',
        [this.context.organizationId, value.name, targetId])
      if (renamed.rowCount !== 0) throw new WebhookEndpointError(409, 'webhook endpoint name is already registered')
      await this.requireRuntimeTarget(client, value.runtimeKind, value.runtimePublicId)
      const user = await client.query<{ id: string }>(
        `SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2 AND status='active' AND deleted_at IS NULL`,
        [this.context.organizationId, value.executionUserId])
      if (user.rows[0] === undefined) throw new WebhookEndpointError(400, 'webhook execution account not found')
      const rotated = secret === undefined ? null : this.cipher.encrypt(this.context.organizationId, row.id, secret)
      await client.query(`UPDATE harness.webhook_endpoints SET
        name=$3,provider=$4,source=$5,events=$6,actions=$7,repositories=$8,title_template=$9,prompt_template=$10,
        workspace_path=$11,
        agent_preset=$12,permission_preset=$13,model_provider=$14,model_id=$15,model_max_tokens=$16,
        execution_user_id=$17,runtime_kind=$18,runtime_public_id=$19,intake_limit=$20,intake_window_ms=$21,
        replay_window_ms=$22,max_body_bytes=$23,
        key_version=COALESCE($24,key_version),nonce=COALESCE($25,nonce),
        ciphertext=COALESCE($26,ciphertext),auth_tag=COALESCE($27,auth_tag),
        revision=revision+1,updated_at=clock_timestamp()
        WHERE organization_id=$1 AND public_id=$2`,
      [this.context.organizationId, targetId, value.name, value.provider, value.source, value.events,
        value.actions, value.repositories, value.titleTemplate, value.promptTemplate, value.workspacePath,
        value.agentPreset,
        value.permissionPreset, value.modelProvider ?? null, value.modelId ?? null, value.modelMaxTokens ?? null,
        user.rows[0].id, value.runtimeKind, value.runtimePublicId, value.intakeLimit, value.intakeWindowMs,
        value.replayWindowMs, value.maxBodyBytes,
        rotated?.keyVersion ?? null, rotated?.nonce ?? null, rotated?.ciphertext ?? null, rotated?.authTag ?? null])
      const updated = await client.query<EndpointRow>(
        `SELECT ${columns} ${from} WHERE e.organization_id=$1 AND e.public_id=$2`,
        [this.context.organizationId, targetId])
      return view(updated.rows[0]!)
    })
  }

  /**
   * Enable, disable, or remove one endpoint under its observed revision.
   * @param input - public endpoint id, observed revision, and the requested mutation.
   * @returns the updated view, or null after removal.
   */
  async mutate(input: unknown): Promise<WebhookEndpointView | null> {
    const parsed = mutateInput.safeParse(input)
    if (!parsed.success) throw new WebhookEndpointError(400, 'invalid webhook endpoint mutation')
    const { targetId, revision, action } = parsed.data
    return this.run(async client => {
      const current = await client.query<{ revision: string }>(
        'SELECT revision::text FROM harness.webhook_endpoints WHERE organization_id=$1 AND public_id=$2 FOR UPDATE',
        [this.context.organizationId, targetId])
      const row = current.rows[0]
      if (row === undefined) throw new WebhookEndpointError(404, 'webhook endpoint not found')
      if (row.revision !== revision) throw new WebhookEndpointError(409, 'webhook endpoint changed; reload before saving')
      if (action === 'remove') {
        await client.query('DELETE FROM harness.webhook_endpoints WHERE organization_id=$1 AND public_id=$2',
          [this.context.organizationId, targetId])
        return null
      }
      await client.query(`UPDATE harness.webhook_endpoints SET enabled=$3,
        revision=revision+1,updated_at=clock_timestamp() WHERE organization_id=$1 AND public_id=$2`,
        [this.context.organizationId, targetId, action === 'enable'])
      const updated = await client.query<EndpointRow>(
        `SELECT ${columns} ${from} WHERE e.organization_id=$1 AND e.public_id=$2`,
        [this.context.organizationId, targetId])
      return view(updated.rows[0]!)
    })
  }

  /**
   * Resolve one enabled endpoint for intake, decrypting its signing secret.
   * @param publicId - endpoint public id carried by the intake route.
   * @returns the intake configuration, or an error when missing or disabled.
   */
  async intake(publicId: unknown): Promise<WebhookIntakeConfig> {
    const parsed = z.number().int().positive().safeParse(publicId)
    if (!parsed.success) throw new WebhookEndpointError(404, 'webhook endpoint not found')
    const rows = await this.context.pool.query<EndpointRow>(
      `SELECT ${columns} ${from} WHERE e.organization_id=$1 AND e.public_id=$2`,
      [this.context.organizationId, parsed.data])
    const row = rows.rows[0]
    if (row === undefined || !row.enabled) throw new WebhookEndpointError(404, 'webhook endpoint not found')
    return intake(row, this.cipher.decrypt(this.context.organizationId, row.id, {
      keyVersion: row.key_version, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag,
    }))
  }

  /**
   * Resolve an endpoint by its durable id for administrator redispatch; the
   * signing secret is irrelevant when replaying a stored verified event.
   * @param endpointId - receipt-owned endpoint UUID.
   * @returns the current dispatch configuration.
   */
  async dispatchConfig(endpointId: unknown): Promise<Omit<WebhookIntakeConfig, 'secret'>> {
    const parsed = z.uuid().safeParse(endpointId)
    if (!parsed.success) throw new WebhookEndpointError(400, 'invalid webhook endpoint id')
    const rows = await this.context.pool.query<EndpointRow>(
      `SELECT ${columns} ${from} WHERE e.organization_id=$1 AND e.id=$2`,
      [this.context.organizationId, parsed.data])
    const row = rows.rows[0]
    if (row === undefined) throw new WebhookEndpointError(404, 'webhook endpoint not found')
    const { secret: _secret, ...config } = intake(row, '')
    return config
  }

  /** Validate that the runtime target owner exists inside this organization. */
  private async requireRuntimeTarget(
    client: { query: (text: string, values: unknown[]) => Promise<{ rowCount: number | null }> },
    kind: 'user' | 'project', publicId: number,
  ): Promise<void> {
    const found = kind === 'user'
      ? await client.query(
        `SELECT 1 FROM harness.users WHERE organization_id=$1 AND public_id=$2 AND status='active' AND deleted_at IS NULL`,
        [this.context.organizationId, publicId])
      : await client.query(
        `SELECT 1 FROM harness.projects WHERE organization_id=$1 AND public_id=$2 AND status='active'`,
        [this.context.organizationId, publicId])
    if (found.rowCount !== 1) throw new WebhookEndpointError(400, 'webhook runtime target not found')
  }
}
