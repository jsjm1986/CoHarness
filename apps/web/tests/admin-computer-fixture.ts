/** Single-computer metadata for built Admin form fixtures; node execution is tested against PostgreSQL separately. */
import type { GatewayDeps } from '../../../gateway/src/server.ts'
import type { RuntimeNodeId } from '../../../gateway/src/runtime-catalog.ts'

/** @param deps - isolated form server whose computer directory and allocation defaults are read-only. */
export function installAdminComputerFixture(deps: GatewayDeps): void {
  const unavailable = async (): Promise<never> => { throw new Error('This form fixture does not mutate computer enrollment or Runtime allocations') }
  deps.cfg.computeNodeName = 'fixture-computer'
  deps.nodeServiceIdentity = { nodeId: '10000000-0000-4000-8000-000000000001' as RuntimeNodeId,
    organizationId: 'form-fixture', authorize: unavailable }
  const entry = { nodeId: deps.nodeServiceIdentity.nodeId, name: deps.cfg.computeNodeName }
  const policy = { mode: 'single' as const, revision: '0', entry, primary: null, scope: 'local' as const,
    role: 'standalone' as const, refreshAfterMs: 30000, legacyMigrationRequired: false }
  deps.topology = { read: async () => policy, adminRead: async () => policy, save: unavailable,
    preflight: async () => ({ canDisable: true, blockingCount: 0, computers: [] }), candidates: unavailable,
    assertNode: async (nodeId) => { if (nodeId !== entry.nodeId) throw new Error('This form fixture only exposes its local computer') } }
  deps.nodeAccess = { list: async () => ({ items: [], nextCursor: null }), issue: unavailable, mutate: unavailable,
    enroll: unavailable, connect: unavailable, heartbeat: unavailable, disconnect: unavailable }
  deps.runtimeManagement = { policy: async () => ({ revision: '1', maxTotal: 16, maxPerNode: 4, source: 'organization' }),
    setPolicy: unavailable, allocate: unavailable, allocationReceipt: unavailable, retire: unavailable }
}
