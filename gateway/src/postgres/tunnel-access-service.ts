/**
 * Durable row for this node's public-access tunnel: what the administrator
 * asked for (`desired`), what was last observed (`state`), and the encrypted
 * Cloudflare credentials a named tunnel needs to resume after a restart.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { PostgresRuntimeContext } from './runtime-context.ts'

const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16

/** AES-256-GCM with tunnel-bound AAD; the deployment key file is shared with model credentials. */
export class TunnelCredentialCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('tunnel credential key must be 32 bytes')
  }

  private aad(organizationId: string, nodeId: string, field: string): Buffer {
    return Buffer.from(`dsh-tunnel-access\0${organizationId}\0${nodeId}\0${field}\0v1`, 'utf8')
  }

  /** Encrypt one non-empty secret for this node's tunnel row. */
  encrypt(organizationId: string, nodeId: string, field: string, value: string): Buffer {
    if (value.length === 0) throw new Error('tunnel credential must not be empty')
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: AUTH_TAG_BYTES })
    cipher.setAAD(this.aad(organizationId, nodeId, field))
    return Buffer.concat([nonce, cipher.getAuthTag(), cipher.update(value, 'utf8'), cipher.final()])
  }

  /** Decrypt one stored secret after authenticating the node's tunnel row. */
  decrypt(organizationId: string, nodeId: string, field: string, packed: Buffer): string {
    if (packed.length < NONCE_BYTES + AUTH_TAG_BYTES + 1) {
      throw new Error('tunnel credential ciphertext is truncated')
    }
    const nonce = packed.subarray(0, NONCE_BYTES)
    const authTag = packed.subarray(NONCE_BYTES, NONCE_BYTES + AUTH_TAG_BYTES)
    const ciphertext = packed.subarray(NONCE_BYTES + AUTH_TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce, { authTagLength: AUTH_TAG_BYTES })
    decipher.setAAD(this.aad(organizationId, nodeId, field))
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  }
}

export type TunnelMode = 'off' | 'quick' | 'named'
export type TunnelDesired = 'stopped' | 'running'
export type TunnelState = 'stopped' | 'starting' | 'running' | 'error'

/** The persisted tunnel row; ciphertext fields stay opaque to callers. */
export interface TunnelAccessRow {
  mode: TunnelMode
  desired: TunnelDesired
  state: TunnelState
  publicUrl: string | null
  hostname: string | null
  domain: string | null
  zoneId: string | null
  accountId: string | null
  tunnelId: string | null
  apiTokenCipher: Buffer | null
  runTokenCipher: Buffer | null
  lastError: string | null
  revision: number
  startedAt: string | null
  updatedAt: string
}

interface Row {
  mode: TunnelMode
  desired: TunnelDesired
  state: TunnelState
  public_url: string | null
  hostname: string | null
  domain: string | null
  zone_id: string | null
  account_id: string | null
  tunnel_id: string | null
  api_token_cipher: Buffer | null
  run_token_cipher: Buffer | null
  last_error: string | null
  revision: string
  started_at: string | null
  updated_at: string
}

const COLUMNS = `mode,desired,state,public_url,hostname,domain,zone_id,account_id,tunnel_id,
  api_token_cipher,run_token_cipher,last_error,revision::text,started_at::text,updated_at::text`

function view(row: Row): TunnelAccessRow {
  return {
    mode: row.mode,
    desired: row.desired,
    state: row.state,
    publicUrl: row.public_url,
    hostname: row.hostname,
    domain: row.domain,
    zoneId: row.zone_id,
    accountId: row.account_id,
    tunnelId: row.tunnel_id,
    apiTokenCipher: row.api_token_cipher,
    runTokenCipher: row.run_token_cipher,
    lastError: row.last_error,
    revision: Number(row.revision),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  }
}

/** Read-modify-write access to the node's single tunnel_access row. */
export class PostgresTunnelAccessStore {
  constructor(private readonly context: PostgresRuntimeContext) {}

  /** Read the node's row, creating the `off` default when it has never been configured. */
  async get(): Promise<TunnelAccessRow> {
    const result = await this.context.pool.query<Row>(
      `INSERT INTO harness.tunnel_access (organization_id,node_id) VALUES ($1,$2)
       ON CONFLICT (organization_id,node_id) DO NOTHING`, [this.context.organizationId, this.context.nodeId])
    void result
    const row = await this.context.pool.query<Row>(
      `SELECT ${COLUMNS} FROM harness.tunnel_access WHERE organization_id=$1 AND node_id=$2`,
      [this.context.organizationId, this.context.nodeId])
    return view(row.rows[0] as Row)
  }

  /** Apply a field patch and bump the optimistic-concurrency revision. */
  async update(patch: Partial<Pick<Row,
    'mode' | 'desired' | 'state' | 'public_url' | 'hostname' | 'domain' | 'zone_id' | 'account_id' | 'tunnel_id' |
    'api_token_cipher' | 'run_token_cipher' | 'last_error' | 'started_at'>>): Promise<TunnelAccessRow> {
    const entries = Object.entries(patch)
    if (entries.length === 0) return this.get()
    const assignments = entries.map(([key], index) => `${key}=$${index + 3}`).join(',')
    const values = entries.map(([, value]) => value)
    const result = await this.context.pool.query<Row>(
      `UPDATE harness.tunnel_access SET ${assignments},revision=revision+1,updated_at=now()
       WHERE organization_id=$1 AND node_id=$2 RETURNING ${COLUMNS}`,
      [this.context.organizationId, this.context.nodeId, ...values])
    if (result.rows[0] === undefined) throw new Error('tunnel_access row missing after update')
    return view(result.rows[0])
  }
}
