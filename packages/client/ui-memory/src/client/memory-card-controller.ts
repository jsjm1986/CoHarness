/** The Memory card's direct-write form over the `memory` settings namespace. */
import {
  createSnapshotStore, type SettingsScope, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Namespace of the memory feature. Spelled here rather than imported: a
 * client package must not depend on the Host package's settings installer,
 * and the owning service spells the same value.
 */
export const MEMORY_NS = 'memory'

/** The `memory` section fields this card edits — the feature's only switch. */
export interface MemorySettingsSection {
  /** Whether the agent reads and writes memory at all. */
  enabled?: boolean
}

/** What the Memory card renders. */
export interface MemoryCardState {
  /** Whether the Host serves the namespace at all. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether memory reads and writes run. */
  enabled: boolean
  /** Whether the last write is still in flight. */
  saving: boolean
  /** Whether the last write failed. */
  failed: boolean
}

/** The registration-side face the Memory card's slot entry injects. */
export interface MemoryCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useMemoryCard. */
    memoryCard: SnapshotStore<MemoryCardState>
  }
  /** Persist the enabled choice; settlement resolves after Host acceptance. */
  setEnabled: (enabled: boolean) => void
}

/** Bridges the `memory` scope onto the Memory card's toggle. */
export class MemoryCardController {
  private saving = false
  private failed = false
  private readonly store: SnapshotStore<MemoryCardState>

  /** @param scope - the bound settings scope for the `memory` namespace. */
  constructor(private readonly scope: SettingsScope<MemorySettingsSection>) {
    this.store = createSnapshotStore(this.projection())
    scope.subscribe(() => { this.store.set(this.projection()) })
  }

  private projection(): MemoryCardState {
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      enabled: snapshot.value?.enabled ?? true,
      saving: this.saving || snapshot.write.status === 'saving',
      failed: this.failed,
    }
  }

  /**
   * Persist the enabled choice with ordered writes. The Host is the only
   * authority on acceptance, so a refused or failed write surfaces through
   * the snapshot's write state and marks the card failed rather than
   * reverting silently.
   * @param enabled - requested feature state.
   */
  private async setEnabled(enabled: boolean): Promise<void> {
    this.saving = true
    this.failed = false
    this.store.set(this.projection())
    try {
      await this.scope.set('enabled', enabled)
      const write = this.scope.getSnapshot().write
      if (write.status === 'blocked' || write.status === 'error') this.failed = true
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.store.set(this.projection())
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its write action.
   */
  inject(): MemoryCardFace {
    return {
      hooks: { memoryCard: this.store },
      setEnabled: (enabled) => { void this.setEnabled(enabled) },
    }
  }
}
