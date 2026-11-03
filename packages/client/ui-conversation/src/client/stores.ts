/**
 * Per-session chat store shared by conversation and details registrations.
 * The plugin creates its handle at apply time so identity follows the fiber.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import type { ToolCallId, ChatStoreState, SelectionTarget } from './contract/views.ts'

interface ChatStorePersistence {
  /** Resolve a complete storage key only for a currently verified owner. */
  key(sessionId: SessionId, intent?: 'forget'): string | undefined
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

function readState(key: string | undefined, readDraft: ChatStorePersistence['readDraft']): ChatStoreState {
  if (key === undefined) return initialState()
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
  if (persistence === undefined) return { ...handle, canRestoreDraft: () => false }
  const adoptions = new Map<string, () => void>()
  const recoverable = new Map<string, () => boolean>()
  persistence.onDispose(() => {
    for (const dispose of [...adoptions.values()]) dispose()
  })
  return { ...handle, canRestoreDraft: id => recoverable.get(id)?.() === true, create(scopeKey) {
    const instance = handle.create(scopeKey)
    if (scopeKey === undefined) return instance
    adoptions.get(scopeKey)?.()
    const currentKey = (): string | undefined => persistence.key(scopeKey as SessionId)
    let key = currentKey()
    let forgetKey = persistence.key(scopeKey as SessionId, 'forget')
    let restoring = false
    let disposed = false
    const restore = (notify = false): void => {
      restoring = true
      try {
        instance.store.set(readState(key, persistence.readDraft))
        if (notify) persistence.restoreDraft?.(scopeKey as SessionId, instance.getSnapshot().draft)
      }
      finally { restoring = false }
      if (key !== undefined) {
        try { globalThis.sessionStorage.setItem(`${key}.tab.v1`, JSON.stringify(instance.getSnapshot())) }
        catch { /* Denied or full tab storage keeps navigation guarded. */ }
      }
    }
    restore()
    const stopStore = instance.subscribe(() => {
      if (restoring || key === undefined || currentKey() !== key) return
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
      if (next === key && nextForget === forgetKey) return
      key = next
      forgetKey = nextForget
      restore(true)
    })
    const dispose = (): void => {
      disposed = true
      adoptions.delete(scopeKey)
      recoverable.delete(scopeKey)
      stopIdentity()
      stopStore()
    }
    adoptions.set(scopeKey, dispose)
    recoverable.set(scopeKey, () => {
      if (disposed || key === undefined || currentKey() !== key) return false
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
