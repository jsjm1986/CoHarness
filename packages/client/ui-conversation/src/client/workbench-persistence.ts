/** Versioned browser metadata for one verified principal's named workbenches. */
import type { ConversationViewportMode, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** One named layout; the active row also owns the viewport's pane selection. */
export interface SavedWorkbench {
  id: string
  name: string
  paneIds: SessionId[]
  activePaneId?: SessionId
  paneRatios: number[]
  updatedAt: number
}

/** The sole durable workbench document for a principal. */
export interface WorkbenchRecord {
  version: 2
  mode: ConversationViewportMode
  activeId: string
  workbenches: SavedWorkbench[]
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function row(value: unknown): SavedWorkbench | undefined {
  if (!object(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string'
    || !Array.isArray(value.paneIds) || value.paneIds.length > 4
    || !value.paneIds.every(id => typeof id === 'string' && id !== '')
    || new Set(value.paneIds).size !== value.paneIds.length
    || !Array.isArray(value.paneRatios) || value.paneRatios.length !== value.paneIds.length
    || !value.paneRatios.every(ratio => typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0)
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
    || (value.activePaneId !== undefined && !value.paneIds.includes(value.activePaneId))) return undefined
  return {
    id: value.id, name: value.name, paneIds: value.paneIds as SessionId[], paneRatios: value.paneRatios as number[],
    updatedAt: value.updatedAt,
    ...(value.activePaneId === undefined ? {} : { activePaneId: value.activePaneId as SessionId }),
  }
}

/** Decode persisted metadata before it can request Session resources.
 * @param value - JSON from browser storage.
 * @returns a structurally valid record, or undefined for corrupt metadata.
 */
export function parseWorkbenchRecord(value: unknown): WorkbenchRecord | undefined {
  if (!object(value) || value.version !== 2 || (value.mode !== 'single' && value.mode !== 'workbench')
    || typeof value.activeId !== 'string' || !Array.isArray(value.workbenches)) return undefined
  const workbenches: SavedWorkbench[] = []
  for (const item of value.workbenches) {
    const parsed = row(item)
    if (parsed === undefined || workbenches.some(existing => existing.id === parsed.id)) return undefined
    workbenches.push(parsed)
  }
  if (!workbenches.some(item => item.id === value.activeId)) return undefined
  return { version: 2, mode: value.mode, activeId: value.activeId, workbenches }
}

/** Read only the requested principal's record.
 * @param principal - verified account identity or explicit independent-local identity.
 * @returns validated metadata when storage is available.
 */
export function readWorkbenchRecord(principal: string): WorkbenchRecord | undefined {
  let raw: string | null
  try { raw = globalThis.localStorage.getItem(`dsh.conversation.workbenches.v2.${encodeURIComponent(principal)}`) }
  catch { return undefined /* Browser policy can deny localStorage. */ }
  if (raw === null) return undefined
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { return undefined /* Corrupt browser metadata cannot request Session resources. */ }
  return parseWorkbenchRecord(value)
}

/** Atomically replace the principal's complete metadata record.
 * @param principal - verified account identity or explicit independent-local identity.
 * @param record - current named layouts and active selection.
 */
export function writeWorkbenchRecord(principal: string, record: WorkbenchRecord): void {
  try { globalThis.localStorage.setItem(`dsh.conversation.workbenches.v2.${encodeURIComponent(principal)}`, JSON.stringify(record)) }
  catch { /* Storage denial or quota exhaustion leaves the current in-memory layout usable. */ }
}

/** Import unscoped legacy records only for an independent local operator.
 * @param visible - current catalog authority for each restored Session.
 * @returns a normalized document without inaccessible pane references.
 */
export function readLegacyWorkbenchRecord(visible: (id: SessionId) => boolean): WorkbenchRecord | undefined {
  let view: unknown
  let catalog: unknown
  try {
    view = JSON.parse(globalThis.localStorage.getItem('dsh.conversation.workbench.v1') ?? 'null')
    catalog = JSON.parse(globalThis.localStorage.getItem('dsh.conversation.workbenches.v1') ?? 'null')
  } catch { return undefined /* Legacy metadata may be corrupt or browser storage denied. */ }
  if (!object(view) && !object(catalog)) return undefined
  const activeId = object(catalog) && typeof catalog.activeId === 'string' ? catalog.activeId : 'default'
  const rows = object(catalog) && Array.isArray(catalog.workbenches) ? catalog.workbenches : []
  if (!rows.some(item => object(item) && item.id === activeId)) rows.push({ id: activeId, name: '我的工作台' })
  const workbenches: SavedWorkbench[] = []
  for (const item of rows) {
    if (!object(item) || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string'
      || workbenches.some(existing => existing.id === item.id)) continue
    const input = item.id === activeId && object(view) ? view : item
    const rawIds: unknown[] = Array.isArray(input.paneIds) ? input.paneIds : []
    const paneIds = [...new Set(rawIds.filter((id): id is SessionId => typeof id === 'string' && id !== '' && visible(id as SessionId)))].slice(0, 4)
    const rawRatios: unknown[] = Array.isArray(input.paneRatios) ? input.paneRatios : []
    const weights = paneIds.map((id) => {
      const value = rawRatios[rawIds.indexOf(id)]
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
    })
    const total = weights.reduce((sum, value) => sum + value, 0)
    const activePaneId = typeof input.activePaneId === 'string' && paneIds.includes(input.activePaneId as SessionId)
      ? input.activePaneId as SessionId : paneIds[0]
    workbenches.push({
      id: item.id, name: item.name, paneIds,
      paneRatios: weights.map(value => Number.isFinite(total) ? value / total : 1 / weights.length),
      updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
      ...(activePaneId === undefined ? {} : { activePaneId }),
    })
  }
  if (!workbenches.some(item => item.id === activeId)) return undefined
  return { version: 2, mode: object(view) && view.mode === 'workbench' ? 'workbench' : 'single', activeId, workbenches }
}
