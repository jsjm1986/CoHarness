/** Fresh Gateway role checks for profile operations, independent of tool approval. */
import type {
  InstallSpecKind,
  ParsedInstallSpec,
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

/**
 * The spec forms the organization lets a managed profile install from, keyed by
 * kind. A kind's host set is undefined when every host is allowed; git and
 * tarball specs carrying a host not in the set are refused. Registry specs
 * resolve through the profile's own registries, so no host list applies.
 */
export type InstallSourcePolicy = ReadonlyMap<InstallSpecKind, ReadonlySet<string> | undefined>

const INSTALL_SOURCE_KINDS: readonly InstallSpecKind[] = ['registry', 'path', 'git', 'tarball']

/**
 * Read `HGW_PLUGIN_INSTALL_SOURCES`: comma-separated `kind` or `kind:host`
 * entries. A bare kind allows the whole form; a `kind:host` entry restricts the
 * kind to that host. The absent or empty variable means registry specs only.
 * @param raw - the environment value, when set.
 * @returns the policy map; an unknown or malformed entry throws at startup.
 */
export function parseInstallSourcePolicy(raw: string | undefined): InstallSourcePolicy {
  const policy = new Map<InstallSpecKind, Set<string> | undefined>()
  for (const entry of (raw ?? '').split(',').map(part => part.trim()).filter(part => part !== '')) {
    const colon = entry.indexOf(':')
    const kind = colon === -1 ? entry : entry.slice(0, colon)
    const host = colon === -1 ? undefined : entry.slice(colon + 1).toLowerCase()
    if (!INSTALL_SOURCE_KINDS.includes(kind as InstallSpecKind) || host === '') {
      throw new Error(`HGW_PLUGIN_INSTALL_SOURCES: unknown entry ${JSON.stringify(entry)}`)
    }
    const key = kind as InstallSpecKind
    if (host === undefined) policy.set(key, undefined)
    else if (policy.get(key) !== undefined || !policy.has(key)) {
      policy.set(key, new Set([...(policy.get(key) ?? []), host]))
    }
  }
  if (!policy.has('registry')) policy.set('registry', undefined)
  return policy
}

/** Bind management authorization to the authenticated runtime and its lifetime.
 * @param runtime - Gateway request context and authenticated transport.
 * @param signal - Aborts when the authorizing provider unloads.
 * @param sources - the deployment's install-source policy; omitted allows every spec form.
 * @returns Policy that rejects missing, restricted, expired or revoked administrators.
 */
export function gatewayPluginManagementAuthorization(
  runtime: Pick<GatewayRuntime, 'current' | 'request'>, signal: AbortSignal,
  sources?: InstallSourcePolicy,
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
    async authorizeInstall(spec: ParsedInstallSpec): Promise<void> {
      signal.throwIfAborted()
      if (sources === undefined) return
      const host = 'host' in spec ? spec.host : undefined
      const rule = sources.get(spec.kind)
      if (sources.has(spec.kind) && (rule === undefined || host === undefined || rule.has(host))) return
      throw new RemoteError(
        'plugin-management/install-source',
        `The organization does not allow installing plugins from ${spec.kind}${host === undefined ? '' : ` host ${host}`} specs.`,
        {},
      )
    },
  }
}
