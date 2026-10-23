/** Register interactive terminal tabs and explicit process cleanup with the sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { SidebarRightTabParamsMap, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionPersistenceKey } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-terminal-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { TerminalGuideIcon } from './TerminalIcon.tsx'
import { TerminalGuide, type TerminalGuideInjected } from './TerminalGuide.tsx'
import { LazyTerminalBody } from './LazyTerminalBody.tsx'
import { TerminalTitle } from './TerminalTitle.tsx'
import { TerminalRecovery, type TerminalRecoveryInjected } from './TerminalRecovery.tsx'
import { TerminalCleanup, type TerminalCleanupInjected } from './TerminalCleanup.tsx'
import type { TerminalBodyInjected, TerminalInjected } from './face.ts'
import { en, zh } from './locales.ts'

/** Services needed by the terminal's two sidebar seats. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'webTerminals', 'theme', 'sessions', 'connection', 'projectUiPolicy']

/**
 * Register the terminal type, observable views and background process cleanup.
 * @param ctx - Client root Context with sidebar and terminal services.
 */
export function apply(ctx: Context): void {
  let disposed = false
  const recovered = new Map<SessionId, { owner: string; consumers: Set<AbortSignal>; promise: Promise<void> }>()
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => () => { disposed = true; recovered.clear() }, 'ui-sidebar-terminal.lifetime')
  ctx.effect(() => {
    const sync = (): void => { ctx.webTerminals.retainTabs(ctx.sidebarRight.openTabs.getSnapshot().filter(tab => tab.kind === 'terminal')) }
    const unsubscribe = ctx.sidebarRight.openTabs.subscribe(sync)
    sync()
    return () => { unsubscribe(); ctx.webTerminals.retainTabs([]) }
  }, 'ui-sidebar-terminal.window-holds')
  const target = (sessionId: SessionId, key: string): SidebarRightTabParamsMap['terminal'] | undefined =>
    ctx.sidebarRight.tabDomain.occurrence(sessionId, { id: key as TabId }).navigation.getSnapshot().params
  const terminalId = (sessionId: SessionId, key: string): WebTerminalId | undefined => {
    const params = target(sessionId, key)
    return params !== undefined && 'terminalId' in params ? params.terminalId : undefined
  }
  const view = (sessionId: SessionId, key: string) => {
    const params = target(sessionId, key)
    const contentId = ctx.sidebarRight.tabDomain.occurrence(sessionId, { id: key as TabId }).navigation.getSnapshot().address
    return ctx.webTerminals.view(sessionId, key, contentId, terminalId(sessionId, key),
      params !== undefined && 'shellPath' in params ? params.shellPath : undefined)
  }
  const namespace = 'sidebarTerminal'
  const id = '@deepseek-ai/dsh-client-ui-sidebar-terminal'
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-sidebar-terminal.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id, kind: 'terminal', multiple: true, priority: 'builtin', title: () => t('title'),
    guide: [{ id: 'new', order: 20, title: () => t('new'), description: () => t('description'), icon: TerminalGuideIcon }],
  }), 'ui-sidebar-terminal.type')
  ctx.effect(() => ctx.sidebarRight.registerCloseHandler('terminal', (sessionId, tab) => {
    ctx.webTerminals.close(sessionId, tab.id, tab.contentId, terminalId(sessionId, tab.id))
  }), 'ui-sidebar-terminal.close')
  const inject = (sessionId: SessionId): TerminalInjected => ({
    view: key => view(sessionId, key),
    keyedHooks: { terminal: key => view(sessionId, key).state },
  })
  const theme: TerminalBodyInjected['hooks']['theme'] = {
    getSnapshot: () => ctx.theme.getTheme(),
    subscribe: listener => ctx.on('theme/change', listener),
  }
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({
    name: 'sidebar.right.tab.guide.entry', key: id, locale: namespace,
    inject: (sessionId): TerminalGuideInjected => ({
      loadShells: signal => ctx.webTerminals.launchShells(sessionId, signal),
      issueOf: error => ctx.webTerminals.issueOf(error),
      selectShell: (path) => { ctx.webTerminals.selectShell(sessionId, path) },
    }),
  }, TerminalGuide)), 'ui-sidebar-terminal.guide')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: id, locale: namespace,
      inject: (sessionId): TerminalBodyInjected => ({ ...inject(sessionId), hooks: { theme } }),
    }, LazyTerminalBody,
  )), 'ui-sidebar-terminal.body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: id, locale: namespace, inject }, TerminalTitle,
  )), 'ui-sidebar-terminal.title')
  ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id, locale: namespace,
    inject: (sessionId): TerminalRecoveryInjected => {
      const ownership: HostObservable<string | undefined> = {
        getSnapshot: () => disposed ? undefined : sessionPersistenceKey(ctx.sessions, sessionId,
          connection.hostDescription.getSnapshot()?.executionAuthorityRequired, ctx.projectUiPolicy.getSnapshot().verifiedAccountId),
        subscribe: (listener) => {
          const changed = (): void => {
            const pending = recovered.get(sessionId)
            if (pending !== undefined && pending.owner !== ownership.getSnapshot()) recovered.delete(sessionId)
            listener()
          }
          const releases = [ctx.sessions.list.subscribe(changed), connection.hostDescription.subscribe(changed),
            ctx.projectUiPolicy.subscribe(changed)]
          return () => { for (const release of releases) release() }
        },
      }
      return { hooks: { ownership }, restore: (signal) => {
        if (signal.aborted) return Promise.resolve()
        const owner = ownership.getSnapshot()
        if (owner === undefined) return Promise.resolve()
        let pending = recovered.get(sessionId)
        if (pending === undefined || pending.owner !== owner || [...pending.consumers].every(consumer => consumer.aborted)) {
          const consumers = new Set([signal])
          const canPublish = (): boolean => ownership.getSnapshot() === owner && recovered.get(sessionId)?.promise === promise
            && [...consumers].some(consumer => !consumer.aborted)
          const promise: Promise<void> = (async () => {
            for (const tab of ctx.sidebarRight.tabsIn(sessionId)) {
              if (tab.kind === 'terminal') view(sessionId, tab.id)
            }
            const terminals = await ctx.webTerminals.recover(sessionId)
            if (!canPublish()) return
            for (const info of terminals) ctx.sidebarRight.openTabIn(sessionId, 'terminal', {
              params: { terminalId: info.id },
            })
          })().catch((error: unknown) => { if (canPublish()) throw error })
            .finally(() => { if (recovered.get(sessionId)?.promise === promise) recovered.delete(sessionId) })
          pending = { owner, consumers, promise }
          recovered.set(sessionId, pending)
        }
        pending.consumers.add(signal)
        return pending.promise
      } }
    },
  }, TerminalRecovery)), 'ui-sidebar-terminal.recovery')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id, locale: namespace,
    inject: (): TerminalCleanupInjected => ({
      hooks: { closeFailures: ctx.webTerminals.closeFailures },
      retryClose: (terminalId) => { ctx.webTerminals.retryClose(terminalId) },
    }),
  }, TerminalCleanup)), 'ui-sidebar-terminal.cleanup')
}
