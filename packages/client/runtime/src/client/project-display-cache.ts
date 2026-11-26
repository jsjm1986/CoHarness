/** Instance-owned session-scoped cache of owner-verified project display fields to prevent `#id` flashes on repeat renders. */
import type { OwnerProjectDisplay } from './project-metadata.ts'

const STORAGE_KEY = 'dsh:verified-project-display:v1'
const MAX_ENTRIES = 256

/** Cached label and root path bound to one exact `(origin, account, nodeId, projectId, runtimeId)` tuple. */
export interface CachedProjectDisplay {
  readonly name: string
  readonly rootPath: string
}

interface StoredEntry {
  readonly account: number
  readonly nodeId: string
  readonly projectId: number
  readonly runtimeId: string
  readonly name: string
  readonly rootPath: string
}

function currentOrigin(): string {
  const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin
  return typeof origin === 'string' && origin.length > 0 ? origin : 'default'
}

function keyOf(origin: string, account: number, nodeId: string, projectId: number, runtimeId: string): string {
  return JSON.stringify([origin, account, nodeId, projectId, runtimeId])
}

function resolveStorage(): Storage | undefined {
  try {
    const candidate = (globalThis as { sessionStorage?: unknown }).sessionStorage
    if (candidate !== null && typeof candidate === 'object'
      && typeof (candidate as Storage).getItem === 'function'
      && typeof (candidate as Storage).setItem === 'function'
      && typeof (candidate as Storage).removeItem === 'function') {
      return candidate as Storage
    }
  } catch {
    // Restricted browser contexts deny sessionStorage reads; fall back to in-memory cache only.
  }
  return undefined
}

/**
 * Cordis-safe, instance-owned LRU cache backed optionally by browser `sessionStorage`.
 * Holds no module-level mutable state so independent roots and tests stay isolated.
 */
export class VerifiedProjectDisplayCache {
  private readonly memory = new Map<string, StoredEntry>()
  private hydratedOrigin: string | undefined

  private hydrate(origin: string): void {
    if (this.hydratedOrigin === origin) return
    this.hydratedOrigin = origin
    const store = resolveStorage()
    if (store === undefined) return
    try {
      const raw = store.getItem(STORAGE_KEY)
      if (raw === null || raw === '') return
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      for (const item of parsed) {
        if (item === null || typeof item !== 'object') continue
        const row = item as Record<string, unknown>
        if (typeof row.account !== 'number' || !Number.isSafeInteger(row.account)
          || typeof row.nodeId !== 'string' || row.nodeId === ''
          || typeof row.projectId !== 'number' || !Number.isSafeInteger(row.projectId)
          || typeof row.runtimeId !== 'string' || row.runtimeId === ''
          || typeof row.name !== 'string' || row.name === ''
          || typeof row.rootPath !== 'string' || row.rootPath === '') continue
        const entry: StoredEntry = {
          account: row.account,
          nodeId: row.nodeId,
          projectId: row.projectId,
          runtimeId: row.runtimeId,
          name: row.name,
          rootPath: row.rootPath,
        }
        this.memory.set(keyOf(origin, entry.account, entry.nodeId, entry.projectId, entry.runtimeId), entry)
      }
      this.trim()
    } catch {
      // Malformed or inaccessible storage is ignored without blocking directory hydration.
    }
  }

  private trim(): void {
    while (this.memory.size > MAX_ENTRIES) {
      const oldest = this.memory.keys().next().value
      if (oldest === undefined) break
      this.memory.delete(oldest)
    }
  }

  private persist(origin: string, removeOnFailure = false): void {
    const store = resolveStorage()
    if (store === undefined) return
    try {
      const rows: StoredEntry[] = []
      for (const [key, entry] of this.memory) {
        if (key.startsWith(`[${JSON.stringify(origin)},`)) rows.push(entry)
      }
      if (rows.length === 0) store.removeItem(STORAGE_KEY)
      else store.setItem(STORAGE_KEY, JSON.stringify(rows))
    } catch {
      if (removeOnFailure) {
        try { store.removeItem(STORAGE_KEY) } catch { /* Storage unavailable; in-memory eviction already applied. */ }
      }
      // Quota or private-mode errors leave the in-memory cache intact.
    }
  }

  /**
   * Look up a previously owner-verified project label for this exact account and Runtime placement.
   * Callers must still perform a live metadata refresh before treating the display as authoritative.
   * @param account - current verified account identifier.
   * @param nodeId - authorized computer identifier.
   * @param projectId - public project identifier.
   * @param runtimeId - exact Runtime identifier.
   * @returns cached name and root path, or undefined on cache miss.
   */
  lookup(
    account: number,
    nodeId: string | undefined,
    projectId: number,
    runtimeId: string | undefined,
  ): CachedProjectDisplay | undefined {
    if (nodeId === undefined || runtimeId === undefined) return undefined
    const origin = currentOrigin()
    this.hydrate(origin)
    const key = keyOf(origin, account, nodeId, projectId, runtimeId)
    const entry = this.memory.get(key)
    if (entry === undefined) return undefined
    this.memory.delete(key)
    this.memory.set(key, entry)
    return { name: entry.name, rootPath: entry.rootPath }
  }

  /**
   * Record one or more owner-verified project display responses for fast hydration on repeat renders.
   * @param account - verified account that received the display.
   * @param displays - owner-verified project metadata records.
   */
  remember(account: number, displays: readonly OwnerProjectDisplay[]): void {
    if (displays.length === 0) return
    const origin = currentOrigin()
    this.hydrate(origin)
    for (const display of displays) {
      const key = keyOf(origin, account, display.nodeId, display.projectId, display.runtimeId)
      this.memory.delete(key)
      this.memory.set(key, {
        account,
        nodeId: display.nodeId,
        projectId: display.projectId,
        runtimeId: display.runtimeId,
        name: display.name,
        rootPath: display.rootPath,
      })
    }
    this.trim()
    this.persist(origin)
  }

  /**
   * Evict one cached project display after access denial or placement withdrawal.
   * @param account - verified account whose grant changed.
   * @param nodeId - computer identifier of the withdrawn project.
   * @param projectId - public project identifier.
   * @param runtimeId - Runtime identifier of the withdrawn project.
   */
  evict(
    account: number,
    nodeId: string | undefined,
    projectId: number,
    runtimeId?: string,
  ): void {
    if (nodeId === undefined) return
    const origin = currentOrigin()
    this.hydrate(origin)
    if (runtimeId !== undefined) {
      if (this.memory.delete(keyOf(origin, account, nodeId, projectId, runtimeId))) this.persist(origin, true)
      return
    }
    let removed = false
    for (const [key, entry] of [...this.memory]) {
      if (entry.account === account && entry.nodeId === nodeId && entry.projectId === projectId
        && key.startsWith(`[${JSON.stringify(origin)},`)) {
        this.memory.delete(key)
        removed = true
      }
    }
    if (removed) this.persist(origin, true)
  }

  /**
   * Evict every cached project display for one account (or all accounts when omitted).
   * @param account - account whose cached labels should be purged on logout or invalidation.
   */
  clear(account?: number): void {
    const origin = currentOrigin()
    if (account === undefined) {
      this.memory.clear()
      this.hydratedOrigin = undefined
      try { resolveStorage()?.removeItem(STORAGE_KEY) } catch { /* Storage unavailable; in-memory state is already cleared. */ }
      return
    }
    this.hydrate(origin)
    let removed = false
    for (const [key, entry] of [...this.memory]) {
      if (entry.account === account) {
        this.memory.delete(key)
        removed = true
      }
    }
    if (removed) this.persist(origin, true)
  }
}
