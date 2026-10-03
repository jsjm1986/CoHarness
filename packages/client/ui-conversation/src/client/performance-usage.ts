/** Performance detail preference bound to the durable conversation settings scope. */

import {
  createSnapshotStore, settingsControlState,
  type SettingsControlState, type SettingsScope, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_PERFORMANCE_USAGE, type ConversationSettings, type PerformanceUsageMode,
} from '../submission-settings.ts'

/** Shared live preference for the Settings row, composer statistics, and Turn usage. */
export class PerformanceUsagePolicy {
  /** Reactive current mode, including the default before durable settings arrive. */
  readonly mode: SnapshotStore<PerformanceUsageMode>
  /** Host writability and write status source for the Settings row. */
  readonly settings: SnapshotStore<SettingsControlState>
  private readonly unsubscribe: (() => void) | undefined

  /**
   * @param host - durable preference scope owned by the providing plugin;
   * absent compositions stay process-local.
   */
  constructor(private readonly host: SettingsScope<ConversationSettings> | undefined) {
    this.mode = createSnapshotStore(DEFAULT_PERFORMANCE_USAGE)
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
   * Publish a choice immediately and persist it when the scope supports writes.
   * @param mode - statistics detail selected by the user.
   */
  setMode(mode: PerformanceUsageMode): void {
    if (this.mode.getSnapshot() === mode) return
    const snapshot = this.host?.getSnapshot()
    if (snapshot?.status === 'ready' && !snapshot.writable) return
    this.mode.set(mode)
    void this.host?.set('performanceUsage', mode)
  }

  /** Adopt the latest accepted durable section without writing it back. */
  private adopt(): void {
    const accepted = this.host?.getSnapshot().value?.performanceUsage
    if (accepted !== undefined && this.mode.getSnapshot() !== accepted) this.mode.set(accepted)
  }
}
