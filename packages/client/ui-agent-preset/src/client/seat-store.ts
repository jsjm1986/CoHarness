/**
 * Hero-chip controller: which preset the NEXT session gets.
 *
 * The new-session screen has no session, so a pick is staged rather than
 * applied. It reaches a session when one becomes current and is still blank —
 * whether the workspace connect created it or reused an existing blank one,
 * which is why staging cannot simply ride along on `sessions.create`.
 *
 * The stage is forgotten once applied: the next new session starts from the
 * deployment default again, matching the workspace picker beside it.
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore, type SessionId, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import { messageOf, presetOptions } from './settings-store.ts'
import type { AgentPresetOption } from './settings-store.ts'

/** Hero-chip snapshot. */
export interface AgentPresetSeatState {
  /** Whether new-session surfaces expose preset selection. */
  showPicker: boolean
  /** Presets the deployment supplies; empty means the chip renders nothing. */
  options: readonly AgentPresetOption[]
  /** The staged choice, empty until the roster loads. */
  current: string
  /** An error message; explicit selection failures also carry the preset for a Toast. */
  error: string | { readonly preset: AgentPresetOption; readonly reason: string } | null
  busy: boolean
  /**
   * One-shot cue that the chip should introduce itself (the creator-draft
   * entry staged the pick from another screen, so the user never touched the
   * chip); the renderer clears it via `introduced()` once played.
   */
  introduce: boolean
}

const INITIAL: AgentPresetSeatState = {
  showPicker: false, options: [], current: '', error: null, busy: false, introduce: false,
}

/** One session's identity and whether it has started. */
export interface SeatSessionSummary {
  /** The session the chip would apply its staged choice to. */
  id: SessionId
  /** False once a turn has run — applying is refused from then on. */
  blank: boolean
  /** The preset the session already runs, when the summary reports one. */
  agentPreset?: string
}

interface StagedPreset {
  readonly id: string
}

interface PresetSelectionAttempt {
  readonly sessionId: SessionId
  readonly done: Promise<undefined>
  queued?: { readonly sessionId: SessionId; readonly stage: StagedPreset }
}

/** Stages the next session's preset and applies it when one appears. */
export class AgentPresetSeatController {
  /** Chip snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentPresetSeatState> = createSnapshotStore(INITIAL)

  /**
   * The deployment default, so a consumed stage can fall back to it without
   * re-reading the roster.
   */
  private fallback = ''

  /** One unapplied choice; replacing it gives the next intent its own identity. */
  private staged: StagedPreset | undefined

  /** One active RPC and the latest explicit apply request observed during it. */
  private pendingSelection: PresetSelectionAttempt | undefined

  /** Only the newest roster read may publish after overlapping refreshes. */
  private loadGeneration = 0

  constructor(
    private readonly remote: Pick<ClientRemote, 'agentPresets'>,
    /** The session the hero is about to hand over to, when there is one. */
    private readonly currentSession: () => SeatSessionSummary | undefined,
    /**
     * Publish an applied switch into the session list, so the header label
     * moves with the composition instead of waiting for the next full list
     * refresh. Optional: a harness that renders no list omits it.
     */
    private readonly onApplied?: (sessionId: string, agentPreset: string) => void,
  ) {}

  /** Forget the unapplied choice without changing any Session. */
  clearStage(): void {
    this.staged = undefined
    if (this.store.getSnapshot().introduce) this.set({ introduce: false })
  }

  private set(patch: Partial<AgentPresetSeatState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /**
   * Read the roster and open the chip on the deployment default.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    const generation = ++this.loadGeneration
    try {
      const response = await this.remote.agentPresets.list()
      if (generation !== this.loadGeneration) return
      // A roster refresh can finish after a selection; leave its refusal for the chip.
      const shown = this.store.getSnapshot()
      const error = shown.error
      if (!response.ok) {
        if (typeof error !== 'object' || error === null) this.set({ error: response.error.message })
        return
      }
      const { presets, modeSelectionEnabled } = response.value
      // A hidden picker cannot serve a staged pick: drop it rather than
      // landing a choice no visible control reports.
      if (!modeSelectionEnabled) this.clearStage()
      this.fallback = presets.find(preset => preset.isDefault)?.id ?? presets[0]?.id ?? ''
      const session = this.currentSession()
      const pending = this.pendingSelection
      this.set({
        showPicker: modeSelectionEnabled,
        options: presetOptions(presets),
        // A roster read preserves a pending choice for the same Session.
        current: this.staged?.id
          ?? (pending !== undefined && pending.sessionId === session?.id
            ? shown.current
            : session?.agentPreset ?? this.fallback),
        error: typeof error === 'object' ? error : null,
        introduce: modeSelectionEnabled && this.store.getSnapshot().introduce,
      })
      await this.apply()
    } catch (error) {
      if (generation !== this.loadGeneration) return
      const current = this.store.getSnapshot().error
      if (typeof current !== 'object' || current === null) this.set({ error: messageOf(error) })
    }
  }

  /**
   * Stage one preset for the next session, applying it immediately when a
   * blank session is already current.
   * @param id - the preset to stage.
   * @returns once the stage settled, and the apply too when one happened.
   */
  async select(id: string): Promise<void> {
    if (this.store.getSnapshot().busy) return
    this.stage(id)
    await this.apply()
  }

  /**
   * Stage a pick WITHOUT the immediate apply, for a flow that starts the
   * receiving session after the pick (the settings section's creator entry).
   * `select()`'s immediate apply would meet the still-current running session
   * and drop the stage as unservable; staging alone leaves it for the
   * list-change applier, which fires when the started session becomes
   * current.
   * @param id - the preset to stage.
   * @param introduce - true when the stage came from another screen and the
   * chip should announce itself on the session it lands on.
   */
  stage(id: string, introduce = false): void {
    this.staged = { id }
    this.set({ current: id, error: null, introduce })
  }

  /**
   * Capture the exact blank Session a Settings action may bring along.
   * @returns its id, or undefined outside a blank Session.
   */
  blankSessionId(): SessionId | undefined {
    const session = this.currentSession()
    return session?.blank === true ? session.id : undefined
  }

  /**
   * Apply a Settings choice only if its captured Session is still current and
   * blank after any active selection settles.
   * @param expectedSessionId - blank Session captured before the Settings write.
   * @param id - the effective default that the write persisted.
   * @returns the Host refusal text, or undefined when applied or no longer relevant.
   */
  async syncBlankSession(
    expectedSessionId: SessionId,
    id: string,
  ): Promise<string | undefined> {
    while (this.pendingSelection !== undefined) await this.pendingSelection.done
    const session = this.currentSession()
    if (session === undefined || !session.blank || session.id !== expectedSessionId) return undefined
    this.stage(id)
    return await this.apply()
  }

  /** Acknowledge the introduction cue once the chip has played it. */
  introduced(): void {
    if (!this.store.getSnapshot().introduce) return
    this.set({ introduce: false })
  }

  /**
   * Apply the staged choice to the current blank Session.
   * A pending selection coalesces explicit apply requests for the latest stage.
   * Replacing or clearing that stage, or leaving its Session, cancels the queued request.
   * @returns this call's Host refusal, or undefined when successful or no selection starts.
   */
  async apply(): Promise<string | undefined> {
    const choice = this.staged
    const session = this.currentSession()
    const active = this.pendingSelection
    if (active !== undefined) {
      if (choice !== undefined && session?.blank === true) {
        active.queued = { sessionId: session.id, stage: choice }
      }
      return undefined
    }
    if (choice === undefined) {
      const current = session?.agentPreset ?? this.fallback
      if (current !== this.store.getSnapshot().current) this.set({ current })
      return undefined
    }
    if (session === undefined) return undefined
    const staged = choice.id
    if (session.agentPreset === staged) {
      this.staged = undefined
      return undefined
    }
    // A stage remains available for the next blank Session.
    if (!session.blank) return undefined
    const completion = Promise.withResolvers<undefined>()
    const attempt: PresetSelectionAttempt = { sessionId: session.id, done: completion.promise }
    const previousPreset = session.agentPreset
    this.pendingSelection = attempt
    this.staged = undefined
    const displayed = (selected: string): string => {
      const current = this.currentSession()
      return this.staged?.id
        ?? (current?.id === attempt.sessionId ? selected : current?.agentPreset ?? this.fallback)
    }
    const refuse = (reason: string): string => {
      this.set({
        error: {
          reason,
          preset: this.store.getSnapshot().options.find(option => option.id === staged)
            ?? { id: staged, trust: 'system' },
        },
        current: displayed(previousPreset ?? this.fallback),
      })
      return reason
    }
    try {
      this.set({ busy: true, error: null })
      const response = await this.remote.agentPresets.select(attempt.sessionId, staged)
      if (!response.ok) {
        const { error } = response
        const detail = error.details
        return refuse('reason' in detail && typeof detail.reason === 'string' ? detail.reason : error.message)
      }
      this.set({ current: displayed(response.value) })
      this.onApplied?.(attempt.sessionId, response.value)
      return undefined
    } catch (error) {
      return refuse(messageOf(error))
    } finally {
      this.pendingSelection = undefined
      completion.resolve(undefined)
      this.set({ busy: false })
      const queued = attempt.queued
      if (queued !== undefined
        && (this.staged as StagedPreset | undefined) === queued.stage
        && this.currentSession()?.id === queued.sessionId) {
        void this.apply()
      }
    }
  }

  /** Acknowledge a displayed refusal without dismissing a newer attempt.
   * @param refusal - the selection error whose Toast finished.
   */
  dismissRefusal(refusal: AgentPresetSeatState['error']): void {
    if (refusal !== null && typeof refusal === 'object' && this.store.getSnapshot().error === refusal) {
      this.set({ error: refusal.reason })
    }
  }
}
