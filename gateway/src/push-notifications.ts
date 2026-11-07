import { readFile } from 'node:fs/promises'
import { GoogleAuth } from 'google-auth-library'
import type { Pool, PoolClient } from 'pg'
import { CollaborationDeniedError } from './collaboration.ts'
import type { GatewayConfig } from './config.ts'
import { publicNumber, type PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import { transaction } from './postgres/database.ts'
import { lockActiveAccount } from './postgres/account-authority.ts'
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

/** Release an accepted response without turning a body-cleanup failure into another notification attempt. */
async function closeAcceptedPushResponse(response: Response): Promise<void> {
  try { await response.body?.cancel() }
  catch (error) { console.error('[gateway] accepted push response cleanup failed:', error) }
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
  /**
   * Register or refresh a device with current active account and organization membership through commit.
   * @param userId - server-authenticated public account id; no computer execution grant is required.
   * @param input - validated registration; omitted provider resolves to FCM for legacy clients.
   * @returns the registered device id; withdrawn account eligibility rejects before mutation.
   */
  registerDevice(userId: number, input: PushDeviceRegistration): Promise<{ id: string }>
  /**
   * Remove a device while retaining the authenticated account's current eligibility.
   * @param userId - server-authenticated public account id.
   * @param deviceId - registered device UUID.
   * @returns false for absent devices or another account's device; withdrawn account eligibility rejects.
   */
  removeDevice(userId: number, deviceId: string): Promise<boolean>
  /**
   * Notify the creator after a completed turn has durably committed; this method supplies no persistence proof.
   * @param runtimeId - authenticated owning Runtime, also carried by the notification.
   * @param sessionId - committed conversation id; recipient eligibility, inherited visibility and device ownership are checked at claim admission.
   * @param eventSeq - durable completed-turn event sequence used by the per-device delivery key.
   * @returns after eligible devices settle or skip existing claims. Provider work owns a deadline and no database transaction;
   * failed/expired claims may retry, and ambiguous provider outcomes may duplicate a remote delivery. Only the current attempt can settle or clean up a device.
   */
  notifyCompleted(runtimeId: RuntimeId, sessionId: string, eventSeq: number): Promise<void>
}

interface PushSender {
  /** Without a signal the direct caller owns the deadline; the configured delivery service always supplies one. */
  send(input: { token: string; runtimeId: RuntimeId; sessionId: string; eventSeq: number }, signal?: AbortSignal): Promise<void>
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
  provider: PushProvider
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

/** FCM HTTP v1 sender backed by a Google service account; successful initialization is cached, failed initialization can retry. */
export class FcmHttpV1Sender implements PushSender {
  private clientPromise: Promise<AccessTokenClient> | undefined
  private accountPromise: Promise<ServiceAccount> | undefined

  constructor(
    private readonly projectId: string | undefined,
    private readonly serviceAccountFile: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async send(input: { token: string; runtimeId: RuntimeId; sessionId: string; eventSeq: number }, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const account = await this.loadAccount()
    signal?.throwIfAborted()
    const projectId = this.projectId ?? account.projectId
    if (projectId === undefined) throw new Error('FCM project id is not configured')
    const client = await this.loadClient(account)
    signal?.throwIfAborted()
    const accessToken = (await client.getAccessToken()).token
    signal?.throwIfAborted()
    if (accessToken === undefined || accessToken === null || accessToken === '') {
      throw new Error('FCM access token was empty')
    }
    const response = await this.request(
      `${FCM_ENDPOINT}/${encodeURIComponent(projectId)}/messages:send`,
      {
        method: 'POST',
        signal,
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
              runtimeId: input.runtimeId,
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
    if (response.ok) { await closeAcceptedPushResponse(response); return }
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
    const pending = this.accountPromise
    try { return await pending }
    catch (error) {
      if (this.accountPromise === pending) this.accountPromise = undefined
      throw error
    }
  }

  private async loadClient(account: ServiceAccount): Promise<AccessTokenClient> {
    this.clientPromise ??= Promise.resolve(new GoogleAuth({
      credentials: {
        client_email: account.clientEmail,
        private_key: account.privateKey,
      },
      scopes: [FCM_SCOPE],
    }).getClient()).then(client => client as AccessTokenClient)
    const pending = this.clientPromise
    try { return await pending }
    catch (error) {
      if (this.clientPromise === pending) this.clientPromise = undefined
      throw error
    }
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

  async send(input: { token: string; runtimeId: RuntimeId; sessionId: string; eventSeq: number }, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const authorization = Buffer.from(`${this.appKey}:${this.masterSecret}`, 'utf8').toString('base64')
    const response = await this.request(this.endpoint, {
      method: 'POST',
      signal,
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
              runtimeId: input.runtimeId,
              sessionId: input.sessionId,
              eventSeq: String(input.eventSeq),
            },
          },
        },
      }),
    })
    if (response.ok) { await closeAcceptedPushResponse(response); return }
    const body = await pushErrorBody(response)
    const invalidToken = response.status === 400
      && /(registration[_ -]?id|invalid audience|invalid registration|1003|1004)/i.test(body)
    throw new PushSendError(`JPush send failed with HTTP ${String(response.status)}`, invalidToken)
  }
}

class UnconfiguredPushSender implements PushSender {
  async send(_input: { token: string; runtimeId: RuntimeId; sessionId: string; eventSeq: number }): Promise<void> {
    throw new PushSendError('Push provider is not configured', false)
  }
}

type PushSenderMap = Readonly<Record<PushProvider, PushSender>>

function isPushSender(
  sender: PushSender | Partial<Record<PushProvider, PushSender>>,
): sender is PushSender {
  return 'send' in sender && typeof sender.send === 'function'
}

function senderFor(cfg: GatewayConfig, request: typeof fetch): PushSenderMap {
  const disabled = new UnconfiguredPushSender()
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

/** PostgreSQL device registry with current recipient authority and retryable delivery claims. */
export class PostgresPushService implements GatewayPushService {
  private readonly senders: PushSenderMap
  private readonly timeoutMs: number
  private readonly leaseMs: number

  constructor(
    private readonly context: Pick<PostgresRuntimeContext, 'pool' | 'organizationId'>,
    cfg: GatewayConfig,
    request: typeof fetch = fetch,
    sender?: PushSender | Partial<Record<PushProvider, PushSender>>,
  ) {
    this.timeoutMs = cfg.pushDeliveryTimeoutMs
    this.leaseMs = cfg.pushDeliveryLeaseMs
    if (sender === undefined) {
      this.senders = senderFor(cfg, request)
    } else if (isPushSender(sender)) {
      this.senders = { fcm: sender, jpush: sender }
    } else {
      const disabled = new UnconfiguredPushSender()
      this.senders = {
        fcm: sender.fcm ?? disabled,
        jpush: sender.jpush ?? disabled,
      }
    }
  }

  async registerDevice(userId: number, input: PushDeviceRegistration): Promise<{ id: string }> {
    const provider = input.provider ?? 'fcm'
    return transaction(this.context.pool, async client => {
      const account = await lockActiveAccount(client, this.context, userId)
      const result = await client.query<{ id: string }>(`INSERT INTO harness.push_devices(
        organization_id,user_id,token,platform,provider,device_id,app_version,updated_at,last_seen_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),clock_timestamp())
      ON CONFLICT (organization_id,provider,token) DO UPDATE SET
        user_id=EXCLUDED.user_id,platform=EXCLUDED.platform,provider=EXCLUDED.provider,device_id=EXCLUDED.device_id,
        app_version=EXCLUDED.app_version,updated_at=clock_timestamp(),last_seen_at=clock_timestamp()
      RETURNING id::text`, [this.context.organizationId, account.id, input.token, input.platform, provider,
        input.deviceId ?? null, input.appVersion ?? null])
      const row = result.rows[0]
      if (row === undefined) throw new Error('push-device-registration-failed')
      return { id: row.id }
    })
  }

  async removeDevice(userId: number, deviceId: string): Promise<boolean> {
    return transaction(this.context.pool, async client => {
      const account = await lockActiveAccount(client, this.context, userId)
      const result = await client.query(`DELETE FROM harness.push_devices
        WHERE organization_id=$1 AND id=$2 AND user_id=$3`, [this.context.organizationId, deviceId, account.id])
      return result.rowCount === 1
    })
  }

  /** Retain project membership, computer access and Steward qualification before the conversation lock. */
  private async readableProject(client: PoolClient, projectId: string, accountId: string): Promise<boolean> {
    const project = (await client.query<{ kind: string }>(`SELECT kind FROM harness.projects
      WHERE organization_id=$1 AND id=$2 AND status='active' FOR SHARE`, [this.context.organizationId, projectId])).rows[0]
    if (project === undefined) return false
    const role = (await client.query<{ role: 'admin' | 'member' }>('SELECT role FROM harness.memberships WHERE organization_id=$1 AND user_id=$2',
      [this.context.organizationId, accountId])).rows[0]!.role
    const computer = (await client.query<{ node_id: string }>(`SELECT assignment.assigned_node_id node_id
      FROM harness.instances assignment JOIN harness.computer_use_permissions permission
        ON permission.organization_id=assignment.organization_id AND permission.node_id=assignment.assigned_node_id
      WHERE assignment.organization_id=$1 AND assignment.project_id=$2 AND permission.user_id=$3 AND permission.enabled
      FOR SHARE OF assignment,permission`, [this.context.organizationId, projectId, accountId])).rows[0]
    if (computer === undefined) return false
    if (project.kind === 'steward') {
      return role === 'admin' && (await client.query(`SELECT 1 FROM harness.steward_access_policies
        WHERE organization_id=$1 AND user_id=$2 AND node_id=$3 AND enabled FOR SHARE`,
      [this.context.organizationId, accountId, computer.node_id])).rowCount === 1
    }
    return role === 'admin' || (await client.query(`SELECT 1 FROM harness.project_members
      WHERE organization_id=$1 AND project_id=$2 AND user_id=$3 FOR SHARE`,
    [this.context.organizationId, projectId, accountId])).rowCount === 1
  }

  /** Retain the personal Session's own assignment and computer grant before locking conversation rows. */
  private async readablePersonal(client: PoolClient, runtimeId: RuntimeId | null, accountId: string): Promise<boolean> {
    if (runtimeId === null) return false
    const result = await client.query(`SELECT 1 FROM harness.instances assignment
      JOIN harness.computer_use_permissions permission ON permission.organization_id=assignment.organization_id
        AND permission.node_id=assignment.assigned_node_id AND permission.user_id=assignment.user_id
      WHERE assignment.organization_id=$1 AND assignment.runtime_id=$2 AND assignment.user_id=$3 AND permission.enabled
      FOR SHARE OF assignment,permission`, [this.context.organizationId, runtimeId, accountId])
    return result.rowCount === 1
  }

  /** Prepare one currently authorized device and acquire a retryable, attempt-fenced durable claim. */
  private async claimDelivery(runtimeId: RuntimeId, sessionId: string, eventSeq: number, userId: number, deviceId: string): Promise<{
    device: DeviceRow
    userId: string
    attempt: number
  } | null> {
    try {
      return await transaction(this.context.pool, async client => {
        const account = await lockActiveAccount(client, this.context, userId)
        const observed = (await client.query<{ project_id: string | null; root_session_id: string; runtime_id: RuntimeId | null }>(`SELECT c.project_id,c.root_session_id,c.runtime_id
          FROM harness.conversation_sessions c JOIN harness.conversation_sessions root
            ON root.organization_id=c.organization_id AND root.runtime_namespace=c.runtime_namespace AND root.id=c.root_session_id
          WHERE c.organization_id=$1 AND c.id=$2 AND c.runtime_id=$3 AND c.status<>'deleted' AND root.status<>'deleted'
            AND c.project_id IS NOT DISTINCT FROM root.project_id AND c.runtime_id IS NOT DISTINCT FROM root.runtime_id AND root.root_session_id=root.id`,
        [this.context.organizationId, sessionId, runtimeId])).rows[0]
        if (observed === undefined) return null
        if (observed.project_id === null && !await this.readablePersonal(client, observed.runtime_id, account.id)) return null
        if (observed.project_id !== null && !await this.readableProject(client, observed.project_id, account.id)) return null
        const current = (await client.query<{ creator_user_id: string; project_id: string | null; root_session_id: string; runtime_id: RuntimeId | null }>(`SELECT
          c.creator_user_id,c.project_id,c.root_session_id,c.runtime_id FROM harness.conversation_sessions c
          JOIN harness.conversation_sessions root ON root.organization_id=c.organization_id AND root.runtime_namespace=c.runtime_namespace AND root.id=c.root_session_id
          WHERE c.organization_id=$1 AND c.id=$2 AND c.runtime_id=$4 AND c.status<>'deleted' AND root.status<>'deleted'
          AND c.project_id IS NOT DISTINCT FROM root.project_id AND c.runtime_id IS NOT DISTINCT FROM root.runtime_id AND root.root_session_id=root.id
          AND ((root.project_id IS NULL AND root.creator_user_id=$3)
            OR (root.project_id IS NOT NULL AND (root.visibility='project' OR root.creator_user_id=$3
              OR EXISTS(SELECT 1 FROM harness.memberships membership WHERE membership.organization_id=$1
                AND membership.user_id=$3 AND membership.role='admin'))))
          FOR SHARE OF c,root`, [this.context.organizationId, sessionId, account.id, runtimeId])).rows[0]
        if (current === undefined || current.creator_user_id !== account.id
          || current.project_id !== observed.project_id || current.root_session_id !== observed.root_session_id || current.runtime_id !== observed.runtime_id) return null
        const device = (await client.query<DeviceRow>(`SELECT id::text,token,provider FROM harness.push_devices
          WHERE organization_id=$1 AND id=$2 AND user_id=$3 FOR UPDATE`, [this.context.organizationId, deviceId, account.id])).rows[0]
        if (device === undefined) return null
        const claimed = await client.query<{ attempts: number }>(`INSERT INTO harness.push_deliveries(
          organization_id,runtime_id,session_id,event_seq,device_id,status,attempts,updated_at
        ) VALUES($1,$6,$2,$3,$4,'pending',1,clock_timestamp())
        ON CONFLICT (organization_id,runtime_namespace,session_id,event_seq,device_id) DO UPDATE SET
          status='pending',attempts=harness.push_deliveries.attempts+1,updated_at=clock_timestamp(),last_error=NULL
        WHERE harness.push_deliveries.status='failed' OR (harness.push_deliveries.status='pending'
          AND harness.push_deliveries.updated_at<=clock_timestamp()-$5*interval '1 millisecond')
        RETURNING attempts`, [this.context.organizationId, sessionId, eventSeq, device.id, this.leaseMs, runtimeId])
        const claim = claimed.rows[0]
        return claim === undefined ? null : { device, userId: account.id, attempt: claim.attempts }
      })
    } catch (error) {
      if (error instanceof CollaborationDeniedError) return null
      throw error
    }
  }

  /** Own the complete send deadline, including late credential preparation; provider HTTP retains no database connection. */
  private async send(device: DeviceRow, runtimeId: RuntimeId, sessionId: string, eventSeq: number): Promise<void> {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new PushSendError('Push delivery timed out', false)
        abort.abort(error)
        reject(error)
      }, this.timeoutMs)
    })
    try {
      await Promise.race([
        Promise.resolve().then(() => this.senders[device.provider].send({ token: device.token, runtimeId, sessionId, eventSeq }, abort.signal)),
        deadline,
      ])
    } finally { clearTimeout(timer) }
  }

  async notifyCompleted(runtimeId: RuntimeId, sessionId: string, eventSeq: number): Promise<void> {
    const recipient = await this.context.pool.query<{ user_id: string; public_id: string }>(`SELECT
      c.creator_user_id user_id,account.public_id::text public_id FROM harness.conversation_sessions c
      JOIN harness.users account ON account.organization_id=c.organization_id AND account.id=c.creator_user_id
      WHERE c.id=$1 AND c.organization_id=$2 AND c.runtime_id=$3 AND c.status<>'deleted'`, [sessionId, this.context.organizationId, runtimeId])
    const owner = recipient.rows[0]
    if (owner === undefined) return
    const candidates = await this.context.pool.query<Pick<DeviceRow, 'id'>>(`SELECT id::text FROM harness.push_devices
      WHERE organization_id=$1 AND user_id=$2 ORDER BY updated_at DESC`, [this.context.organizationId, owner.user_id])
    for (const candidate of candidates.rows) {
      const claim = await this.claimDelivery(runtimeId, sessionId, eventSeq, publicNumber(owner.public_id, 'user'), candidate.id)
      if (claim === null) continue
      const { device, attempt } = claim
      try {
        await this.send(device, runtimeId, sessionId, eventSeq)
      } catch (error: unknown) {
        try {
          const failed = await this.context.pool.query(`UPDATE harness.push_deliveries SET
            status='failed',last_error=$6,updated_at=clock_timestamp()
            WHERE organization_id=$1 AND session_id=$2 AND event_seq=$3 AND device_id=$4 AND attempts=$5 AND runtime_id=$7 AND status='pending'`,
          [this.context.organizationId, sessionId, eventSeq, device.id, attempt, error instanceof Error ? error.message : String(error), runtimeId])
          if (failed.rowCount === 1 && error instanceof PushSendError && error.invalidToken) {
            await this.context.pool.query(`DELETE FROM harness.push_devices device
              WHERE device.organization_id=$1 AND device.id=$2 AND device.user_id=$3 AND device.token=$4 AND device.provider=$5
                AND EXISTS(SELECT 1 FROM harness.push_deliveries delivery WHERE delivery.organization_id=$1
                  AND delivery.session_id=$6 AND delivery.event_seq=$7 AND delivery.device_id=device.id
                  AND delivery.runtime_id=$9 AND delivery.attempts=$8 AND delivery.status='failed')`,
            [this.context.organizationId, device.id, claim.userId, device.token, device.provider, sessionId, eventSeq, attempt, runtimeId])
          }
        } catch (recordError) { throw new AggregateError([error, recordError], 'Push delivery failed and its outcome could not be recorded') }
        console.error(`[gateway] push delivery failed for device ${device.id}:`, error)
        continue
      }
      await this.context.pool.query(`UPDATE harness.push_deliveries SET
        status='sent',sent_at=clock_timestamp(),updated_at=clock_timestamp(),last_error=NULL
        WHERE organization_id=$1 AND session_id=$2 AND event_seq=$3 AND device_id=$4 AND attempts=$5 AND runtime_id=$6 AND status='pending'`,
      [this.context.organizationId, sessionId, eventSeq, device.id, attempt, runtimeId])
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
