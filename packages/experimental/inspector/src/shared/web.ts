/** Browser bootstrap, origin admission, and per-connection DevTools source selection. */

import { inspectorId, type InspectorSourceId } from './bridge/ids.ts'
import type { InspectorSourceDescriptor } from './bridge/messages/observation.ts'
import type { CordisRuntimeSource } from './cordis/model.ts'

/** Read the current browser-source connection parameters. */
export const INSPECTOR_BOOTSTRAP_PATH = '/api/experimental-inspector/bootstrap'

/** Document-relative browser route for the authenticated source bootstrap. */
export const INSPECTOR_BOOTSTRAP_ROUTE = INSPECTOR_BOOTSTRAP_PATH.slice(1)

/** Query parameter selecting the Client visible beside Host in one DevTools connection. */
export const INSPECTOR_CLIENT_QUERY = 'clientSourceId'

/** Query parameter selecting a Host-only DevTools connection when set to `host`. */
export const INSPECTOR_SOURCE_SCOPE_QUERY = 'sourceScope'

/** Undefined includes every Client, null excludes Clients, and an id selects one Client. */
export type InspectorClientSelection = InspectorSourceId | null | undefined

/**
 * Check the browser-origin policy shared by Client startup and Worker ingest.
 * @param origin - Browser origin from the document or WebSocket upgrade.
 * @param clientOrigins - Additional exact origins configured by the Host.
 * @returns Whether the origin is loopback or explicitly admitted.
 */
export function isInspectorClientOriginAllowed(origin: string, clientOrigins: readonly string[]): boolean {
  if (clientOrigins.includes(origin)) return true
  try {
    const hostname = new URL(origin).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * Read Client inclusion from a DevTools frontend or WebSocket URL.
 * @param url - Untrusted upgrade URL.
 * @returns The selected Client id, null for Host only, or undefined for all Clients.
 * @throws If selectors are invalid, repeated, or combined.
 */
export function readInspectorClientSelection(url: URL): InspectorClientSelection {
  const values = url.searchParams.getAll(INSPECTOR_CLIENT_QUERY)
  const scopes = url.searchParams.getAll(INSPECTOR_SOURCE_SCOPE_QUERY)
  if (scopes.length > 0) {
    if (scopes.length !== 1 || scopes[0] !== 'host' || values.length > 0) {
      throw new Error('Inspector sourceScope must be host and cannot accompany clientSourceId')
    }
    return null
  }
  const selected = values[0]
  if (selected === undefined) return undefined
  if (values.length !== 1) throw new Error('Inspector Client selection must occur once')
  return inspectorId<'InspectorSourceId'>(selected, INSPECTOR_CLIENT_QUERY)
}

/**
 * Include Host and the Clients selected by one DevTools connection.
 * @param selection - Parsed connection selection.
 * @param source - Bridge descriptor or consumer-neutral Cordis source.
 * @returns Whether this connection includes the source.
 */
export function isInspectorSourceSelected(
  selection: InspectorClientSelection,
  source: Pick<InspectorSourceDescriptor, 'kind' | 'sourceId'> | CordisRuntimeSource,
): boolean {
  return selection === undefined || source.kind === 'host' || source.sourceId === selection
}
