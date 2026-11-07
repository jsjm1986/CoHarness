/** Explicit Host and Client selection for DevTools connections. */

import { inspectorId, type InspectorSourceId } from './bridge/ids.ts'
import type { InspectorSourceDescriptor } from './bridge/messages/observation.ts'
import type { CordisRuntimeSource } from './cordis/model.ts'

/** Query parameter selecting the Client visible beside Host in one DevTools connection. */
export const INSPECTOR_CLIENT_QUERY = 'clientSourceId'

/** Query parameter selecting a Host-only DevTools connection when set to `host`. */
export const INSPECTOR_SOURCE_SCOPE_QUERY = 'sourceScope'

/** Undefined includes every Client, null excludes Clients, and an id selects one Client. */
export type InspectorClientSelection = InspectorSourceId | null | undefined

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
