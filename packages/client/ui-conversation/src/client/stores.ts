/**
 * Per-session chat store shared by conversation and details registrations.
 * The plugin creates its handle at apply time so identity follows the fiber.
 */
import { createSnapshotStore, defineStore, NodeDraft, type NodeDraftOwner, type EngineStoreHandle, type ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import type { ToolCallId, ChatStoreState, SelectionTarget } from './contract/views.ts'

interface ChatStorePersistence {
  /** Resolve a complete storage key only for a currently verified owner. */
  key(sessionId: SessionId, intent?: 'forget'): string | undefined
  /** Verified managed owner, pending verification, or legacy local persistence. */
  nodeOwner?(sessionId: SessionId): NodeDraftOwner | 'pending' | undefined
  /** Observe account, runtime, and visible-Session ownership changes. */
  subscribe(listener: () => void): () => void
  /** Register cleanup with the owning plugin. */
  onDispose(dispose: () => void): void
  /** Decode semantic input data without restoring executable callbacks. */
  readDraft(this: void, value: unknown): ChatStoreState['draft']
  /** Restore the materialized composer when its verified storage ownership changes. */
  restoreDraft?(sessionId: SessionId, draft: ChatStoreState['draft']): void
}

const callId = z.string().min(1)
const sequence = z.number().int().nonnegative()
const selectionFields = z.object({ stepSeq: sequence.optional(), toolName: z.string().optional() })
const selection = z.union([
  selectionFields.extend({ turnSeq: sequence, callId: callId.optional() }),
  selectionFields.extend({ callId, turnSeq: sequence.optional() }),
])
const storedState = z.object({
  selection: selection.nullable().catch(null),
  draft: z.unknown(),
  view: z.string().nullable().catch(null),
  inspect: z.object({ callId }).nullable().catch(null),
})

function initialState(): ChatStoreState {
  return { selection: null, draft: '', view: null, inspect: null }
}

function readState(key: string, readDraft: ChatStorePersistence['readDraft']): ChatStoreState {
  let raw: string | null
  try { raw = globalThis.sessionStorage.getItem(`${key}.tab.v1`) }
  catch { raw = null /* Tab storage can be unavailable; durable recovery remains independent. */ }
  if (raw === null) {
    try { raw = globalThis.localStorage.getItem(key) }
    catch { return initialState() /* Durable storage can also be denied by browser policy. */ }
  }
  if (raw === null) return initialState()
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { return initialState() /* Corrupt browser metadata cannot restore interaction state. */ }
  const parsed = storedState.safeParse(value)
  if (!parsed.success) return initialState()
  // Browser JSON omits undefined optional fields.
  return { ...parsed.data, selection: parsed.data.selection as SelectionTarget | null, draft: readDraft(parsed.data.draft) }
}

function serializeDraft(value: ChatStoreState['draft']): string {
  return value === '' ? '' : JSON.stringify({ version: 1, draft: value })
}

function parseDraft(text: string, read: ChatStorePersistence['readDraft']): ChatStoreState['draft'] {
  if (text === '') return ''
  const encoded: unknown = JSON.parse(text)
  if (encoded === null || typeof encoded !== 'object' || !('version' in encoded) || encoded.version !== 1 || !('draft' in encoded)) {
    throw new Error('Unsupported saved draft')
  }
  return read(encoded.draft)
}

function legacyCopies(key: string): { storage: Storage; key: string; raw: string }[] {
  const rows: { storage: Storage; key: string; raw: string }[] = []
  for (const [area, name] of [['sessionStorage', `${key}.tab.v1`], ['localStorage', key]] as const) {
    try {
      const storage = globalThis[area]
      const raw = storage.getItem(name)
      if (raw !== null) rows.push({ storage, key: name, raw })
    } catch { /* Unavailable copies cannot be migrated by this document. */ }
  }
  return rows
}

/** Declared action shape used to give the exported factory a stable return type. */
type ChatActions = {
  select: (draft: ChatStoreState, target: SelectionTarget | null) => void
  setDraft: (draft: ChatStoreState, value: ChatStoreState['draft']) => void
  setView: (draft: ChatStoreState, view: string) => void
  setInspect: (draft: ChatStoreState, target: { callId: ToolCallId } | null) => void
}

/** Chat stores with tab-owned recovery checks for page navigation. */
export interface ChatStoreHandle extends EngineStoreHandle<ChatStoreState, ChatActions> {
  /**
   * Check whether this tab can recover the complete current input record.
   * @param sessionId - verified Session whose store is already materialized.
   * @returns false when identity, storage, or the saved value is unavailable.
   */
  canRestoreDraft(sessionId: SessionId): boolean
  /** Session identities whose exact source node has not confirmed a recovery read or write. */
  readonly draftFailures: ObservableSnapshot<readonly { sessionId: SessionId; versionUnavailable: boolean }[]>
  /** Retry the failed read or reconcile the last receipt before writing.
   * @param sessionId - verified Session selected for retry.
   */
  retryDraft(sessionId: SessionId): void
  /** Finish reading an existing draft before augmenting it with input typed during navigation.
   * @param sessionId - exact Session owning the composer.
   * @returns whether the draft source was resolved.
   */
  prepareInput(sessionId: SessionId): Promise<boolean>
  /** @returns true if a node mutation has not been confirmed for this tab. */
  hasUnsavedNodeDrafts(): boolean
}

/**
 * Declares the per-session chat state and write surface.
 * @param persistence - verified storage ownership and plugin cleanup; omitted keeps state in memory.
 * @returns the store handle.
 */
export function createChatStore(persistence?: ChatStorePersistence): ChatStoreHandle {
  const handle = defineStore({
    init: initialState,
    actions: {
      select: (d, target: SelectionTarget | null) => { d.selection = target },
      setDraft: (d, value: ChatStoreState['draft']) => { d.draft = value },
      setView: (d, view: string) => { d.view = view },
      setInspect: (d, target: { callId: ToolCallId } | null) => { d.inspect = target },
    },
  })
  const failures = createSnapshotStore<readonly { sessionId: SessionId; versionUnavailable: boolean }[]>([])
  const writers = new Map<SessionId, NodeDraft>()
  const suspendedDrafts = new Set<string>()
  const nodeSurface = {
    draftFailures: failures,
    prepareInput: async (id: SessionId) => {
      const writer = writers.get(id)
      if (writer === undefined) return persistence?.nodeOwner?.(id) !== 'pending'
      await writer.restore()
      return writer.sourceReady
    },
    retryDraft: (id: SessionId) => { void writers.get(id)?.retry() },
    hasUnsavedNodeDrafts: () => suspendedDrafts.size > 0 || [...writers.values()].some(writer => writer.unsynchronized),
  }
  const changed = (): void => {
    const next = [...writers].filter(([, writer]) => writer.unavailable)
      .map(([sessionId, writer]) => ({ sessionId, versionUnavailable: writer.versionUnavailable }))
    const old = failures.getSnapshot()
    if (old.length !== next.length || next.some((row, i) => {
      const prior = old[i]
      return !prior || prior.sessionId !== row.sessionId || prior.versionUnavailable !== row.versionUnavailable
    })) failures.set(next)
  }
  if (persistence === undefined) return { ...handle, ...nodeSurface, canRestoreDraft: () => false }
  const adoptions = new Map<string, () => void>()
  const recoverable = new Map<string, () => boolean>()
  persistence.onDispose(() => {
    for (const dispose of [...adoptions.values()]) dispose()
  })
  return { ...handle, ...nodeSurface, canRestoreDraft: id => recoverable.get(id)?.() === true, create(scopeKey) {
    const instance = handle.create(scopeKey)
    if (scopeKey === undefined) return instance
    adoptions.get(scopeKey)?.()
    const currentKey = (): string | undefined => persistence.key(scopeKey as SessionId)
    let key = currentKey()
    let forgetKey = persistence.key(scopeKey as SessionId, 'forget')
    const id = scopeKey as SessionId
    let owner = persistence.nodeOwner?.(id)
    const privateInputs = new Map<string, ChatStoreState['draft']>()
    let node: NodeDraft | undefined
    let restoring = false
    let disposed = false
    const restore = (notify = false): void => {
      restoring = true
      try {
        node?.dispose()
        node = undefined
        writers.delete(id)
        changed()
        if (owner === 'pending') {
          instance.store.set(initialState())
          if (notify) persistence.restoreDraft?.(id, '')
          return
        }
        const previous = key === undefined ? initialState() : readState(key, persistence.readDraft)
        if (owner !== undefined && key !== undefined) {
          const previousInput = privateInputs.get(key)
          if (previousInput !== undefined) previous.draft = previousInput
          const copies = legacyCopies(key)
          const original = serializeDraft(previous.draft)
          node = new NodeDraft(owner, key, (text) => {
            const value = parseDraft(text, persistence.readDraft)
            restoring = true
            try { instance.actions.setDraft(value); persistence.restoreDraft?.(id, value) }
            finally { restoring = false }
          }, (text) => {
            if (key !== undefined) { privateInputs.delete(key); suspendedDrafts.delete(key) }
            // A different tab may have changed its legacy value since our read.
            for (const copy of copies) {
              try {
                if (copy.storage.getItem(copy.key) !== copy.raw) continue
                const value = storedState.safeParse(JSON.parse(copy.raw))
                if (value.success && serializeDraft(persistence.readDraft(value.data.draft)) === original
                  && (original === text || original === '')) copy.storage.removeItem(copy.key)
              } catch { /* A corrupt or inaccessible legacy copy is left intact. */ }
            }
          }, changed)
          writers.set(id, node)
          const writer = node
          if (previousInput !== undefined) writer.write(serializeDraft(previousInput))
          void writer.settle().then(() => {
            if (node !== writer || disposed || currentKey() !== key || original === '' || writer.restoredFromNode) return
            writer.write(serializeDraft(instance.getSnapshot().draft))
          })
        }
        instance.store.set(previous)
        if (notify) persistence.restoreDraft?.(id, previous.draft)
      }
      finally { restoring = false }
      if (key !== undefined && owner === undefined) {
        try { globalThis.sessionStorage.setItem(`${key}.tab.v1`, JSON.stringify(instance.getSnapshot())) }
        catch { /* Denied or full tab storage keeps navigation guarded. */ }
      }
    }
    restore()
    const stopStore = instance.subscribe(() => {
      if (restoring || key === undefined || currentKey() !== key) return
      if (owner === 'pending') return
      if (node !== undefined) { node.write(serializeDraft(instance.getSnapshot().draft)); return }
      const encoded = JSON.stringify(instance.getSnapshot())
      try { globalThis.sessionStorage.setItem(`${key}.tab.v1`, encoded) }
      catch { /* The current tab retains its input; navigation checks the saved copy. */ }
      try { globalThis.localStorage.setItem(key, encoded) }
      catch { /* Browser storage may be unavailable, denied, or full. */ }
    })
    const stopIdentity = persistence.subscribe(() => {
      if (disposed) return
      const next = currentKey()
      const nextForget = persistence.key(scopeKey as SessionId, 'forget')
      const nextOwner = persistence.nodeOwner?.(id)
      const category = (value: typeof owner) => value === undefined ? 'local' : value === 'pending' ? 'pending' : value.accountId
      if (next === key && nextForget === forgetKey && category(nextOwner) === category(owner)) return
      if (key !== undefined && node?.unsynchronized) {
        privateInputs.set(key, instance.getSnapshot().draft)
        suspendedDrafts.add(key)
      }
      owner = nextOwner
      key = next
      forgetKey = nextForget
      restore(true)
    })
    const dispose = (): void => {
      disposed = true
      node?.dispose()
      writers.delete(id)
      for (const stored of privateInputs.keys()) suspendedDrafts.delete(stored)
      privateInputs.clear()
      changed()
      adoptions.delete(scopeKey)
      recoverable.delete(scopeKey)
      stopIdentity()
      stopStore()
    }
    adoptions.set(scopeKey, dispose)
    recoverable.set(scopeKey, () => {
      if (disposed || key === undefined || currentKey() !== key) return false
      if (owner === 'pending') return false
      if (node !== undefined) return node.canRestore(serializeDraft(instance.getSnapshot().draft))
      try { return globalThis.sessionStorage.getItem(`${key}.tab.v1`) === JSON.stringify(instance.getSnapshot()) }
      catch { return false /* Denied tab storage cannot prove recovery after unloading. */ }
    })
    return { ...instance, clearPersisted() {
      if (disposed) return
      const target = persistence.key(scopeKey as SessionId, 'forget')
      dispose()
      if (target === undefined || target !== forgetKey) return
      try { globalThis.sessionStorage.removeItem(`${target}.tab.v1`) }
      catch { /* Storage denial leaves the retired instance unable to republish. */ }
      try { globalThis.localStorage.removeItem(target) }
      catch { /* Storage denial leaves the retired instance unable to republish. */ }
    } }
  } }
}
