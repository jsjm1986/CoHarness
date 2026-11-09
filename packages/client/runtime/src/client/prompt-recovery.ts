/** Tab-private identities for unconfirmed inputs. The owning Runtime stores their contents. */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { promptInputJson, promptProofJson, type RequestPayload, type RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'

type Prompt = RequestPayload<'session.prompt'>
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu
const hex = /^[a-f\d]{64}$/u

interface ReceiptHost {
  readonly sessionStorage?: Storage
  readonly navigator?: { readonly locks?: LockManager }
  readonly performance: Pick<Performance, 'timeOrigin'> & Partial<Pick<Performance, 'getEntriesByType'>>
  readonly window?: { readonly opener?: unknown } & Partial<Pick<EventTarget, 'addEventListener' | 'removeEventListener'>>
}
const browser: ReceiptHost = globalThis

interface PendingPrompt {
  node: string | null
  tab: string
  document: number
  id: RpcId
  proof: string
  zone: string | null
  handoff?: true
}

function inaccessible(): Error {
  return new Error('This tab cannot save the message receipt. Keep the draft and enable session storage before sending.')
}

function parse(raw: string | null): PendingPrompt | undefined {
  if (raw === null) return undefined
  const row: unknown = JSON.parse(raw)
  if (!row || typeof row !== 'object'
    || !('node' in row) || !(row.node === null || typeof row.node === 'string' && uuid.test(row.node))
    || !('tab' in row) || typeof row.tab !== 'string' || !uuid.test(row.tab)
    || !('id' in row) || typeof row.id !== 'string' || !uuid.test(row.id)
    || !('proof' in row) || typeof row.proof !== 'string' || !hex.test(row.proof)
    || !('zone' in row) || !(row.zone === null || typeof row.zone === 'string' && row.zone.length <= 128)
    || !('document' in row) || typeof row.document !== 'number' || !Number.isFinite(row.document)
    || ('handoff' in row && row.handoff !== true)) {
    throw inaccessible()
  }
  return row as PendingPrompt
}

function hash(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input)))
}

/**
 * Bind an operation identity to the exact message input used for admission.
 * @param id - original random submission identity.
 * @param payload - outgoing message, with the original browser time zone on retry.
 * @returns a proof specific to this operation and its exact input.
 */
export function promptInputProof(id: RpcId, payload: Prompt): string {
  return hash(promptProofJson(id, hash(promptInputJson(payload.mode, payload.clientTimeZone ?? null, payload.content))))
}

/** A Session owns the pending slot and any Web Lock for its document. */
export class PromptRecovery {
  private readonly document = browser.performance.timeOrigin
  private tab: string = randomUUID()
  private claimed: Promise<void> | undefined
  private unlock: (() => void) | undefined
  private waiter: AbortController | undefined
  private primed = false
  private closed = false
  private suspended = false

  constructor(readonly key: string, private readonly handoffTimeoutMs: number) {}

  /**
   * Check this tab's pending slot without creating or claiming one.
   * @param key - verified account and allocation.
   * @returns whether its former managed route has an unsettled operation.
   * @throws when the browser cannot establish whether the slot is empty.
   */
  static exists(key: string): boolean {
    try {
      const storage = browser.sessionStorage
      if (storage) return storage.getItem(key) !== null
    } catch { /* The previous managed submission cannot be ruled out without reading this tab's slot. */ }
    throw inaccessible()
  }

  private storage(): Storage {
    if (this.closed || this.suspended) throw new Error('This message belongs to a closed or suspended Session.')
    try {
      const storage = browser.sessionStorage
      if (storage) return storage
    } catch { /* Session storage can be denied by the browser. */ }
    throw inaccessible()
  }

  private write(store: Storage, row: PendingPrompt): void {
    const serialized = JSON.stringify(row)
    try {
      store.setItem(this.key, serialized)
      if (store.getItem(this.key) === serialized) return
    } catch { /* A quota or privacy policy may reject an otherwise readable store. */ }
    throw inaccessible()
  }

  private async take(tab: string, handoff = false, signal?: AbortSignal): Promise<boolean> {
    const locks = browser.navigator?.locks
    if (!locks) return true
    const claimed = Promise.withResolvers<boolean>()
    const hold = Promise.withResolvers<void>()
    let options: LockOptions = { ifAvailable: true }
    const waiter = handoff ? new AbortController() : undefined
    if (waiter) {
      this.waiter = waiter
      const signals = [AbortSignal.timeout(this.handoffTimeoutMs), waiter.signal]
      if (signal) signals.push(signal)
      options = { signal: AbortSignal.any(signals) }
    }
    void locks.request(this.key + ':' + tab, options, async (lock) => {
      if (!lock || this.closed || this.suspended) {
        claimed.resolve(false)
        return
      }
      this.unlock = hold.resolve
      claimed.resolve(true)
      await hold.promise
    }).catch(() => { claimed.resolve(false) })
    try { return await claimed.promise }
    finally { if (this.waiter === waiter) this.waiter = undefined }
  }

  // A departing document updates only its own tab's storage. A previously duplicated tab retains its live copy.
  private readonly depart = (): void => {
    if (this.closed) return
    try {
      const store = this.storage()
      const row = parse(store.getItem(this.key))
      if (row?.tab === this.tab && row.document === this.document) this.write(store, { ...row, handoff: true })
    } catch { /* An inaccessible store cannot acknowledge a handoff. Its prior operation remains pending. */ }
    this.suspended = true
    this.release()
  }

  private readonly resume = (): void => {
    this.suspended = false
    try {
      const store = this.storage()
      const row = parse(store.getItem(this.key))
      if (row?.tab === this.tab && row.document === this.document && row.handoff) {
        const { handoff: _handoff, ...owned } = row
        this.write(store, owned)
      }
    } catch { /* A denied restore keeps its old pointer for an explicit retry. */ }
  }

  private release(): void {
    this.waiter?.abort()
    this.unlock?.()
    this.unlock = undefined
    this.claimed = undefined
  }

  private async claim(signal?: AbortSignal, emptyOnly = false): Promise<void> {
    const store = this.storage()
    const raw = store.getItem(this.key)
    const row = parse(raw)
    if (row) {
      if (emptyOnly) throw inaccessible()
      const navigation = browser.performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined
      const newDocument = row.document !== this.document
      const newNavigation = newDocument && navigation?.type === 'navigate'
      const copied = newNavigation && (!row.handoff || browser.window?.opener != null)
      if (newDocument && !row.handoff && !navigation && !browser.navigator?.locks) {
        throw new Error('This browser cannot identify the tab that owns the unconfirmed message.')
      }
      // A confirmed handoff may precede the browser releasing the old document's Web Lock.
      if (!copied && await this.take(row.tab, !newDocument || row.handoff === true, signal)) {
        this.tab = row.tab
        if (store.getItem(this.key) !== raw) throw inaccessible()
        const { handoff: _handoff, ...owned } = row
        this.write(store, { ...owned, document: this.document })
      } else {
        if (!copied && !newNavigation) throw new Error('The previous tab is still confirming this message. Retry after it finishes.')
        if (store.getItem(this.key) !== raw) throw inaccessible()
        store.removeItem(this.key)
        if (!await this.take(this.tab)) throw inaccessible()
      }
    } else if (!await this.take(this.tab)) throw inaccessible()
    if (this.closed || this.suspended) throw inaccessible()
    browser.window?.addEventListener?.('pagehide', this.depart)
    browser.window?.addEventListener?.('pageshow', this.resume)
  }

  /** Whether this browser supports preclaiming a fresh receipt slot before a send. */
  static get canPrepareEmpty(): boolean { return browser.navigator?.locks !== undefined }

  /** Begin claiming the active tab's unused slot without adopting another submission.
   * @returns whether claiming began without writing or adopting a receipt.
   */
  prepareEmpty(): boolean {
    if (!PromptRecovery.canPrepareEmpty) return false
    try { if (this.storage().getItem(this.key) !== null) return false }
    catch { return false } // Sending checks storage and reports an unavailable store with the draft intact.
    const claim = this.claim(undefined, true)
    this.primed = true
    this.claimed = claim
    void claim.catch(() => { if (this.claimed === claim) this.release() })
    return true
  }

  /**
   * Recover only the original submission retained by this tab.
   * @param node - selected computer, when supplied by the Gateway directory.
   * @param signal - cancels a pending ownership transfer.
   * @returns only the current tab's original operation.
   */
  async pending(node?: string | null, signal?: AbortSignal): Promise<PendingPrompt | undefined> {
    const primed = this.primed
    this.primed = false
    try { await (this.claimed ??= this.claim(signal)) }
    catch (error) {
      this.release()
      if (primed && !signal?.aborted && !this.closed && !this.suspended) return this.pending(node, signal)
      throw error
    }
    const row = parse(this.storage().getItem(this.key))
    if (primed && row && row.tab !== this.tab) {
      this.release()
      return this.pending(node, signal)
    }
    if (row && row.tab !== this.tab) throw inaccessible()
    if (row && node !== undefined && row.node !== null && row.node !== node) {
      throw new Error('This message receipt belongs to another computer.')
    }
    return row
  }

  /** Persist before dispatch, including a request whose HTTP response never arrives.
   * @param id - exact admission identity.
   * @param proof - opaque proof for this input.
   * @param zone - original time zone.
   * @param node - originating computer, when supplied with the allocation.
   */
  save(id: RpcId, proof: string, zone: string | undefined, node: string | null): void {
    const store = this.storage()
    const prior = parse(store.getItem(this.key))
    if (prior && (prior.tab !== this.tab || prior.id !== id)) throw new Error('Another submission in this tab is unconfirmed.')
    this.write(store, { node, tab: this.tab, document: this.document, id, proof, zone: zone ?? null })
  }

  /** Remove this document's completed receipt without clearing another document's pointer.
   * @param id - completed identity.
   */
  clear(id: RpcId): void {
    const store = this.storage()
    const raw = store.getItem(this.key)
    const row = parse(raw)
    if (row?.tab !== this.tab || row.id !== id || row.document !== this.document) return
    store.removeItem(this.key)
    if (store.getItem(this.key) === raw) throw inaccessible()
  }

  /** Release the document without losing an unconfirmed input. */
  close(): void {
    this.closed = true
    this.release()
    browser.window?.removeEventListener?.('pagehide', this.depart)
    browser.window?.removeEventListener?.('pageshow', this.resume)
  }
}
