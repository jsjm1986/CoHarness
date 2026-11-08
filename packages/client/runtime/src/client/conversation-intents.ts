/** Editable, document-owned input while an explicitly selected Session is being prepared. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { SessionDraftId, SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionRuntimeTarget } from './contract/sessions.ts'
import { createSnapshotStore } from './contract/store.ts'

/** One click's fixed Host reservation and editable input. */
export interface ConversationIntent {
  readonly id: string
  readonly sessionId: SessionId
  readonly draftId: SessionDraftId
  readonly target: SessionRuntimeTarget
  readonly workspaceId?: WorkspaceId
  readonly paneId?: SessionId
  readonly label: string
  readonly text: string
  readonly phase: 'preparing' | 'unavailable'
  readonly denied?: boolean
}

/** Pending input remains addressable after another navigation supersedes its view. */
export interface ConversationIntentsSnapshot {
  readonly active?: ConversationIntent
  readonly saved: readonly ConversationIntent[]
}

type Prepare = (intent: ConversationIntent, signal: AbortSignal, transfer: () => void) => Promise<void>

interface Entry {
  intent: ConversationIntent
  readonly prepare: Prepare
  controller?: AbortController
}

/** Per-document intent owner. Preparation never submits input or cancels an accepted Host task. */
export class ConversationIntents {
  /** Editable preparations and retained drafts belonging to this browser document. */
  readonly snapshot = createSnapshotStore<ConversationIntentsSnapshot>({ saved: [] })
  private readonly entries = new Map<string, Entry>()
  private active: string | undefined

  private publish(): void {
    const current = this.active === undefined ? undefined : this.entries.get(this.active)?.intent
    this.snapshot.set({ ...(current === undefined ? {} : { active: current }),
      saved: [...this.entries.values()].filter(e => e.intent.id !== this.active && e.intent.text !== '').map(e => e.intent) })
  }

  /** Set up an editable draft synchronously, before starting the exact target operation.
   * @param target - captured allocation, Workspace and optional workbench pane.
   * @param prepare - authenticated operation; invokes transfer only after acquiring the real composer.
   * @returns the identity for this action.
   */
  begin(target: Pick<ConversationIntent, 'target' | 'workspaceId' | 'label' | 'paneId'>, prepare: Prepare): string {
    this.hide()
    const id = randomUUID()
    const intent: ConversationIntent = { ...target, id, sessionId: `session-${id}` as SessionId,
      draftId: `draft-${id}` as SessionDraftId, phase: 'preparing', text: '' }
    this.entries.set(id, { intent, prepare })
    this.resume(id)
    return id
  }

  /** Update only the indicated tab-local draft.
   * @param id - intent identified by the editing surface.
   * @param text - unsent input.
   */
  edit(id: string, text: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined || id !== this.active) return
    entry.intent = { ...entry.intent, text }
    this.publish()
  }

  /** Retry the same reservation or reopen an interrupted draft.
   * @param id - existing local intent.
   */
  resume(id: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.controller !== undefined) return
    if (this.active !== id) this.hide()
    this.active = id
    const controller = new AbortController()
    entry.controller = controller
    entry.intent = { ...entry.intent, phase: 'preparing' }
    this.publish()
    void entry.prepare(entry.intent, controller.signal, () => {
      if (this.active !== id || controller.signal.aborted) return
      this.entries.delete(id)
      this.active = undefined
      this.publish()
    }).catch((error: unknown) => {
      console.warn(`conversation intent prepare failed: ${error instanceof Error ? error.name : 'unknown'} editingAborted=${String(controller.signal.aborted)}`)
      if (entry.controller !== controller || controller.signal.aborted) return
      const refusal = error instanceof Error && ('status' in error && (error.status === 401 || error.status === 403)
        || 'code' in error && error.code === 'access-revoked' || error.name === 'ProjectReadOnlyError')
      entry.intent = { ...entry.intent, denied: refusal }
    }).finally(() => {
      if (entry.controller !== controller) return
      delete entry.controller
      if (!this.entries.has(id)) return
      entry.intent = { ...entry.intent, phase: 'unavailable' }
      this.publish()
    })
  }

  /** Leave the editor while preserving any input for this intent. */
  hide(): void {
    console.warn('[intents] hide() called')
    if (this.active === undefined) return
    const entry = this.entries.get(this.active)
    if (entry !== undefined) {
      entry.controller?.abort()
      delete entry.controller
      if (entry.intent.text === '') this.entries.delete(this.active)
      else entry.intent = { ...entry.intent, phase: 'unavailable' }
    }
    this.active = undefined
    this.publish()
  }

  /** Check for input that still belongs to this document.
   * @returns true when leaving the document would lose unsynchronized input.
   */
  hasUnsavedDrafts(): boolean { return [...this.entries.values()].some(entry => entry.intent.text !== '') }

  /** Forget all content after a verified account change or document disposal. */
  clear(): void {
    console.warn('[intents] clear() called')
    for (const entry of this.entries.values()) entry.controller?.abort()
    this.entries.clear()
    this.active = undefined
    this.publish()
  }
}
