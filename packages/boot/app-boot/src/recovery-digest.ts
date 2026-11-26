/** Deterministic JSON digests shared by sealed composition and connector permissions. */
import { createHash } from 'node:crypto'

/** Hash bytes without retaining them.
 * @param value UTF-8 text or exact file bytes.
 * @returns Lowercase SHA-256.
 */
export function recoveryHash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }

/** Serialize literal configuration with stable object-key order.
 * @param value Parsed configuration; undefined object fields are omitted.
 * @returns Deterministic JSON text.
 */
export function recoveryCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(recoveryCanonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${recoveryCanonical(v)}`).join(',')}}`
  const encoded: unknown = JSON.stringify(value)
  return typeof encoded === 'string' ? encoded : 'null'
}
