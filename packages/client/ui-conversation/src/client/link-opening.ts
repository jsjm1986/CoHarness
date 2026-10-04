/** Chat HTTP(S) link destination preference bound to the durable conversation settings scope. */

import type { SettingsControlState, SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_LINK_OPENING, type ConversationSettings, type LinkOpening,
} from '../submission-settings.ts'
import { SettingsPreference } from './settings-preference.ts'

/** Shared live preference for the Settings row and external-link dispatch. */
export class LinkOpeningPolicy {
  /** Reactive current destination, including the default before durable settings arrive. */
  readonly destination: SnapshotStore<LinkOpening>
  /** Host writability and write status source for the Settings row. */
  readonly settings: SnapshotStore<SettingsControlState>
  private readonly preference: SettingsPreference<'linkOpening'>

  /**
   * @param host - durable preference scope owned by the providing plugin;
   * absent compositions stay process-local.
   */
  constructor(host: SettingsScope<ConversationSettings> | undefined) {
    this.preference = new SettingsPreference(host, 'linkOpening', DEFAULT_LINK_OPENING)
    this.destination = this.preference.current
    this.settings = this.preference.settings
  }

  /** Release the scope observer owned by this policy. */
  dispose(): void { this.preference.dispose() }

  /**
   * Publish a destination immediately and persist it when the scope supports writes.
   * @param destination - sidebar browser or a new browser tab.
   */
  setDestination(destination: LinkOpening): void { this.preference.set(destination) }
}
