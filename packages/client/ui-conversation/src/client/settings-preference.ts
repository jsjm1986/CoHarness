/** Generic live preference over one field of the durable conversation settings scope. */

import {
  createSnapshotStore, settingsControlState,
  type SettingsControlState, type SettingsScope, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSettings } from '../submission-settings.ts'

/**
 * Live current value plus writability state for one settings field: publishes
 * optimistic local choices, persists them when the scope accepts writes, and
 * adopts each accepted durable section without writing it back.
 * @param K - field inside the conversation settings section.
 * @param V - live value type; fields whose durable section accepts legacy or
 * cleared values normalize them through {@link SettingsPreference.constructor}'s
 * `normalize`.
 */
export class SettingsPreference<
  K extends keyof ConversationSettings,
  V extends ConversationSettings[K] = ConversationSettings[K],
> {
  /** Reactive current value, including the fallback before durable settings arrive. */
  readonly current: SnapshotStore<V>
  /** Host writability and write status source for the Settings row. */
  readonly settings: SnapshotStore<SettingsControlState>
  private readonly normalize: (saved: ConversationSettings[K] | undefined) => V | undefined
  private readonly unsubscribe: (() => void) | undefined

  /**
   * @param host - durable preference scope owned by the providing plugin;
   * absent compositions stay process-local.
   * @param key - section field this preference owns.
   * @param fallback - local value before the first accepted section.
   * @param normalize - narrows one accepted section value into the live value;
   * `undefined` keeps the current value. Defaults to identity.
   */
  constructor(
    private readonly host: SettingsScope<ConversationSettings> | undefined,
    private readonly key: K,
    fallback: V,
    normalize?: (saved: ConversationSettings[K] | undefined) => V | undefined,
  ) {
    this.normalize = normalize ?? ((saved: ConversationSettings[K] | undefined) => saved as V | undefined)
    this.current = createSnapshotStore(fallback)
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

  /** Release the scope observer owned by this preference. */
  dispose(): void { this.unsubscribe?.() }

  /**
   * Publish a value immediately and persist it when the scope supports writes.
   * @param value - field value selected by the user.
   */
  set(value: V): void {
    if (this.current.getSnapshot() === value) return
    const snapshot = this.host?.getSnapshot()
    if (snapshot?.status === 'ready' && !snapshot.writable) return
    this.current.set(value)
    void this.host?.set(this.key, value)
  }

  /** Adopt the latest accepted durable section without writing it back. */
  private adopt(): void {
    const accepted = this.normalize(this.host?.getSnapshot().value?.[this.key])
    if (accepted !== undefined && this.current.getSnapshot() !== accepted) this.current.set(accepted)
  }
}
