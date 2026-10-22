/** Grant matching and the JSONL-backed grant store for the VNC provider.
 * @module @deepseek-ai/dsh-remote-desktop-vnc/grants
 */

import { readFile, stat } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteDesktopError, RemoteDesktopGrantId } from '@deepseek-ai/dsh-remote-desktop'
import type {
  RemoteDesktopGrant,
  RemoteDesktopTarget,
} from '@deepseek-ai/dsh-remote-desktop'

/**
 * Live grants authorizing `{principal, target, sessionId?}` at `at`:
 * unrevoked rows matching the principal and target whose scope is either a
 * machine grant or an unexpired session grant for `sessionId`.
 * @param grants - the stored rows to filter.
 * @param principal - the caller principal to match.
 * @param target - the desktop target to match.
 * @param sessionId - the caller Session admitting session-scoped rows.
 * @param at - the timestamp session scopes are checked against.
 * @returns the unrevoked rows authorizing the request.
 */
export function matchingGrants(
  grants: readonly RemoteDesktopGrant[],
  principal: string,
  target: RemoteDesktopTarget,
  sessionId: SessionId | undefined,
  at: number,
): RemoteDesktopGrant[] {
  return grants.filter(g =>
    g.revokedAt === undefined
    && g.principal === principal
    && g.target.nodeId === target.nodeId
    && (g.target.desktop ?? '') === (target.desktop ?? '')
    && (g.scope.kind === 'machine'
      || (sessionId !== undefined && g.scope.sessionId === sessionId && g.scope.expiresAt > at)))
}

interface StoredGrant {
  id: string
  target: RemoteDesktopTarget
  principal: string
  level: 'view' | 'control'
  scope: RemoteDesktopGrant['scope']
  recording: boolean
  grantedBy: string
  createdAt: number
  revokedAt?: number
}

/** Durable grant store: JSONL file, rewritten atomically on each mutation and
 * reloaded when an external writer (the deployment's grant administration
 * surface) changes the file. */
export class VncGrantStore {
  private readonly grants = new Map<string, RemoteDesktopGrant>()
  private seenMtimeMs = 0
  private pending: Promise<void> = Promise.resolve()

  private constructor(private readonly file: string) {}

  /**
   * Open the store. `':memory:'` opens an empty volatile store — a valid
   * choice for tests and an explicit opt-out of durability.
   * @param file - the JSONL store path, or `':memory:'`.
   * @returns the opened store with any durable rows loaded.
   */
  static async open(file: string): Promise<VncGrantStore> {
    const store = new VncGrantStore(file)
    if (file === ':memory:') return store
    await store.reload()
    return store
  }

  /**
   * Re-read the file when its mtime advanced past the last committed revision.
   * A failed reload keeps the last good rows and leaves the mtime unconsumed,
   * so every call retries until the file parses again.
   */
  async refresh(): Promise<void> {
    await this.serialize(async () => {
      if (this.file === ':memory:') return
      const info = await stat(this.file).catch(() => undefined)
      const mtimeMs = info?.mtimeMs ?? 0
      if (mtimeMs === this.seenMtimeMs) return
      await this.reload()
      this.seenMtimeMs = mtimeMs
    })
  }

  private async reload(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      text = ''
    }
    const next = new Map<string, RemoteDesktopGrant>()
    for (const [index, line] of text.split('\n').entries()) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        throw new RemoteDesktopError(`invalid JSON in remote-desktop grants file "${this.file}" line ${index + 1}`, 'REMOTE_DESKTOP_TRANSPORT')
      }
      const row = parsed as { id?: unknown; target?: unknown }
      if (typeof row.id !== 'string' || typeof row.target !== 'object' || row.target === null) {
        throw new RemoteDesktopError(`invalid grant row in remote-desktop grants file "${this.file}" line ${index + 1}`, 'REMOTE_DESKTOP_TRANSPORT')
      }
      next.set(row.id, { ...row, id: RemoteDesktopGrantId(row.id) } as RemoteDesktopGrant)
    }
    this.grants.clear()
    for (const [id, grant] of next) this.grants.set(id, grant)
  }

  /**
   * All stored rows, including revoked ones.
   * @returns every committed grant row.
   */
  all(): RemoteDesktopGrant[] {
    return [...this.grants.values()]
  }

  /**
   * Insert one grant row and persist.
   * @param grant - the committed row to append.
   */
  async insert(grant: RemoteDesktopGrant): Promise<void> {
    await this.serialize(async () => {
      const next = new Map(this.grants)
      next.set(grant.id, grant)
      await this.persist(next)
      this.grants.set(grant.id, grant)
    })
  }

  /**
   * Apply a partial update to a stored row, persist, and return the result.
   * @param id - the grant row to update.
   * @param patch - the fields to apply; `id` cannot be rewritten.
   * @returns the updated row.
   */
  async update(id: RemoteDesktopGrantId, patch: Partial<Omit<StoredGrant, 'id'>>): Promise<RemoteDesktopGrant> {
    return this.serialize(async () => {
      const existing = this.grants.get(id)
      if (!existing) {
        throw new RemoteDesktopError('remote-desktop grant not found', 'REMOTE_DESKTOP_GRANT_NOT_FOUND')
      }
      const updated = { ...existing, ...patch }
      const next = new Map(this.grants)
      next.set(id, updated)
      await this.persist(next)
      this.grants.set(id, updated)
      return updated
    })
  }

  /** Serialize reloads and writes; a rejected write does not block the next operation. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.then(() => {}, () => {})
    return result
  }

  private async persist(grants: ReadonlyMap<string, RemoteDesktopGrant>): Promise<void> {
    if (this.file === ':memory:') return
    const body = [...grants.values()].map(g => JSON.stringify(g)).join('\n') + '\n'
    await writeFileAtomic(this.file, body, { dirMode: 0o700, mode: 0o600 })
    // Seen mtime is not advanced: an external writer landing between the
    // rename and the next refresh must still be picked up.
  }
}
