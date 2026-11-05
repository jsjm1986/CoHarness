/** Bounded, node-owned predecessor values used when a duplicated tab still references an earlier receipt. */
export interface DraftValue { revision: number; text: string }
/** Per-owner retention budget for superseded node draft receipts. */
export interface DraftHistoryLimits { revisions: number; bytes: number }
/** Per-draft retention defaults. The current value and independently owned tabs are outside this window. */
export const defaultDraftHistoryLimits: DraftHistoryLimits = { revisions: 16, bytes: 256 * 1024 }

/** Parse the private serialized history without accepting malformed revisions or content.
 * @param raw - serialized newest-first predecessor list.
 * @returns validated immutable receipt values.
 */
export function decodeDraftHistory(raw: string): DraftValue[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('Invalid stored draft history')
  let previous = Number.MAX_SAFE_INTEGER
  for (const row of parsed as unknown[]) {
    if (typeof row !== 'object' || row === null || !('revision' in row) || typeof row.revision !== 'number'
      || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision >= previous || !('text' in row) || typeof row.text !== 'string') {
      throw new Error('Invalid stored draft revision')
    }
    previous = row.revision
  }
  return parsed as DraftValue[]
}

/** Retain a newest-first contiguous window under both count and serialized UTF-8 limits.
 * @param current - the committed row that the new revision supersedes.
 * @param raw - its previous retained versions.
 * @param limits - per-draft count and byte budgets.
 * @returns the serialized predecessors for the replacement row.
 */
export function retainDraftHistory(current: DraftValue, raw: string, limits: DraftHistoryLimits): string {
  if (!current.revision || limits.revisions === 0 || limits.bytes < 2) return '[]'
  const old = decodeDraftHistory(raw)
  if (old[0] && old[0].revision >= current.revision) throw new Error('Invalid stored draft predecessor')
  const entries: string[] = []
  let bytes = 2
  for (const row of [current, ...old]) {
    if (entries.length === limits.revisions) break
    const encoded = JSON.stringify({ revision: row.revision, text: row.text })
    bytes += Buffer.byteLength(encoded) + (entries.length ? 1 : 0)
    if (bytes > limits.bytes) break
    entries.push(encoded)
  }
  return '[' + entries.join(',') + ']'
}

/** Read exactly the pinned version, or report that the owner no longer retains it.
 * @param current - current committed value for this authenticated owner.
 * @param revision - requested snapshot, or undefined for the current value.
 * @param history - owner-scoped predecessors.
 * @returns the requested receipt, or a historical version miss.
 */
export function pinnedDraftValue(current: DraftValue, revision: number | undefined, history: string):
  { status: 200; value: DraftValue & { currentRevision?: number } } | { status: 410 } {
  if (revision === undefined) return { status: 200, value: current }
  if (revision > current.revision) return { status: 410 }
  const row = revision === current.revision ? current : decodeDraftHistory(history).find(item => item.revision === revision)
  return row ? { status: 200, value: { ...row, currentRevision: current.revision } } : { status: 410 }
}
