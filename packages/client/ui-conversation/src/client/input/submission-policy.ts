/**
 * Composer submission policy. It owns the live busy-Enter
 * preference and resolves composer gestures into queue/steer delivery modes;
 * Host and Agent keep the actual delivery-window authority.
 */
import type { SettingsControlState, SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  BusyEnterBehavior,
} from '../contract/composer-submission.ts'
import { BUSY_ENTER_FIELD, DEFAULT_BUSY_ENTER_BEHAVIOR } from '../../submission-settings.ts'
import type { ConversationSettings } from '../../submission-settings.ts'
import { SettingsPreference } from '../settings-preference.ts'

export { resolveSubmitMode } from '../contract/composer-submission.ts'

export { DEFAULT_BUSY_ENTER_BEHAVIOR } from '../../submission-settings.ts'

/**
 * Busy-Enter policy used by both the composer inject face and its Settings row.
 * Direct `steer` is intentionally best-effort: AgentLoop turns a closed-window
 * submission into the next waking Queue item.
 */
export class ComposerSubmissionPolicy {
  /** Reactive preference source shared by the composer and Settings row. */
  readonly busyEnter: SnapshotStore<BusyEnterBehavior>
  /** Host writability and write status source for the Settings row. */
  readonly settings: SnapshotStore<SettingsControlState>
  private readonly preference: SettingsPreference<typeof BUSY_ENTER_FIELD>

  /**
   * @param host - durable preference scope owned by the providing plugin;
   * absent compositions stay process-local. The adoption subscription shares
   * the scope's plugin lifetime — a disposed scope never publishes again, so
   * the policy needs no release hook.
   */
  constructor(host?: SettingsScope<ConversationSettings>) {
    this.preference = new SettingsPreference(host, BUSY_ENTER_FIELD, DEFAULT_BUSY_ENTER_BEHAVIOR)
    this.busyEnter = this.preference.current
    this.settings = this.preference.settings
  }

  /**
   * Change the plain-Enter behavior used during busy state; the live value
   * publishes before the durable write starts.
   * @param behavior - Queue or Steer.
   */
  setBusyEnter(behavior: BusyEnterBehavior): void { this.preference.set(behavior) }

  /** Release the scope observer owned by this policy. */
  dispose(): void { this.preference.dispose() }
}
