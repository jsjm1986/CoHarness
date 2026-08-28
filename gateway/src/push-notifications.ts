import { readFile } from 'node:fs/promises'
import { GoogleAuth } from 'google-auth-library'
import type { Pool } from 'pg'
import type { GatewayConfig } from './config.ts'
import { internalUserId, type PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { readResponseBytes, ResponseBodyTooLargeError } from './response-budget.ts'

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const FCM_ENDPOINT = 'https://fcm.googleapis.com/v1/projects'
const JPUSH_ENDPOINT = 'https://api.jpush.cn/v3/push'
const PUSH_CHANNEL_ID = 'ai-replies'
const PUSH_ERROR_RESPONSE_MAX_BYTES = 64 * 1024

async function pushErrorBody(response: Response): Promise<string> {
  try {
    return new TextDecoder().decode(await readResponseBytes(response, PUSH_ERROR_RESPONSE_MAX_BYTES))
  } catch (error: unknown) {
    if (error instanceof ResponseBodyTooLargeError) return ''
    throw error
  }
}

/** Provider used to address one Android push registration. */
export type PushProvider = 'fcm' | 'jpush'

/** Android device registration accepted by the authenticated account API. */
export interface PushDeviceRegistration {
  token: string
  platform: 'android'
  provider?: PushProvider
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
  provider?: PushProvider
}

class PushSendError extends Error {
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
    const body = await pushErrorBody(response)
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
    throw new PushSendError(`FCM send failed with HTTP ${String(response.status)}`, invalidToken)
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

/** JPush REST sender addressed by an Android RegistrationID. */
export class JpushRestSender implements PushSender {
  constructor(
    private readonly appKey: string,
    private readonly masterSecret: string,
    private readonly request: typeof fetch = fetch,
    private readonly endpoint = JPUSH_ENDPOINT,
  ) {}

  async send(input: { token: string; sessionId: string; eventSeq: number }): Promise<void> {
    const authorization = Buffer.from(`${this.appKey}:${this.masterSecret}`, 'utf8').toString('base64')
    const response = await this.request(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Basic ${authorization}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        platform: 'android',
        audience: { registration_id: [input.token] },
        notification: {
          alert: '点击查看回复',
          android: {
            alert: '点击查看回复',
            title: 'AI 回复完成',
            extras: {
              sessionId: input.sessionId,
              eventSeq: String(input.eventSeq),
            },
          },
        },
      }),
    })
    if (response.ok) return
    const body = await pushErrorBody(response)
    const invalidToken = response.status === 400
      && /(registration[_ -]?id|invalid audience|invalid registration|1003|1004)/i.test(body)
    throw new PushSendError(`JPush send failed with HTTP ${String(response.status)}`, invalidToken)
  }
}

class DisabledPushSender implements PushSender {
  async send(_input: { token: string; sessionId: string; eventSeq: number }): Promise<void> {}
}

type PushSenderMap = Readonly<Record<PushProvider, PushSender>>

function isPushSender(
  sender: PushSender | Partial<Record<PushProvider, PushSender>>,
): sender is PushSender {
  return 'send' in sender && typeof sender.send === 'function'
}

function senderFor(cfg: GatewayConfig, request: typeof fetch): PushSenderMap {
  const disabled = new DisabledPushSender()
  const fcm = cfg.fcmServiceAccountFile === undefined
    ? disabled
    : new FcmHttpV1Sender(cfg.fcmProjectId, cfg.fcmServiceAccountFile, request)
  const { jpushAppKey, jpushMasterSecret } = cfg
  const hasJpushAppKey = jpushAppKey !== undefined
  const hasJpushMasterSecret = jpushMasterSecret !== undefined
  if (hasJpushAppKey !== hasJpushMasterSecret) {
    throw new Error('HGW_JPUSH_APP_KEY and HGW_JPUSH_MASTER_SECRET must be configured together')
  }
  const jpush = jpushAppKey !== undefined && jpushMasterSecret !== undefined
    ? new JpushRestSender(jpushAppKey, jpushMasterSecret, request)
    : disabled
  return { fcm, jpush }
}

/** PostgreSQL-backed device registry and idempotent multi-provider delivery service. */
export class PostgresPushService implements GatewayPushService {
  private readonly senders: PushSenderMap

  constructor(
    private readonly context: Pick<PostgresRuntimeContext, 'pool' | 'organizationId'>,
    cfg: GatewayConfig,
    request: typeof fetch = fetch,
    sender?: PushSender | Partial<Record<PushProvider, PushSender>>,
  ) {
    if (sender === undefined) {
      this.senders = senderFor(cfg, request)
    } else if (isPushSender(sender)) {
      this.senders = { fcm: sender, jpush: sender }
    } else {
      const disabled = new DisabledPushSender()
      this.senders = {
        fcm: sender.fcm ?? disabled,
        jpush: sender.jpush ?? disabled,
      }
    }
  }

  async registerDevice(userId: number, input: PushDeviceRegistration): Promise<{ id: string }> {
    const internalId = await internalUserId(this.context.pool, this.context.organizationId, userId)
    if (internalId === null) throw new Error('user-not-found')
    const provider = input.provider ?? 'fcm'
    const result = await this.context.pool.query<{ id: string }>(`INSERT INTO harness.push_devices(
      organization_id,user_id,token,platform,provider,device_id,app_version,updated_at,last_seen_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,now(),now())
    ON CONFLICT (organization_id,provider,token) DO UPDATE SET
      user_id=EXCLUDED.user_id,platform=EXCLUDED.platform,provider=EXCLUDED.provider,device_id=EXCLUDED.device_id,
      app_version=EXCLUDED.app_version,updated_at=now(),last_seen_at=now()
    RETURNING id::text`, [
      this.context.organizationId,
      internalId,
      input.token,
      input.platform,
      provider,
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
    const devices = await this.context.pool.query<DeviceRow>(`SELECT id::text,token,provider
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
        const provider = device.provider ?? 'fcm'
        await this.senders[provider].send({ token: device.token, sessionId, eventSeq })
        await this.context.pool.query(`UPDATE harness.push_deliveries SET
          status='sent',sent_at=now(),updated_at=now(),last_error=NULL
          WHERE organization_id=$1 AND session_id=$2 AND event_seq=$3 AND device_id=$4`, [
          owner.organization_id, sessionId, eventSeq, device.id,
        ])
      } catch (error: unknown) {
        const invalidToken = error instanceof PushSendError && error.invalidToken
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
