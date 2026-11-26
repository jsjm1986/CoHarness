/** Deterministic verification of personal single-statement and project CTE terminal authorization. */
import { describe, expect, it, vi } from 'vitest'
import { ExecutionIdentityError, GatewayExecutionIdentity } from '../src/execution-identity.ts'
import type { GatewayPrincipalClaims } from '../src/principal.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import type { RuntimeCredentialSubject } from '../src/runtime-api.ts'
import { fixtureQueryClient, fixtureQueryPool } from './postgres-query-fixture.ts'

const ORG_ID = '00000000-0000-4000-8000-000000000001'
const NODE_ID = '00000000-0000-4000-8000-000000000002'
const RUNTIME_ID = '00000000-0000-4000-8000-000000000003' as RuntimeId
const GRANT_ID = '00000000-0000-4000-8000-000000000099'

const personalSubject: RuntimeCredentialSubject = {
  organizationId: ORG_ID,
  target: { kind: 'user', id: 7, runtimeId: RUNTIME_ID },
  generation: 2,
  userInternalId: '00000000-0000-4000-8000-000000000007',
}

const principalOf = (userId: number): GatewayPrincipalClaims => ({
  version: 1,
  issuer: 'harness-gateway',
  audience: 'dsh-runtime',
  organization: 'org',
  user: { id: userId, username: `u${userId}`, displayName: `User ${userId}`, role: 'user' },
  scope: { kind: 'personal' },
  runtime: { kind: 'user', id: 7, runtimeId: RUNTIME_ID, generation: 2 },
  issuedAt: Date.now() - 1000,
  expiresAt: Date.now() + 60_000,
  nonce: 'n1',
})

describe('ExecutionIdentityService.authorizeTerminal fast path', () => {
  it('authorizes a personal terminal in one auto-commit SQL statement without BEGIN/COMMIT', async () => {
    const pool = fixtureQueryPool(() => [{ grant_id: GRANT_ID }])
    const query = vi.mocked(pool.query)
    const connect = vi.spyOn(pool, 'connect')
    const service = new GatewayExecutionIdentity(pool, NODE_ID)

    const result = await service.authorizeTerminal(
      personalSubject,
      principalOf(7),
      NODE_ID,
      { sessionId: 'sess-1' },
      { bearer: 'runtime-token', epoch: 1n },
    )

    expect(result).toEqual({ userId: 7, grantId: GRANT_ID })
    expect(connect).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledTimes(1)
    const [sql] = query.mock.calls[0]!
    expect(sql).toContain('harness.personal_execution_actor')
    expect(sql).toContain('harness.terminal_access_policies')
    expect(sql).toContain('WITH authorized AS MATERIALIZED')
    expect(sql).toContain('ON CONFLICT')
    expect(sql).toContain('RETURNING grant_id')
    expect(sql).not.toContain('UNION ALL')
    expect(sql).not.toContain('WHERE g.generation<>EXCLUDED.generation')
  })

  it('maps missing qualification, SQL fence errors, foreign users, and invalid payloads cleanly', async () => {
    const pool = fixtureQueryPool(() => [])
    const query = vi.mocked(pool.query)
    const service = new GatewayExecutionIdentity(pool, NODE_ID)
    const fence = { bearer: 'runtime-token', epoch: 1n }

    await expect(service.authorizeTerminal(personalSubject, principalOf(7), NODE_ID, { sessionId: 'sess-1' }, fence))
      .rejects.toMatchObject({ status: 403, message: 'terminal qualification is unavailable' })

    query.mockRejectedValueOnce(Object.assign(new Error('maintenance'), { code: 'P4104' }))
    await expect(service.authorizeTerminal(personalSubject, principalOf(7), NODE_ID, { sessionId: 'sess-1' }, fence))
      .rejects.toMatchObject({ status: 503 })

    query.mockRejectedValueOnce(Object.assign(new Error('revoked'), { code: 'P4101' }))
    await expect(service.authorizeTerminal(personalSubject, principalOf(7), NODE_ID, { sessionId: 'sess-1' }, fence))
      .rejects.toMatchObject({ status: 403 })

    query.mockClear()
    await expect(service.authorizeTerminal(personalSubject, principalOf(99), NODE_ID, { sessionId: 'sess-1' }, fence))
      .rejects.toBeInstanceOf(ExecutionIdentityError)
    await expect(service.authorizeTerminal(personalSubject, principalOf(7), NODE_ID, { sessionId: 'sess-1', userId: 99 }, fence))
      .rejects.toMatchObject({ status: 400 })
    expect(query).not.toHaveBeenCalled()
  })

  it('uses single terminal_access_policies read and single CTE upsert on general path', async () => {
    const queries: string[] = []
    const client = fixtureQueryClient(sql => {
      queries.push(sql)
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return []
      if (sql.includes('FROM harness.instances')) return [{ ok: 1 }]
      if (sql.includes('SELECT id FROM harness.users')) return [{ id: 'actor-uuid' }]
      if (sql.includes('harness.computer_use_allowed')) return [{ id: 'actor-uuid', public_id: '7', role: 'user' }]
      if (sql.includes('FROM harness.terminal_access_policies')) return [{ user_id: 'actor-uuid', revision: '3' }]
      if (sql.includes('INSERT INTO harness.terminal_session_grants')) return [{ grant_id: GRANT_ID }]
      throw new Error(`Unexpected terminal authorization SQL: ${sql}`)
    })
    const pool = fixtureQueryPool(() => { throw new Error('Terminal authorization requires a transaction') })
    vi.spyOn(pool, 'connect').mockImplementation(async () => client)
    const service = new GatewayExecutionIdentity(pool, NODE_ID)

    const result = await service.authorizeTerminal(personalSubject, principalOf(7), NODE_ID, { sessionId: 'sess-1' })
    expect(result).toEqual({ userId: 7, grantId: GRANT_ID })
    // Verify no duplicate computer_use_allowed check and no separate fallback SELECT on terminal_session_grants.
    expect(queries.filter(sql => sql.includes('computer_use_allowed'))).toHaveLength(1)
    expect(queries.filter(sql => sql.includes('terminal_access_policies'))).toHaveLength(1)
    const grantQueries = queries.filter(sql => sql.includes('terminal_session_grants'))
    expect(grantQueries).toHaveLength(1)
    expect(grantQueries[0]).toContain('RETURNING grant_id')
    expect(grantQueries[0]).not.toContain('UNION ALL')
    expect(grantQueries[0]).not.toContain('WHERE g.generation<>EXCLUDED.generation')
  })
})
