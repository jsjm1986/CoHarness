/** Read-only management catalog, available even when the Host has no managed profile. */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from './index.ts'
import type { PluginManagementCatalog } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** One authorized plugin-management catalog read without a required profile provider. */
    pluginManagerCatalog: PluginManagerCatalogGateway
  }
}

/** Aggregate the existing profile reads without allocating a second management owner or cache. */
export class PluginManagerCatalogGateway extends TypertRemoteService {
  private readonly abort = new AbortController()
  private readonly reads = new Set<Promise<PluginManagementCatalog>>()

  constructor(ctx: Context) {
    super(ctx, 'pluginManagerCatalog', { namespace: 'pluginManager' })
    ctx.effect(() => async () => {
      this.abort.abort()
      await Promise.allSettled([...this.reads])
    }, 'plugin-manager: catalog read lifetime')
  }

  /**
   * Read current profile availability, mutation authority, bundles, and entries.
   * Transport authorization precedes invocation, including the administrator assertion.
   * A missing profile reads no files; a refused read publishes no catalog.
   * @param signal - cancellation of this request; disposal also cancels publication and drains reads.
   * @returns live catalog values, without an atomic profile-revision guarantee.
   */
  @Remote
  catalog(signal: AbortSignal): Promise<PluginManagementCatalog> {
    const operation = this.read(AbortSignal.any([signal, this.abort.signal]))
    this.reads.add(operation)
    const settled = (): void => { this.reads.delete(operation) }
    void operation.then(settled, settled)
    return operation
  }

  private async read(signal: AbortSignal): Promise<PluginManagementCatalog> {
    signal.throwIfAborted()
    const manager = this.ctx.get('pluginManager')
    if (manager === undefined) return { managementAvailable: false, manage: false, bundles: [], plugins: [] }
    await manager.authorize('read')
    signal.throwIfAborted()
    const pending = [manager.listBundles(), manager.listPlugins(), manager.access()] as const
    try {
      const [bundles, plugins, access] = await Promise.all(pending)
      signal.throwIfAborted()
      await manager.authorize('read')
      signal.throwIfAborted()
      return { managementAvailable: true, manage: access.manage, bundles, plugins }
    } finally {
      await Promise.allSettled(pending)
    }
  }
}

export default PluginManagerCatalogGateway
