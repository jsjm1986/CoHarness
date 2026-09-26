/**
 * Browser half: fill the frame's right column with the panel, put the expand
 * button in the conversation header, and own the seats a tab type registers
 * into.
 *
 * Two seats share one session-scoped store, which the slot runtime allows
 * because both are session-scoped (a handle may not span scopes). The panel seat
 * in the frame draws the surface normally or fullscreen, retaining the track
 * on wide viewports; the header's corner seat draws the way back in
 * while the panel is hidden. The store is the layout's only source of truth; the docking
 * kit's pure planners compute every change and the store records them, one
 * history entry per intent.
 *
 * The frame is a base package and never injects this one. What it needs —
 * whether the panel is shown and whether it wants a track — arrives through its
 * own `ctx.layout` action face, reported by the seat that knows both facts.
 *
 * Tab types register in two stages: the type itself into `ctx.sidebarRightTabs`,
 * its body into the keyed `sidebar.right.pane.tab` seat under the same kind. The
 * guide registers through those stages unmodified, exactly as a type shipped
 * from another package does — `ui-sidebar-browser` and workspace file preview use this lifecycle.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { parseWorkspaceResourceAddress, workspaceResourceAddress, sessionPersistenceKey } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from './contract/slots.ts'
import { clearSidebarLayout, readSidebarLayout, writeSidebarLayout } from './persistence.ts'
import { parseToolAddress, toolAddress } from './tabs/tool/address.ts'
import { ToolBody } from './tabs/tool/ToolBody.tsx'
import { GuideBody, type GuideInjected } from './tabs/guide/GuideBody.tsx'
import { GuideTitle } from './tabs/guide/GuideTitle.tsx'
import { ExpandButton, BlankExpandButton } from './shell/ExpandButton.tsx'
import { RightbarSeat, type SidebarRightInjected } from './shell/SidebarRight.tsx'
import { RightbarRoot } from './shell/RightbarRoot.tsx'
import { createSidebarRightController, type SidebarRightController } from './service.ts'
import { SidebarRightTabRegistry } from './tab-registry.ts'
import { createSidebarRightStore } from './stores.ts'
import { en, zh } from './locales.ts'
import { GUIDE_ID, guideDefinition } from './tabs/guide/definition.ts'
import { guideTabInfoFactory, tabInfoFactory } from './tab-info.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { defaultSeed } from './contract/seed.ts'

export type { RightbarSeatProps, SidebarRightInjected, SidebarRightPresentation } from './shell/SidebarRight.tsx'
export type { GuideBodyProps, GuideInjected } from './tabs/guide/GuideBody.tsx'
export type { ExpandButtonProps } from './shell/ExpandButton.tsx'
export type { SidebarRightState, SurfaceState } from './stores.ts'
export type {
  ISidebarRight, SidebarRightBinding, SidebarRightOpenResourceOptions, SidebarRightOpenTabOptions,
  SidebarRightPlacement, SidebarRightCloseHandler, SurfaceActions,
} from './service.ts'
export type {
  SidebarRightGuideBox, SidebarRightGuideEntry, SidebarRightTabClaim, SidebarRightTabDefinition,
  SidebarRightTabPriority,
} from './tab-registry.ts'
export type {
  SidebarRightTabInfo, SidebarRightTabInjected, UseSidebarRightTabInfo, SidebarRightTabActions,
  SidebarRightTabMenuOwnerProps, SidebarRightTabNavigation, SidebarRightTabPlacement, SidebarRightGuideEntryOwnerProps,
} from './contract/slots.ts'
export type {
  SidebarRightNavigationParams, SidebarRightResourceParams, SidebarRightResourceParamsMap,
  SidebarRightTabParams, SidebarRightTabParamsFor, SidebarRightTabParamsMap,
} from './contract/params.ts'
// The layout ids and rectangle the navigation face takes, so a caller needs no import from the kit.
export type { FloatRect, PaneId, TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
export type { PinResource, SidebarRightNavigator, TabOccurrence } from './tab-domain.ts'
export type { SidebarRightKey } from './locales.ts'
export type { OpenContentIntent } from './stores.ts'
export type { SidebarRightOpenTab } from './tab-inventory.ts'

/** This package's copy namespace. */
const NS = 'sidebarRight'

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface SessionReferenceSourceMap { auxiliary: true }
}

/** Required browser services: the slot registry, the frame's panel actions, copy, and the resource model. */
export const inject = ['slots', 'layout', 'locale', 'sessions', 'workspaceResources', 'connection', 'projectUiPolicy']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Right-Sidebar navigation and presentation face. */
    sidebarRight: SidebarRightController
    /** Right-Sidebar tab-type registry (stage one of a tab type's registration). */
    sidebarRightTabs: SidebarRightTabRegistry
  }
}

/**
 * Client plugin body: provide the registry and the navigation face, register the
 * panel seat and the rail seat over one store with their extension children, and
 * register the guide type through the same public two-stage path any other type
 * uses.
 * @param ctx - client root context carrying the slot registry, the frame's face, and copy.
 */
export function apply(ctx: ClientContext): void {
  // The registry and the face it backs are built here, at apply's top level,
  // and never inside an effect. A registry other packages register into cannot
  // have an effect-internal scope as its host: `register()` adds an effect to
  // this fiber, and doing that from another plugin's apply while the effect is
  // still the active scope stalls browser boot with no error at all. The
  // template this follows (ui-conversation's definition registry) is built at
  // its own apply top level for the same reason.
  const connection = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(NS)
  const tabs = new SidebarRightTabRegistry(ctx)
  const validateResource = (sessionId: SessionId, address: string): void => {
    const target = parseWorkspaceResourceAddress(address) ?? parseToolAddress(address)
    const owner = target?.sessionId ?? tabs.get(tabs.claim(address).kind)?.resourceSession?.(address)
    if (owner !== sessionId) throw new Error('Sidebar resource does not belong to this Session')
  }
  const { controller, adopt, forget } = createSidebarRightController(
    tabs,
    (address, signal, sessionId) => {
      if (!address.startsWith('dsh-resource://')) return
      const file = parseWorkspaceResourceAddress(address)
      validateResource(sessionId, address)
      const reference = ctx.sessions.retain(sessionId, { source: 'auxiliary', signal })
      try {
        if (file !== undefined) {
          const runtimeTarget = ctx.sessions.runtimeTargetFor?.(sessionId) ?? { kind: 'base' as const }
          ctx.workspaceResources.pin({ ...file, runtimeTarget, address: workspaceResourceAddress(sessionId, file.path) }, signal)
        }
        signal.addEventListener('abort', () => { reference.release() }, { once: true })
        /* v8 ignore if -- the domain pins an occurrence before any sync can abort it; this guards an abort racing the listener attach */
        if (signal.aborted) reference.release()
      } catch (error) {
        reference.release()
        throw error
      }
    },
    { discoverSaved: false, validateResource },
  )
  const disposeRegistry = ctx.reflect.provide('sidebarRightTabs', tabs)
  const disposeService = ctx.reflect.provide('sidebarRight', controller)
  // Registered first, so it tears down last: the faces outlive every seat and
  // type that reaches for them. provide()'s disposer settles asynchronously;
  // teardown is synchronous fire-and-forget, matching ui-layout's root entry.
  // Unloading aborts every tab occurrence, which releases every pin.
  ctx.effect(() => () => {
    controller.tabDomain.dispose()
    void disposeService()
    void disposeRegistry()
  }, 'ui-sidebar-right: service faces')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar-right: dictionaries')

  ctx.effect(() => {
    const handle = createSidebarRightStore(() => defaultSeed(tabs), false)
    // The runtime mints one instance of this handle per session (the scope key
    // is the session id) and caches it per key. Each is adopted as it is minted,
    // so a tab's own action reaches its session's store while another session
    // is on screen, and that store's commits sync the Tab domain themselves.
    const adoptions: Array<() => void> = []
    const store: typeof handle = {
      ...handle,
      create: (scopeKey) => {
        const instance = handle.create(scopeKey)
        if (scopeKey === undefined) return instance
        const sessionId = scopeKey as SessionId
        const storageKey = (): string | undefined => sessionPersistenceKey(
          ctx.sessions, sessionId, connection.hostDescription.getSnapshot()?.executionAuthorityRequired,
          ctx.projectUiPolicy.getSnapshot().verifiedAccountId,
        )
        let key = storageKey()
        let restoring = false
        const restore = (): void => {
          restoring = true
          try {
            const saved = key === undefined ? undefined : readSidebarLayout(key)
            const valid = saved !== undefined && Object.values(saved.layout.tabs).every((tab) => {
              if (!tab.contentId.startsWith('dsh-resource://')) return true
              try { validateResource(sessionId, tab.contentId); return true } catch { return false }
            })
            if (saved !== undefined && !valid && key !== undefined) clearSidebarLayout(key)
            instance.store.set({ bySession: valid ? { [scopeKey]: saved } : {} })
          } finally { restoring = false }
        }
        restore()
        adoptions.push(adopt(sessionId, instance))
        adoptions.push(instance.subscribe(() => {
          const surface = instance.getSnapshot().bySession[scopeKey]
          if (!restoring && key !== undefined && surface !== undefined) writeSidebarLayout(key, surface)
        }))
        const reconcile = (): void => {
          const next = storageKey()
          if (next === key) return
          controller.tabDomain.forget(sessionId)
          key = next
          restore()
        }
        adoptions.push(
          ctx.projectUiPolicy.subscribe(reconcile), connection.hostDescription.subscribe(reconcile), ctx.sessions.list.subscribe(reconcile),
        )
        return { ...instance, clearPersisted() {
          if (key !== undefined) clearSidebarLayout(key)
          forget(sessionId)
        } }
      },
    }
    const layout: ILayout = ctx.layout
    const injected: Omit<SidebarRightInjected, 'keyedHooks' | 'occurrence' | 'closeTab'> = {
      syncPresentation({ shown, track, fullscreen }) {
        if (shown) layout.openRightbar(track, fullscreen)
        else layout.closeRightbar()
      },
      bindService: binding => controller.bind(binding),
      openTab: (kind, options) => { controller.openTab(kind, options) },
      hooks: { tabTypes: { subscribe: listener => tabs.subscribe(listener), getSnapshot: () => tabs.entries() } },
    }

    const disposeTypes = [tabs.register(guideDefinition(t)), tabs.register({
      id: 'tool-details', kind: 'tool-details', priority: 'builtin',
      patterns: ['dsh-resource://tool/session/*/*'],
      canOpen: address => parseToolAddress(address) !== undefined,
      title: address => parseToolAddress(address)?.callId ?? t('tab.tool.title'),
    })]
    const releaseOwner = layout.bindRightbar({
      openDetails(sessionId, target) {
        const owner = sessionId ?? ctx.sessions.list.getSnapshot().current
        if (owner === undefined || target?.callId === undefined) throw new Error('Tool details require an explicit Session and call')
        layout.focusRightbar(owner)
        controller.openSessionResource(owner, toolAddress(owner, target.callId), { kind: 'tool-details' })
      },
      close: (sessionId) => { controller.setExpandedIn(sessionId, false) },
    })
    const disposeTool = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: 'tool-details',
      children: { details: { kind: 'single', scope: 'session' } },
    }, ToolBody))
    const disposeSeat = ctx.slots.inject('rightbar', function* () {
      yield ctx.slots.register({
        name: 'rightbar',
        children: { 'rightbar.session': { kind: 'single', scope: 'session' } },
      }, RightbarRoot)
      yield ctx.slots.register({
        name: 'rightbar.session',
        locale: NS,
        children: {
          'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: tabInfoFactory } } },
          'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: tabInfoFactory } } },
          'sidebar.right.tab.menu.item': { kind: 'list', scope: 'session' },
        },
        store,
        inject: (sessionId): SidebarRightInjected => ({
          ...injected,
          closeTab: (tabId) => {
            try { controller.closeIn(sessionId, tabId) }
            catch (error) { console.error('Sidebar tab close failed:', error) }
          },
          keyedHooks: { tabNavigation: key => controller.tabDomain.occurrence(sessionId, { id: key as TabId }).navigation },
          occurrence: tab => controller.tabDomain.occurrence(sessionId, tab),
        }),
      }, RightbarSeat)
    })
    // The expand button shares the panel's store: it only needs to know whether
    // the panel is expanded, and to ask for it to be. The header's corner seat
    // is its own place, past the utilities, so showing and hiding it moves
    // nothing else in the row.
    const disposeExpand = ctx.slots.inject('conversation.session.header.corner', () => ctx.slots.register({
      name: 'conversation.session.header.corner',
      locale: NS,
      store,
      inject: sessionId => ({ focus: () => { layout.focusRightbar(sessionId) } }),
    }, ExpandButton))
    const disposeBlankExpand = ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
      name: 'conversation.input.left', id: 'auxiliary-sidebar', locale: NS, store,
      inject: sessionId => ({ focus: () => { layout.focusRightbar(sessionId) } }),
    }, BlankExpandButton))
    const disposeMobileExpand = ctx.slots.inject('shell.mobile.header.actions', () => ctx.slots.register({
      name: 'shell.mobile.header.actions', id: 'auxiliary-sidebar', locale: NS, store,
      inject: sessionId => ({ focus: () => { layout.focusRightbar(sessionId) } }),
    }, ExpandButton))
    // Stage two for the guide: it declares the chain child it hosts and reads
    // the registry's entry boxes, which an ordinary type has no reason to do.
    const guideInjected: GuideInjected = {
      hooks: { guideEntries: { subscribe: listener => tabs.subscribe(listener), getSnapshot: () => tabs.guide() } },
    }
    const disposeGuide = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: GUIDE_ID,
      children: {
        'sidebar.right.tab.guide.entry': {
          kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: guideTabInfoFactory } },
        },
        'sidebar.right.tab.guide': {
          kind: 'chain', scope: 'session', inject: { hooks: { tabInfo: guideTabInfoFactory } },
        },
      },
      inject: () => guideInjected,
    }, GuideBody))
    const disposeGuideTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab.title', key: GUIDE_ID },
      GuideTitle,
    ))
    return () => {
      releaseOwner()
      disposeTool()
      disposeGuideTitle()
      disposeGuide()
      disposeMobileExpand()
      disposeBlankExpand()
      disposeExpand()
      disposeSeat()
      for (const dispose of disposeTypes.reverse()) dispose()
      for (const release of adoptions) release()
    }
  }, 'ui-sidebar-right: seats and shipped tab type')
}
