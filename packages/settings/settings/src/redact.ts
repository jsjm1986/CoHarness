/**
 * Structural secret redaction for settings values. `role('secret')` fields are
 * removed from a value before it crosses a wire boundary; a sidecar records
 * each schema-declared secret position and whether it currently holds a value,
 * so a configuration surface can render a write-only input without ever
 * receiving the secret itself.
 * @module @deepseek-ai/dsh-settings/redact
 */

import type z from '@deepseek-ai/schemastery'

/**
 * Minimal structural view of a live schemastery node. Only the relations the
 * redactor walks are named; everything else on the instance is ignored.
 */
interface SchemaNode {
  type?: string
  meta?: { role?: unknown }
  /** `object` properties, keyed by property name. */
  dict?: Record<string, SchemaNode>
  /** `dict`/`array` element schema. */
  inner?: SchemaNode
  /** Union/tuple/intersection branch schemas. */
  list?: SchemaNode[]
}

/** One schema-declared secret position inside a redacted value. */
export interface RedactedSecret {
  /** Path from the section root to the removed field (concrete dict keys and array indexes included). */
  path: string[]
  /** Whether the field held a value before redaction. */
  set: boolean
}

/** A value with every `role('secret')` field removed, plus the removal record. */
export interface RedactedValue {
  /** Detached copy of the input with secret fields absent. */
  value: unknown
  /**
   * Every reachable secret position: object properties always (even unset, so
   * a form knows the slot exists), dict entries and array items only where the
   * value has them.
   */
  secrets: RedactedSecret[]
}

interface SerializedSchemaNode {
  type?: unknown
  meta?: Record<string, unknown>
  inner?: unknown
  sKey?: unknown
  list?: unknown
  dict?: unknown
}

interface SerializedSchemaEnvelope {
  uid?: unknown
  refs?: Record<string, SerializedSchemaNode>
}

/** Whether a value is a plain data object the walker may recurse into. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function schemaReferenceIds(node: SerializedSchemaNode): number[] {
  const ids: number[] = []
  const add = (value: unknown): void => {
    if (typeof value === 'number' && Number.isSafeInteger(value)) ids.push(value)
  }
  add(node.inner)
  add(node.sKey)
  if (Array.isArray(node.list)) for (const value of node.list) add(value)
  if (isRecord(node.dict)) for (const value of Object.values(node.dict)) add(value)
  return ids
}

/**
 * Remove serialized defaults from every schema node that can contain a secret.
 * @param schema - serialized schemastery schema envelope.
 * @returns a detached envelope with secret-containing defaults removed.
 */
export function redactSchemaDefaults(schema: unknown): unknown {
  if (!isRecord(schema) || !isRecord(schema.refs)) return schema
  const envelope = schema as SerializedSchemaEnvelope
  const refs = envelope.refs
  if (refs === undefined) return schema
  const memo = new Map<number, boolean>()
  const visiting = new Set<number>()
  const containsSecret = (id: number): boolean => {
    const known = memo.get(id)
    if (known !== undefined) return known
    const node = refs[String(id)]
    if (node === undefined) return false
    if (node.meta?.role === 'secret') {
      memo.set(id, true)
      return true
    }
    if (visiting.has(id)) return false
    visiting.add(id)
    const result = schemaReferenceIds(node).some(containsSecret)
    visiting.delete(id)
    memo.set(id, result)
    return result
  }
  if (typeof envelope.uid === 'number') containsSecret(envelope.uid)
  const cloned = structuredClone(schema) as SerializedSchemaEnvelope
  if (!isRecord(cloned.refs)) return cloned
  for (const [id, node] of Object.entries(cloned.refs)) {
    if (!containsSecret(Number(id)) || node.meta === undefined) continue
    const { default: _default, ...safeMeta } = node.meta
    node.meta = safeMeta
  }
  return cloned
}

function redactOpaque(value: unknown, path: string[], secrets: RedactedSecret[]): undefined {
  secrets.push({ path, set: value !== undefined })
  return undefined
}

/**
 * Determine whether a live schema node can reach a secret-role descendant.
 * Unions and transforms are kept intact when none of their branches contains a
 * secret; this avoids dropping ordinary enum settings merely because their
 * schema uses a non-object container. Once a secret is reachable, callers can
 * conservatively omit the opaque value without selecting a branch.
 */
function schemaSecretAnalyzer(): (node: SchemaNode | undefined) => boolean {
  const memo = new WeakMap<object, boolean>()
  const visiting = new Set<object>()
  const visit = (candidate: SchemaNode | undefined): boolean => {
    if (candidate === undefined || (typeof candidate !== 'object' && typeof candidate !== 'function')) return false
    if (candidate.meta?.role === 'secret') return true
    const object = candidate as object
    const known = memo.get(object)
    if (known !== undefined) return known
    if (visiting.has(object)) return false
    visiting.add(object)
    const result = (candidate.inner !== undefined && visit(candidate.inner))
      || (candidate.list?.some(visit) ?? false)
      || (candidate.dict !== undefined && Object.values(candidate.dict).some(visit))
    visiting.delete(object)
    memo.set(object, result)
    return result
  }
  return visit
}

function walk(
  node: SchemaNode | undefined,
  value: unknown,
  path: string[],
  secrets: RedactedSecret[],
  containsSecret: (node: SchemaNode | undefined) => boolean,
): unknown {
  if (node === undefined) return value
  if (node.meta?.role === 'secret') {
    secrets.push({ path, set: value !== undefined })
    return undefined
  }
  switch (node.type) {
    case 'object': {
      const properties = node.dict ?? {}
      const source = isRecord(value) ? value : undefined
      const rebuilt: Record<string, unknown> = {}
      if (source !== undefined) {
        for (const [key, entry] of Object.entries(source)) {
          if (Object.hasOwn(properties, key)) continue
          Object.defineProperty(rebuilt, key, { configurable: true, enumerable: true, value: entry, writable: true })
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        const stripped = walk(child, source?.[key], [...path, key], secrets, containsSecret)
        if (stripped !== undefined) Object.defineProperty(rebuilt, key, {
          configurable: true, enumerable: true, value: stripped, writable: true,
        })
      }
      return source === undefined && Object.keys(rebuilt).length === 0 ? value : rebuilt
    }
    case 'dict': {
      if (!isRecord(value)) return value
      const rebuilt: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        const stripped = walk(node.inner, entry, [...path, key], secrets, containsSecret)
        if (stripped !== undefined) Object.defineProperty(rebuilt, key, {
          configurable: true, enumerable: true, value: stripped, writable: true,
        })
      }
      return rebuilt
    }
    case 'array': {
      if (!Array.isArray(value)) return value
      return value.map((entry, index) => walk(node.inner, entry, [...path, String(index)], secrets, containsSecret))
    }
    // Leaf schemas do not contain child positions. Preserve their values even
    // when they carry non-secret renderer metadata such as `credential-ref`.
    case 'any':
    case 'never':
    case 'const':
    case 'string':
    case 'number':
    case 'boolean':
    case 'bitset':
    case 'function':
    case 'is':
    case 'regexp':
    case 'json':
      return value
    case 'union':
    case 'intersect':
    case 'tuple':
    case 'transform':
    case 'lazy':
    default:
      // The runtime schema can carry secret fields behind these nodes, but the
      // redactor cannot select a branch without re-running owner code. Never
      // return a secret-bearing value verbatim. Schemas without a secret
      // descendant are safe to preserve (for example a union of enum values).
      if (containsSecret(node)) {
        redactOpaque(value, path, secrets)
        return undefined
      }
      return value
  }
}

/**
 * Remove every `role('secret')` field a schema declares from a value. The
 * walker follows `object`, `dict`, and `array` containers. A union, tuple,
 * intersection, transform, or lazy node is treated as opaque: its value is
 * omitted and recorded rather than returned, because the redactor cannot
 * prove which nested fields are safe without executing schema owner code. The
 * input is never mutated.
 * @param schema - live schemastery schema describing the value.
 * @param value - the value to strip; `undefined` yields an empty record with
 *   object-property secret slots still enumerated.
 * @returns the stripped detached value and the ordered secret positions.
 */
export function redactSecrets(schema: z<never>, value: unknown): RedactedValue {
  const secrets: RedactedSecret[] = []
  // Share one analyzer across the entire walk. Rebuilding its memo for every
  // opaque union/transform node turns a wide schema into repeated traversals.
  const containsSecret = schemaSecretAnalyzer()
  const stripped = walk(schema, value, [], secrets, containsSecret)
  return { value: stripped, secrets }
}
