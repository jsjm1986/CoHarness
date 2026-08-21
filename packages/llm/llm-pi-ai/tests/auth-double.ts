import type { Credential } from '@earendil-works/pi-ai'
import type { PiAiAuthInjection } from '../src/adapter.ts'

/**
 * Auth injectables for adapter tests that exercise streaming rather than
 * authentication. The in-memory store keeps the test independent of the
 * user's Harness home and the ambient context deliberately finds nothing.
 * @param seed - credentials keyed by pi-ai provider id.
 * @returns an auth injection and its observable store.
 */
export function memoryAuth(seed: Record<string, Credential> = {}): PiAiAuthInjection & {
  stored: Map<string, Credential>
} {
  const stored = new Map(Object.entries(seed))
  return {
    stored,
    credentials: {
      read: id => Promise.resolve(stored.get(id)),
      list: () => Promise.resolve([...stored].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }))),
      async modify(id, mutate) {
        const next = await mutate(stored.get(id))
        if (next !== undefined) stored.set(id, next)
        return stored.get(id)
      },
      delete: (id) => {
        stored.delete(id)
        return Promise.resolve()
      },
    },
    authContext: {
      env: () => Promise.resolve(undefined),
      fileExists: () => Promise.resolve(false),
    },
  }
}
