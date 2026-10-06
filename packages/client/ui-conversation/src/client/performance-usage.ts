/** Performance detail preference bound to the durable conversation settings scope. */

import type { SettingsControlState, SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_PERFORMANCE_USAGE, type ConversationSettings, type PerformanceUsageMode,
} from '../submission-settings.ts'
import { SettingsPreference } from './settings-preference.ts'

/** Shared live preference for the Settings row, composer statistics, and Turn usage. */
export class PerformanceUsagePolicy {
  /** Reactive current mode, including the default before durable settings arrive. */
  readonly mode: SnapshotStore<PerformanceUsageMode>
  /** Host writability and write status source for the Settings row. */
  readonly settings: SnapshotStore<SettingsControlState>
  private readonly preference: SettingsPreference<'performanceUsage'>

  /**
   * @param host - durable preference scope owned by the providing plugin;
   * absent compositions stay process-local.
   */
  constructor(host: SettingsScope<ConversationSettings> | undefined) {
    this.preference = new SettingsPreference(host, 'performanceUsage', DEFAULT_PERFORMANCE_USAGE)
    this.mode = this.preference.current
    this.settings = this.preference.settings
  }

  /** Release the scope observer owned by this policy. */
  dispose(): void { this.preference.dispose() }

  /**
   * Publish a choice immediately and persist it when the scope supports writes.
   * @param mode - statistics detail selected by the user.
   */
  setMode(mode: PerformanceUsageMode): void { this.preference.set(mode) }
}
