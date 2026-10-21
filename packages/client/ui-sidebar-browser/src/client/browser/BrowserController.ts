/** Per-tab Browser controller. */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { IframeImpl } from './BrowserFrame.ts'
import type { BrowserFrame, BrowserFrameState } from './BrowserFrame.ts'
import { BrowserNavigation } from './BrowserNavigation.ts'
import type { BrowserTabState } from './BrowserNavigation.ts'
import type { BrowserStore } from './store.ts'
import { parseBrowserAddress } from './url.ts'

/** Construction dependencies for one tab-scoped Browser controller. */
export interface BrowserControllerOptions {
  readonly tabId: TabId
  readonly signal: AbortSignal
  readonly applicationOrigin: string
  readonly initial?: BrowserTabState
  readonly actions: BoundActions<BrowserStore>
}

/** Owns one Browser tab's URL state, loading lifecycle, and four navigation commands. */
export class BrowserController {
  /** Renderer-facing iframe and sandbox state. */
  readonly frame: BrowserFrame
  private readonly navigation: BrowserNavigation
  private started = false
  private disposed = false

  /**
   * @param options - tab identity, persistence writer, URL origin, and lifetime.
   */
  constructor(private readonly options: BrowserControllerOptions) {
    this.navigation = new BrowserNavigation(options.initial)
    this.frame = new IframeImpl(
      () => { this.reload() },
      (revision) => { this.frameLoaded(revision) },
    )
    options.signal.addEventListener('abort', () => { this.dispose() }, { once: true })
  }

  /**
   * Consume the typed-open address once; a saved checkpoint alone never starts a load.
   * @param initialUrl - explicit navigation supplied with the tab record, when any.
   */
  start(initialUrl: string | undefined): void {
    if (this.started || this.disposed) return
    this.started = true
    if (initialUrl !== undefined) this.loadUrl(initialUrl)
  }

  /**
   * Validate and load one address, replacing a same-address load with Reload.
   * @param value - address-bar or typed-tab value.
   */
  loadUrl(value: string): void {
    if (this.disposed) return
    const parsed = parseBrowserAddress(value, this.options.applicationOrigin)
    if (!parsed.ok) {
      this.navigation.addressFailed(parsed.reason)
      this.publish()
      return
    }
    const current = BrowserNavigation.current(this.navigation.snapshot)
    if (current?.url === parsed.target.url) {
      this.reload()
      return
    }
    this.beginLoad(this.navigation.navigate(parsed.target))
  }

  /** Move to the preceding application-known address when Web history remains usable. */
  goBack(): void {
    if (this.disposed) return
    const request = this.navigation.back()
    if (request !== undefined) this.beginLoad(request)
  }

  /** Move to the following application-known address when Web history remains usable. */
  goForward(): void {
    if (this.disposed) return
    const request = this.navigation.forward()
    if (request !== undefined) this.beginLoad(request)
  }

  /** Reload the last application-known address without adding history. */
  reload(): void {
    if (this.disposed) return
    const request = this.navigation.reload()
    if (request !== undefined) this.beginLoad(request)
  }

  private beginLoad(request: NonNullable<BrowserTabState['request']>): void {
    this.publish()
    this.frame.clearDocument()
    this.frame.setDocument({ target: request.target, src: request.target.url, revision: request.revision })
  }

  private frameLoaded(revision: number): void {
    if (this.disposed) return
    const previous = this.navigation.snapshot
    this.navigation.frameLoaded(revision)
    if (this.navigation.snapshot !== previous) this.publish()
  }

  private publish(): void {
    this.options.actions.replace(this.options.tabId, this.navigation.snapshot)
  }

  private dispose(): void {
    this.disposed = true
    this.frame.clearDocument()
  }
}

/** Browser commands and keyed frame state injected into the tab body. */
export interface BrowserInjected {
  readonly keyedHooks: {
    readonly browserFrame: (key: string) => HostObservable<BrowserFrameState> | undefined
  }
  /**
   * @param tabId - tab occurrence.
   * @param signal - occurrence lifetime.
   * @param applicationOrigin - current application origin.
   * @param initial - persisted tab state.
   * @param initialUrl - explicit typed-open address; consumed once per occurrence.
   */
  mount(tabId: TabId, signal: AbortSignal, applicationOrigin: string, initial?: BrowserTabState, initialUrl?: string): void
  /** @param tabId - tab occurrence. @param value - address-bar or typed-open value. */
  loadUrl(tabId: TabId, value: string): void
  /** @param tabId - tab occurrence. */
  goBack(tabId: TabId): void
  /** @param tabId - tab occurrence. */
  goForward(tabId: TabId): void
  /** @param tabId - tab occurrence. */
  reload(tabId: TabId): void
  /** @param tabId - tab occurrence. */
  toggleSandbox(tabId: TabId): void
  /** @param tabId - tab occurrence. @param revision - rendered document revision. */
  reportLoaded(tabId: TabId, revision: number): void
  /** @param tabId - tab occurrence. @param revision - rendered document revision that emitted `error`. */
  reportLoadFailed(tabId: TabId, revision: number): void
}

/**
 * Bind Browser controllers to one Session and its persistence writer.
 * @param actions - Browser store mutation face.
 * @param isTabOpen - authoritative open-record membership; aborts without it forget saved navigation.
 * @returns a per-tab controller registry exposed as plain Slot callbacks.
 */
export function createBrowserControllers(
  actions: BoundActions<BrowserStore>,
  isTabOpen: (tabId: TabId) => boolean,
): BrowserInjected {
  const controllers = new Map<TabId, { readonly signal: AbortSignal; readonly controller: BrowserController }>()
  const controller = (tabId: TabId): BrowserController | undefined => controllers.get(tabId)?.controller
  return {
    keyedHooks: { browserFrame: key => controller(key as TabId)?.frame },
    mount(tabId, signal, applicationOrigin, initial, initialUrl) {
      if (signal.aborted) return
      const held = controllers.get(tabId)
      if (held?.signal === signal) {
        held.controller.start(initialUrl)
        return
      }
      const created = new BrowserController({
        tabId, signal, applicationOrigin, actions,
        ...(initial === undefined ? {} : { initial }),
      })
      controllers.set(tabId, { signal, controller: created })
      signal.addEventListener('abort', () => {
        if (controllers.get(tabId)?.controller !== created) return
        controllers.delete(tabId)
        // Domain disposal aborts every live occurrence too; only record removal deletes saved navigation.
        if (!isTabOpen(tabId)) actions.forget(tabId)
      }, { once: true })
      created.start(initialUrl)
    },
    loadUrl: (tabId, value) => { controller(tabId)?.loadUrl(value) },
    goBack: (tabId) => { controller(tabId)?.goBack() },
    goForward: (tabId) => { controller(tabId)?.goForward() },
    reload: (tabId) => { controller(tabId)?.reload() },
    toggleSandbox: (tabId) => { controller(tabId)?.frame.toggleSandbox() },
    reportLoaded: (tabId, revision) => { controller(tabId)?.frame.reportLoaded(revision) },
    reportLoadFailed: (tabId, revision) => { controller(tabId)?.frame.reportLoadFailed(revision) },
  }
}
