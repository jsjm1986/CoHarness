/** Register the HTTP(S) Browser tab type in the right Sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { sessionPersistenceKey } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { BrowserBody } from './view/BrowserBody.tsx'
import { BrowserTitle } from './view/BrowserTitle.tsx'
import { createBrowserControllers } from './browser/BrowserController.ts'
import { BROWSER_ID, browserDefinition } from './definition.tsx'
import { en, zh } from './locales.ts'
import { createScopedBrowserStore } from './browser/persistence.ts'

export type { BrowserBodyProps } from './view/BrowserBody.tsx'
export type { BrowserInjected } from './browser/BrowserController.ts'
export type { BrowserDocument, BrowserFrame, BrowserFrameState } from './browser/BrowserFrame.ts'
export type { BrowserFailure, BrowserHistoryEntry, BrowserNavigationStatus, BrowserTabState } from './browser/BrowserNavigation.ts'
export type { SidebarBrowserKey } from './locales.ts'
export type { BrowserState } from './browser/store.ts'
export type { BrowserAddressFailure, BrowserAddressResult, BrowserTarget } from './browser/url.ts'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Optional initial Browser URL. */
    browser: { readonly url?: string }
  }
}

/** Required Browser services. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'layout', 'sessions', 'connection', 'projectUiPolicy']

/** Register the Browser type, localized guide entry, body, and title. */
export function apply(ctx: Context): void {
  ctx.on('web/browser-open', ({ sessionId, url }) => {
    ctx.sidebarRight.openSessionTab(sessionId, 'browser', { params: { url } })
    ctx.layout.focusRightbar(sessionId)
    return true
  })
  const namespace = 'sidebarBrowser'
  const t = ctx.locale.bind(namespace)
  const connection = ctx.get('connection') as ConnectionHandle
  const disposers: Array<() => void> = []
  ctx.effect(() => () => { for (const dispose of disposers.reverse()) dispose() }, 'ui-sidebar-browser.persistence')
  const store = createScopedBrowserStore({
    key: sessionId => sessionPersistenceKey(ctx.sessions, sessionId as SessionId,
      connection.hostDescription.getSnapshot()?.executionAuthorityRequired,
      ctx.projectUiPolicy.getSnapshot().verifiedAccountId),
    subscribe(listener) {
      const stop = [
        ctx.sessions.list.subscribe(listener), ctx.projectUiPolicy.subscribe(listener), connection.hostDescription.subscribe(listener),
      ]
      return () => { for (const dispose of stop) dispose() }
    },
    origin: () => window.location.origin,
    onDispose: (dispose) => { disposers.push(dispose) },
  })
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-sidebar-browser.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register(browserDefinition(t)), 'ui-sidebar-browser.type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: BROWSER_ID, locale: namespace, store,
    inject: (_sessionId, actions) => createBrowserControllers(actions),
  }, BrowserBody)), 'ui-sidebar-browser.body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: BROWSER_ID, store,
  }, BrowserTitle)), 'ui-sidebar-browser.title')
}
