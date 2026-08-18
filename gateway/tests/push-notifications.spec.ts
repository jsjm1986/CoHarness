import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool, QueryResultRow } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.ts'
import {
  FcmHttpV1Sender,
  PostgresPushService,
  type PushDeviceRegistration,
} from '../src/push-notifications.ts'

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    constructor(_options: unknown) {}

    getClient(): Promise<{ getAccessToken: () => Promise<{ token: string }> }> {
      return Promise.resolve({ getAccessToken: async () => ({ token: 'access-token' }) })
    }
  },
}))

const ORGANIZATION_ID = 'org-1'
const INTERNAL_USER_ID = 'user-internal-1'
const SESSION_ID = 'session-1'
const DEVICE_ID = 'device-1'

type Sender = {
  send(input: { token: string; sessionId: string; eventSeq: number }): Promise<void>
}

interface RecordedQuery {
  text: string
  values: readonly unknown[] | undefined
}

interface QueryPlan {
  duplicateClaim?: boolean
}

function poolFixture(plan: QueryPlan = {}): {
  pool: Pool
  queries: RecordedQuery[]
  sender: Sender & { send: ReturnType<typeof vi.fn> }
} {
  const queries: RecordedQuery[] = []
  let claimed = false
  const query = vi.fn(async <R extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
    queries.push({ text, values })
    if (text.includes('SELECT id FROM harness.users')) {
      return { rows: [{ id: INTERNAL_USER_ID }], rowCount: 1 } as unknown as { rows: R[]; rowCount: number }
    }
    if (text.includes('INSERT INTO harness.push_devices')) {
      return { rows: [{ id: DEVICE_ID }], rowCount: 1 } as unknown as { rows: R[]; rowCount: number }
    }
    if (text.includes('DELETE FROM harness.push_devices')) {
      return { rows: [], rowCount: 1 } as { rows: R[]; rowCount: number }
    }
    if (text.includes('FROM harness.conversation_sessions')) {
      return { rows: [{ organization_id: ORGANIZATION_ID, user_id: INTERNAL_USER_ID }], rowCount: 1 } as unknown as { rows: R[]; rowCount: number }
    }
    if (text.includes('FROM harness.push_devices')) {
      return { rows: [{ id: DEVICE_ID, token: 'device-token' }], rowCount: 1 } as unknown as { rows: R[]; rowCount: number }
    }
    if (text.includes('INSERT INTO harness.push_deliveries')) {
      if (plan.duplicateClaim === true && claimed) return { rows: [], rowCount: 0 } as { rows: R[]; rowCount: number }
      claimed = true
      return { rows: [{ device_id: DEVICE_ID }], rowCount: 1 } as unknown as { rows: R[]; rowCount: number }
    }
    if (text.includes('UPDATE harness.push_deliveries')) {
      return { rows: [], rowCount: 1 } as unknown as { rows: R[]; rowCount: number }
    }
    throw new Error(`unexpected query: ${text}`)
  })
  const sender = { send: vi.fn(async (_input: { token: string; sessionId: string; eventSeq: number }): Promise<void> => {}) }
  return { pool: { query } as unknown as Pool, queries, sender }
}

function service(
  pool: Pool,
  sender: Sender,
): PostgresPushService {
  return new PostgresPushService(
    { pool, organizationId: ORGANIZATION_ID },
    loadConfig({}),
    fetch,
    sender,
  )
}

const registration: PushDeviceRegistration = { token: 'device-token', platform: 'android' }

describe('PostgresPushService', () => {
  it('registers a device and only removes it for its owning user', async () => {
    const fixture = poolFixture()
    const push = service(fixture.pool, fixture.sender)

    await expect(push.registerDevice(42, registration)).resolves.toEqual({ id: DEVICE_ID })
    await expect(push.removeDevice(42, DEVICE_ID)).resolves.toBe(true)

    const insert = fixture.queries.find(query => query.text.includes('INSERT INTO harness.push_devices'))
    expect(insert?.text).toContain('ON CONFLICT (organization_id,token)')
    const remove = fixture.queries.at(-1)
    expect(remove?.text).toContain('WHERE organization_id=$1 AND id=$2 AND user_id=$3')
    expect(remove?.values).toEqual([ORGANIZATION_ID, DEVICE_ID, INTERNAL_USER_ID])
  })

  it('sends one notification per device for a repeated completed event', async () => {
    const fixture = poolFixture({ duplicateClaim: true })
    const push = service(fixture.pool, fixture.sender)

    await push.notifyCompleted(SESSION_ID, 17)
    await push.notifyCompleted(SESSION_ID, 17)

    expect(fixture.sender.send).toHaveBeenCalledOnce()
    expect(fixture.sender.send).toHaveBeenCalledWith({
      token: 'device-token', sessionId: SESSION_ID, eventSeq: 17,
    })
    expect(fixture.queries.filter(query => query.text.includes('INSERT INTO harness.push_deliveries')))
      .toHaveLength(2)
  })

  it('deletes an FCM token when FCM reports it as unregistered', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hgw-fcm-'))
    const credentials = join(directory, 'service-account.json')
    await writeFile(credentials, JSON.stringify({
      project_id: 'firebase-project',
      client_email: 'sender@example.test',
      private_key: 'not-used-by-the-mock',
    }))
    const request = vi.fn(async () => new Response(JSON.stringify({ error: { status: 'UNREGISTERED' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }))
    const sender = new FcmHttpV1Sender('firebase-project', credentials, request)
    const fixture = poolFixture()
    const push = new PostgresPushService(
      { pool: fixture.pool, organizationId: ORGANIZATION_ID },
      loadConfig({}),
      fetch,
      sender,
    )

    try {
      await push.notifyCompleted(SESSION_ID, 18)
      expect(request).toHaveBeenCalledOnce()
      expect(fixture.queries.some(query => query.text.includes('DELETE FROM harness.push_devices'))).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('FcmHttpV1Sender', () => {
  it('sends an HTTP v1 message without including the reply body', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hgw-fcm-success-'))
    const credentials = join(directory, 'service-account.json')
    await writeFile(credentials, JSON.stringify({
      project_id: 'firebase-project',
      client_email: 'sender@example.test',
      private_key: 'not-used-by-the-mock',
    }))
    const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { message: Record<string, unknown> }
      expect(body.message).toMatchObject({
        token: 'device-token',
        notification: { title: 'AI 回复完成', body: '点击查看回复' },
        data: { sessionId: SESSION_ID, eventSeq: '19' },
      })
      expect(body.message).not.toHaveProperty('reply')
      return new Response(null, { status: 200 })
    })
    try {
      await new FcmHttpV1Sender('firebase-project', credentials, request).send({
        token: 'device-token', sessionId: SESSION_ID, eventSeq: 19,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    expect(request).toHaveBeenCalledOnce()
  })
})
