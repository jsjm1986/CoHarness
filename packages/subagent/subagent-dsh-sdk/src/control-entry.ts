/** Managed child entry selection for source launches and published SDK providers. */
import { existsSync } from 'node:fs'

/**
 * Resolve the child bootstrap relative to the loaded provider module.
 * @param providerModule - actual source or bundled provider module URL.
 * @returns built bootstrap when available, or the declared source-launch entry on a clean checkout.
 */
export function managedControlEntry(providerModule: URL): URL {
  if (!providerModule.pathname.endsWith('.ts')) return new URL('./managed.js', providerModule)
  const built = new URL('../lib/managed.js', providerModule)
  return existsSync(built) ? built : new URL('./managed.ts', providerModule)
}
