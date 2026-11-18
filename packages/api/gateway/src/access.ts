/**
 * Resource resolution for non-owner access decisions: the resources one
 * forwarded event touches, read from Typert-validated arguments.
 * @module @deepseek-ai/dsh-api-gateway/src/access
 */

import type {
  RemoteAccessResource,
  TypertResourceReader,
} from '@deepseek-ai/dsh-typert-protocol'

const GLOBAL: readonly RemoteAccessResource[] = Object.freeze([Object.freeze({ kind: 'global' })])

/** Resource ids one source produced for a kind, or `invalid` for a malformed value. */
type ResourceIds = readonly unknown[] | 'invalid'

/**
 * Resolve the resources one forwarded event notification touches. An event
 * carries every resource it declares, so a reader returning `undefined`
 * makes the notification invalid instead of a global one.
 * @param readers - the event entry's declared readers, or `undefined` when it declares none.
 * @param args - the event's validated JSON arguments, passed to each reader as its positional arguments.
 * @returns the global resource alone without readers, including an empty
 *   reader set; otherwise the touched resources; `undefined` when the
 *   resources are invalid: a resource id is missing or malformed.
 */
export function eventResources(
  readers: Readonly<Record<string, TypertResourceReader>> | undefined,
  args: readonly unknown[],
): readonly RemoteAccessResource[] | undefined {
  const declared = Object.entries(readers ?? {})
  if (declared.length === 0) return GLOBAL
  const resources: RemoteAccessResource[] = []
  for (const [kind, reader] of declared) {
    if (!collect(resources, kind, read(() => reader(...args), 'invalid'))) return undefined
  }
  return resources
}

/** Read resource identities: `undefined` yields `absent`, a list names several and must not be empty. */
function read(reader: () => unknown, absent: ResourceIds): ResourceIds {
  let value: unknown
  try {
    value = reader()
  } catch {
    // Any reader error means it cannot name its resources, so they are invalid.
    return 'invalid'
  }
  if (value === undefined) return absent
  if (!Array.isArray(value)) return [value]
  return value.length === 0 ? 'invalid' : value
}

/** Append one kind's resource ids; false when any is malformed. */
function collect(resources: RemoteAccessResource[], kind: string, ids: ResourceIds): boolean {
  if (ids === 'invalid') return false
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) return false
    // Kinds come from registrations, lookups, Context adapters, and reader keys, all typed by the merged resource map.
    resources.push({ kind, id } as RemoteAccessResource)
  }
  return true
}
