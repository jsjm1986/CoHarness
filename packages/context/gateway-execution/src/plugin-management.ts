/** Fresh Gateway role checks for profile operations, independent of tool approval. */
import type {
  PluginDesiredState,
  PluginDesiredStatePublish,
  PluginDesiredStateSnapshot,
  PluginManagementAuthorization,
} from '@deepseek-ai/dsh-plugin-manager/types'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { GatewayRuntime } from '@deepseek-ai/dsh-gateway-runtime'

const protectedModules = new Set([
  '@deepseek-ai/dsh-gateway-runtime',
  '@deepseek-ai/dsh-gateway-execution',
  '@deepseek-ai/dsh-collaboration',
  '@deepseek-ai/dsh-collaboration-gateway',
  '@deepseek-ai/dsh-collaboration-context',
  '@deepseek-ai/dsh-session-persistence-gateway',
  '@deepseek-ai/dsh-model-governance',
  '@deepseek-ai/dsh-directory-guard',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-archive-gateway',
])

const pluginStatePath = '/internal/runtime/plugin-state'

/** Bind management authorization to the authenticated runtime and its lifetime.
 * @param runtime - Gateway request context and authenticated transport.
 * @param signal - Aborts when the authorizing provider unloads.
 * @returns Policy that rejects missing, restricted, expired or revoked administrators.
 */
export function gatewayPluginManagementAuthorization(
  runtime: Pick<GatewayRuntime, 'current' | 'request'>, signal: AbortSignal,
): PluginManagementAuthorization {
  return {
    protectedModules,
    async authorize(capability = 'manage') {
      signal.throwIfAborted()
      if (capability === 'read') return
      const principal = runtime.current()
      // The Gateway endpoint decides who manages: administrators and
      // qualified members both reach it, while restricted-purpose and expired
      // assertions never leave this runtime.
      if (principal === undefined
        || (principal.claims.purpose !== undefined && principal.claims.purpose !== 'plugin-admin') || principal.claims.expiresAt <= Date.now()) {
        throw new RemoteError('plugin-management/forbidden', 'Profile management requires an authenticated account.', {})
      }
      const response = await runtime.request('/internal/runtime/plugin-management/authorize', {
        method: 'POST', principal, signal,
      })
      if (response.status !== 204) {
        await response.body?.cancel()
        throw new RemoteError('plugin-management/forbidden', 'The Gateway did not authorize profile management.', {})
      }
    },
    async readDesiredState(): Promise<PluginDesiredStateSnapshot> {
      signal.throwIfAborted()
      const response = await runtime.request(pluginStatePath, { method: 'GET', signal })
      if (response.status !== 200) {
        await response.body?.cancel()
        throw new Error(`Gateway plugin-state read failed: ${response.status}`)
      }
      return await response.json() as PluginDesiredStateSnapshot
    },
    async publishDesiredState(state: PluginDesiredState, baseRevision: string): Promise<PluginDesiredStatePublish> {
      signal.throwIfAborted()
      const response = await runtime.request(pluginStatePath, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, baseRevision }),
      })
      if (response.status === 200) {
        const body = await response.json() as { revision: string }
        return { status: 'applied', revision: body.revision }
      }
      if (response.status === 409) {
        const current = await response.json() as PluginDesiredStateSnapshot
        return { status: 'conflict', current }
      }
      await response.body?.cancel()
      throw new Error(`Gateway plugin-state publish failed: ${response.status}`)
    },
  }
}
