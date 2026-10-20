/** Register the human remote-desktop tab type and its consent/RFB body. */
import type { Context } from '@deepseek-ai/cordis'
import RFB from '@novnc/novnc/lib/rfb.js'
import type {} from '@deepseek-ai/dsh-api-remote-desktop-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { RemoteDesktopBody } from './RemoteDesktopBody.tsx'
import { RemoteDesktopGuide } from './RemoteDesktopGuide.tsx'
import { RemoteDesktopGuideIcon } from './RemoteDesktopIcon.tsx'
import type { RemoteDesktopInjected } from './face.ts'
import { en, zh } from './locales.ts'

/** Services needed by the remote-desktop sidebar seat. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remoteDesktops']

/**
 * Register the `remoteDesktop` tab kind and its pane body. Tabs are opened
 * through `openTabIn(sessionId, 'remoteDesktop', { params: { nodeId, desktop? } })`.
 * @param ctx - Client root Context with slot, locale, sidebar, and remote-desktop services.
 */
export function apply(ctx: Context): void {
  const namespace = 'remoteDesktop'
  const id = '@deepseek-ai/dsh-client-ui-remote-desktop'
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-remote-desktop.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id, kind: 'remoteDesktop', multiple: true, priority: 'builtin', title: () => t('title'),
    guide: [{ id: 'connect', order: 40, title: () => t('connectTitle'), description: () => t('connectDescription'), icon: RemoteDesktopGuideIcon }],
  }), 'ui-remote-desktop.type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register(
    { name: 'sidebar.right.tab.guide.entry', key: id, locale: namespace, inject: () => ({}) },
    RemoteDesktopGuide,
  )), 'ui-remote-desktop.guide')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab', key: id, locale: namespace,
      inject: (sessionId): RemoteDesktopInjected => ({
        status: (target, signal) => ctx.remoteDesktops.status(sessionId, target, signal),
        confirm: (target, level, signal) => ctx.remoteDesktops.confirm(sessionId, target, level, signal),
        attach: (target, level, signal) => ctx.remoteDesktops.attach(sessionId, target, level, signal),
        openScreen: (container, url, options) => {
          const rfb = new RFB(container, url, {})
          rfb.viewOnly = options.viewOnly
          rfb.scaleViewport = true
          rfb.focusOnClick = true
          return rfb
        },
      }),
    },
    RemoteDesktopBody,
  )), 'ui-remote-desktop.body')
}
