/** Node-owned draft content. Browser storage holds only this tab's acknowledged recovery pointer. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { addressRuntimeUrl } from '@deepseek-ai/dsh-host-apiproxy/api'
import { readApiResponseJson } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionRuntimeTarget } from './contract/sessions.ts'

/** Authenticated owner of a private draft on one Runtime's node. */
export interface NodeDraftOwner {
  readonly accountId: number
  readonly target: SessionRuntimeTarget
  readonly sessionId: SessionId
  readonly requestTimeoutMs: number
}

interface DraftRow { revision: number; text: string; currentRevision?: number }

class VersionUnavailable extends Error {}

function parseRow(value: unknown): DraftRow {
  if (value === null || typeof value !== 'object' || !('revision' in value) || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || !('text' in value) || typeof value.text !== 'string') {
    throw new Error('Invalid draft receipt')
  }
  const head = 'currentRevision' in value ? value.currentRevision : undefined
  if (head !== undefined && (typeof head !== 'number' || !Number.isSafeInteger(head) || head < value.revision)) {
    throw new Error('Invalid draft head revision')
  }
  return { revision: value.revision, text: value.text, ...(head === undefined ? {} : { currentRevision: head }) }
}

/** One document's serialized draft writer. A duplicated tab claims its own acknowledged copy before advertising recovery. */
export class NodeDraft {
  private readonly controller = new AbortController()
  private destination: string = randomUUID()
  private releaseLock: (() => void) | undefined
  private claimed: Promise<void> | undefined
  private readonly pointer: string
  private source: string | null = null
  private sourceRevision?: number
  private invalidPointer = false
  private missingVersion = false
  private received = false
  private restoring: Promise<void> | undefined
  private revision = 0
  private desired: string | undefined
  private acknowledged: string | undefined
  private inflight: Promise<void> | undefined
  private ambiguous: string | undefined
  private failed = false
  private pointerSaved = false
  private savedPointer: string | null = null

  /** @param owner - verified account, node target, Session and transport limit.
   * @param storageKey - account/Runtime/Session-qualified browser pointer name.
   * @param restored - adopt the node's last recorded input, only before the first edit.
   * @param saved - called after a matching receipt and recovery-pointer publication.
   * @param changed - notify the owning UI after recovery or its availability changes.
   */
  constructor(private readonly owner: NodeDraftOwner, storageKey: string,
    private readonly restored: (text: string) => void, private readonly saved: (text: string) => void,
    private readonly changed: () => void = () => {}) {
    if (owner.target.runtimeId === undefined) throw new Error('Node drafts require a specific Runtime')
    this.pointer = `${storageKey}.node-draft.v1`
    try { this.source = globalThis.sessionStorage.getItem(this.pointer) }
    catch { /* Storage denial leaves navigation guarded. */ }
    if (this.source !== null) {
      const match = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:@([1-9]\d*))?$/iu.exec(this.source)
      if (match?.[1] && (match[2] === undefined || Number.isSafeInteger(Number(match[2])))) {
        this.source = match[1]
        if (match[2] !== undefined) this.sourceRevision = Number(match[2])
      } else { this.invalidPointer = true; this.missingVersion = true }
    }
  }

  private async request(id: string, method: 'GET' | 'PUT' | 'DELETE', body?: { revision: number; text?: string },
    version?: number): Promise<DraftRow> {
    const url = new URL(`/account/api/drafts/${id}`, globalThis.location.origin)
    addressRuntimeUrl(url, this.owner.target)
    url.searchParams.set('sessionId', this.owner.sessionId)
    if (version !== undefined) url.searchParams.set('revision', String(version))
    const timer = new AbortController()
    const deadline = setTimeout(() => { timer.abort() }, this.owner.requestTimeoutMs)
    try {
      const response = await fetch(url, { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([this.controller.signal, timer.signal]),
        headers: { accept: 'application/json', 'x-dsh-expected-principal-id': String(this.owner.accountId),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      if (!response.ok || response.headers.get('x-dsh-runtime-id') !== this.owner.target.runtimeId) {
        await response.body?.cancel()
        if (version !== undefined && response.status === 410) throw new VersionUnavailable()
        throw new Error('The draft owner did not confirm the request')
      }
      const row = parseRow(await readApiResponseJson(response))
      this.controller.signal.throwIfAborted()
      if (version !== undefined && row.revision !== version) throw new VersionUnavailable()
      return row
    } finally { clearTimeout(deadline) }
  }

  /** Read this tab's acknowledged input from the exact target. @returns after the initial read. */
  restore(): Promise<void> {
    if (this.received) return Promise.resolve()
    return this.restoring ??= this.readSource().finally(() => { this.restoring = undefined })
  }

  private async lock(id: string): Promise<boolean> {
    const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks
    if (locks === undefined) return false
    const claimed = Promise.withResolvers<boolean>()
    void locks.request(`${this.pointer}:${id}`, { ifAvailable: true }, async (lock) => {
      if (lock === null || this.controller.signal.aborted) { claimed.resolve(false); return }
      const hold = Promise.withResolvers<undefined>()
      this.releaseLock = () => { hold.resolve(undefined) }
      claimed.resolve(true)
      await hold.promise
    }).catch(() => { claimed.resolve(false) })
    return claimed.promise
  }

  private async claimWriter(): Promise<void> {
    if (this.source !== null && await this.lock(this.source)) this.destination = this.source
    else if (!this.controller.signal.aborted) await this.lock(this.destination)
  }

  private async readSource(): Promise<void> {
    if (this.invalidPointer) { this.markUnavailable(); return }
    await (this.claimed ??= this.claimWriter())
    if (this.controller.signal.aborted) return
    if (this.source === null) { this.received = true; this.acknowledged = ''; this.pointerSaved = true; return }
    try {
      const row = await this.request(this.source, 'GET', undefined, this.sourceRevision)
      if (this.destination === this.source && row.currentRevision !== undefined && row.currentRevision !== row.revision) {
        this.releaseLock?.()
        this.releaseLock = undefined
        this.destination = randomUUID()
        await this.lock(this.destination)
        this.controller.signal.throwIfAborted()
      }
      if (this.desired === undefined) this.restored(row.text)
      this.received = true
      this.missingVersion = false
      this.failed = false
      if (this.destination === this.source) {
        this.revision = row.revision
        this.publish(row.text)
      } else {
        // The source pointer was copied. An editing sibling can advance or clear it at any time.
        this.acknowledged = ''
        this.desired ??= row.text
        if (this.desired === '') this.publish('')
        else this.changed()
      }
      this.drain()
    } catch (error) {
      if (error instanceof VersionUnavailable) this.missingVersion = true
      this.markUnavailable()
    }
  }

  /** Submit the newest unsent value. A failed mutation needs an explicit reconciliation.
   * @param text - complete versioned input, or empty text to delete.
   */
  write(text: string): void {
    if (this.controller.signal.aborted || text === this.desired) return
    this.desired = text
    if (!this.failed) this.drain()
  }

  private publish(text: string): void {
    this.acknowledged = text
    this.pointerSaved = false
    try {
      if (text === '') globalThis.sessionStorage.removeItem(this.pointer)
      else globalThis.sessionStorage.setItem(this.pointer, `${this.destination}@${this.revision}`)
      this.pointerSaved = true
      this.savedPointer = text === '' ? null : `${this.destination}@${this.revision}`
    } catch { /* The node accepted the write; unloading still requires a recoverable pointer. */ }
    if (this.pointerSaved) this.saved(text)
    this.changed()
  }

  private drain(): void {
    if (this.inflight !== undefined || this.desired === undefined || this.desired === this.acknowledged
      || !this.received || this.failed || this.controller.signal.aborted) return
    const persist = async (): Promise<void> => {
      while (!this.controller.signal.aborted && this.desired !== undefined && this.desired !== this.acknowledged) {
        const text = this.desired
        this.ambiguous = text
        const method = text === '' ? 'DELETE' : 'PUT'
        const row = await this.request(this.destination, method, { revision: this.revision, ...(text === '' ? {} : { text }) })
        if (row.text !== text || row.revision !== this.revision + 1) throw new Error('Draft receipt does not match request')
        this.revision = row.revision
        this.ambiguous = undefined
        this.publish(text)
      }
    }
    this.inflight = persist().catch(() => { if (!this.controller.signal.aborted) { this.failed = true; this.changed() } }).finally(() => {
      this.inflight = undefined
      if (!this.failed && this.desired !== this.acknowledged) this.drain()
    })
  }

  /** Finish an initial restoration and any queued writes. @returns after the current writes stop. */
  async settle(): Promise<void> {
    await this.restore()
    this.drain()
    await this.inflight
  }

  /** Reconcile an ambiguous write against the node before issuing a new mutation. @returns after reconciliation. */
  async retry(): Promise<void> {
    if (!this.failed || this.controller.signal.aborted || this.inflight !== undefined) return
    this.failed = false
    this.changed()
    try {
      if (this.ambiguous !== undefined) {
        const row = await this.request(this.destination, 'GET')
        if (row.text === this.ambiguous && row.revision === this.revision + 1) { this.revision = row.revision; this.publish(row.text) }
        else if (row.revision !== this.revision) throw new Error('Draft changed on the owning node')
        this.ambiguous = undefined
      }
      await this.settle()
    } catch { this.markUnavailable() }
  }

  private markUnavailable(): void {
    if (!this.controller.signal.aborted) { this.failed = true; this.changed() }
  }

  /** Check the node receipt and the pointer held by this document.
   * @param text - complete current input.
   * @returns whether this tab can recover the exact acknowledged input.
   */
  canRestore(text: string): boolean {
    if (!this.pointerSaved || this.controller.signal.aborted || !this.received || this.failed
      || this.ambiguous !== undefined || text !== this.acknowledged) return false
    try { return globalThis.sessionStorage.getItem(this.pointer) === this.savedPointer }
    catch { return false /* Browser storage may be disabled after a successful receipt. */ }
  }

  /** Source input has been read or proven empty and is safe to augment. */
  get sourceReady(): boolean { return this.received && !this.controller.signal.aborted && !this.failed }

  /** This tab had an earlier acknowledged source to restore. */
  get restoredFromNode(): boolean { return this.source !== null }
  /** The pinned revision is unavailable and current text cannot replace it. */
  get versionUnavailable(): boolean { return this.missingVersion }
  /** The owner needs an explicit retry after a read or mutation failure. */
  get unavailable(): boolean { return this.failed }
  /** This document has input that the node and recovery pointer have not confirmed. */
  get unsynchronized(): boolean { return this.desired !== undefined && !this.canRestore(this.desired) }

  /** Retire this verified owner and suppress all late receipts. */
  dispose(): void { this.controller.abort(); this.releaseLock?.() }
}
