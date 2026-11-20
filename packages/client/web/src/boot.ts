/**
 * Web boot kernel. It owns only the module system, Cordis loader, and a
 * framework-free boot page; plugin composition and the renderer handoff are
 * `bootClient` and `mountClient`. The dynamic UI renderer receives the mount
 * point after the required client entries activate.
 * @module @deepseek-ai/dsh-client-web/src/boot
 */
import { Context } from '@deepseek-ai/cordis'
import type {
  BootManifest, ClientModuleCreateOptions, ClientModuleSystem, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import { bootClient } from './boot-client.ts'
import { BootPage } from './boot-page.ts'
import { mountClient } from './mount.ts'
import { loadRemoteEntry, remoteEntrySelection, RemoteEntryAccountChanged, remoteEntryUrl } from './remote-entry.ts'
import { getStaticModules } from './seed.ts'
import { StartupDraftView } from './startup-draft.ts'
import './abort-signal.ts'
import './base.css'

/** Module transport hook replaced by jsdom tests. */
export type BootSeams = Pick<ClientModuleCreateOptions, 'loadBundle'>

/** Browser boot entry consumed by `apps/web`. */
export class AppWebEntry {
  private readonly container: HTMLElement
  private readonly seams: BootSeams | undefined
  private readonly page: BootPage
  private readonly lifetime = new AbortController()
  private startupDraft: StartupDraftView | undefined
  private ctx: Context | undefined
  private modules!: ClientModuleSystem
  private manifest!: BootManifest

  /**
   * Draw the boot page; {@link run} starts the loader.
   * @param container - Application mount point.
   * @param seams - Optional module transport replacement.
   */
  constructor(container: HTMLElement, seams?: BootSeams) {
    this.container = container
    this.seams = seams
    this.page = new BootPage(container)
  }

  /**
   * Activate the required client entries, then hand the mount point to the
   * UI renderer. Required plugin failures remain visible on the boot page.
   * @param onFailure - Optional carrier-owned fatal presentation; keeps the boot page visible.
   * @returns Resolves after application mount or failure reporting.
   */
  async run(onFailure?: (reason: unknown) => void): Promise<void> {
    try {
      const remote = remoteEntrySelection()
      if (remote !== undefined) {
        const draft = new StartupDraftView(remote)
        this.startupDraft = draft
        this.page.attachDraft(draft)
        const boot = await loadRemoteEntry(remote, this.lifetime.signal)
        if (boot === 'full-index') {
          if (draft.read() === '') location.replace(remoteEntryUrl(remote, 'full'))
          else draft.showNativeIndexLink()
          return
        }
      }
      // Boot-readiness gate: whichever bootstrap applies the injection table
      // settles this deferred once every row has taken effect — the served
      // index resolves it in the rendered tail, so the await returns on the
      // next microtask; an asynchronous bootstrap resolves it after its last
      // row, or rejects it into the failure rendering below. An absent global
      // means no bootstrap owns the document and there is nothing to wait for.
      await (globalThis as { __DSH_BOOT_READY__?: { promise: Promise<void> } }).__DSH_BOOT_READY__?.promise
      const win = globalThis as DshWindow
      const moduleLoader = win.__ModuleLoader__
      if (moduleLoader === undefined) {
        throw new Error('web boot: window.__ModuleLoader__ bootstrap facade is missing')
      }
      // A pre-injected transport (the worker preview page) owns bundle bytes;
      // its loadBundle is the default and explicit seams still win. The global
      // is `ClientTransportHooks`, owned by @deepseek-ai/dsh-client-connection;
      // this structural slice reads one optional member without adding a
      // package edge.
      const transport = (globalThis as {
        __DSH_TRANSPORT__?: { loadBundle?: ClientModuleCreateOptions['loadBundle'] }
      }).__DSH_TRANSPORT__
      this.modules = moduleLoader.create({
        boot: win.__DSH_BOOT__,
        staticModules: getStaticModules(),
        ...transport?.loadBundle === undefined ? {} : { loadBundle: transport.loadBundle },
        ...this.seams,
      })
      this.manifest = this.modules.manifest

      const prefetching = this.prefetchImmediateTier()
      const ctx = new Context()
      this.ctx = ctx
      const draft = this.startupDraft
      if (draft !== undefined) {
        ctx.effect(() => {
          const remove = ctx.reflect.provide('startupDraft', draft)
          return () => { draft.dispose(); return remove() }
        }, 'web boot: local entry draft')
      }
      this.page.setTotal(this.manifest.plugins.filter(row => row.optional !== true).length)
      await prefetching
      await bootClient({
        ctx,
        modules: this.modules,
        manifest: this.manifest,
        onEntryState: (name, state) => {
          if (onFailure === undefined || state !== 'failed') this.page.setState(name, state)
        },
      })
      draft?.retainAtMount()
      await mountClient(ctx, this.container)
    } catch (reason) {
      if (this.lifetime.signal.aborted) return
      console.error(reason)
      if (onFailure !== undefined) onFailure(reason)
      else this.page.fail(reason instanceof Error ? reason.message : String(reason))
      if (this.startupDraft !== undefined) {
        if (reason instanceof RemoteEntryAccountChanged) this.startupDraft.dispose()
        else {
          this.page.attachDraft(this.startupDraft)
          this.startupDraft.showNativeIndexLink()
        }
      }
    }
  }

  /** Dispose the client plugin tree and whichever page owns the mount point. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    const ctx = this.ctx
    this.ctx = undefined
    if (ctx !== undefined) await ctx.fiber.dispose()
    this.startupDraft?.dispose()
    this.page.dispose()
  }

  /** Prefetch stage-one bundles and their dynamic requests before concurrent plugin imports. */
  private async prefetchImmediateTier(): Promise<void> {
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately && row.optional !== true)
      .map(row => this.modules.prefetch(row.id).catch((_prefetchError: unknown) => {
        // Prefetch only starts transport early; the Loader import retries and reports this bundle failure.
      })))
  }
}
