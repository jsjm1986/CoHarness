/**
 * `remote.<ns>` services for the whole-client tier, without the generated
 * Remote clients. Cordis resolves `ctx.remote.<ns>` to whichever service is
 * registered under `remote.<ns>` (vendored cordis `utils.ts`, traceable get),
 * so the carrier provides one Proxy per namespace: `remote.<ns>.<method>(...args)`
 * calls the endpoint `<ns>/<method>` over the roster's own Connection with the
 * positional `args`, as a stream when the mock registered a stream script for
 * it and as a unary call otherwise. The result folds the way the generated
 * namespace service folds a carrier outcome: `{ ok: true, value }` passes
 * through, `{ ok: false }` rebuilds its wire failure as a `RemoteError`, and a
 * carrier throw becomes `gateway/internal` (or `gateway/cancelled` once the
 * caller's signal aborted), so product code that never awaits a rejection sees
 * none; stream items and failures pass through as the stream yields them.
 * @module @deepseek-ai/dsh-client-test-runtime/src/assembly/remote-proxies
 */
import type { Context } from '@deepseek-ai/cordis'
import { cancelledFailure, carrierFailure, rebuiltFailure, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import {
  ConnectionRpcStreamInterrupted,
  type ClientConnectionRpc,
  type ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import type { ClientPluginModule } from './roster.ts'

/** The assembly row the proxies stand in for; its generated clients exist only in built `lib/`. */
export const REMOTES_PACKAGE = '@deepseek-ai/dsh-api-remotes'

const PREFIX = 'remote.'

/**
 * Namespaces to provide: every `remote.<ns>` a roster module injects, plus the
 * namespace of every `<ns>/<method>` endpoint the mock has a rule for.
 * @param modules - loaded roster modules.
 * @param mock - the spec's mock.
 * @returns sorted namespace names.
 */
export function remoteNamespacesOf(modules: Iterable<ClientPluginModule>, mock: RemoteMock): readonly string[] {
  const names = new Set<string>()
  for (const module of modules) {
    for (const service of injectNames(module.inject)) if (service.startsWith(PREFIX)) names.add(service.slice(PREFIX.length))
  }
  for (const endpoint of mock.endpoints()) {
    const slash = endpoint.indexOf('/')
    if (slash > 0 && !endpoint.startsWith('$')) names.add(endpoint.slice(0, slash))
  }
  return [...names].sort()
}

function injectNames(inject: ClientPluginModule['inject']): readonly string[] {
  if (inject === undefined) return []
  if (Array.isArray(inject)) return inject as readonly string[]
  return Object.keys(inject)
}

/**
 * Plugin providing the namespace proxies; `TestClient.start` mounts it before the Loader rows.
 * @param namespaces - namespaces to provide.
 * @param mock - the spec's mock, asked for each endpoint's mode.
 * @returns the plugin.
 */
export function remoteProxiesPlugin(namespaces: readonly string[], mock: RemoteMock): ClientPluginModule {
  return {
    inject: ['connection'],
    apply(ctx: Context) {
      const connection = ctx.get('connection') as ConnectionHandle
      for (const namespace of namespaces) ctx.provide(`${PREFIX}${namespace}`, namespaceProxy(namespace, connection.rpc, mock))
    },
  }
}

function namespaceProxy(namespace: string, rpc: ClientConnectionRpc, mock: RemoteMock): object {
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get: (_target, property) => {
      // No `then`: awaiting the namespace object itself must not call a method.
      if (typeof property !== 'string' || property === 'then') return undefined
      return (...values: readonly unknown[]): unknown => {
        const endpoint = `${namespace}/${property}`
        const args = [...values]
        const signal = args.at(-1) instanceof AbortSignal ? (args.pop() as AbortSignal) : undefined
        if (mock.modeOf(endpoint) === 'stream') {
          const stream = rpc.stream?.bind(rpc)
          if (stream === undefined) throw new Error(`client-test-runtime: ${endpoint} is a stream but the carrier has no stream channel`)
          return streamEndpoint(endpoint, stream, { args }, signal ?? new AbortController().signal)
        }
        return callEndpoint(endpoint, rpc, { args }, signal)
      }
    },
  })
}

/** Unary call folded like the generated namespace service's direct invocation. */
async function callEndpoint(
  endpoint: string,
  rpc: ClientConnectionRpc,
  payload: unknown,
  signal: AbortSignal | undefined,
): Promise<RemoteResult<unknown>> {
  try {
    const result = await rpc.call('/api', endpoint, payload, signal)
    if (!result.ok) return { ok: false, error: rebuiltFailure(result.error) }
    return { ok: true, value: result.value }
  } catch (error) {
    if (signal?.aborted === true) return cancelledFailure(endpoint, error)
    return carrierFailure(endpoint, error)
  }
}

/** Stream items folded like the generated namespace service's stream invocation. */
async function* streamEndpoint(
  endpoint: string,
  stream: ClientConnectionRpc['stream'] & {},
  payload: unknown,
  signal: AbortSignal,
): AsyncGenerator<unknown, void, undefined> {
  try {
    for await (const result of stream('/api', endpoint, payload, signal)) {
      signal.throwIfAborted()
      if (!result.ok) throw rebuiltFailure(result.error)
      yield result.value
    }
  } catch (error) {
    if (signal.aborted) throw cancelledFailure(endpoint, error).error
    if (error instanceof ConnectionRpcStreamInterrupted) {
      throw new RemoteStreamCarrierError(error.message, { cause: error })
    }
    throw error
  }
}
