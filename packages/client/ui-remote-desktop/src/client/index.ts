/** Register the human remote-desktop tab type and its consent/RFB body. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-desktop-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { RemoteDesktopBody } from './RemoteDesktopBody.tsx'
import { RemoteDesktopGuide } from './RemoteDesktopGuide.tsx'
import { RemoteDesktopGuideIcon } from './RemoteDesktopIcon.tsx'
import type { RemoteDesktopGuideInjected, RemoteDesktopInjected, RemoteDesktopQuality, RemoteDesktopZoom } from './face.ts'
import { en, zh } from './locales.ts'

/** Tight-encoding levels behind `RemoteDesktopQuality`; `balanced` repeats noVNC's shipped defaults. */
const QUALITY_LEVELS: Record<RemoteDesktopQuality, { readonly quality: number; readonly compression: number }> = {
  smooth: { quality: 4, compression: 6 },
  balanced: { quality: 6, compression: 2 },
  sharp: { quality: 9, compression: 1 },
}

/** Viewport fit behind `RemoteDesktopZoom`: scaled, or native pixels with clip-and-pan. */
function applyZoom(rfb: { scaleViewport: boolean; clipViewport: boolean; dragViewport: boolean }, zoom: RemoteDesktopZoom): void {
  rfb.scaleViewport = zoom === 'fit'
  rfb.clipViewport = zoom === 'actual'
  rfb.dragViewport = zoom === 'actual'
}

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
    // An RFB stream is a live socket, not a re-renderable view: deselecting the
    // tab must not unmount the body, or every tab hop re-attaches and re-challenges.
    keepMounted: true,
    guide: [{ id: 'connect', order: 40, title: () => t('connectTitle'), description: () => t('connectDescription'), icon: RemoteDesktopGuideIcon }],
  }), 'ui-remote-desktop.type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register(
    {
      name: 'sidebar.right.tab.guide.entry', key: id, locale: namespace,
      inject: (sessionId): RemoteDesktopGuideInjected => ({
        listTargets: signal => ctx.remoteDesktops.listGrants(sessionId, { attachable: true }, signal),
      }),
    },
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
          // noVNC stays out of the registration module: a stream pays the import
          // only when it actually opens, so mounting the sidebar costs nothing.
          let localClose = false
          const ready = import('./rfb.ts').then(({ RFB }) => {
            const rfb = new RFB(container, url, {})
            rfb.viewOnly = options.viewOnly
            rfb.scaleViewport = true
            // Servers that advertise ExtendedDesktopSize follow the container's
            // size; servers that do not (TightVNC) silently ignore the request.
            rfb.resizeSession = true
            rfb.focusOnClick = true
            rfb.addEventListener('credentialsrequired', (event) => {
              const types = (event as CustomEvent<{ types?: string[] }>).detail.types
              options.onCredentialsRequired?.(types ?? ['password'])
            })
            rfb.addEventListener('disconnect', () => { if (!localClose) options.onDisconnected?.() })
            return rfb
          })
          return {
            sendCredentials: (credentials) => {
              const offer: Record<string, string> = {}
              if (credentials.username !== undefined) offer.username = credentials.username
              if (credentials.password !== undefined) offer.password = credentials.password
              void ready.then((rfb) => { rfb.sendCredentials(offer) })
            },
            setZoom: (zoom) => { void ready.then((rfb) => { applyZoom(rfb, zoom) }) },
            setQuality: (quality) => {
              void ready.then((rfb) => {
                const level = QUALITY_LEVELS[quality]
                rfb.qualityLevel = level.quality
                rfb.compressionLevel = level.compression
              })
            },
            sendCtrlAltDel: () => { void ready.then((rfb) => { rfb.sendCtrlAltDel() }) },
            disconnect: () => { localClose = true; void ready.then((rfb) => { rfb.disconnect() }) },
          }
        },
      }),
    },
    RemoteDesktopBody,
  )), 'ui-remote-desktop.body')
}
