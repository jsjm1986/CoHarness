import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface UsageRecord {
  eventId: string
  occurredAt: number
  provider: string
  model: string
  purpose: string
  sessionId?: string
  /** Public participant id extracted from the durable request, when known. */
  actorUserId?: number
  /** Public project id from the participant claim, used only for scope verification. */
  actorProjectId?: number
  credentialSource: string
  credentialClass: 'company' | 'personal' | 'unknown'
  status: 'succeeded' | 'failed' | 'cancelled' | 'missing-usage' | 'denied'
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
}

/** A non-secret personal Provider/model settings change. */
export interface ModelRegistrationRecord {
  kind: 'model-registration'
  eventId: string
  occurredAt: number
  provider: string
  model?: string
  action: 'provider-created' | 'provider-modified' | 'provider-deleted'
    | 'model-created' | 'model-modified' | 'model-deleted'
  scope: 'personal'
}

/** Every record accepted by the governance intake. */
export type GovernanceRecord = UsageRecord | ModelRegistrationRecord

/** Crash-safe local outbox; each record is committed by same-directory rename. */
export class UsageOutbox {
  private pumping: Promise<void> = Promise.resolve()
  private timer: NodeJS.Timeout
  private closed = false

  constructor(private readonly dir: string, private url: string, private token: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.timer = setInterval(() => this.kick(), 5_000)
    this.timer.unref()
    this.kick()
  }

  /**
   * Replace the intake destination used by future delivery attempts.
   * @param url - loopback intake URL from the validated policy.
   * @param token - bearer token from the validated policy.
   */
  setEndpoint(url: string, token: string): void {
    if (this.closed) return
    this.url = url
    this.token = token
  }

  enqueue(record: GovernanceRecord): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const target = join(this.dir, `${record.eventId}.json`)
    const temp = `${target}.${randomBytes(5).toString('hex')}.tmp`
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(record)); closeSync(fd); renameSync(temp, target) } catch (error) {
      try { closeSync(fd) } catch { /* already closed */ }
      rmSync(temp, { force: true })
      throw error
    }
    this.kick()
  }

  private kick(): void {
    if (this.closed) return
    this.pumping = this.pumping.then(() => this.drain(), () => this.drain())
  }

  private async drain(): Promise<void> {
    for (const name of readdirSync(this.dir).filter(name => name.endsWith('.json')).sort()) {
      if (this.closed) return
      const path = join(this.dir, name)
      let body: string
      try { body = await import('node:fs/promises').then(fs => fs.readFile(path, 'utf8')) } catch { return }
      const post = (payload: string): Promise<Response> => fetch(this.url, {
        method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: payload, signal: AbortSignal.timeout(5_000),
      })
      let response: Response
      try {
        response = await post(body)
      } catch { return }
      if (!response.ok && response.status === 400) {
        const fallback = actorlessUsageBody(body)
        if (fallback !== undefined) {
          try { response = await post(fallback) } catch { return }
        }
      }
      if (!response.ok) return
      rmSync(path, { force: true })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    await this.pumping
  }
}

/** Remove unverifiable activity fields while preserving the billable usage event. */
function actorlessUsageBody(body: string): string | undefined {
  let value: unknown
  try { value = JSON.parse(body) } catch { return undefined }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'model-registration'
    || (!Object.hasOwn(record, 'actorUserId') && !Object.hasOwn(record, 'actorProjectId'))) return undefined
  delete record.actorUserId
  delete record.actorProjectId
  return JSON.stringify(record)
}
