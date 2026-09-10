/** Versioned browser persistence for named workbench layouts. */
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** One persisted named workbench layout. */
export interface WorkbenchLayout {
  id: string
  name: string
  paneIds: SessionId[]
  activePaneId?: SessionId
  paneRatios: number[]
  updatedAt: number
}
/** The versioned localStorage document holding the active and all saved layouts. */
export interface WorkbenchRegistrySnapshot { version: 1; activeId: string; workbenches: WorkbenchLayout[] }
const KEY = 'dsh.conversation.workbenches.v1'

/** Read layouts, migrating the former unnamed single layout.
 * @param fallback - the layout to persist when no stored registry exists.
 * @returns the stored or default registry snapshot.
 */
export function readWorkbenchRegistry(fallback: WorkbenchLayout): WorkbenchRegistrySnapshot {
  try {
    const raw = globalThis.localStorage.getItem(KEY)
    if (raw !== null) {
      const value: unknown = JSON.parse(raw)
      if (isSnapshot(value)) return value
    }
  } catch { /* malformed or unavailable storage uses the safe default */ }
  return { version: 1, activeId: fallback.id, workbenches: [fallback] }
}

/** Persist only layout metadata; callers should debounce writes.
 * @param snapshot - the current registry to persist.
 */
export function writeWorkbenchRegistry(snapshot: WorkbenchRegistrySnapshot): void {
  try { globalThis.localStorage.setItem(KEY, JSON.stringify(snapshot)) } catch { /* storage quota/private mode */ }
}

function isSnapshot(value: unknown): value is WorkbenchRegistrySnapshot {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<WorkbenchRegistrySnapshot>
  return row.version === 1 && typeof row.activeId === 'string' && Array.isArray(row.workbenches)
    && row.workbenches.every(item => typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.paneIds))
}
