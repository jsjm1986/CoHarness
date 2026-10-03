/** Chat HTTP(S) link destination preference bound to the durable conversation settings scope. */

import {
  createSnapshotStore, settingsControlState,
  type SettingsControlState, type SettingsScope, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_LINK_OPENING, type ConversationSettings, type LinkOpening,
} from '../submission-settings.ts'

/** Shared live preference for the Settings row and external-link dispatch. */
export class LinkOpeningPolicy {
  /** Reactive current destination, including the default before durable settings arrive. */
  readonly destination: SnapshotStore<LinkOpening>
  /** Host writability and write status source for the Settings row. */
  readonly settings: SnapshotStore<SettingsControlState>
  private readonly unsubscribe: (() => void) | undefined

  /**
   * @param host - durable preference scope owned by the providing plugin;
   * absent compositions stay process-local.
   */
  constructor(private readonly host: SettingsScope<ConversationSettings> | undefined) {
    this.destination = createSnapshotStore(DEFAULT_LINK_OPENING)
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
   * Publish a destination immediately and persist it when the scope supports writes.
   * @param destination - sidebar browser or a new browser tab.
   */
  setDestination(destination: LinkOpening): void {
    if (this.destination.getSnapshot() === destination) return
    const snapshot = this.host?.getSnapshot()
    if (snapshot?.status === 'ready' && !snapshot.writable) return
    this.destination.set(destination)
    void this.host?.set('linkOpening', destination)
  }

  /** Adopt the latest accepted durable section without writing it back. */
  private adopt(): void {
    const accepted = this.host?.getSnapshot().value?.linkOpening
    if (accepted !== undefined && this.destination.getSnapshot() !== accepted) {
      this.destination.set(accepted)
    }
  }
}
