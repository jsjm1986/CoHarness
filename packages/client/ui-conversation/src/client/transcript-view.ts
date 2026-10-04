/** Durable work-details presentation policy over the conversation settings scope. */

import type { SettingsControlState, SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_TRANSCRIPT_VIEW_MODE, LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE, LEGACY_TRANSCRIPT_VIEW_MODE, TRANSCRIPT_VIEW_FIELD,
  type ConversationSettings, type TranscriptViewMode,
} from '../submission-settings.ts'
import { SettingsPreference } from './settings-preference.ts'

/** Live work-details preference consumed by the Chat view and its Settings row. */
export class TranscriptViewPolicy {
  /** Reactive current mode, including the client default before durable settings arrive. */
  readonly mode: SnapshotStore<TranscriptViewMode>
  /** Host writability and write status source for the Settings row. */
  readonly settings: SnapshotStore<SettingsControlState>
  private readonly preference: SettingsPreference<typeof TRANSCRIPT_VIEW_FIELD, TranscriptViewMode>

  /**
   * @param host - durable preference scope owned by the providing plugin;
   * absent compositions stay process-local. The adoption subscription shares
   * the scope's plugin lifetime — a disposed scope never publishes again, so
   * the policy needs no release hook for it.
   * @param defaultMode - presentation used without an explicit saved mode.
   */
  constructor(
    host: SettingsScope<ConversationSettings> | undefined,
    defaultMode: TranscriptViewMode = DEFAULT_TRANSCRIPT_VIEW_MODE,
  ) {
    this.preference = new SettingsPreference(host, TRANSCRIPT_VIEW_FIELD, defaultMode, saved =>
      saved === LEGACY_TRANSCRIPT_VIEW_MODE || saved === LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE
        ? 'detailed' : saved ?? defaultMode)
    this.mode = this.preference.current
    this.settings = this.preference.settings
  }

  /** Release the scope observer owned by this policy. */
  dispose(): void { this.preference.dispose() }

  /**
   * Publish and persist one explicit user choice; the live value publishes
   * before the durable write starts.
   * @param mode - Compact, Standard, Detailed, or Verbose work details.
   */
  setMode(mode: TranscriptViewMode): void { this.preference.set(mode) }
}
