/** Deterministic tests for Wave 4 model first-token fast paths on project and node_content Runtimes. */
import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  RESOURCE_ACTIVE_MODEL_CHECK_HEADER,
  RESOURCE_CHANGE_CURSOR_HEADER,
  RESOURCE_CHANGE_WAIT_TIMING_HEADER,
  RESOURCE_PHASE_TIMING_HEADER,
  RESOURCE_QUALIFIED_GRANT_HEADER,
} from '@deepseek-ai/dsh-resource-budget/wire'
import { ExecutionIdentityError, GatewayExecutionIdentity } from '../src/execution-identity.ts'
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { PostgresModelGovernanceService } from '../src/postgres/model-governance-service.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import type { RuntimeCredentialSubject } from '../src/runtime-api.ts'
import { handleRuntimeResourceApi } from '../src/runtime-resource-api.ts'

const ORG_ID = '00000000-0000-4000-8000-000000000001'
const NODE_ID = '00000000-0000-4000-8000-000000000002'
const RUNTIME_ID = '00000000-0000-4000-8000-000000000003' as RuntimeId
const PROJECT_UUID = '00000000-0000-4000-8000-000000000010'
const ACTOR_UUID = '00000000-0000-4000-8000-000000000011'
const SCOPE_ID = '00000000-0000-4000-8000-000000000022'
const INPUT_ID = '00000000-0000-4000-8000-000000000023'

const projectSubject: RuntimeCredentialSubject = {
  organizationId: ORG_ID,
  target: { kind: 'project', id: 42, runtimeId: RUNTIME_ID },
  generation: 3,
  projectInternalId: PROJECT_UUID,
}

const nodeContentProjectSubject: RuntimeCredentialSubject = {
  ...projectSubject,
  contentBinding: {
    organizationId: ORG_ID,
    projectId: PROJECT_UUID,
    nodeId: NODE_ID,
    runtimeId: RUNTIME_ID,
    volumeId: 'vol-1',
    writerEpoch: '5',
  },
}

function fakeResponse() {
  const headers = new Map<string, string>()
  let statusCode = 200
  let body = ''
  const res = {
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value) },
    writeHead(status: number, extra: Record<string, string> = {}) {
      statusCode = status
      for (const [k, v] of Object.entries(extra)) headers.set(k.toLowerCase(), v)
      return res
    },
    end(chunk = '') { body += chunk; return res },
  } as unknown as ServerResponse
  return { res, status: () => statusCode, headers, json: () => JSON.parse(body) as unknown }
}

describe('Wave 4: single-statement project model credential resolution', () => {
  it('resolves both organization-managed and project-owned credentials in 1 SQL query with epoch/serving fencing', async () => {
    const cipher = new OrganizationModelCredentialCipher(randomBytes(32))
    const encryptedOrg = cipher.encrypt(ORG_ID, 'prov-org', 'sk-org-secret')
    const encryptedProj = cipher.encrypt(ORG_ID, 'prov-proj', 'sk-proj-secret')
    const query = vi.fn()
    const pool = { query } as unknown as Pool
    const governance = new PostgresModelGovernanceService(
      { pool, organizationId: ORG_ID, organizationSlug: 'org', nodeId: NODE_ID, nodeName: 'n1' },
      cipher,
    )
    const fence = { bearer: 'tok-project', epoch: 7n }

    const toDbRow = (providerId: string, enc: ReturnType<typeof cipher.encrypt>) => ({
      verdict: 'open',
      provider_id: providerId,
      key_version: enc.keyVersion,
      nonce: enc.nonce,
      ciphertext: enc.ciphertext,
      auth_tag: enc.authTag,
    })

    query.mockResolvedValueOnce({
      rows: [toDbRow('prov-org', encryptedOrg)],
      rowCount: 1,
    })
    const orgResult = await governance.resolveRuntimeCredential(nodeContentProjectSubject, 'DSH_ORG_DEEPSEEK_KEY', fence)
    expect(orgResult).toEqual({ status: 'ok', value: 'sk-org-secret' })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]![0]).toContain('JOIN harness.projects owner')
    expect(query.mock.calls[0]![0]).toContain('organization_model_credentials')

    query.mockClear()
    query.mockResolvedValueOnce({
      rows: [toDbRow('prov-proj', encryptedProj)],
      rowCount: 1,
    })
    const projResult = await governance.resolveRuntimeCredential(projectSubject, 'DSH_PROJECT_CUSTOM_KEY', fence)
    expect(projResult).toEqual({ status: 'ok', value: 'sk-proj-secret' })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]![0]).toContain('project_model_credentials')

    query.mockResolvedValueOnce({ rows: [{ verdict: 'maintenance', provider_id: null }], rowCount: 1 })
    expect(await governance.resolveRuntimeCredential(projectSubject, 'DSH_PROJECT_CUSTOM_KEY', fence))
      .toEqual({ status: 'maintenance' })

    query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    expect(await governance.resolveRuntimeCredential(projectSubject, 'DSH_ORG_DEEPSEEK_KEY', fence))
      .toEqual({ status: 'invalid-runtime-token' })
  })
})

describe('Wave 4: immediate qualified project model grants and cursor wakeups', () => {
  it('qualifies immediate active scoped project model grants inline and refuses when post-grant authority fails', async () => {
    const authorize = vi.fn(async () => ({
      scopeId: SCOPE_ID, revision: '1', inputs: [INPUT_ID], actors: [{ userId: 7 }],
      primaryActorUserId: 7, unverifiedHistory: false,
    }))
    const budgetRequest = vi.fn<() => Promise<{ state: 'active' | 'queued' }>>(async () => ({ state: 'active' }))
    const deps = {
      pool: {} as Pool,
      principals: {} as never,
      execution: { authorize } as never,
      budget: { request: budgetRequest, changeCursor: '11111111-1111-4111-8111-111111111111.5' } as never,
      waitForQueued: true,
    }
    const payload = JSON.stringify({
      requestId: randomUUID(), sequence: 1, kind: 'model',
      origin: { kind: 'session', sessionId: 'sess-1', scopeId: SCOPE_ID },
    })

    // Case 1: active grant confirmed post-reservation -> sets RESOURCE_QUALIFIED_GRANT_HEADER=1.
    const r1 = fakeResponse()
    await handleRuntimeResourceApi(deps, projectSubject, { method: 'POST' } as IncomingMessage, r1.res,
      '/internal/runtime/resources/request', payload)
    expect(r1.status()).toBe(200)
    expect(r1.json()).toEqual({ state: 'active' })
    expect(r1.headers.get(RESOURCE_QUALIFIED_GRANT_HEADER)).toBe('1')
    expect(authorize).toHaveBeenCalledTimes(2)

    // Case 2: revoked during reservation -> returns refused/authority-unavailable without qualified header.
    authorize.mockClear()
    authorize.mockResolvedValueOnce({
      scopeId: SCOPE_ID, revision: '1', inputs: [INPUT_ID], actors: [{ userId: 7 }],
      primaryActorUserId: 7, unverifiedHistory: false,
    }).mockRejectedValueOnce(new ExecutionIdentityError(403, 'revoked'))
    const r2 = fakeResponse()
    await handleRuntimeResourceApi(deps, projectSubject, { method: 'POST' } as IncomingMessage, r2.res,
      '/internal/runtime/resources/request', payload)
    expect(r2.status()).toBe(200)
    expect(r2.json()).toEqual({ state: 'refused', reason: 'authority-unavailable' })
    expect(r2.headers.get(RESOURCE_QUALIFIED_GRANT_HEADER)).toBeUndefined()

    // Case 3: queued project model request receives RESOURCE_CHANGE_CURSOR_HEADER for instant wakeup.
    authorize.mockClear()
    authorize.mockResolvedValueOnce({
      scopeId: SCOPE_ID, revision: '1', inputs: [INPUT_ID], actors: [{ userId: 7 }],
      primaryActorUserId: 7, unverifiedHistory: false,
    })
    budgetRequest.mockResolvedValueOnce({ state: 'queued' as const })
    const r3 = fakeResponse()
    await handleRuntimeResourceApi(deps, projectSubject, { method: 'POST' } as IncomingMessage, r3.res,
      '/internal/runtime/resources/request', payload)
    expect(r3.status()).toBe(200)
    expect(r3.json()).toEqual({ state: 'queued' })
    expect(r3.headers.get(RESOURCE_QUALIFIED_GRANT_HEADER)).toBeUndefined()
    expect(r3.headers.get(RESOURCE_CHANGE_CURSOR_HEADER)).toBe('11111111-1111-4111-8111-111111111111.5')

    // Case 4: queued project model statuses honors waitForChange + emits fresh cursor while still queued.
    authorize.mockClear()
    authorize.mockResolvedValueOnce({
      scopeId: SCOPE_ID, revision: '1', inputs: [INPUT_ID], actors: [{ userId: 7 }],
      primaryActorUserId: 7, unverifiedHistory: false,
    })
    const waitForChange = vi.fn(async () => true)
    const admissions = vi.fn(async () => [{
      status: { state: 'queued' as const },
      origin: { kind: 'session' as const, sessionId: 'sess-1', scopeId: SCOPE_ID },
    }])
    const statusDeps = {
      ...deps,
      budget: { request: budgetRequest, waitForChange, admissions, changeCursor: '11111111-1111-4111-8111-111111111111.6' } as never,
      resourceStatusWaitMs: 500,
      bearerMs: 1,
    }
    const r4 = fakeResponse()
    const statusPayload = JSON.stringify({ operations: [{ sequence: 1, requestId: randomUUID() }] })
    await handleRuntimeResourceApi(
      statusDeps,
      projectSubject,
      {
        method: 'POST',
        headers: {
          [RESOURCE_ACTIVE_MODEL_CHECK_HEADER]: '1',
          [RESOURCE_CHANGE_CURSOR_HEADER]: '11111111-1111-4111-8111-111111111111.5',
        },
      } as unknown as IncomingMessage,
      r4.res,
      '/internal/runtime/resources/statuses',
      statusPayload,
    )
    expect(waitForChange).toHaveBeenCalledTimes(1)
    expect(waitForChange).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111.5', 500, expect.any(AbortSignal))
    expect(r4.status()).toBe(200)
    expect(r4.json()).toEqual([{ state: 'queued' }])
    expect(r4.headers.get(RESOURCE_CHANGE_CURSOR_HEADER)).toBe('11111111-1111-4111-8111-111111111111.6')
    expect(r4.headers.get(RESOURCE_CHANGE_WAIT_TIMING_HEADER)).toBeDefined()
    expect(r4.headers.get(RESOURCE_PHASE_TIMING_HEADER)).toBeDefined()
  })
})

describe('Wave 4: combined scope+actor and project/steward/members/placement SQL in GatewayExecutionIdentity.authorize', () => {
  it('uses only 2 governance SQL statements for node_content project authorize (down from 4+)', async () => {
    const governanceQueries: string[] = []
    const localQueries: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
        governanceQueries.push(sql)
        if (sql.includes('computer_use_allowed')) {
          return { rows: [{ id: ACTOR_UUID, public_id: '7', role: 'member' }], rowCount: 1 }
        }
        if (sql.includes('project_content_placement')) {
          return {
            rows: [{
              steward_ok: true,
              members: [{ user_id: ACTOR_UUID, access_mode: 'rw' }],
            }],
            rowCount: 1,
          }
        }
        throw new Error(`Unexpected governance query: ${sql}`)
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    const localDb = {
      query: vi.fn(async (sql: string) => {
        localQueries.push(sql)
        if (sql.includes('node_content.execution_scopes')) {
          return {
            rows: [{
              id: SCOPE_ID, revision: '2', input_ids: [INPUT_ID],
              primary_actor_user_id: ACTOR_UUID, unverified: false,
              matched_inputs: 1, actors: [ACTOR_UUID],
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('node_content.conversation_sessions')) {
          return { rows: [{ visibility: 'project', creator_user_id: ACTOR_UUID }], rowCount: 1 }
        }
        throw new Error(`Unexpected local query: ${sql}`)
      }),
    }
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool
    const nodeContent = {
      read: vi.fn(),
      write: vi.fn(async (_binding: unknown, fn: (tx: typeof localDb) => Promise<unknown>) => fn(localDb)),
    }
    const service = new GatewayExecutionIdentity(pool, NODE_ID, nodeContent as never)

    const result = await service.authorize(nodeContentProjectSubject, {
      sessionId: 'sess-1', capability: 'execute', scopeId: SCOPE_ID,
    })

    expect(result).toEqual({
      scopeId: SCOPE_ID, revision: '2', inputs: [INPUT_ID], primaryActorUserId: 7,
      actors: [{ userId: 7 }], unverifiedHistory: false,
    })
    // Local node_content: 1 combined scope+actors query + 1 conversation_sessions query = 2 local queries.
    expect(localQueries).toHaveLength(2)
    // Governance PG (over 200ms tunnel): 1 users/memberships + 1 combined placement/steward/members = ONLY 2 queries!
    expect(governanceQueries).toHaveLength(2)
    // PostgreSQL forbids FOR SHARE on the nullable side of an outer join (0A000): enforce inner JOIN.
    expect(governanceQueries[1]).toContain('JOIN harness.project_content_placement')
    expect(governanceQueries[1]).not.toMatch(/LEFT\s+JOIN\s+harness\.project_content_placement/iu)
  })
})
