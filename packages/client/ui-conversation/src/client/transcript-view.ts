/** Durable work-details presentation policy over the conversation settings scope. */

import {
  createSnapshotStore, settingsControlState,
  type SettingsControlState, type SettingsScope, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_TRANSCRIPT_VIEW_MODE, LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE, LEGACY_TRANSCRIPT_VIEW_MODE, TRANSCRIPT_VIEW_FIELD,
  type ConversationSettings, type TranscriptViewMode,
} from '../submission-settings.ts'

/** Live work-details preference consumed by the Chat view and its Settings row. */
export class TranscriptViewPolicy {
  /** Reactive current mode, including the client default before durable settings arrive. */
  readonly mode: SnapshotStore<TranscriptViewMode>
  /** Host writability and write status source for the Settings row. */
  readonly settings: SnapshotStore<SettingsControlState>
  private readonly unsubscribe: (() => void) | undefined

  /**
   * @param host - durable preference scope owned by the providing plugin;
   * absent compositions stay process-local. The adoption subscription shares
   * the scope's plugin lifetime — a disposed scope never publishes again, so
   * the policy needs no release hook for it.
   * @param defaultMode - presentation used without an explicit saved mode.
   */
  constructor(
    private readonly host: SettingsScope<ConversationSettings> | undefined,
    private readonly defaultMode: TranscriptViewMode = DEFAULT_TRANSCRIPT_VIEW_MODE,
  ) {
    this.mode = createSnapshotStore(defaultMode)
    this.settings = createSnapshotStore(host === undefined
      ? { status: 'ready', writable: true, writableReason: undefined, write: { status: 'idle' } }
      : settingsControlState(host.getSnapshot()))
    if (host !== undefined) {
      this.unsubscribe = host.subscribe(() => {
        this.settings.set(settingsControlState(host.getSnapshot()))
        this.adopt()
      })
      this.adopt()
    }
  }

  /** Release the scope observer owned by this policy. */
  dispose(): void { this.unsubscribe?.() }

  /**
   * Publish and persist one explicit user choice; the live value publishes
   * before the durable write starts.
   * @param mode - Compact, Standard, Detailed, or Verbose work details.
   */
  setMode(mode: TranscriptViewMode): void {
    if (this.mode.getSnapshot() === mode) return
    const snapshot = this.host?.getSnapshot()
    if (snapshot?.status === 'ready' && !snapshot.writable) return
    this.mode.set(mode)
    void this.host?.set(TRANSCRIPT_VIEW_FIELD, mode)
  }

  /** Adopt the latest accepted durable section without writing it back. */
  private adopt(): void {
    const section = this.host?.getSnapshot().value
    if (section === undefined) return
    const saved = section.transcriptView
    const mode = saved === LEGACY_TRANSCRIPT_VIEW_MODE || saved === LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE
      ? 'detailed' : saved ?? this.defaultMode
    if (this.mode.getSnapshot() !== mode) this.mode.set(mode)
  }
}
