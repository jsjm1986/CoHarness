import { readFile } from 'node:fs/promises'
import { GoogleAuth } from 'google-auth-library'
import type { Pool } from 'pg'
import type { GatewayConfig } from './config.ts'
import { internalUserId, type PostgresRuntimeContext } from './postgres/runtime-context.ts'

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const FCM_ENDPOINT = 'https://fcm.googleapis.com/v1/projects'
const PUSH_CHANNEL_ID = 'ai-replies'

/** Android device registration accepted by the authenticated account API. */
export interface PushDeviceRegistration {
  token: string
  platform: 'android'
  deviceId?: string
  appVersion?: string
}

/** Push capability consumed by the Gateway HTTP and runtime handlers. */
export interface GatewayPushService {
  /** Register or refresh one device for the authenticated user. */
  registerDevice(userId: number, input: PushDeviceRegistration): Promise<{ id: string }>
  /** Remove a device owned by the authenticated user. */
  removeDevice(userId: number, deviceId: string): Promise<boolean>
  /** Notify the conversation creator after a durable completed turn. */
  notifyCompleted(sessionId: string, eventSeq: number): Promise<void>
}

interface PushSender {
  send(input: { token: string; sessionId: string; eventSeq: number }): Promise<void>
}

interface AccessTokenClient {
  getAccessToken(): Promise<{ token?: string | null }>
}

interface ServiceAccount {
  projectId?: string
  clientEmail: string
  privateKey: string
}

interface DeviceRow {
  id: string
  token: string
}

class FcmSendError extends Error {
  constructor(message: string, readonly invalidToken: boolean) {
    super(message)
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function serviceAccount(value: unknown): ServiceAccount {
  const row = object(value)
  const clientEmail = nonEmptyString(row?.client_email)
  const privateKey = nonEmptyString(row?.private_key)
  const projectId = nonEmptyString(row?.project_id)
  if (clientEmail === undefined || privateKey === undefined) {
    throw new Error('FCM service-account JSON must contain client_email and private_key')
  }
  return { clientEmail, privateKey, ...(projectId === undefined ? {} : { projectId }) }
}

/** FCM HTTP v1 sender backed by a Google service account. */
export class FcmHttpV1Sender implements PushSender {
  private clientPromise: Promise<AccessTokenClient> | undefined
  private accountPromise: Promise<ServiceAccount> | undefined

  constructor(
    private readonly projectId: string | undefined,
    private readonly serviceAccountFile: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async send(input: { token: string; sessionId: string; eventSeq: number }): Promise<void> {
    const account = await this.loadAccount()
    const projectId = this.projectId ?? account.projectId
    if (projectId === undefined) throw new Error('FCM project id is not configured')
    const client = await this.loadClient(account)
    const accessToken = (await client.getAccessToken()).token
    if (accessToken === undefined || accessToken === null || accessToken === '') {
      throw new Error('FCM access token was empty')
    }
    const response = await this.request(
      `${FCM_ENDPOINT}/${encodeURIComponent(projectId)}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: input.token,
            notification: {
              title: 'AI 回复完成',
              body: '点击查看回复',
            },
            data: {
              sessionId: input.sessionId,
              eventSeq: String(input.eventSeq),
            },
            android: {
              notification: { channelId: PUSH_CHANNEL_ID },
            },
          },
        }),
      },
    )
    if (response.ok) return
    const body = await response.text()
    let code: string | undefined
    try {
      const parsed = object(JSON.parse(body))
      const error = object(parsed?.error)
      code = nonEmptyString(error?.status)
    } catch {
      // The status code is enough for diagnostics when FCM does not return JSON.
    }
    const invalidToken = response.status === 404 || code === 'UNREGISTERED'
      || (code === 'INVALID_ARGUMENT' && /token/i.test(body))
    throw new FcmSendError(`FCM send failed with HTTP ${String(response.status)}`, invalidToken)
  }

  private async loadAccount(): Promise<ServiceAccount> {
    this.accountPromise ??= readFile(this.serviceAccountFile, 'utf8')
      .then(raw => serviceAccount(JSON.parse(raw) as unknown))
    return this.accountPromise
  }

  private async loadClient(account: ServiceAccount): Promise<AccessTokenClient> {
    this.clientPromise ??= Promise.resolve(new GoogleAuth({
      credentials: {
        client_email: account.clientEmail,
        private_key: account.privateKey,
      },
      scopes: [FCM_SCOPE],
    }).getClient()).then(client => client as AccessTokenClient)
    return this.clientPromise
  }
}

class DisabledPushSender implements PushSender {
  async send(_input: { token: string; sessionId: string; eventSeq: number }): Promise<void> {}
}

function senderFor(cfg: GatewayConfig, request: typeof fetch): PushSender {
  if (cfg.fcmServiceAccountFile === undefined) return new DisabledPushSender()
  return new FcmHttpV1Sender(cfg.fcmProjectId, cfg.fcmServiceAccountFile, request)
}

/** PostgreSQL-backed device registry and idempotent FCM delivery service. */
export class PostgresPushService implements GatewayPushService {
  private readonly sender: PushSender

  constructor(
    private readonly context: Pick<PostgresRuntimeContext, 'pool' | 'organizationId'>,
    cfg: GatewayConfig,
    request: typeof fetch = fetch,
    sender?: PushSender,
  ) {
    this.sender = sender ?? senderFor(cfg, request)
  }

  async registerDevice(userId: number, input: PushDeviceRegistration): Promise<{ id: string }> {
    const internalId = await internalUserId(this.context.pool, this.context.organizationId, userId)
    if (internalId === null) throw new Error('user-not-found')
    const result = await this.context.pool.query<{ id: string }>(`INSERT INTO harness.push_devices(
      organization_id,user_id,token,platform,device_id,app_version,updated_at,last_seen_at
    ) VALUES($1,$2,$3,$4,$5,$6,now(),now())
    ON CONFLICT (organization_id,token) DO UPDATE SET
      user_id=EXCLUDED.user_id,platform=EXCLUDED.platform,device_id=EXCLUDED.device_id,
      app_version=EXCLUDED.app_version,updated_at=now(),last_seen_at=now()
    RETURNING id::text`, [
      this.context.organizationId,
      internalId,
      input.token,
      input.platform,
      input.deviceId ?? null,
      input.appVersion ?? null,
    ])
    const row = result.rows[0]
    if (row === undefined) throw new Error('push-device-registration-failed')
    return { id: row.id }
  }

  async removeDevice(userId: number, deviceId: string): Promise<boolean> {
    const internalId = await internalUserId(this.context.pool, this.context.organizationId, userId)
    if (internalId === null) return false
    const result = await this.context.pool.query(`DELETE FROM harness.push_devices
      WHERE organization_id=$1 AND id=$2 AND user_id=$3`, [
      this.context.organizationId, deviceId, internalId,
    ])
    return result.rowCount === 1
  }

  async notifyCompleted(sessionId: string, eventSeq: number): Promise<void> {
    const recipient = await this.context.pool.query<{ organization_id: string; user_id: string }>(`SELECT
      c.organization_id,c.creator_user_id user_id
      FROM harness.conversation_sessions c
      WHERE c.id=$1 AND c.organization_id=$2 AND c.status<>'deleted'`,
    [sessionId, this.context.organizationId])
    const owner = recipient.rows[0]
    if (owner === undefined) return
    const devices = await this.context.pool.query<DeviceRow>(`SELECT id::text,token
      FROM harness.push_devices
      WHERE organization_id=$1 AND user_id=$2
      ORDER BY updated_at DESC`, [owner.organization_id, owner.user_id])
    for (const device of devices.rows) {
      const claimed = await this.context.pool.query<{ device_id: string }>(`INSERT INTO harness.push_deliveries(
        organization_id,session_id,event_seq,device_id,status,attempts
      ) VALUES($1,$2,$3,$4,'pending',1)
      ON CONFLICT (organization_id,session_id,event_seq,device_id) DO UPDATE SET
        status='pending',attempts=harness.push_deliveries.attempts+1,updated_at=now()
      WHERE harness.push_deliveries.status<>'sent'
      RETURNING device_id::text`, [
        owner.organization_id, sessionId, eventSeq, device.id,
      ])
      if (claimed.rows[0] === undefined) continue
      try {
        await this.sender.send({ token: device.token, sessionId, eventSeq })
        await this.context.pool.query(`UPDATE harness.push_deliveries SET
          status='sent',sent_at=now(),updated_at=now(),last_error=NULL
          WHERE organization_id=$1 AND session_id=$2 AND event_seq=$3 AND device_id=$4`, [
          owner.organization_id, sessionId, eventSeq, device.id,
        ])
      } catch (error: unknown) {
        const invalidToken = error instanceof FcmSendError && error.invalidToken
        await this.context.pool.query(`UPDATE harness.push_deliveries SET
          status='failed',last_error=$5,updated_at=now()
          WHERE organization_id=$1 AND session_id=$2 AND event_seq=$3 AND device_id=$4`, [
          owner.organization_id, sessionId, eventSeq, device.id,
          error instanceof Error ? error.message : String(error),
        ])
        if (invalidToken) {
          await this.context.pool.query(
            'DELETE FROM harness.push_devices WHERE organization_id=$1 AND id=$2',
            [owner.organization_id, device.id],
          )
        }
        console.error(`[gateway] push delivery failed for device ${device.id}:`, error)
      }
    }
  }
}

/** Build the production push service; it still stores tokens when FCM is disabled. */
export function createPostgresPushService(
  context: Pick<PostgresRuntimeContext, 'pool' | 'organizationId'>,
  cfg: GatewayConfig,
): PostgresPushService {
  return new PostgresPushService(context, cfg)
}
