/** A recovery ingress guard cannot adopt another import or silently reopen on a failed read. */
import { describe, expect, it, vi } from 'vitest'
import { GovernanceRebuildAdmission } from '../src/governance-rebuild-admission.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { fixtureQueryPool } from './postgres-query-fixture.ts'

const initial = { operationId: 'operation', bootstrapUserId: 7, state: 'review',
  targetNodeId: 'replacement', recoveryEpoch: '3', writeEpoch: '12' }

function fixture(row: typeof initial | undefined = initial) {
  const query = vi.fn(async () => ({ rows: row === undefined ? [] : [{ ...row }] }))
  const pool = fixtureQueryPool(async () => (await query()).rows)
  const context: PostgresRuntimeContext = {
    pool, organizationId: 'organization', organizationSlug: 'fixture', nodeId: 'replacement', nodeName: 'fixture',
  }
  return { query, context }
}

describe('governance recovery admission', () => {
  it('leaves an ordinary organization without a request-time guard', async () => {
    const f = fixture()
    f.query.mockResolvedValue({ rows: [] })
    expect(await GovernanceRebuildAdmission.open(f.context, 12n)).toBeUndefined()
    expect(f.query).toHaveBeenCalledOnce()
  })

  it('keeps review restricted and caches only the release of the bound import', async () => {
    const f = fixture()
    const gate = await GovernanceRebuildAdmission.open(f.context, 12n)
    expect(await gate!.admission()).toEqual({ operationId: 'operation', bootstrapUserId: 7, state: 'review' })
    f.query.mockResolvedValue({ rows: [{ ...initial, state: 'released' }] })
    expect(await gate!.admission()).toMatchObject({ state: 'released' })
    f.query.mockRejectedValue(new Error('unrelated later pool failure'))
    expect(await gate!.admission()).toMatchObject({ state: 'released' })
    expect(f.query).toHaveBeenCalledTimes(3)
  })

  it('does not add request-time lookups after restarting a released recovery', async () => {
    const f = fixture({ ...initial, state: 'released' })
    const gate = await GovernanceRebuildAdmission.open(f.context, 12n)
    expect(await gate!.admission()).toMatchObject({ state: 'released' })
    expect(f.query).toHaveBeenCalledOnce()
  })

  it('still fences dedicated recovery operations after a cached release', async () => {
    const f = fixture({ ...initial, state: 'released' })
    const gate = await GovernanceRebuildAdmission.open(f.context, 12n)
    await gate!.verifyAdministration()
    f.query.mockResolvedValue({ rows: [{ ...initial, state: 'released', writeEpoch: '13' }] })
    await expect(gate!.verifyAdministration()).rejects.toMatchObject({ status: 503 })
    f.query.mockResolvedValue({ rows: [initial] })
    await expect(gate!.verifyAdministration()).rejects.toMatchObject({ status: 503 })
  })

  it.each([
    { operationId: 'another' }, { bootstrapUserId: 8 }, { targetNodeId: 'another' },
    { recoveryEpoch: '4' }, { writeEpoch: '13' },
  ])('refuses a changed binding: %j', async change => {
    const f = fixture()
    const gate = await GovernanceRebuildAdmission.open(f.context, 12n)
    f.query.mockResolvedValue({ rows: [{ ...initial, ...change, state: 'released' }] })
    await expect(gate!.admission()).rejects.toMatchObject({ status: 503, code: 'peer-backup/governance-admission-unavailable' })
  })

  it('refuses a missing or unreadable recovery while review is pending', async () => {
    const f = fixture()
    const gate = await GovernanceRebuildAdmission.open(f.context, 12n)
    f.query.mockResolvedValue({ rows: [] })
    await expect(gate!.admission()).rejects.toMatchObject({ status: 503 })
    const error = new Error('database unavailable')
    f.query.mockRejectedValue(error)
    await expect(gate!.admission()).rejects.toBe(error)
  })

  it('refuses an epoch change during startup', async () => {
    const f = fixture()
    await expect(GovernanceRebuildAdmission.open(f.context, 11n)).rejects.toMatchObject({ status: 503 })
  })
})
