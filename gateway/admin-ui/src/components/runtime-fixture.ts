/** Stable instance metadata for Admin interaction tests; no timers, ports or live services. */
import type { RuntimeCatalogEntry, RuntimeCatalogPage, RuntimeId, RuntimeNodeId } from '../api.ts'

/** @param kind - allocation owner kind. @param id - public owner id. @returns a stable stopped or running assignment on the fixture computer. */
export function runtimeFixture(kind: 'user' | 'project', id: number): RuntimeCatalogEntry {
  return { id: `10000000-0000-4000-8000-${String(kind === 'user' ? id : id + 1000).padStart(12, '0')}` as RuntimeId,
    owner: { kind: kind === 'user' ? 'personal' : 'project', id, name: `${kind} ${id}` },
    node: { id: 'node-a' as RuntimeNodeId, name: 'Computer A', status: 'active', lastHeartbeatAt: null },
    generation: 3, observedState: 'ready', routing: 'local', provisioning: 'ready' }
}

/** @param kind - allocation owner kind. @param id - public owner id. @returns a complete one-item directory page. */
export function runtimePageFixture(kind: 'user' | 'project', id: number): RuntimeCatalogPage {
  return { items: [runtimeFixture(kind, id)], nextCursor: null }
}
