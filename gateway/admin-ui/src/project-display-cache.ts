/** Bounded session-scoped cache of owner-verified Admin project displays to avoid `#id` flashes across navigation. */

const STORAGE_KEY = 'dsh:admin-verified-project-display:v1'
const MAX_ENTRIES = 256

/** Cached project name and host path bound to one exact `(origin, nodeId, projectId, runtimeId)` tuple. */
export interface CachedAdminProjectDisplay {
  readonly name: string
  readonly path: string
}

interface StoredAdminDisplay {
  readonly nodeId: string
  readonly projectId: number
  readonly runtimeId: string
  readonly name: string
  readonly path: string
}

function currentOrigin(): string {
  const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin
  return typeof origin === 'string' && origin.length > 0 ? origin : 'default'
}

function keyOf(origin: string, nodeId: string, projectId: number, runtimeId: string): string {
  return JSON.stringify([origin, nodeId, projectId, runtimeId])
}

function resolveStorage(): Storage | undefined {
  try {
    const candidate = (globalThis as { sessionStorage?: unknown }).sessionStorage
    if (candidate !== null && typeof candidate === 'object'
      && typeof (candidate as Storage).getItem === 'function'
      && typeof (candidate as Storage).setItem === 'function') {
      return candidate as Storage
    }
  } catch {
    // Restricted storage contexts fall back to the in-memory map.
  }
  return undefined
}

/** Instance-owned LRU display cache optionally mirrored to `sessionStorage` and cleared on sign-out or 401/403. */
export class AdminProjectDisplayCache {
  private readonly memory = new Map<string, StoredAdminDisplay>()
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
        if (typeof row.nodeId !== 'string' || row.nodeId === ''
          || typeof row.projectId !== 'number' || !Number.isSafeInteger(row.projectId)
          || typeof row.runtimeId !== 'string' || row.runtimeId === ''
          || typeof row.name !== 'string' || row.name === ''
          || typeof row.path !== 'string' || row.path === '') continue
        const entry: StoredAdminDisplay = {
          nodeId: row.nodeId,
          projectId: row.projectId,
          runtimeId: row.runtimeId,
          name: row.name,
          path: row.path,
        }
        this.memory.set(keyOf(origin, entry.nodeId, entry.projectId, entry.runtimeId), entry)
      }
      this.trim()
    } catch {
      // Malformed sessionStorage entries are ignored without blocking list reads.
    }
  }

  private trim(): void {
    while (this.memory.size > MAX_ENTRIES) {
      const oldest = this.memory.keys().next().value
      if (oldest === undefined) break
      this.memory.delete(oldest)
    }
  }

  private persist(origin: string): void {
    const store = resolveStorage()
    if (store === undefined) return
    try {
      const rows: StoredAdminDisplay[] = []
      for (const [key, entry] of this.memory) {
        if (key.startsWith(`[${JSON.stringify(origin)},`)) rows.push(entry)
      }
      if (rows.length === 0) store.removeItem(STORAGE_KEY)
      else store.setItem(STORAGE_KEY, JSON.stringify(rows))
    } catch {
      // Quota or private-mode failures keep the in-memory cache functional.
    }
  }

  /** Look up a previously owner-verified project name and path for optimistic hydration. */
  lookup(nodeId: string | undefined, projectId: number, runtimeId: string | undefined): CachedAdminProjectDisplay | undefined {
    if (nodeId === undefined || runtimeId === undefined) return undefined
    const origin = currentOrigin()
    this.hydrate(origin)
    const key = keyOf(origin, nodeId, projectId, runtimeId)
    const entry = this.memory.get(key)
    if (entry === undefined) return undefined
    this.memory.delete(key)
    this.memory.set(key, entry)
    return { name: entry.name, path: entry.path }
  }

  /** Store verified owner project displays after a successful `/admin/api/project-metadata` read. */
  remember(
    nodeId: string,
    entries: ReadonlyArray<{ readonly projectId: number; readonly runtimeId: string; readonly name: string; readonly path: string }>,
  ): void {
    if (entries.length === 0) return
    const origin = currentOrigin()
    this.hydrate(origin)
    for (const entry of entries) {
      const key = keyOf(origin, nodeId, entry.projectId, entry.runtimeId)
      this.memory.delete(key)
      this.memory.set(key, {
        nodeId,
        projectId: entry.projectId,
        runtimeId: entry.runtimeId,
        name: entry.name,
        path: entry.path,
      })
    }
    this.trim()
    this.persist(origin)
  }

  /** Evict cached display records for one project ID after rename, delete, or authorization refusal. */
  evictById(projectId: number): void {
    const origin = currentOrigin()
    this.hydrate(origin)
    let removed = false
    for (const [key, entry] of [...this.memory]) {
      if (entry.projectId === projectId) {
        this.memory.delete(key)
        removed = true
      }
    }
    if (removed) this.persist(origin)
  }

  /** Clear all cached Admin project display entries (invoked on sign-out, 401, or test reset). */
  clear(): void {
    this.memory.clear()
    this.hydratedOrigin = undefined
    try { resolveStorage()?.removeItem(STORAGE_KEY) } catch { /* Storage unavailable; memory cleared. */ }
  }
}

const defaultCache = new AdminProjectDisplayCache()

/**
 * Look up a previously owner-verified project name and path for optimistic hydration.
 * Callers leave `ownerDisplayLoaded` unset so live metadata still refreshes authoritatively.
 * @param nodeId - selected computer identifier.
 * @param projectId - public project identifier.
 * @param runtimeId - exact Runtime identifier.
 * @returns cached name and path, or undefined on cache miss.
 */
export function lookupAdminProjectDisplay(
  nodeId: string | undefined,
  projectId: number,
  runtimeId: string | undefined,
): CachedAdminProjectDisplay | undefined {
  return defaultCache.lookup(nodeId, projectId, runtimeId)
}

/**
 * Store verified owner project displays after a successful `/admin/api/project-metadata` read.
 * @param nodeId - computer identifier that answered the metadata read.
 * @param entries - verified project display entries keyed by project ID and Runtime ID.
 */
export function rememberAdminProjectDisplays(
  nodeId: string,
  entries: ReadonlyArray<{ readonly projectId: number; readonly runtimeId: string; readonly name: string; readonly path: string }>,
): void {
  defaultCache.remember(nodeId, entries)
}

/**
 * Evict cached display records for one project ID after rename, delete, or authorization refusal.
 * @param projectId - public project identifier to invalidate.
 */
export function evictAdminProjectDisplayById(projectId: number): void {
  defaultCache.evictById(projectId)
}

/** Clear all cached Admin project display entries (for example on sign-out, 401, or test reset). */
export function clearAdminProjectDisplayCache(): void {
  defaultCache.clear()
}
