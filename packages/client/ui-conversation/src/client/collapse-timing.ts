/** Durable work-details collapse-timing policy over the conversation settings scope. */

import type { SettingsControlState, SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  COLLAPSE_TIMING_FIELD, DEFAULT_COLLAPSE_TIMING,
  type CollapseTiming, type ConversationSettings,
} from '../submission-settings.ts'
import { SettingsPreference } from './settings-preference.ts'

/** Live collapse-timing preference consumed by the Chat view and its Settings row. */
export class CollapseTimingPolicy {
  /** Reactive current timing, including the client default before durable settings arrive. */
  readonly timing: SnapshotStore<CollapseTiming>
  /** Host writability and write status source for the Settings row. */
  readonly settings: SnapshotStore<SettingsControlState>
  private readonly preference: SettingsPreference<typeof COLLAPSE_TIMING_FIELD, CollapseTiming>

  /**
   * @param host - durable preference scope owned by the providing plugin;
   * absent compositions stay process-local. The adoption subscription shares
   * the scope's plugin lifetime — a disposed scope never publishes again, so
   * the policy needs no release hook for it.
   */
  constructor(host: SettingsScope<ConversationSettings> | undefined) {
    this.preference = new SettingsPreference(host, COLLAPSE_TIMING_FIELD, DEFAULT_COLLAPSE_TIMING)
    this.timing = this.preference.current
    this.settings = this.preference.settings
  }

  /** Release the scope observer owned by this policy. */
  dispose(): void { this.preference.dispose() }

  /**
   * Publish and persist one explicit user choice; the live value publishes
   * before the durable write starts.
   * @param timing - completion-time or next-input folding.
   */
  setTiming(timing: CollapseTiming): void { this.preference.set(timing) }
}
