/** Exact-account observation URLs neither authorize execution nor share a tab selection. */
import { describe, expect, it } from 'vitest'
import { RuntimeStartObservations } from '../src/runtime-start-observation.ts'
import type { RuntimeCatalogEntry, RuntimeId, RuntimeNodeId } from '../src/runtime-catalog.ts'

const environment: RuntimeCatalogEntry = {
  id: '10111111-1111-4111-8111-111111111111' as RuntimeId,
  node: { id: '61f22202-1c02-4a3c-8d34-f11222333444' as RuntimeNodeId, name: 'Remote', status: 'active', lastHeartbeatAt: null },
  owner: { kind: 'personal', id: 1, name: 'User' }, routing: 'unavailable', observedState: 'starting', generation: 1,
}

describe('read-only start observation', () => {
  it('binds independent URLs to their exact account, computer, Runtime and space', () => {
    const owner = new RuntimeStartObservations(30_000)
    const first = new URL(owner.issue(1, environment, 'personal'), 'http://gateway').searchParams.get('observation')!
    const second = new URL(owner.issue(1, { ...environment, id: '20111111-1111-4111-8111-111111111111' as RuntimeId }, 'project:7'), 'http://gateway').searchParams.get('observation')!
    expect(owner.read(first, 1)).toMatchObject({ userId: 1, nodeId: environment.node.id, runtimeId: environment.id, target: 'personal' })
    expect(owner.read(second, 1)).toMatchObject({ target: 'project:7', runtimeId: '20111111-1111-4111-8111-111111111111' })
    expect(owner.read(first, 2)).toBeNull()
    expect(new RuntimeStartObservations(30_000).read(first, 1)).toBeNull()
    const [payload, signature] = first.split('.')
    const changed = JSON.parse(Buffer.from(payload!, 'base64url').toString())
    changed.nodeId = '71f22202-1c02-4a3c-8d34-f11222333444'
    expect(owner.read(Buffer.from(JSON.stringify(changed)).toString('base64url') + '.' + signature, 1)).toBeNull()
    for (const invalid of [null, '', 'invalid', 'x'.repeat(2049), first + '.extra']) expect(owner.read(invalid, 1)).toBeNull()
  })
})
