/**
 * The configurable-plugins tab's card list.
 *
 * The tab dispatches its slot by settings namespace, so what it renders is
 * the intersection of two ledgers: the namespaces the Host serves and the
 * cards registered into `settings.plugin.item`. A served namespace no card
 * claims renders nothing, and a card whose namespace the Host does not serve
 * is never dispatched.
 */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** What the section renders. */
export interface ConfigurablePluginsTabState {
  /** Whether the Host has answered at least once. */
  loaded: boolean
  /** Served namespaces in card registration order. */
  namespaces: string[]
}

/** The registration-side face the tab's slot entry injects. */
export interface ConfigurablePluginsTabFace {
  hooks: {
    /** Configurable plugin directory snapshot. */
    configurablePlugins: SnapshotStore<ConfigurablePluginsTabState>
  }
}

/** Reads served namespaces and pairs them with cards that claim them. */
export class ConfigurablePluginsTabController {
  private readonly store = createSnapshotStore<ConfigurablePluginsTabState>({ loaded: false, namespaces: [] })
  private served: readonly string[] = []
  private loaded = false
  private generation = 0
  private disposed = false

  /**
   * @param api - settings wire face.
   * @param entries - cards currently registered into the section's slot.
   */
  constructor(
    private readonly api: Pick<IApiClient, 'settings'>,
    private readonly entries: () => readonly StoredEntry[],
  ) {}

  /** Opaque read because control flow cannot narrow a property across awaits. */
  private isDisposed(): boolean {
    return this.disposed
  }

  /** Re-read served namespaces and publish their registered cards. */
  async load(): Promise<void> {
    if (this.isDisposed()) return
    const generation = ++this.generation
    let response: Awaited<ReturnType<IApiClient['settings']['describe']>>
    try {
      response = await this.api.settings.describe({})
    } catch (_settingsReadFailure) {
      return
    }
    if (this.isDisposed() || generation !== this.generation || !response.result.ok) return
    this.served = response.result.value.namespaces.map(view => view.ns)
    this.loaded = true
    this.publish()
  }

  /** Republish after the slot ledger changed without another wire read. */
  refresh(): void {
    if (this.disposed) return
    this.publish()
  }

  /** Stop publishing and invalidate any in-flight read. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
  }

  /**
   * Build the face injected into the tab registration.
   *
   * @returns The registration face backed by the controller's snapshot store.
   */
  inject(): ConfigurablePluginsTabFace {
    return { hooks: { configurablePlugins: this.store } }
  }

  private publish(): void {
    const served = new Set(this.served)
    const namespaces = this.entries().flatMap(entry =>
      entry.options.key !== undefined && served.has(entry.options.key) ? [entry.options.key] : [])
    const previous = this.store.getSnapshot()
    if (previous.loaded === this.loaded
      && previous.namespaces.length === namespaces.length
      && previous.namespaces.every((ns, index) => ns === namespaces[index])) return
    this.store.set({ loaded: this.loaded, namespaces })
  }
}
